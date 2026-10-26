import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { getCycle, requestSearch, SOURCE, step, tick, type EngineDeps } from '../src/engine.ts';
import { type FilterDef, type SearchTarget } from '../src/filters.ts';
import { SourceError, type Job, type JobSource, type SearchPage } from '../src/sources/types.ts';

const url = (q: string, extra = '') => `https://www.upwork.com/nx/search/jobs?q=${encodeURIComponent(q)}&sort=recency${extra}`;

const job = (id: string, title: string, over: Partial<Job> = {}): Job => ({
  id,
  title,
  url: `https://www.upwork.com/jobs/~${id}`,
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
    const kw = (f.criteria.keyword ?? '').toLowerCase().split(' ').filter(Boolean);
    const all = this.market.filter((j) => kw.every((w) => j.title.toLowerCase().includes(w)));
    const off = Number(cursor ?? 0);
    const page = all.slice(off, off + pageSize);
    return { jobs: page, nextCursor: off + pageSize < all.length ? String(off + pageSize) : null, ignoredFilters: this.ignored, emptyReason: null, invalidRecords: 0 };
  }
  async close() {}
}

/** A clock that only moves when the engine sleeps, so time budgets are exact. */
function setup(env: Record<string, string> = {}) {
  const store = Store.open(':memory:');
  const src = new FakeSource();
  // Starts at the real time: the database stamps runs with the real clock.
  const clock = { t: Date.now() };
  const cfg: Config = loadConfig({ DATA_DIR: 'data', TURSO_DATABASE_URL: 'file::memory:', DELAY_BETWEEN_SEARCHES_MS: '1000', PAGE_SIZE: '2', ...env } as NodeJS.ProcessEnv);
  const deps: EngineDeps = { store, cfg, openSource: async () => src, sleep: async (ms) => void (clock.t += ms), now: () => clock.t };
  const add = (name: string, q: string, extra = '') => store.addFilter({ name, url: url(q, extra), enabled: true });
  /** Runs steps until the search finishes (like the scheduler / the open page would). */
  const runAll = async (budgetMs = 60_000) => {
    for (let i = 0; i < 50; i++) {
      const r = await step(deps, budgetMs);
      if (r.status === 'finished') return r.summary;
      if (r.status === 'idle') return null;
      if (r.status === 'waiting') clock.t += 60_000;
    }
    throw new Error('search never finished');
  };
  const search = async (filter: string | null = null, budgetMs?: number) => {
    await requestSearch(store, filter);
    return runAll(budgetMs);
  };
  return { store, src, clock, cfg, deps, add, runAll, search };
}

test('first search records jobs; later searches add only new ones; nothing is ever duplicated', async () => {
  const { store, src, add, search } = setup();
  await add('Full Stack', 'full stack');
  src.market = [job('a', 'Full stack developer')];
  const r1 = await search();
  assert.equal(r1?.status, 'ok');
  assert.equal(r1?.newJobs, 1);
  assert.equal(r1?.filters[0]?.firstRun, true);

  src.market.unshift(job('b', 'Full stack developer for SaaS'));
  const r2 = await search();
  assert.equal(r2?.newJobs, 1);
  assert.equal(r2?.filters[0]?.firstRun, false);
  for (let i = 0; i < 3; i++) assert.equal((await search())?.newJobs, 0);

  const jobs = await store.listJobs({ filters: ['Full Stack'] });
  assert.deepEqual(jobs.map((j) => [j.jobId, j.baseline]).sort(), [['a', true], ['b', false]], 'first-search jobs are marked as found before the filter existed');
});

test('a job returned by several filters is one dashboard entry naming all of them', async () => {
  const { store, src, add, search } = setup();
  await add('React', 'react');
  await add('Node', 'node');
  await add('WordPress', 'wordpress');
  src.market = [job('x', 'React and Node developer')];
  await search();
  const jobs = await store.listJobs({ filters: ['React', 'Node', 'WordPress'] });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0]!.filters.sort(), ['Node', 'React']);
});

