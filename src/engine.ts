import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { FilterLastSearch, JobDetails, Store } from './db.ts';
import { matchJob, searchTargets, toFilterDefs, type FilterDef, type SearchTarget } from './filters.ts';
import { budgetText, safeUpworkUrl } from './format.ts';
import { log } from './log.ts';
import { loadDiscovery } from './mcp/discover.ts';
import { connectUpwork } from './mcp/session.ts';
import { SourceError, type Job, type JobSource } from './sources/types.ts';
import { UpworkMcpSource } from './sources/upwork-mcp.ts';

export const SOURCE = 'upwork-mcp';
const CYCLE_KEY = 'search_cycle';
const REQUEST_PREFIX = 'search_request:';
/** Pages always read per search target on a normal run (Upwork's newest-first order is not strict). */
const MIN_PAGES = 2;
/** Attempts per page (across calls) before a search target is given up for this cycle. */
const MAX_ATTEMPTS = 3;

export interface FilterSummary {
  name: string;
  firstRun: boolean;
  pages: number;
  returned: number;
  accepted: number;
  newJobs: number;
  rejectedLocally: number;
  ignoredFilters: string[];
  emptyReason: string | null;
  moreResultsNotFetched: boolean;
  error: string | null;
}

/** One server-side search (a filter, or one of its categories) and where its paging stands. */
interface Task {
  filter: string;
  target: SearchTarget;
  cursor: string | null;
  pages: number;
  attempts: number;
  done: boolean;
}

/** A search over some filters, saved in the database between calls so it can resume. */
export interface Cycle {
  id: string;
  runId: number;
  startedAt: string;
  tasks: Task[];
  filters: FilterSummary[];
  stoppedEarly: string | null;
  /** Upwork asked to wait (rate limit): no search before this time. */
  retryAfter: string | null;
}

export interface RunSummary {
  status: 'ok' | 'partial' | 'failed';
  filters: FilterSummary[];
  newJobs: number;
  stoppedEarly: string | null;
}

export type StepResult =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'waiting' | 'continued'; progress: Progress }
  | { status: 'finished'; summary: RunSummary };

export interface Progress {
  startedAt: string;
  tasksDone: number;
  tasksTotal: number;
  newJobs: number;
  filters: string[];
  retryAfter: string | null;
}

