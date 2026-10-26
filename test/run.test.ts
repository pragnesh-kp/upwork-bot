import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { parseUpworkSearchUrl, type FilterDef } from '../src/filters.ts';
import { runSearch, type RunOptions } from '../src/run.ts';
import type { SearchTarget } from '../src/filters.ts';
import { SourceError, type Job, type JobSource, type SearchPage } from '../src/sources/types.ts';
import { TelegramError, type TelegramSender } from '../src/telegram.ts';

const filter = (name: string, q: string, extra = ''): FilterDef => {
  const url = `https://www.upwork.com/nx/search/jobs?q=${encodeURIComponent(q)}&sort=recency${extra}`;
  const p = parseUpworkSearchUrl(url);
  if (!p.ok) throw new Error(p.error);
  return { name, url, enabled: true, criteria: p.criteria, params: p.params };
};

const job = (id: string, title: string, over: Partial<Job> = {}): Job => ({
  id,
  title,
  url: `https://www.upwork.com/jobs/${id}`,
  description: 'desc',
  postedAt: '2026-10-25T10:00:00.000Z',
  contractType: 'FIXED',
  fixedBudget: 3000,
  hourlyMin: null,
  hourlyMax: null,
  currency: 'USD',
  budgetLabel: null,
  skills: [],
  ...over,
});

/** Fake source: a keyword-filtered market, optional scripted errors, paging. */
class FakeSource implements JobSource {
  readonly name = 'upwork-mcp' as const;
  market: Job[] = [];
  errors: SourceError[] = [];
  calls = 0;
  targets: string[] = [];
  ignored: string[] = [];
  describeMapping() {
    return { applied: [], notApplied: [] };
  }
  async search(f: FilterDef, cursor: string | null, pageSize: number, target: SearchTarget = {}): Promise<SearchPage> {
    this.calls++;
    this.targets.push(JSON.stringify(target));
    const e = this.errors.shift();
    if (e) throw e;
    const kw = (f.criteria.keyword ?? '').toLowerCase().split(' ');
    const all = this.market.filter((j) => kw.every((w) => j.title.toLowerCase().includes(w)));
    const off = Number(cursor ?? 0);
    const page = all.slice(off, off + pageSize);
    return { jobs: page, nextCursor: off + pageSize < all.length ? String(off + pageSize) : null, ignoredFilters: this.ignored, emptyReason: null, invalidRecords: 0 };
  }
  async close() {}
}

function recorder(script: ('ok' | 'temporary' | 'permanent')[] = []) {
  const sent: { chat: string; text: string }[] = [];
  let i = 0;
  const sender: TelegramSender = {
    async send(chat, text) {
      const b = script[i++] ?? 'ok';
      if (b === 'temporary') throw new TelegramError('temporary', 'Telegram server error');
      if (b === 'permanent') throw new TelegramError('permanent', 'chat not found');
      sent.push({ chat, text });
      return { messageId: String(sent.length) };
    },
  };
  return { sender, sent };
}

function opts(store: Store, source: JobSource, filters: FilterDef[], sender: TelegramSender, over: Partial<RunOptions> = {}): RunOptions {
  return {
    store,
    source,
    filters,
    sender,
    chatIds: ['1001'],
    maxPagesPerFilter: 3,
    pageSize: 50,
    delayBetweenSearchesMs: 0,
    alertOnFirstRun: false,
    descriptionMaxChars: 200,
    retentionDays: 30,
    sleep: async () => undefined,
    ...over,
  };
}

const FILTERS = () => [filter('Full Stack', 'full stack'), filter('React', 'react'), filter('Node', 'node.js'), filter('WordPress', 'wordpress')];

test('first run is a silent baseline; new jobs alert once; reruns never duplicate', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  src.market = [job('a', 'Full stack developer')];
  const tg = recorder();
  const r1 = await runSearch(opts(store, src, FILTERS(), tg.sender));
  assert.equal(r1.status, 'ok');
  assert.equal(r1.newJobs, 1);
  assert.equal(tg.sent.length, 0);

  src.market.unshift(job('b', 'Full stack developer for SaaS'));
  const r2 = await runSearch(opts(store, src, FILTERS(), tg.sender));
  assert.equal(r2.alertsQueued, 1);
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0]!.text, /Full stack developer for SaaS/);

  for (let i = 0; i < 3; i++) await runSearch(opts(store, src, FILTERS(), tg.sender));
  assert.equal(tg.sent.length, 1);
});