test('budget, rate and contract type are re-checked locally', async () => {
  const { store, src, add, search } = setup();
  await add('Big fixed', 'dev', '&amount=1500-500000&t=1');
  src.market = [job('cheap', 'dev', { fixedBudget: 500 }), job('ok', 'dev', { fixedBudget: 1500 }), job('hourly', 'dev', { contractType: 'HOURLY', fixedBudget: null, hourlyMin: 20, hourlyMax: 40 })];
  const r = await search();
  assert.equal(r?.filters[0]?.rejectedLocally, 2);
  assert.deepEqual((await store.listJobs({ filters: ['Big fixed'] })).map((j) => j.jobId), ['ok']);
});

test('honours retry_after, retries transient errors, then succeeds', async () => {
  const { src, clock, add, search } = setup();
  await add('React', 'react');
  src.market = [job('r', 'React developer')];
  src.errors = [new SourceError('rate_limited', 'slow down', { retryAfterSeconds: 7 }), new SourceError('temporary', 'blip')];
  const start = clock.t;
  const r = await search();
  assert.equal(r?.status, 'ok');
  assert.ok(clock.t - start >= 7000, 'waited at least the server-requested 7 s');
  assert.equal(src.calls, 3);
});

test('a wait longer than the time budget is carried over to a later call instead of hammering', async () => {
  const { store, src, clock, deps, add } = setup();
  await add('React', 'react');
  src.market = [job('r', 'React developer')];
  src.errors = [new SourceError('rate_limited', 'quota', { retryAfterSeconds: 600 })];
  await requestSearch(store, null);
  const first = await step(deps, 60_000);
  assert.equal(first.status, 'waiting');
  assert.equal(src.calls, 1);
  assert.equal((await step(deps, 60_000)).status, 'waiting', 'no search before the requested time');
  assert.equal(src.calls, 1);
  clock.t += 601_000;
  const done = await step(deps, 60_000);
  assert.equal(done.status, 'finished');
  assert.equal(src.calls, 2);
});

test('an authorization failure ends the search after one call and says why', async () => {
  const { src, add, search } = setup();
  await add('React', 'react');
  await add('Node', 'node');
  src.errors = [new SourceError('auth', 'Upwork authorization expired. Run "npm run connect".')];
  const r = await search();
  assert.match(r?.stoppedEarly ?? '', /connect/);
  assert.equal(src.calls, 1);
  assert.notEqual(r?.status, 'ok');
});

test('a failing filter does not block the others and keeps its first-search status', async () => {
  const { store, src, add, search } = setup();
  await add('Broken', 'broken');
  await add('React', 'react');
  src.market = [job('r', 'React developer')];
  src.errors = [new SourceError('permanent', 'bad params')];
  const r = await search();
  assert.equal(r?.status, 'partial');
  assert.equal(r?.filters.find((f) => f.name === 'Broken')?.error, 'bad params');
  assert.equal(await store.baselineDone(SOURCE, 'Broken'), false);
  assert.equal(await store.baselineDone(SOURCE, 'React'), true);
});

test('first search pages deeper; later searches stop after 2 pages with nothing new', async () => {
  const { src, add, search } = setup({ MAX_PAGES_PER_FILTER: '5', FIRST_RUN_MAX_PAGES: '3' });
  await add('React', 'react');
  src.market = Array.from({ length: 9 }, (_, i) => job(`p${i}`, `React developer ${i}`));
  const r1 = await search();
  assert.equal(src.calls, 3);
  assert.equal(r1?.newJobs, 6);
  assert.equal(r1?.filters[0]?.moreResultsNotFetched, true);

  src.calls = 0;
  src.market.unshift(job('fresh', 'React developer fresh'));
  const r2 = await search();
  // Page 1 = fresh + p0 (one new) → page 2 = p1 + p2 (all known) → stop.
  assert.equal(src.calls, 2);
  assert.equal(r2?.newJobs, 1);
});

