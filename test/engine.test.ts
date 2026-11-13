import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { CHECK_GAP_MS, checkOneJob, checkRemovedJobs, continueSearch, getCycle, nextDueAt, requestSearch, SOURCE, step, tick, type EngineDeps } from '../src/engine.ts';
import { type FilterDef, type SearchTarget } from '../src/filters.ts';
import { SourceError, type Job, type JobSource, type SearchPage } from '../src/sources/types.ts';

const url = (q: string, extra = '') => `https://www.upwork.com/nx/search/jobs?q=${encodeURIComponent(q)}&sort=recency${extra}`;

const job = (id: string, title: string, over: Partial<Job> = {}): Job => ({
  id,
  title,
  url: `https://www.upwork.com/jobs/~${id}`,
  description: 'desc',
  postedAt: new Date(Date.now() - 3_600_000).toISOString(),
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
  /** Jobs Upwork no longer has (checkJob answers "removed"). */
  gone = new Set<string>();
  checkErrors: SourceError[] = [];
  checked: string[] = [];
  async checkJob(id: string) {
    this.checked.push(id);
    const e = this.checkErrors.shift();
    if (e) throw e;
    return this.gone.has(id) ? { removed: true, reason: 'Job not found' } : { removed: false, reason: null };
  }
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

test('after a long gap between scans, a search reads as deep as a first search so no new posts are skipped', async () => {
  const { src, clock, add, search } = setup({ MAX_PAGES_PER_FILTER: '2', FIRST_RUN_MAX_PAGES: '6' });
  await add('React', 'react');
  src.market = [job('old1', 'React developer o1'), job('old2', 'React developer o2')];
  await search();

  // 8 new posts arrive soon after: a normal search stops at 2 pages (4 jobs) and says more were left.
  src.market.unshift(...Array.from({ length: 8 }, (_, i) => job(`a${i}`, `React developer a${i}`)));
  src.calls = 0;
  const normal = await search();
  assert.equal(src.calls, 2);
  assert.equal(normal?.newJobs, 4);
  assert.equal(normal?.filters[0]?.moreResultsNotFetched, true);

  // 8 more arrive while the scheduler is silent for 3 hours: the catch-up search pages on until a known page.
  clock.t += 3 * 3_600_000;
  src.market.unshift(...Array.from({ length: 8 }, (_, i) => job(`b${i}`, `React developer b${i}`)));
  src.calls = 0;
  const caught = await search();
  assert.equal(caught?.filters[0]?.catchUp, true);
  // All 8 (a normal search would stop at 4); paging ends at the first page it already knows.
  assert.equal(src.calls, 5);
  assert.equal(caught?.newJobs, 8);
  assert.equal(caught?.filters[0]?.moreResultsNotFetched, false);
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

test('each filter has its own schedule: searching one by hand never delays the others', async () => {
  const { store, src, clock, deps, add, search } = setup({ SEARCH_INTERVAL_MINUTES: '30' });
  await add('React', 'react');
  await add('Node', 'node');
  src.market = [job('r', 'React developer'), job('n', 'Node developer')];
  const t0 = clock.t;
  const first = await tick(deps);
  assert.equal(first.status, 'finished');
  if (first.status === 'finished') assert.deepEqual(first.summary.filters.map((f) => f.name), ['React', 'Node']);

  clock.t = t0 + 20 * 60_000;
  await search('React');
  const last = await store.filterLastSearches();
  assert.equal(last.get('React')?.startedAt, new Date(t0 + 20 * 60_000).toISOString());
  assert.equal(last.get('Node')?.startedAt, new Date(t0).toISOString());

  clock.t = t0 + 29 * 60_000;
  const nodeDue = await tick(deps);
  assert.equal(nodeDue.status, 'finished', 'Node is still searched 30 min after its own last search');
  if (nodeDue.status === 'finished') assert.deepEqual(nodeDue.summary.filters.map((f) => f.name), ['Node']);
  assert.equal((await tick(deps)).status, 'idle', 'React is not due yet');

  clock.t = t0 + 49 * 60_000;
  const reactDue = await tick(deps);
  if (reactDue.status !== 'finished') assert.fail(`expected finished, got ${reactDue.status}`);
  assert.deepEqual(reactDue.summary.filters.map((f) => f.name), ['React']);
  assert.equal(await nextDueAt(deps), new Date(t0 + 59 * 60_000).toISOString(), 'next: Node, 30 min after it started at +29');
});

test('a failed search still sets the next due time, so it is not retried on every call', async () => {
  const { store, src, deps, add } = setup();
  await add('React', 'react');
  src.errors = [new SourceError('auth', 'Upwork authorization expired.')];
  assert.equal((await tick(deps)).status, 'finished');
  assert.equal((await store.filterLastSearches()).get('React')?.status, 'failed');
  assert.equal((await tick(deps)).status, 'idle');
  assert.equal(src.calls, 1);
});

test('continueSearch finishes a long search in one go, within its time budget', async () => {
  const { store, src, clock, deps, add } = setup({ FIRST_RUN_MAX_PAGES: '10', STEP_BUDGET_SECONDS: '5' });
  await add('React', 'react');
  src.market = Array.from({ length: 20 }, (_, i) => job(`r${i}`, `React developer ${i}`));
  const first = await tick(deps);
  assert.equal(first.status, 'continued', 'one scheduler call alone cannot finish it');
  const start = clock.t;
  const r = await continueSearch(deps, 230_000);
  assert.equal(r?.status, 'finished');
  assert.ok(clock.t - start <= 230_000);
  assert.equal((await store.listJobs({ filters: ['React'] })).length, 20);
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

test('jobs of any age are fetched: old posts are stored and paging continues past them', async () => {
  const { store, src, deps, add } = setup({ FIRST_RUN_MAX_PAGES: '10' });
  await add('React', 'react');
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  src.market = [
    job('fresh1', 'React fresh 1', { postedAt: daysAgo(0.5) }),
    job('fresh2', 'React fresh 2', { postedAt: daysAgo(2.5) }),
    job('old1', 'React old 1', { postedAt: daysAgo(4) }),
    job('old2', 'React old 2', { postedAt: daysAgo(5) }),
    job('old3', 'React old 3', { postedAt: daysAgo(6) }),
    job('old4', 'React old 4', { postedAt: daysAgo(7) }),
  ];
  await requestSearch(store, null);
  assert.equal((await step(deps, 60_000)).status, 'finished');
  assert.deepEqual((await store.listJobs({ filters: ['React'] })).map((j) => j.jobId).sort(), ['fresh1', 'fresh2', 'old1', 'old2', 'old3', 'old4']);
  assert.equal(src.calls, 3, 'every page is read, old posts included');
});

test('a deleted job is removed and never added back by a later search', async () => {
  const { store, src, deps, add } = setup();
  await add('React', 'react');
  src.market = [job('r1', 'React one'), job('r2', 'React two')];
  await requestSearch(store, null);
  await step(deps, 60_000);
  assert.equal(await store.deleteJob(SOURCE, 'r1'), true);
  assert.equal(await store.deleteJob(SOURCE, 'r1'), false, 'already gone');
  await requestSearch(store, null);
  await step(deps, 60_000);
  assert.deepEqual((await store.listJobs({ filters: ['React'] })).map((j) => j.jobId), ['r2']);
});

test('nothing is ever cleared automatically: year-old jobs, counts, history and deleted ids survive searches (RETENTION_DAYS is ignored)', async () => {
  const { store, src, add, search } = setup({ RETENTION_DAYS: '30', MAX_JOB_AGE_DAYS: '3' }) /* both ignored now */;
  await add('React', 'react');
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  // Rows written a year ago (as an older version of the app would have left them).
  await store.importRows('job_details', [
    { source: SOURCE, job_id: 'old', title: 'React old', skills: '[]', posted_at: old, review_state: 'new', baseline: 0, first_seen_at: old, last_seen_at: old },
    { source: SOURCE, job_id: 'oldSaved', title: 'React old saved', skills: '[]', posted_at: old, review_state: 'saved', baseline: 0, first_seen_at: old, last_seen_at: old },
  ]);
  await store.importRows('seen_jobs', [{ source: SOURCE, job_id: 'old', first_seen_at: old, last_seen_at: old }]);
  await store.importRows('job_matches', [
    { source: SOURCE, job_id: 'old', filter_name: 'React', matched_at: old },
    { source: SOURCE, job_id: 'oldSaved', filter_name: 'React', matched_at: old },
  ]);
  await store.importRows('job_posts', [{ source: SOURCE, job_id: 'old', filter_name: 'React', posted_at: old, found_at: old }]);
  await store.importRows('deleted_jobs', [{ source: SOURCE, job_id: 'gone', deleted_at: old }]);
  await store.importRows('scan_log', [{ run_id: 1, filter_name: 'React', trigger: 'scheduler', started_at: old, finished_at: old, status: 'ok' }]);

  src.market = [job('fresh', 'React fresh'), job('gone', 'React gone')];
  await search();
  await search();

  assert.deepEqual((await store.listJobs({ filters: ['React'] })).map((j) => j.jobId).sort(), ['fresh', 'old', 'oldSaved']);
  assert.equal((await store.exportTable('seen_jobs')).some((r) => r.job_id === 'old'), true);
  assert.equal((await store.exportTable('job_posts')).some((r) => r.job_id === 'old'), true);
  assert.equal((await store.exportTable('scan_log')).some((r) => r.started_at === old), true);
  assert.deepEqual([...(await store.deletedIds(SOURCE, ['gone']))], ['gone'], 'a job you deleted stays deleted, and is never fetched again');
});

test('a job is only removed when you delete it', async () => {
  const { store, src, add, search } = setup();
  await add('React', 'react');
  src.market = [job('r1', 'React one'), job('r2', 'React two')];
  await search();
  assert.equal(await store.deleteJob(SOURCE, 'r1'), true);
  assert.deepEqual((await store.listJobs({ filters: ['React'] })).map((j) => j.jobId), ['r2']);
});

test('the same job found again and again is stored once', async () => {
  const { store, src, add, search } = setup();
  await add('React', 'react');
  src.market = [job('r1', 'React one')];
  await search();
  await search();
  src.market = [job('r1', 'React one (edited title)')];
  await search();
  const jobs = await store.listJobs({ filters: ['React'] });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.title, 'React one (edited title)', 'fields are refreshed in place');
  assert.equal(await store.seenCount(), 1);
});

test('jobs removed from Upwork are marked, kept and listed; finding one again clears the mark', async () => {
  const { store, src, clock, deps, add, search } = setup();
  await add('React', 'react');
  src.market = [job('r1', 'React one'), job('r2', 'React two'), job('r3', 'React three')];
  await search();
  // Just found: not due for a check yet.
  assert.equal(await checkRemovedJobs(deps, 60_000), null);
  assert.deepEqual(src.checked, []);

  src.market = [job('r1', 'React one'), job('r3', 'React three')];
  src.gone.add('r2');
  clock.t += 25 * 3_600_000;
  const r = await checkRemovedJobs(deps, 60_000);
  assert.deepEqual(r, { checked: 3, removed: 1, stopped: null });
  const jobs = await store.listJobs({ filters: ['React'] });
  assert.equal(jobs.length, 3, 'a removed job is still listed');
  const r2 = jobs.find((j) => j.jobId === 'r2')!;
  assert.ok(r2.removedAt);
  assert.equal(r2.removedReason, 'Job not found');
  assert.ok(jobs.every((j) => j.checkedAt));
  assert.equal(await store.removedCount(['React']), 1);

  // One round per CHECK_GAP_MS at most.
  assert.equal(await checkRemovedJobs(deps, 60_000), null);

  assert.equal((await store.listJobs({ filters: ['React'] })).length, 3);

  // A search returns it again: it is on Upwork after all.
  src.market = [job('r2', 'React two')];
  await search();
  assert.equal((await store.listJobs({ filters: ['React'] })).find((j) => j.jobId === 'r2')!.removedAt, null);
  assert.equal(await store.removedCount(['React']), 0);
});

test('removal checks: unclear answers mark nothing, a sign-in problem stops the round, only the scheduler checks', async () => {
  const { store, src, clock, deps, add, search } = setup({ REMOVAL_CHECK_BATCH: '3' });
  await add('React', 'react');
  src.market = [job('r1', 'React one'), job('r2', 'React two'), job('r3', 'React three')];
  await search();
  src.gone.add('r1').add('r2').add('r3');
  clock.t += 25 * 3_600_000;

  // The dashboard's own calls never run checks (a search is due here, and runs instead).
  await tick(deps, 60_000, 'dashboard');
  assert.deepEqual(src.checked, []);

  src.checkErrors = [new SourceError('temporary', 'boom'), new SourceError('auth', 'Upwork sign-in expired')];
  const r = await checkRemovedJobs(deps, 60_000);
  assert.equal(r?.checked, 0);
  assert.equal(r?.stopped, 'Upwork sign-in expired');
  assert.equal(await store.removedCount(['React']), 0, 'nothing marked from an error');

  // The "Check on Upwork" button checks one job at once, gap or not.
  assert.deepEqual(await checkOneJob(deps, SOURCE, 'r3'), { removed: true, reason: 'Job not found' });
  assert.equal(await checkOneJob(deps, SOURCE, 'nope'), null);
  assert.equal(await store.removedCount(['React']), 1);
  assert.ok(CHECK_GAP_MS >= 60_000);
});

test('REMOVAL_CHECK_BATCH=0 turns the checks off', async () => {
  const { src, clock, deps, add, search } = setup({ REMOVAL_CHECK_BATCH: '0' });
  await add('React', 'react');
  src.market = [job('r1', 'React one')];
  await search();
  clock.t += 25 * 3_600_000;
  assert.equal(await checkRemovedJobs(deps, 60_000), null);
  assert.deepEqual(src.checked, []);
});
