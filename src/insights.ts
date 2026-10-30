import type { ScanRow } from './db.ts';
import { enabledFilters, getCycle, type EngineDeps } from './engine.ts';

/**
 * The Insights page: jobs posted per day (per filter and combined), the scan history,
 * and a check of every filter's scans against its timetable (one scan every
 * SEARCH_INTERVAL_MINUTES, counted from its previous scan, as the scheduler runs it).
 */

const DAY_MS = 86_400_000;
/** A scan still "running" this long after it started was cut off (e.g. the function was stopped). */
const STALLED_AFTER_MS = 15 * 60_000;
/** Scans before the window that anchor its timetable. */
const ANCHOR_LOOKBACK_MS = 2 * DAY_MS;

export type SlotStatus = 'completed' | 'delayed' | 'missed' | 'failed' | 'pending' | 'running';

export interface Slot {
  /** When this scan was due (ISO). */
  dueAt: string;
  status: SlotStatus;
  /** The scan that served this slot, if one ran. */
  scanAt: string | null;
  /** How much later than due it started (ms), for delayed scans. */
  delayMs: number | null;
  /** A pending slot past its grace time. */
  late?: boolean;
  error?: string | null;
}

export interface ScanStatusRow extends ScanRow {
  /** ok, failed, running, or interrupted (started but never finished). */
  outcome: 'ok' | 'failed' | 'running' | 'interrupted';
}

export interface InsightsQuery {
  /** Local day YYYY-MM-DD, or null for the last 24 hours. */
  day: string | null;
  /** The viewer's UTC offset in minutes (India: 330). */
  tzOffsetMinutes: number;
  /** How many days the daily job comparison covers (ending at the selected day). */
  days: number;
  /** A second local day whose jobs are compared with the selected one. */
  compareDay?: string | null;
  /** A custom first / last local day for the daily job comparison (replaces `days`). */
  trendFrom?: string | null;
  trendTo?: string | null;
}

/** The longest daily job comparison (two months, for month vs month). */
export const MAX_TREND_DAYS = 62;

const iso = (ms: number) => new Date(ms).toISOString();

/** Midnight (UTC ms) of a local day, for a viewer at this UTC offset. */
export function localDayStart(day: string, tzOffsetMinutes: number): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) - tzOffsetMinutes * 60_000;
}

