import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, loadEnvFile } from '../config.ts';
import { Store } from '../db.ts';
import { continueSearch, tick, type EngineDeps } from '../engine.ts';
import { configureLog, log } from '../log.ts';
import { ASSETS } from './dev.ts';
import { BACKGROUND_BUDGET_MS, createHandler, LAST_CRON_KEY, SECURITY_HEADERS } from './handler.ts';

/** How often the server checks for due searches by itself (an idle check is a few small queries). */
const SCHEDULER_MS = 60_000;
/** /api/ping wakes the scheduler at most this often. */
const PING_MIN_GAP_MS = 30_000;

/** The usual MySQL setup mistakes, in words (see HOSTINGER.md, step 1). */
const DB_ERRORS: Record<string, string> = {
  ER_ACCESS_DENIED_ERROR: 'MySQL refused MYSQL_USER / MYSQL_PASSWORD. Check both, and that the user is assigned to the database in hPanel.',
  ER_DBACCESS_DENIED_ERROR: 'MYSQL_USER has no access to MYSQL_DATABASE. Assign the user to the database in hPanel.',
  ER_BAD_DB_ERROR: 'MYSQL_DATABASE does not exist. Use the full name hPanel shows (like u123456789_upwork).',
  ECONNREFUSED: 'Nothing answers at MYSQL_HOST / MYSQL_PORT. On Hostinger use localhost and 3306.',
  ENOTFOUND: 'MYSQL_HOST is not a known host name. On Hostinger use localhost.',
  ETIMEDOUT: 'MYSQL_HOST did not answer in time. On Hostinger use localhost.',
};

/** dist/public (built) or the project's public/ (running src/web/server.ts directly). */
function publicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, 'public'), join(here, '..', '..', 'public'), resolve('public')].find((d) => existsSync(join(d, 'index.html'))) ?? resolve('public');
}

const sendJson = (res: import('node:http').ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS }).end(JSON.stringify(body));

/**
 * Production server for an always-on Node host (Hostinger Node.js Web Apps, a VPS, …):
 * serves public/ and the API on $PORT and runs the searches itself.
 *
 * It listens first and connects to the database afterwards: Hostinger restarts an app
 * that has not called listen() within 3 seconds, and requests that arrive meanwhile
 * simply wait for the database.
 */
function main() {
  loadEnvFile();
  // A public server: the dashboard always requires DASHBOARD_PASSWORD and a Secure cookie.
  process.env.HOSTED ??= '1';
  const port = Number(process.env.PORT) || 3000;
  const dir = publicDir();
  const files = new Map<string, Buffer>();
  const asset = (name: string) => {
    let b = files.get(name);
    if (!b) files.set(name, (b = readFileSync(join(dir, name))));
    return b;
  };

  let startupError: string | null = null;
  let deps: EngineDeps | null = null;
  let timer: NodeJS.Timeout | null = null;

  // --- the scheduler: one run at a time; a started search is finished in the same run ---
  let running: Promise<void> | null = null;
  let lastRun = 0;
  const runScheduler = (): Promise<void> => {
    if (!deps) return Promise.resolve();
    const d = deps;
    lastRun = Date.now();
    running ??= (async () => {
      try {
        let r = await tick(d);
        if (r.status === 'continued') r = (await continueSearch(d, BACKGROUND_BUDGET_MS)) ?? r;
        if (r.status !== 'idle' && r.status !== 'busy') log.info('scheduler run', { status: r.status });
      } catch (err) {
        log.error('scheduler run failed', { error: (err as Error).message });
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const ready: Promise<ReturnType<typeof createHandler> | null> = (async () => {
    try {
      const cfg = loadConfig(process.env);
      configureLog(cfg.logLevel, null);
      const store = Store.open(cfg.db.url, cfg.db.authToken);
      await store.init();
      deps = { store, cfg };
      // The process stays up, so search work after the response simply keeps running.
      const api = createHandler({ store, cfg, background: () => (p) => void p, selfScheduling: true });
      timer = setInterval(() => void runScheduler(), SCHEDULER_MS);
      setTimeout(() => void runScheduler(), 3_000);
      log.info('database ready');
      return api;
    } catch (err) {
      // Keep serving so the browser shows what is wrong instead of a bare 503 from the host.
      // Configuration messages never contain secret values; other errors are logged only.
      const code = (err as { code?: string }).code ?? '';
      startupError = err instanceof ConfigError ? err.message : `Server could not start: ${DB_ERRORS[code] ?? (code || 'see the app logs')}`;
      log.error('startup failed', { error: (err as Error).message });
      return null;
    }
  })();

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const a = req.method === 'GET' ? ASSETS[path] : undefined;
    if (a) {
      res.writeHead(200, { 'content-type': a[1], 'cache-control': 'no-cache', ...SECURITY_HEADERS }).end(asset(a[0]));
      return;
    }
    const api = await ready;
    if (!api) return sendJson(res, 500, { error: startupError });
    // Keep-alive for an outside caller (a Hostinger Cron Job), no secret needed: it wakes the
    // app if the host put it to sleep and starts searches that are due. It never starts a
    // search that is not due, so calling it often is harmless.
    if (path === '/api/ping') {
      if (Date.now() - lastRun > PING_MIN_GAP_MS && deps) {
        await deps.store.kvSet(LAST_CRON_KEY, new Date().toISOString()).catch(() => {});
        void runScheduler();
      }
      return sendJson(res, 200, { ok: true, searching: !!running });
    }
    await api(req, res);
  });
  server.listen(port, () => log.info('server listening', { port }));

  const shutdown = () => {
    if (timer) clearInterval(timer);
    server.close(() => process.exit(0));
    void deps?.store.close();
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
