import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, loadEnvFile } from '../config.ts';
import { Store } from '../db.ts';
import { tick } from '../engine.ts';
import { configureLog, log } from '../log.ts';
import { ASSETS } from './dev.ts';
import { createHandler, SECURITY_HEADERS } from './handler.ts';

/** How often the server starts due searches by itself (the external scheduler may also call /api/cron). */
const SCHEDULER_MS = 5 * 60_000;

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

/**
 * Production server for an always-on Node host (Hostinger Node.js Web Apps, a VPS, …):
 * serves public/ and the API on $PORT, keeps searching after answering the scheduler,
 * and starts due searches every few minutes by itself.
 */
async function main() {
  loadEnvFile();
  // A public server: the dashboard always requires DASHBOARD_PASSWORD and a Secure cookie.
  process.env.HOSTED ??= '1';
  const port = Number(process.env.PORT) || 3000;
  const dir = publicDir();

  let api: ReturnType<typeof createHandler> | null = null;
  let startupError: string | null = null;
  let stop = () => {};
  try {
    const cfg = loadConfig(process.env);
    configureLog(cfg.logLevel, null);
    const store = Store.open(cfg.db.url, cfg.db.authToken);
    await store.init();
    // The process stays up, so search work after the response simply keeps running.
    api = createHandler({ store, cfg, background: () => (p) => void p });
    const run = () =>
      tick({ store, cfg })
        .then((r) => r.status !== 'idle' && log.info('scheduler tick', { status: r.status }))
        .catch((err: Error) => log.error('scheduler tick failed', { error: err.message }));
    const timer = setInterval(run, SCHEDULER_MS);
    setTimeout(run, 10_000);
    stop = () => {
      clearInterval(timer);
      void store.close();
    };
  } catch (err) {
    // Keep serving so the browser shows what is wrong instead of a bare 503 from the host.
    // Configuration messages never contain secret values; other errors are logged only.
    const code = (err as { code?: string }).code ?? '';
    startupError = err instanceof ConfigError ? err.message : `Server could not start: ${DB_ERRORS[code] ?? (code || 'see the app logs')}`;
    log.error('startup failed', { error: (err as Error).message });
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const asset = req.method === 'GET' ? ASSETS[path] : undefined;
    if (asset) {
      res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-cache', ...SECURITY_HEADERS }).end(readFileSync(join(dir, asset[0])));
      return;
    }
    if (!api) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS }).end(JSON.stringify({ error: startupError }));
      return;
    }
    await api(req, res);
  });
  server.listen(port, () => log.info('server listening', { port, database: startupError ? 'not connected' : 'ok' }));

  const shutdown = () => {
    stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