/** The local day (YYYY-MM-DD) a moment falls on. */
export function localDay(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Started but never finished, and not part of the search running now: it was cut off. */
export function scanOutcome(s: ScanRow, activeRunId: number | null, now: number): ScanStatusRow['outcome'] {
  if (s.status === 'ok' || s.status === 'failed') return s.status;
  if (s.runId === activeRunId) return 'running';
  return now - Date.parse(s.startedAt) > STALLED_AFTER_MS ? 'interrupted' : 'running';
}

/**
 * One filter's timetable: after a scan starting at S, the next is due at S + interval.
 * A scan starting within `grace` of its due time is on time (earlier counts too: a
 * manual search resets the timetable, as the scheduler does); later, but before the
 * following slot, it is delayed; a slot with no scan at all is missed. The slot after
 * the latest scan is pending (or running).
 */
export function timetable(scans: ScanStatusRow[], opts: { intervalMs: number; graceMs: number; now: number; createdAt?: string | null }): Slot[] {
  const { intervalMs: I, graceMs: G, now } = opts;
  const slots: Slot[] = [];
  const sorted = [...scans].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const scanStatus = (s: ScanStatusRow, onTime: boolean): SlotStatus =>
    s.outcome === 'failed' || s.outcome === 'interrupted' ? 'failed' : s.outcome === 'running' ? 'running' : onTime ? 'completed' : 'delayed';
  let anchor: number | null = null;
  const pushMissedUntil = (limit: number) => {
    // Every slot whose whole window [due, due + I) passed with no scan; capped so a long outage stays cheap.
    let due = anchor! + I;
    for (let n = 0; due + I <= limit && n < 500; n++, due += I) slots.push({ dueAt: iso(due), status: 'missed', scanAt: null, delayMs: null });
    return due;
  };
  for (const s of sorted) {
    const start = Date.parse(s.startedAt);
    if (anchor === null) {
      // The first scan we know of: nothing was expected of it.
      slots.push({ dueAt: s.startedAt, status: scanStatus(s, true), scanAt: s.startedAt, delayMs: null, error: s.error });
    } else {
      const due = pushMissedUntil(start);
      const late = start - due;
      slots.push({ dueAt: iso(Math.min(due, start)), status: scanStatus(s, late <= G), scanAt: s.startedAt, delayMs: late > G ? late : null, error: s.error });
    }
    anchor = start;
  }
  if (anchor === null) {
    // Never scanned: due since the filter was added.
    const since = opts.createdAt ? Date.parse(opts.createdAt) : now;
    slots.push({ dueAt: iso(Math.min(since, now)), status: 'pending', scanAt: null, delayMs: null, late: now - since > G });
    return slots;
  }
  if (slots.at(-1)!.status !== 'running') {
    const due = pushMissedUntil(now);
    slots.push({ dueAt: iso(due), status: 'pending', scanAt: null, delayMs: null, late: now > due + G });
  }
  return slots;
}

const STATUSES: SlotStatus[] = ['completed', 'delayed', 'missed', 'failed', 'pending', 'running'];
const countSlots = (slots: Slot[]) => Object.fromEntries(STATUSES.map((st) => [st, slots.filter((x) => x.status === st).length])) as Record<SlotStatus, number>;

export async function buildInsights(d: EngineDeps, q: InsightsQuery) {
  const { store, cfg } = d;
  const now = (d.now ?? Date.now)();
  const tz = q.tzOffsetMinutes;
  const intervalMs = cfg.intervalMinutes * 60_000;
  const graceMs = cfg.scanGraceMinutes * 60_000;
  const filters = (await enabledFilters(store)).map((f) => f.name);
  const created = await store.filterCreatedAt();
  const activeRunId = (await getCycle(store))?.runId ?? null;

  // The window: a chosen local day, or the last 24 hours.
  const today = localDay(now, tz);
  const from = q.day ? localDayStart(q.day, tz) : now - DAY_MS;
  const to = q.day ? Math.min(from + DAY_MS, now) : now;
  const isPast = !!q.day && from + DAY_MS <= now;

  // --- jobs posted per day -----------------------------------------------------
  let lastDay = q.day && q.day < today ? q.day : today;
  let dayCount = q.days;
  if (q.trendFrom && q.trendTo) {
    // A custom range: never past today, at most MAX_TREND_DAYS long.
    lastDay = q.trendTo < today ? q.trendTo : today;
    const first = q.trendFrom < lastDay ? q.trendFrom : lastDay;
    dayCount = Math.min(Math.round((localDayStart(lastDay, tz) - localDayStart(first, tz)) / DAY_MS) + 1, MAX_TREND_DAYS);
  }
  const firstDayMs = localDayStart(lastDay, tz) - (dayCount - 1) * DAY_MS;
  const dayKeys = Array.from({ length: dayCount }, (_, i) => localDay(firstDayMs + i * DAY_MS + DAY_MS / 2, tz));
  const tally = (rows: { day: string; filter: string | null; count: number }[]) =>
    dayKeys.map((day) => {
      const byFilter = Object.fromEntries(filters.map((f) => [f, rows.find((r) => r.day === day && r.filter === f)?.count ?? 0]));
      return { day, total: rows.find((r) => r.day === day && r.filter === null)?.count ?? 0, byFilter };
    });
  const posted = tally(await store.jobDayCounts('posted', filters, iso(firstDayMs), tz));
  const found = tally(await store.jobDayCounts('found', filters, iso(firstDayMs), tz));
  const toCounts = (rows: { filter: string | null; count: number }[]) => ({
    total: rows.find((r) => r.filter === null)?.count ?? 0,
    byFilter: Object.fromEntries(filters.map((f) => [f, rows.find((r) => r.filter === f)?.count ?? 0])),
  });
  const last24h = toCounts(await store.jobsPostedBetween(filters, iso(now - DAY_MS), iso(now)));
  const inWindow = toCounts(await store.jobsPostedBetween(filters, iso(from), iso(to)));

  // Jobs posted per hour: 24 hours from the window start (a day, or the last 24 hours).
  const hourly = async (start: number) => {
    const rows = await store.jobHourCounts(filters, iso(start), iso(start + DAY_MS));
    return Array.from({ length: 24 }, (_, h) => ({
      start: iso(start + h * 3_600_000),
      total: rows.find((r) => r.hour === h && r.filter === null)?.count ?? 0,
      byFilter: Object.fromEntries(filters.map((f) => [f, rows.find((r) => r.hour === h && r.filter === f)?.count ?? 0])),
    }));
  };
  const hourCounts = await hourly(from);
  let compare: { day: string; counts: ReturnType<typeof toCounts>; hours: typeof hourCounts } | null = null;
  if (q.compareDay) {
    const cFrom = localDayStart(q.compareDay, tz);
    compare = { day: q.compareDay, counts: toCounts(await store.jobsPostedBetween(filters, iso(cFrom), iso(cFrom + DAY_MS))), hours: await hourly(cFrom) };
  }

  // --- scan history --------------------------------------------------------------
  const anchorFrom = Math.min(from, now - DAY_MS) - ANCHOR_LOOKBACK_MS;
  const allScans: ScanStatusRow[] = (await store.scans(iso(anchorFrom), iso(Math.max(to, now) + 1))).map((s) => ({ ...s, outcome: scanOutcome(s, activeRunId, now) }));
  const inRange = (ms: number, a: number, b: number) => ms >= a && ms < b;
  const windowScans = allScans.filter((s) => inRange(Date.parse(s.startedAt), from, to + 1));

  // One search run covers several filters: group them, newest first.
  const runs = new Map<number, ScanStatusRow[]>();
  for (const s of windowScans) runs.set(s.runId, [...(runs.get(s.runId) ?? []), s]);
  const runList = [...runs.values()]
    .map((rows) => {
      const startedAt = rows.map((r) => r.startedAt).sort()[0]!;
      const finished = rows.every((r) => r.finishedAt) ? rows.map((r) => r.finishedAt!).sort().at(-1)! : null;
      const outcomes = rows.map((r) => r.outcome);
      const status = outcomes.includes('running') ? 'running' : outcomes.includes('interrupted') ? 'interrupted' : outcomes.every((o) => o === 'failed') ? 'failed' : outcomes.includes('failed') ? 'partial' : 'ok';
      return {
        runId: rows[0]!.runId,
        startedAt,
        finishedAt: finished,
        durationMs: finished ? Date.parse(finished) - Date.parse(startedAt) : null,
        trigger: rows[0]!.trigger,
        status,
        newJobs: rows.reduce((n, r) => n + r.newJobs, 0),
        returned: rows.reduce((n, r) => n + r.returned, 0),
        filters: rows.map((r) => ({ name: r.filter, startedAt: r.startedAt, finishedAt: r.finishedAt, outcome: r.outcome, newJobs: r.newJobs, returned: r.returned, pages: r.pages, moreNotFetched: r.moreNotFetched, error: r.error })),
        gapMs: null as number | null,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  // Gap since the run before (that run may be before the window).
  const allRunStarts = [...new Set(allScans.map((s) => s.runId))].map((id) => allScans.filter((s) => s.runId === id).map((s) => s.startedAt).sort()[0]!).sort();
  for (const r of runList) {
    const prev = allRunStarts.filter((t) => t < r.startedAt).at(-1);
    r.gapMs = prev ? Date.parse(r.startedAt) - Date.parse(prev) : null;
  }
  const gaps = runList.map((r) => r.gapMs).filter((g): g is number => g !== null);
  const hours = Math.max((to - from) / 3_600_000, 1 / 60);

  // --- timetable per filter --------------------------------------------------------
  const byFilter = filters.map((name) => {
    const slots = timetable(
      allScans.filter((s) => s.filter === name),
      { intervalMs, graceMs, now, createdAt: created.get(name) ?? null },
    );
    const windowed = slots.filter((s) => inRange(Date.parse(s.dueAt), from, to) || (s.status === 'pending' && !isPast) || (s.status === 'running' && !isPast));
    const last24 = slots.filter((s) => Date.parse(s.dueAt) >= now - DAY_MS);
    return { name, slots: windowed, counts: countSlots(windowed), last24h: countSlots(last24) };
  });
  const sum = (pick: (f: (typeof byFilter)[number]) => Record<SlotStatus, number>) =>
    Object.fromEntries(STATUSES.map((st) => [st, byFilter.reduce((n, f) => n + pick(f)[st], 0)])) as Record<SlotStatus, number>;

  return {
    generatedAt: iso(now),
    tzOffsetMinutes: tz,
    window: { from: iso(from), to: iso(to), day: q.day, isPast },
    filters,
    intervalMinutes: cfg.intervalMinutes,
    graceMinutes: cfg.scanGraceMinutes,
    retentionDays: cfg.retentionDays,
    jobs: { last24h, inWindow, posted, found, hours: hourCounts, compare },
    scans: {
      runs: runList.reverse(),
      stats: {
        runs: runList.length,
        filterScans: windowScans.length,
        perHour: runList.length / hours,
        avgGapMs: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
        maxGapMs: gaps.length ? Math.max(...gaps) : null,
        minGapMs: gaps.length ? Math.min(...gaps) : null,
        newJobs: runList.reduce((n, r) => n + r.newJobs, 0),
      },
    },
    timetable: { byFilter, counts: sum((f) => f.counts), last24h: sum((f) => f.last24h) },
  };
}

export type Insights = Awaited<ReturnType<typeof buildInsights>>;