test('a category filter searches every category and subcategory and merges the results', async () => {
  const { store, src, search } = setup();
  await store.addFilter({ name: 'Cats', url: 'https://www.upwork.com/nx/search/jobs?category2_uid=111111,222222&subcategory2_uid=333333&t=1', enabled: true });
  src.market = [job('c1', 'Anything')];
  const r = await search();
  assert.deepEqual(src.targets, ['{"category":"111111"}', '{"category":"222222"}', '{"subcategory":"333333"}']);
  assert.equal(r?.newJobs, 1);
});

test('a search cut off by the time budget resumes on the next call and finishes with the same result', async () => {
  const { store, src, deps, add } = setup({ FIRST_RUN_MAX_PAGES: '10' });
  await add('React', 'react');
  src.market = Array.from({ length: 12 }, (_, i) => job(`r${i}`, `React developer ${i}`));
  await requestSearch(store, null);
  // 1 s between searches and a 2.5 s budget: about three pages per call.
  const first = await step(deps, 2500);
  assert.equal(first.status, 'continued');
  assert.ok((await getCycle(store))!.tasks[0]!.pages >= 1, 'progress was saved');
  let r: Awaited<ReturnType<typeof step>> = first;
  for (let i = 0; i < 10 && r.status !== 'finished'; i++) r = await step(deps, 2500);
  assert.equal(r.status, 'finished');
  assert.equal(src.calls, 6, 'every page fetched exactly once across calls');
  assert.equal((await store.listJobs({ filters: ['React'] })).length, 12);
  assert.equal(await getCycle(store), null);
});

test('only one search runs at a time; requests made meanwhile are added to the running search', async () => {
  const { store, src, deps, add } = setup();
  await add('React', 'react');
  src.market = [...Array.from({ length: 6 }, (_, i) => job(`r${i}`, `React developer ${i}`)), job('n', 'Node developer')];
  assert.equal(await store.acquireLock('search', 'someone-else', 60_000), true);
  await requestSearch(store, null);
  assert.equal((await step(deps, 60_000)).status, 'busy');
  await store.releaseLock('search', 'someone-else');

  // A filter added while a search is running joins that search.
  const first = await step(deps, 0);
  assert.equal(first.status, 'continued');
  await add('Node', 'node');
  await requestSearch(store, 'Node');
  const r = await step(deps, 60_000);
  assert.equal(r.status, 'finished');
  if (r.status === 'finished') assert.deepEqual(r.summary.filters.map((f) => f.name), ['React', 'Node']);
});

test('the scheduler starts a search when one is due and does nothing otherwise', async () => {
  const { src, clock, deps, add } = setup({ SEARCH_INTERVAL_MINUTES: '30' });
  await add('React', 'react');
  src.market = [job('r', 'React developer')];
  assert.equal((await tick(deps)).status, 'finished', 'first call: never searched before');
  assert.equal(src.calls, 1);
  clock.t += 10 * 60_000;
  assert.equal((await tick(deps)).status, 'idle', '10 min later: not due');
  assert.equal(src.calls, 1);
  // The last search started at real wall-clock time; the engine's "now" is only used for slack.
  clock.t = Date.now() + 29 * 60_000;
  assert.equal((await tick(deps)).status, 'finished', 'due within the 2-minute slack');
  assert.equal(src.calls, 2);
});

test('the dashboard lists only jobs returned by the configured filters, labelled only with them', async () => {
  const store = Store.open(':memory:');
  const d = (id: string) => ({ id, title: id, url: null, budget: '', contractType: null, postedAt: null, snippet: null, skills: [] });
  await store.saveJobs(SOURCE, 'AI Developer', [{ details: d('a'), baseline: false }]);
  await store.saveJobs(SOURCE, 'Removed filter', [{ details: d('a'), baseline: false }, { details: d('b'), baseline: false }]);
  const jobs = await store.listJobs({ filters: ['AI Developer', 'Full Stack Developer'] });
  assert.deepEqual(jobs.map((j) => [j.jobId, j.filters]), [['a', ['AI Developer']]]);
  assert.equal((await store.listJobs({ filters: [] })).length, 0);
  assert.equal(await store.newJobCount(['AI Developer']), 1);
});
