import { randomUUID } from 'node:crypto';
import type { Store } from './db.ts';
import { matchJob, searchTargets, type FilterDef, type SearchTarget } from './filters.ts';
import { log } from './log.ts';
import { SourceError, type Job, type JobSource, type SearchPage } from './sources/types.ts';
import { budgetText, deliverOutbox, formatAlert, type TelegramSender } from './telegram.ts';

export interface RunOptions {
  store: Store;
  source: JobSource;
  filters: FilterDef[];
  sender: TelegramSender;
  chatIds: string[];
  maxPagesPerFilter: number;
  /** Page limit per search target on a filter's first run; defaults to maxPagesPerFilter. */
  firstRunMaxPages?: number;
  pageSize: number;
  delayBetweenSearchesMs: number;
  alertOnFirstRun: boolean;
  descriptionMaxChars: number;
  retentionDays: number;
  onlyFilter?: string | null;
  sleep?: (ms: number) => Promise<void>;
}

export interface FilterSummary {
  name: string;
  baselineRun: boolean;
  pages: number;
  returned: number;
  accepted: number;
  rejectedLocally: number;
  ignoredFilters: string[];
  emptyReason: string | null;
  moreResultsNotFetched: boolean;
  error: string | null;
}

export interface RunSummary {
  status: 'ok' | 'partial' | 'failed' | 'locked';
  source: string;
  filters: FilterSummary[];
  newJobs: number;
  alertsQueued: number;
  delivery: { sent: number; retrying: number; failed: number };
  recoveredFromPreviousRun: number;
  stoppedEarly: string | null;
}

/** Pages always read per search target on a normal run (Upwork's newest-first order is not strict). */
const MIN_PAGES = 2;
const MAX_ATTEMPTS = 3;
/** Longest server-requested wait honoured inside one run; longer means "try again later". */
const MAX_INLINE_WAIT_S = 120;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class StopRun extends Error {}

async function searchWithRetry(o: RunOptions, f: FilterDef, cursor: string | null, target: SearchTarget): Promise<SearchPage> {
  const sleep = o.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await o.source.search(f, cursor, o.pageSize, target);
    } catch (err) {
      const se = err instanceof SourceError ? err : new SourceError('temporary', (err as Error).message);
      if (se.kind === 'auth') throw new StopRun(se.message);
      if (!se.retryable || attempt >= MAX_ATTEMPTS) throw se;
      if (se.retryAfterSeconds !== null && se.retryAfterSeconds > MAX_INLINE_WAIT_S) {
        throw new StopRun(`Upwork asked to wait ${se.retryAfterSeconds}s before searching again; run again later.`);
      }
      // Exponential backoff with jitter; never shorter than the server's instruction.
      const backoff = Math.round(1000 * 2 ** attempt * (0.5 + Math.random() / 2));
      const wait = Math.max(backoff, (se.retryAfterSeconds ?? 0) * 1000);
      log.warn('search failed, retrying', { filter: f.name, kind: se.kind, attempt, waitMs: wait, error: se.message });
      await sleep(wait);
    }
  }
}