export interface EngineDeps {
  store: Store;
  cfg: Config;
  /** Opens the job source (the Upwork MCP connection); replaced in tests. */
  openSource?: () => Promise<JobSource>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function enabledFilters(store: Store): Promise<FilterDef[]> {
  return toFilterDefs(await store.listFilters()).filter((f) => f.enabled);
}

async function openUpwork(d: EngineDeps): Promise<JobSource> {
  const discovery = await loadDiscovery(d.store);
  if (!discovery) throw new SourceError('auth', 'Upwork is not connected yet. Press "Connect Upwork" on the dashboard.');
  return new UpworkMcpSource(await connectUpwork(d.cfg, d.store, { interactive: false }), discovery);
}

export async function getCycle(store: Store): Promise<Cycle | null> {
  const raw = await store.kvGet(CYCLE_KEY);
  return raw ? (JSON.parse(raw) as Cycle) : null;
}

export function progressOf(c: Cycle): Progress {
  return {
    startedAt: c.startedAt,
    tasksDone: c.tasks.filter((t) => t.done).length,
    tasksTotal: c.tasks.length,
    newJobs: c.filters.reduce((n, f) => n + f.newJobs, 0),
    filters: c.filters.map((f) => f.name),
    retryAfter: c.retryAfter,
  };
}

/**
 * Asks for a search of one filter, or of all enabled filters (null). Each request is
 * its own row, so requests made while a search is running are never lost; the next
 * `step` picks them up.
 */
export async function requestSearch(store: Store, filter: string | null): Promise<void> {
  await store.kvSet(`${REQUEST_PREFIX}${filter ?? '*'}`, new Date().toISOString());
}

export async function hasPendingWork(store: Store): Promise<boolean> {
  return !!(await store.kvGet(CYCLE_KEY)) || (await store.kvKeys(REQUEST_PREFIX)).length > 0;
}

/** Adds the requested filters (that are not in it yet) to the running cycle, creating one if needed. */
async function absorbRequests(d: EngineDeps, cycle: Cycle | null): Promise<Cycle | null> {
  const keys = await d.store.kvKeys(REQUEST_PREFIX);
  if (!keys.length) return cycle;
  const wanted = new Set(keys.map((k) => k.slice(REQUEST_PREFIX.length)));
  const filters = (await enabledFilters(d.store)).filter((f) => wanted.has('*') || wanted.has(f.name));
  for (const k of keys) await d.store.kvDelete(k);
  const fresh = filters.filter((f) => !cycle?.filters.some((s) => s.name === f.name));
  if (!fresh.length) return cycle;
  const c: Cycle = cycle ?? { id: randomUUID(), runId: await d.store.startRun(SOURCE), startedAt: new Date((d.now ?? Date.now)()).toISOString(), tasks: [], filters: [], stoppedEarly: null, retryAfter: null };
  for (const f of fresh) {
    c.filters.push({
      name: f.name,
      firstRun: !(await d.store.baselineDone(SOURCE, f.name)),
      pages: 0,
      returned: 0,
      accepted: 0,
      newJobs: 0,
      rejectedLocally: 0,
      ignoredFilters: [],
      emptyReason: null,
      moreResultsNotFetched: false,
      error: null,
    });
    // Categories and subcategories are OR-ed (as on the Upwork website): one search per target.
    for (const target of searchTargets(f.criteria)) c.tasks.push({ filter: f.name, target, cursor: null, pages: 0, attempts: 0, done: false });
  }
  await d.store.kvSet(CYCLE_KEY, JSON.stringify(c));
  return c;
}

function toDetails(job: Job): JobDetails {
  return {
    id: job.id,
    title: job.title,
    url: safeUpworkUrl(job.url),
    budget: budgetText(job),
    contractType: job.contractType,
    postedAt: job.postedAt,
    snippet: job.description ? job.description.replace(/\s+/g, ' ').trim().slice(0, 500) : null,
    skills: job.skills,
    clientCountry: job.clientCountry,
    clientPaymentVerified: job.clientPaymentVerified,
    proposals: job.proposals,
  };
}

/**
 * Does up to `budgetMs` of search work and saves its place after every page, so a
 * function that is stopped (Vercel's time limit) loses at most one page, and the next
 * call continues where this one stopped. Only one step runs at a time (database lock).
 */
export async function step(d: EngineDeps, budgetMs: number): Promise<StepResult> {
  const { store, cfg } = d;
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? defaultSleep;
  const owner = randomUUID();
  if (!(await store.acquireLock('search', owner, budgetMs + 60_000))) return { status: 'busy' };
  try {
    const cycle = await absorbRequests(d, await getCycle(store));
    if (!cycle) return { status: 'idle' };
    if (cycle.retryAfter && Date.parse(cycle.retryAfter) > now()) return { status: 'waiting', progress: progressOf(cycle) };
    cycle.retryAfter = null;

    const filters = new Map((await enabledFilters(store)).map((f) => [f.name, f]));
    const started = now();
    let searches = 0;
    let source: JobSource | null = null;
    const save = () => store.kvSet(CYCLE_KEY, JSON.stringify(cycle));
    try {
      tasks: for (const task of cycle.tasks) {
        const fs = cycle.filters.find((s) => s.name === task.filter)!;
        const f = filters.get(task.filter);
        if (!f) task.done = true; // removed or disabled meanwhile
        while (!task.done) {
          // Every call makes at least one search (so a search always moves forward); after that,
          // stop before the pause plus the next search would run past the budget.
          const pause = searches > 0 ? cfg.search.delayBetweenSearchesMs : 0;
          if (searches > 0 && now() - started + pause > budgetMs) {
            await save();
            return { status: 'continued', progress: progressOf(cycle) };
          }
          if (pause > 0) await sleep(pause);
          searches++;
          let page;
          try {
            source ??= await (d.openSource ?? (() => openUpwork(d)))();
            page = await source.search(f!, task.cursor, cfg.search.pageSize, task.target);
          } catch (err) {
            const se = err instanceof SourceError ? err : new SourceError('temporary', (err as Error).message);
            if (se.kind === 'auth') {
              // Nothing can succeed until the sign-in is fixed: end the cycle instead of hammering.
              cycle.stoppedEarly = se.message;
              for (const t of cycle.tasks) t.done = true;
              for (const s of cycle.filters) s.error ??= 'skipped: Upwork sign-in problem';
              log.error('search stopped: Upwork authorization problem', { error: se.message });
              break tasks;
            }
            task.attempts++;
            if (!se.retryable || task.attempts >= MAX_ATTEMPTS) {
              task.done = true;
              fs.error = se.message;
              log.error('filter search failed', { filter: f!.name, error: se.message });
              break;
            }
            // Exponential backoff with jitter; never shorter than the server's instruction.
            const wait = Math.max(Math.round(1000 * 2 ** task.attempts * (0.5 + Math.random() / 2)), (se.retryAfterSeconds ?? 0) * 1000);
            log.warn('search failed, will retry', { filter: f!.name, kind: se.kind, attempt: task.attempts, waitMs: wait, error: se.message });
            if (now() - started + wait > budgetMs) {
              cycle.retryAfter = new Date(now() + wait).toISOString();
              await save();
              return { status: 'waiting', progress: progressOf(cycle) };
            }
            await sleep(wait);
            continue;
          }

          task.attempts = 0;
          task.pages++;
          fs.pages++;
          fs.returned += page.jobs.length;
          for (const ig of page.ignoredFilters) if (!fs.ignoredFilters.includes(ig)) fs.ignoredFilters.push(ig);
          if (page.emptyReason) fs.emptyReason = page.emptyReason;
          const seen = await store.seenIds(SOURCE, page.jobs.map((j) => j.id));
          const keep: { details: JobDetails; baseline: boolean }[] = [];
          for (const job of page.jobs) {
            // Upwork applied this filter's keyword and category; re-check budget, rate and type locally.
            const m = matchJob(job, f!.criteria, { trustKeyword: true });
            if (!m.matched) {
              fs.rejectedLocally++;
              log.debug('job rejected by local check', { filter: f!.name, job: job.id, failed: m.failed });
              continue;
            }
            fs.accepted++;
            const isNew = !seen.has(job.id);
            if (isNew) fs.newJobs++;
            keep.push({ details: toDetails(job), baseline: isNew && fs.firstRun });
          }
          await store.saveJobs(SOURCE, f!.name, keep);
          const unseen = keep.filter((k) => !seen.has(k.details.id)).length;

          task.cursor = page.nextCursor;
          const maxPages = fs.firstRun ? cfg.search.firstRunMaxPages : cfg.search.maxPagesPerFilter;
          if (!task.cursor) task.done = true;
          // Newest first: once a whole page is already known, older pages are too. Upwork's order is
          // not perfectly strict, so always read at least MIN_PAGES before stopping.
          else if (!fs.firstRun && unseen === 0 && task.pages >= MIN_PAGES) task.done = true;
          else if (task.pages >= maxPages) {
            task.done = true;
            fs.moreResultsNotFetched = true;
          }
          await save();
        }
      }
    } finally {
      await source?.close();
    }
    return { status: 'finished', summary: await finish(d, cycle) };
  } finally {
    await store.releaseLock('search', owner);
  }
}

async function finish(d: EngineDeps, cycle: Cycle): Promise<RunSummary> {
  const finishedAt = new Date((d.now ?? Date.now)()).toISOString();
  for (const f of cycle.filters) {
    for (const ig of f.ignoredFilters) log.warn('Upwork did not apply some filter terms', { filter: f.name, ignored: ig });
    if (f.firstRun && !f.error) await d.store.completeBaseline(SOURCE, f.name);
    // Failed searches count too, so a broken filter or sign-in is retried next interval, not every call.
    await d.store.recordFilterSearch(f.name, { startedAt: cycle.startedAt, finishedAt, status: f.error ? 'failed' : 'ok', newJobs: f.newJobs, error: f.error });
  }
  const failed = cycle.filters.filter((f) => f.error).length;
  const summary: RunSummary = {
    status: failed === 0 && !cycle.stoppedEarly ? 'ok' : failed === cycle.filters.length ? 'failed' : 'partial',
    filters: cycle.filters,
    newJobs: cycle.filters.reduce((n, f) => n + f.newJobs, 0),
    stoppedEarly: cycle.stoppedEarly,
  };
  await d.store.purge(d.cfg.retentionDays);
  await d.store.finishRun(cycle.runId, summary.status, summary);
  await d.store.kvDelete(CYCLE_KEY);
  log.info('search finished', { status: summary.status, newJobs: summary.newJobs, stoppedEarly: summary.stoppedEarly });
  return summary;
}

/** Two minutes of slack, so a scheduler that fires every N minutes never skips a whole interval. */
const DUE_SLACK_MS = 2 * 60_000;

export interface FilterSchedule {
  name: string;
  lastSearch: FilterLastSearch | null;
  /** When this filter's next automatic search is due (ISO); never searched = due now. */
  nextDueAt: string;
}

/**
 * Each enabled filter's own schedule: due SEARCH_INTERVAL_MINUTES after its last search
 * started. Per filter, so searching one filter by hand never delays the others.
 */
export async function filterSchedules(d: EngineDeps): Promise<FilterSchedule[]> {
  const now = d.now ?? Date.now;
  const last = await d.store.filterLastSearches();
  return (await enabledFilters(d.store)).map((f) => {
    const s = last.get(f.name) ?? null;
    return { name: f.name, lastSearch: s, nextDueAt: new Date(s ? Date.parse(s.startedAt) + d.cfg.intervalMinutes * 60_000 : now()).toISOString() };
  });
}

/** When the next automatic search is due (ISO): the earliest of the enabled filters. */
export async function nextDueAt(d: EngineDeps): Promise<string | null> {
  const due = (await filterSchedules(d)).map((s) => s.nextDueAt).sort();
  return due[0] ?? null;
}

/**
 * What the scheduler calls (every few minutes): continues a running search, or starts
 * one for every filter whose SEARCH_INTERVAL_MINUTES have passed since its last search.
 */
export async function tick(d: EngineDeps, budgetMs = d.cfg.stepBudgetSeconds * 1000): Promise<StepResult> {
  const now = d.now ?? Date.now;
  if (!(await hasPendingWork(d.store))) {
    const all = await filterSchedules(d);
    const due = all.filter((s) => Date.parse(s.nextDueAt) - DUE_SLACK_MS <= now());
    if (!due.length) return { status: 'idle' };
    if (due.length === all.length) await requestSearch(d.store, null);
    else for (const s of due) await requestSearch(d.store, s.name);
  }
  return step(d, budgetMs);
}

/**
 * Keeps a running search going for up to `totalMs` (in steps, each saving its place).
 * Used after the scheduler has answered, so a search finishes in one scheduler call
 * instead of moving forward 20 seconds every few minutes.
 */
export async function continueSearch(d: EngineDeps, totalMs: number): Promise<StepResult | null> {
  const now = d.now ?? Date.now;
  const started = now();
  const budget = d.cfg.stepBudgetSeconds * 1000;
  let r: StepResult | null = null;
  while (now() - started + budget <= totalMs) {
    r = await step(d, budget);
    if (r.status !== 'continued') break;
  }
  return r;
}
