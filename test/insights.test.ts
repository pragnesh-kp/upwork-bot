import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { requestSearch, SOURCE, step, type EngineDeps } from '../src/engine.ts';
import { buildInsights, localDay, localDayStart, timetable, type ScanStatusRow } from '../src/insights.ts';
import type { JobSource, SearchPage } from '../src/sources/types.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-29T00:00:00.000Z');
const scan = (atMin: number, outcome: ScanStatusRow['outcome'] = 'ok'): ScanStatusRow => ({
  id: atMin,
  runId: atMin,
  filter: 'A',
  trigger: 'scheduler',
  startedAt: new Date(T0 + atMin * MIN).toISOString(),
  finishedAt: outcome === 'running' || outcome === 'interrupted' ? null : new Date(T0 + (atMin + 1) * MIN).toISOString(),
  status: outcome === 'interrupted' ? 'running' : outcome,
  pages: 2,
  returned: 20,
  accepted: 10,
  newJobs: 1,
  moreNotFetched: false,
  error: outcome === 'failed' ? 'boom' : null,
  outcome,
});
const opts = (nowMin: number) => ({ intervalMs: 30 * MIN, graceMs: 10 * MIN, now: T0 + nowMin * MIN });

test('timetable: on time, delayed, missed and pending slots', () => {
  // Scans at 0, 30 (on time), 75 (due 60: 15 min late → delayed), 200 (due 105, 135, 165 missed; due 195 → on time).
  const slots = timetable([scan(0), scan(30), scan(75), scan(200)], opts(215));
  assert.deepEqual(
    slots.map((s) => s.status),
    ['completed', 'completed', 'delayed', 'missed', 'missed', 'missed', 'completed', 'pending'],
  );
  assert.equal(slots[2]!.delayMs, 15 * MIN);
  assert.equal(slots.at(-1)!.dueAt, new Date(T0 + 230 * MIN).toISOString());
  assert.equal(slots.at(-1)!.late, false);
});

test('timetable: no scan for a long time means missed slots up to now, then a late pending one', () => {
  const slots = timetable([scan(0)], opts(100));
  // Due 30 and 60 have passed whole windows; due 90 is the current slot, 10 min overdue (= grace, not late yet).
  assert.deepEqual(slots.map((s) => s.status), ['completed', 'missed', 'missed', 'pending']);
  assert.equal(timetable([scan(0)], opts(105)).at(-1)!.late, true);
});

test('timetable: failed and cut-off scans are failed; a running scan has no pending slot after it', () => {
  assert.deepEqual(timetable([scan(0), scan(30, 'failed'), scan(60, 'interrupted')], opts(70)).map((s) => s.status), ['completed', 'failed', 'failed', 'pending']);
  assert.deepEqual(timetable([scan(0), scan(30, 'running')], opts(31)).map((s) => s.status), ['completed', 'running']);
});

test('timetable: an early manual scan is on time and resets the timetable', () => {
  const slots = timetable([scan(0), scan(10), scan(40)], opts(45));
  assert.deepEqual(slots.map((s) => s.status), ['completed', 'completed', 'completed', 'pending']);
});

test('local days follow the viewer time zone', () => {
  assert.equal(localDay(Date.parse('2026-10-29T20:00:00Z'), 330), '2026-10-30'); // 01:30 in India
  assert.equal(new Date(localDayStart('2026-10-30', 330)).toISOString(), '2026-10-29T18:30:00.000Z');
});

class OnePage implements JobSource {
  readonly name = 'upwork-mcp' as const;
  ids: string[];
  constructor(ids: string[]) {
    this.ids = ids;
  }
  describeMapping() {
    return { applied: [], notApplied: [] };
  }
  async search(): Promise<SearchPage> {
    const postedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    return {
      jobs: this.ids.map((id) => ({ id, title: `Job ${id}`, url: null, description: null, postedAt, contractType: 'FIXED', fixedBudget: 5000, hourlyMin: null, hourlyMax: null, currency: 'USD', budgetLabel: null, skills: [] })),
      nextCursor: null,
      ignoredFilters: [],
      emptyReason: null,
      invalidRecords: 0,
    };
  }
  async close() {}
}

test('insights: scans and daily job counts are recorded and survive deleting a job', async () => {
  const store = Store.open(':memory:');
  const cfg = loadConfig({ TURSO_DATABASE_URL: 'file::memory:', DELAY_BETWEEN_SEARCHES_MS: '0' } as NodeJS.ProcessEnv);
  await store.addFilter({ name: 'A', url: 'https://www.upwork.com/nx/search/jobs?q=node', enabled: true });
  await store.addFilter({ name: 'B', url: 'https://www.upwork.com/nx/search/jobs?q=react', enabled: true });
  const src = new OnePage(['1', '2']);
  const deps: EngineDeps = { store, cfg, openSource: async () => src, sleep: async () => {} };
  await requestSearch(store, null, 'scheduler');
  assert.equal((await step(deps, 20_000)).status, 'finished');
  await store.deleteJob(SOURCE, '1');

  const ins = await buildInsights(deps, { day: null, tzOffsetMinutes: 330, days: 7 });
  assert.equal(ins.jobs.last24h.total, 2, 'distinct jobs across filters, deleted one still counted');
  assert.deepEqual(ins.jobs.last24h.byFilter, { A: 2, B: 2 });
  assert.equal(ins.jobs.posted.length, 7);
  assert.equal(ins.jobs.posted.at(-1)!.total + ins.jobs.posted.at(-2)!.total, 2);
  assert.equal(ins.scans.runs.length, 1);
  assert.equal(ins.scans.runs[0]!.trigger, 'scheduler');
  assert.equal(ins.scans.runs[0]!.status, 'ok');
  assert.deepEqual(ins.scans.runs[0]!.filters.map((f) => f.name).sort(), ['A', 'B']);
  assert.equal(ins.timetable.counts.completed, 2);
  assert.equal(ins.timetable.counts.pending, 2);
  store.close();
});