/** One run over all enabled filters (started by the CLI, the dashboard or `npm run watch`). */
export async function runSearch(o: RunOptions): Promise<RunSummary> {
  const owner = randomUUID();
  const summary: RunSummary = {
    status: 'ok',
    source: o.source.name,
    filters: [],
    newJobs: 0,
    alertsQueued: 0,
    delivery: { sent: 0, retrying: 0, failed: 0 },
    recoveredFromPreviousRun: 0,
    stoppedEarly: null,
  };
  if (!o.store.acquireLock('run', owner, 30 * 60_000)) return { ...summary, status: 'locked' };
  const sleep = o.sleep ?? defaultSleep;
  let runId = 0;
  try {
    const interrupted = o.store.recoverInterruptedRuns();
    if (interrupted) log.warn('previous run was interrupted; continuing safely', { interrupted });
    runId = o.store.startRun(o.source.name);

    // Recovery: alerts queued by an earlier run that were not confirmed yet.
    const before = o.store.pendingCount();
    if (before) {
      const d = await deliverOutbox(o.store, o.sender);
      summary.recoveredFromPreviousRun = d.sent;
      log.info('delivered alerts left over from a previous run', d);
    }

    const filters = o.filters.filter((f) => f.enabled && (!o.onlyFilter || f.name === o.onlyFilter));
    const pastBaseline = new Map(filters.map((f) => [f.name, o.store.baselineDone(o.source.name, f.name)]));
    const found = new Map<string, { job: Job; filters: Set<string> }>();
    let searches = 0;

    for (const f of filters) {
      const fs: FilterSummary = {
        name: f.name,
        baselineRun: !pastBaseline.get(f.name),
        pages: 0,
        returned: 0,
        accepted: 0,
        rejectedLocally: 0,
        ignoredFilters: [],
        emptyReason: null,
        moreResultsNotFetched: false,
        error: null,
      };
      summary.filters.push(fs);
      if (summary.stoppedEarly) {
        fs.error = 'skipped: run stopped early';
        continue;
      }
      const maxPages = fs.baselineRun ? (o.firstRunMaxPages ?? o.maxPagesPerFilter) : o.maxPagesPerFilter;
      try {
        // Categories and subcategories are OR-ed (as on the Upwork website): one search per target.
        for (const target of searchTargets(f.criteria)) {
          let cursor: string | null = null;
          let pages = 0;
          do {
            if (searches++ > 0 && o.delayBetweenSearchesMs > 0) await sleep(o.delayBetweenSearchesMs);
            const page = await searchWithRetry(o, f, cursor, target);
            pages++;
            fs.pages++;
            fs.returned += page.jobs.length;
            for (const ig of page.ignoredFilters) if (!fs.ignoredFilters.includes(ig)) fs.ignoredFilters.push(ig);
            if (page.emptyReason) fs.emptyReason = page.emptyReason;
            let unseen = 0;
            for (const job of page.jobs) {
              if (!found.has(job.id) && !o.store.isSeen(o.source.name, job.id)) unseen++;
              // The server applied this filter's keyword and category; re-check budget, rate and type locally.
              const m = matchJob(job, f.criteria, { trustKeyword: true });
              if (!m.matched) {
                fs.rejectedLocally++;
                log.debug('job rejected by local check', { filter: f.name, job: job.id, failed: m.failed });
                continue;
              }
              fs.accepted++;
              const entry = found.get(job.id) ?? { job, filters: new Set<string>() };
              entry.filters.add(f.name);
              found.set(job.id, entry);
            }
            cursor = page.nextCursor;
            // Newest first: once a whole page is already known, older pages are too. Upwork's order is not
            // perfectly strict, so always read at least MIN_PAGES before stopping.
            if (!fs.baselineRun && unseen === 0 && pages >= MIN_PAGES) break;
            if (cursor && pages >= maxPages) {
              fs.moreResultsNotFetched = true;
              break;
            }
          } while (cursor);
        }
        if (fs.ignoredFilters.length) log.warn('Upwork did not apply some filter terms', { filter: f.name, ignored: fs.ignoredFilters });
        if (!pastBaseline.get(f.name)) o.store.completeBaseline(o.source.name, f.name);
      } catch (err) {
        fs.error = (err as Error).message;
        if (err instanceof StopRun) summary.stoppedEarly = err.message;
        log.error('filter search failed', { filter: f.name, error: fs.error });
      }
    }

    o.store.transaction(() => {
      for (const { job, filters: names } of found.values()) {
        const isNew = o.store.markSeen(o.source.name, job.id);
        for (const n of names) o.store.recordMatch(o.source.name, job.id, n);
        // Jobs that already existed when a filter was first run are a baseline, not news.
        const alertable = o.alertOnFirstRun || [...names].some((n) => pastBaseline.get(n));
        o.store.saveJobDetails(
          o.source.name,
          {
            id: job.id,
            title: job.title,
            url: job.url,
            budget: budgetText(job),
            contractType: job.contractType,
            postedAt: job.postedAt,
            snippet: job.description ? job.description.replace(/\s+/g, ' ').trim().slice(0, 500) : null,
            skills: job.skills,
            clientCountry: job.clientCountry,
            clientPaymentVerified: job.clientPaymentVerified,
            proposals: job.proposals,
          },
          isNew && !alertable,
        );
        if (!isNew) continue;
        summary.newJobs++;
        if (!alertable || o.chatIds.length === 0) continue;
        const ordered = filters.map((f) => f.name).filter((n) => names.has(n));
        const text = formatAlert(job, ordered, { descriptionMaxChars: o.descriptionMaxChars });
        summary.alertsQueued += o.store.enqueue(o.source.name, job.id, o.chatIds, text, job.url);
      }
    });

    summary.delivery = await deliverOutbox(o.store, o.sender);
    o.store.purge(o.retentionDays);

    const failedFilters = summary.filters.filter((f) => f.error).length;
    summary.status = failedFilters === 0 ? 'ok' : failedFilters === summary.filters.length ? 'failed' : 'partial';
    return summary;
  } catch (err) {
    summary.status = 'failed';
    throw err;
  } finally {
    if (runId) o.store.finishRun(runId, summary.status === 'locked' ? 'failed' : summary.status, summary);
    o.store.releaseLock('run', owner);
  }
}