test('one job matching three of ten filters sends ONE alert naming all three', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  const ten = [...FILTERS(), ...['python', 'flutter', 'swift', 'laravel', 'django', 'unity'].map((q) => filter(q, q))];
  await runSearch(opts(store, src, ten, recorder().sender));
  src.market = [job('m', 'Full stack developer React Node.js', { skills: ['React', 'Node.js'] })];
  const tg = recorder();
  const r = await runSearch(opts(store, src, ten, tg.sender));
  assert.equal(r.alertsQueued, 1);
  assert.equal(tg.sent.length, 1);
  for (const n of ['Full Stack', 'React', 'Node']) assert.match(tg.sent[0]!.text, new RegExp(`• ${n}`));
  assert.doesNotMatch(tg.sent[0]!.text, /• WordPress/);
});

test('respects filter boundaries locally even when the server returns the job', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  const f = [filter('Full Stack', 'full stack', '&amount=1500-500000&t=1')];
  await runSearch(opts(store, src, f, recorder().sender));
  src.market = [job('cheap', 'Full stack developer', { fixedBudget: 1499 }), job('ok', 'Full stack developer', { fixedBudget: 1500 })];
  const tg = recorder();
  const r = await runSearch(opts(store, src, f, tg.sender));
  assert.equal(r.filters[0]!.rejectedLocally, 1);
  assert.equal(tg.sent.length, 1);
});

test('a temporary Telegram failure is retried by a later run (survives restarts)', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  await runSearch(opts(store, src, FILTERS(), recorder().sender));
  src.market = [job('x', 'React developer')];
  const failing = recorder(['temporary']);
  const r1 = await runSearch(opts(store, src, FILTERS(), failing.sender));
  assert.equal(r1.delivery.retrying, 1);
  assert.equal(store.pendingCount(), 1);
  // Make the retry due now, as if time passed / the app restarted.
  store.db.exec("UPDATE outbox SET next_attempt_at = '2000-01-01T00:00:00Z'");
  const ok = recorder();
  const r2 = await runSearch(opts(store, src, FILTERS(), ok.sender));
  assert.equal(r2.recoveredFromPreviousRun, 1);
  assert.equal(ok.sent.length, 1);
  assert.equal(store.pendingCount(), 0);
});

test('a permanent Telegram failure is recorded and not retried', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  await runSearch(opts(store, src, FILTERS(), recorder().sender));
  src.market = [job('y', 'React developer')];
  const r = await runSearch(opts(store, src, FILTERS(), recorder(['permanent']).sender));
  assert.equal(r.delivery.failed, 1);
  assert.equal(store.stats().alertsFailed, 1);
});

test('honours retry_after, retries transient errors, then succeeds', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  src.errors = [new SourceError('rate_limited', 'slow down', { retryAfterSeconds: 7 }), new SourceError('temporary', 'blip')];
  const waits: number[] = [];
  const r = await runSearch(opts(store, src, [filter('React', 'react')], recorder().sender, { sleep: async (ms) => void waits.push(ms) }));
  assert.equal(r.status, 'ok');
  assert.ok(waits[0]! >= 7000, `waited ${waits[0]}ms`);
  assert.equal(src.calls, 3);
});

test('a long retry_after or an authorization failure stops the run without hammering', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  src.errors = [new SourceError('rate_limited', 'quota', { retryAfterSeconds: 3600 })];
  const r = await runSearch(opts(store, src, FILTERS(), recorder().sender));
  assert.equal(r.status, 'failed');
  assert.match(r.stoppedEarly ?? '', /3600s/);
  assert.equal(src.calls, 1);

  const src2 = new FakeSource();
  src2.errors = [new SourceError('auth', 'Run npm run connect')];
  const r2 = await runSearch(opts(store, src2, FILTERS(), recorder().sender));
  assert.match(r2.stoppedEarly ?? '', /connect/);
  assert.equal(src2.calls, 1);
});

test('a failing filter does not block the others and keeps its baseline pending', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  src.errors = [new SourceError('permanent', 'bad params')];
  const r = await runSearch(opts(store, src, FILTERS(), recorder().sender));
  assert.equal(r.status, 'partial');
  assert.equal(store.baselineDone('upwork-mcp', 'Full Stack'), false);
  assert.equal(store.baselineDone('upwork-mcp', 'React'), true);
});

