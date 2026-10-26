import { makeSender, runOnce } from './app.ts';
import type { Config } from './config.ts';
import { startDashboard } from './dashboard/server.ts';
import type { Store } from './db.ts';
import { log } from './log.ts';
import type { RunSummary } from './run.ts';
import { escapeHtml, type TelegramSender } from './telegram.ts';

/**
 * Sends one Telegram notice when searches start failing and one when they work
 * again, so a background process that silently stopped finding jobs (expired
 * Upwork sign-in, rate limit, network) does not go unnoticed.
 */
export function healthNotifier(sender: TelegramSender, chatIds: string[]) {
  let healthy = true;
  return async (ok: boolean, detail: string): Promise<void> => {
    if (ok === healthy) return;
    healthy = ok;
    const text = ok
      ? '✅ <b>Upwork Job Alert Lite</b>\nSearches are working again.'
      : `⚠️ <b>Upwork Job Alert Lite</b>\nSearches are failing, so no job alerts will arrive until this is fixed:\n${escapeHtml(detail.slice(0, 500))}`;
    for (const chat of chatIds) {
      await sender.send(chat, text).catch((err: Error) => log.warn('could not send health notice', { error: err.message }));
    }
  };
}

/** Why a run did not fully work, or null when it did. */
export function runProblem(s: RunSummary): string | null {
  if (s.stoppedEarly) return s.stoppedEarly;
  if (s.status === 'failed') return s.filters.find((f) => f.error)?.error ?? 'every filter failed';
  return null;
}

export interface WatchDeps {
  run?: () => Promise<RunSummary>;
  /** Started dashboard handle; tests pass null to skip it. */
  dashboard?: { close: () => Promise<void> } | null;
}

/**
 * Long-running mode for the background task: searches all enabled filters now
 * and then every SEARCH_INTERVAL_MINUTES (±10% jitter), and serves the
 * dashboard from the same process. Returns a function that stops it.
 */
export async function startWatch(cfg: Config, store: Store, deps: WatchDeps = {}): Promise<() => Promise<void>> {
  const run = deps.run ?? (() => runOnce(cfg, store));
  let nextRunAt: string | null = null;
  const dashboard =
    deps.dashboard !== undefined
      ? deps.dashboard
      : await startDashboard(cfg, { port: cfg.watch.dashboardPort }, { store, schedule: () => ({ intervalMinutes: cfg.watch.intervalMinutes, nextRunAt }) });
  const notify = healthNotifier(makeSender(cfg), cfg.telegram.chatIds);
  const intervalMs = cfg.watch.intervalMinutes * 60_000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();

  const cycle = async () => {
    try {
      const s = await run();
      if (s.status === 'locked') {
        log.info('watch: another search is running, skipping this cycle');
        return;
      }
      log.info('watch: search finished', { status: s.status, newJobs: s.newJobs, alertsSent: s.delivery.sent, alertsRetrying: s.delivery.retrying, stoppedEarly: s.stoppedEarly });
      const problem = runProblem(s);
      await notify(problem === null, problem ?? '');
    } catch (err) {
      const msg = (err as Error).message;
      log.error('watch: search failed', { error: msg });
      await notify(false, msg);
    }
  };

  const schedule = () => {
    if (stopped) return;
    const wait = Math.round(intervalMs * (0.9 + Math.random() * 0.2));
    nextRunAt = new Date(Date.now() + wait).toISOString();
    log.info('watch: next search scheduled', { inMinutes: Math.round(wait / 60_000) });
    timer = setTimeout(() => {
      nextRunAt = null;
      current = cycle().finally(schedule);
    }, wait);
  };

  log.info('watch: started', { intervalMinutes: cfg.watch.intervalMinutes });
  current = cycle().finally(schedule);

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await current;
    await dashboard?.close();
  };
}