test('pagination stops at the page limit and reports partial coverage', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  src.market = Array.from({ length: 12 }, (_, i) => job(`p${i}`, 'React developer'));
  const r = await runSearch(opts(store, src, [filter('React', 'react')], recorder().sender, { pageSize: 5, maxPagesPerFilter: 2 }));
  assert.equal(r.filters[0]!.pages, 2);
  assert.equal(r.filters[0]!.returned, 10);
  assert.equal(r.filters[0]!.moreResultsNotFetched, true);
});

test('surfaces filters the server ignored', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  src.ignored = ['hourly_rate'];
  const r = await runSearch(opts(store, src, [filter('React', 'react')], recorder().sender));
  assert.deepEqual(r.filters[0]!.ignoredFilters, ['hourly_rate']);
});

test('a second concurrent run is refused; a crashed run is recovered', async () => {
  const store = new Store(':memory:');
  assert.ok(store.acquireLock('run', 'other-process', 60_000));
  const r = await runSearch(opts(store, new FakeSource(), FILTERS(), recorder().sender));
  assert.equal(r.status, 'locked');
  store.releaseLock('run', 'other-process');

  store.startRun('upwork-mcp'); // left "running" by a crash
  await runSearch(opts(store, new FakeSource(), FILTERS(), recorder().sender));
  const statuses = (store.stats().lastRuns as { status: string }[]).map((x) => x.status);
  assert.ok(statuses.includes('interrupted'));
});

test('without TELEGRAM_CHAT_ID jobs are recorded but nothing is queued', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  src.market = [job('z', 'React developer')];
  const r = await runSearch(opts(store, src, FILTERS(), recorder().sender, { chatIds: [], alertOnFirstRun: true }));
  assert.equal(r.newJobs, 1);
  assert.equal(r.alertsQueued, 0);
});

test('first run pages deeper; later runs stop at the first page with nothing new', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  src.market = Array.from({ length: 9 }, (_, i) => job(`p${i}`, `React developer ${i}`));
  const f = [filter('React', 'react')];
  const r1 = await runSearch(opts(store, src, f, recorder().sender, { pageSize: 2, maxPagesPerFilter: 1, firstRunMaxPages: 3 }));
  assert.equal(src.calls, 3);
  assert.equal(r1.newJobs, 6);
  assert.equal(r1.filters[0]!.moreResultsNotFetched, true);

  src.calls = 0;
  src.market.unshift(job('fresh', 'React developer fresh'));
  const r2 = await runSearch(opts(store, src, f, recorder().sender, { pageSize: 2, maxPagesPerFilter: 5, firstRunMaxPages: 3 }));
  // Page 1 = fresh + p0 (one unseen) → page 2 = p1 + p2 (all known) → stop.
  assert.equal(src.calls, 2);
  assert.equal(r2.newJobs, 1);
});

test('a category filter searches every category and subcategory and merges the results', async () => {
  const store = new Store(':memory:');
  const src = new FakeSource();
  src.market = [job('c1', 'Anything')];
  const url = 'https://www.upwork.com/nx/search/jobs?category2_uid=111111,222222&subcategory2_uid=333333&t=1';
  const p = parseUpworkSearchUrl(url);
  if (!p.ok) throw new Error(p.error);
  const r = await runSearch(opts(store, src, [{ name: 'Cats', url, enabled: true, criteria: p.criteria, params: p.params }], recorder().sender));
  assert.deepEqual(src.targets, ['{"category":"111111"}', '{"category":"222222"}', '{"subcategory":"333333"}']);
  assert.equal(r.newJobs, 1);
});

test('the dashboard lists only jobs returned by the configured filters, labelled only with them', () => {
  const store = new Store(':memory:');
  const save = (id: string) =>
    store.saveJobDetails('upwork-mcp', { id, title: id, url: null, budget: '', contractType: null, postedAt: null, snippet: null, skills: [] }, false);
  save('a');
  save('b');
  store.recordMatch('upwork-mcp', 'a', 'AI Developer');
  store.recordMatch('upwork-mcp', 'a', 'Removed filter');
  store.recordMatch('upwork-mcp', 'b', 'Removed filter');
  const jobs = store.listJobs({ filters: ['AI Developer', 'Full Stack Developer'] });
  assert.deepEqual(jobs.map((j) => [j.jobId, j.filters]), [['a', ['AI Developer']]]);
  assert.equal(store.listJobs({ filters: [] }).length, 0);
  assert.equal(store.newJobCount(['AI Developer']), 1);
});
