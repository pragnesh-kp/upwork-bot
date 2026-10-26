import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbPath, discoveryPath, runOnce } from '../app.ts';
import type { Config } from '../config.ts';
import { Store } from '../db.ts';
import { defaultFilterName, filterProblems, loadFilters, parseUpworkSearchUrl, saveFilters } from '../filters.ts';
import { log } from '../log.ts';
import { loadDiscovery } from '../mcp/discover.ts';
import type { RunSummary } from '../run.ts';

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static');
const STATES = new Set(['new', 'saved', 'reviewed', 'dismissed']);

export interface DashboardDeps {
  /** Runs one search; replaced in tests. */
  run?: (filter: string | null) => Promise<RunSummary>;
  store?: Store;
  /** Automatic-search schedule, when the dashboard runs inside `npm run watch`. */
  schedule?: () => { intervalMinutes: number; nextRunAt: string | null };
}

/**
 * Local job-alerts dashboard. It listens on 127.0.0.1 only; "Search now" runs
 * one search (automatic searches come from `npm run watch`).
 *
 * Security: Host header check (blocks DNS rebinding); every state-changing
 * request needs a per-process token that only the served page knows, sent in a
 * custom header (other websites cannot send it cross-origin). All data is
 * rendered as text in the browser, never as HTML.
 */
export async function startDashboard(cfg: Config, opts: { port: number }, deps: DashboardDeps = {}): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const store = deps.store ?? new Store(dbPath(cfg));
  const token = randomBytes(24).toString('base64url');
  const run = deps.run ?? ((filter: string | null) => runOnce(cfg, store, filter));
  const page = readFileSync(join(STATIC_DIR, 'index.html'), 'utf8');
  const assets: Record<string, [string, string]> = {
    '/app.js': [readFileSync(join(STATIC_DIR, 'app.js'), 'utf8'), 'text/javascript; charset=utf-8'],
    '/app.css': [readFileSync(join(STATIC_DIR, 'app.css'), 'utf8'), 'text/css; charset=utf-8'],
  };
  let running: { filter: string | null; startedAt: string } | null = null;
  let lastSummary: (RunSummary & { finishedAt: string }) | null = null;
  let lastError: string | null = null;

  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 16_384) {
          reject(new Error('Body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const state = () => {
    let filters: { name: string; url: string; enabled: boolean; problems: string[] }[] = [];
    let filtersError: string | null = null;
    try {
      filters = loadFilters(cfg.filtersFile).map((f) => ({ name: f.name, url: f.url, enabled: f.enabled, problems: filterProblems(f.params) }));
    } catch (err) {
      filtersError = (err as Error).message;
    }
    const counts = new Map(store.filterCounts().map((c) => [c.filter, c]));
    const d = loadDiscovery(discoveryPath(cfg));
    const stats = store.stats();
    const last = (stats.lastRuns as { started_at: string; finished_at: string | null; status: string }[])[0];
    return {
      schedule: deps.schedule?.() ?? null,
      lastRun: last ? { startedAt: last.started_at, finishedAt: last.finished_at, status: last.status } : null,
      account: d ? `${d.account.name} (${d.account.roleLabel})` : null,
      telegram: { configured: !!cfg.telegram.token && cfg.telegram.chatIds.length > 0, dryRun: cfg.telegram.dryRun || !cfg.telegram.token, recipients: cfg.telegram.chatIds.length },
      retentionDays: cfg.retentionDays,
      filters: filters.map((f) => ({ ...f, total: counts.get(f.name)?.total ?? 0, newCount: counts.get(f.name)?.newCount ?? 0 })),
      filtersError,
      totals: { seen: store.listJobs({ filters: filters.filter((f) => f.enabled).map((f) => f.name), limit: 2000 }).length, newJobs: store.newJobCount(filters.filter((f) => f.enabled).map((f) => f.name)), alertsSent: stats.alertsSent, alertsPending: stats.alertsPending, alertsFailed: stats.alertsFailed },
      running,
      lastSummary,
      lastError,
    };
  };

  /** Runs one search (one filter or all) and records the outcome for the page. */
  const search = async (filter: string | null): Promise<RunSummary & { finishedAt: string }> => {
    running = { filter, startedAt: new Date().toISOString() };
    lastError = null;
    try {
      const summary = await run(filter);
      lastSummary = { ...summary, finishedAt: new Date().toISOString() };
      return lastSummary;
    } catch (err) {
      lastError = (err as Error).message;
      log.error('dashboard search failed', { error: lastError });
      throw err;
    } finally {
      running = null;
    }
  };

  /** Searches a newly added filter, waiting (up to ~20 min) while another search holds the lock. */
  const searchWhenFree = async (filter: string): Promise<void> => {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if (!running && (await search(filter)).status !== 'locked') return;
      } catch {
        return; // recorded in lastError
      }
      await new Promise((r) => setTimeout(r, 30_000));
    }
  };

  const checkToken = (req: IncomingMessage): boolean => {
    const got = String(req.headers['x-dashboard-token'] ?? '');
    return got.length === token.length && timingSafeEqual(Buffer.from(got), Buffer.from(token));
  };

  const server = createServer(async (req, res) => {
    try {
      const port = (server.address() as { port: number }).port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host))) return send(res, 421, { error: 'Unexpected Host header' });
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page.replace('__DASHBOARD_TOKEN__', token), 'text/html; charset=utf-8');
      if (req.method === 'GET' && assets[url.pathname]) return send(res, 200, assets[url.pathname]![0], assets[url.pathname]![1]);
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state());
      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        const stateParam = url.searchParams.get('state');
        let enabled: string[] = [];
        try {
          enabled = loadFilters(cfg.filtersFile).filter((f) => f.enabled).map((f) => f.name);
        } catch {
          // An unreadable filters.json shows no jobs rather than jobs of unknown filters.
        }
        const one = url.searchParams.get('filter');
        return send(res, 200, {
          jobs: store.listJobs({
            filters: one ? enabled.filter((n) => n === one) : enabled,
            state: stateParam && STATES.has(stateParam) ? stateParam : null,
            source: url.searchParams.get('source') || null,
            search: url.searchParams.get('q')?.slice(0, 100) || null,
            limit: 2000,
          }),
        });
      }

      if (req.method === 'POST') {
        if (!checkToken(req)) return send(res, 403, { error: 'Missing or invalid dashboard token. Reload the page.' });
        const body = await readJson(req);
        if (url.pathname === '/api/jobs/state') {
          const s = String(body.state ?? '');
          if (!STATES.has(s) || typeof body.source !== 'string' || typeof body.jobId !== 'string') return send(res, 400, { error: 'Invalid request' });
          const ok = store.setReviewState(body.source, body.jobId, s as 'new' | 'saved' | 'reviewed' | 'dismissed');
          return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Job not found' });
        }
        if (url.pathname === '/api/search') {
          if (running) return send(res, 409, { error: 'A search is already running' });
          const filter = typeof body.filter === 'string' && body.filter ? body.filter : null;
          try {
            return send(res, 200, await search(filter));
          } catch (err) {
            return send(res, 502, { error: (err as Error).message });
          }
        }
        if (url.pathname === '/api/filters/add') {
          const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
          const parsed = parseUpworkSearchUrl(rawUrl);
          if (!parsed.ok) return send(res, 400, { error: `That link is not an Upwork job search: ${parsed.error}.` });
          const bad = parsed.params.filter((p) => p.status === 'unsupported' || p.status === 'invalid').map((p) => p.key);
          if (bad.length) {
            return send(res, 400, {
              error: `Not added: this link uses Upwork filter(s) the bot can't apply yet (${bad.join(', ')}). Without them the bot would also list jobs outside your filter. Remove those filters on Upwork and copy the link again.`,
            });
          }
          const current = loadFilters(cfg.filtersFile);
          if (current.length >= 25) return send(res, 400, { error: 'At most 25 filters. Remove one first.' });
          if (current.some((f) => f.url.trim() === rawUrl)) return send(res, 400, { error: 'This link is already one of your filters.' });
          const name = (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : defaultFilterName(parsed.criteria, current.length + 1)).slice(0, 60);
          if (current.some((f) => f.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: `A filter named "${name}" already exists. Pick another name.` });
          saveFilters(cfg.filtersFile, [...current, { name, url: rawUrl, enabled: true }]);
          log.info('filter added from dashboard', { filter: name });
          // First search right away (in the background); if another search is running it waits its turn.
          void searchWhenFree(name);
          return send(res, 200, { ok: true, name });
        }
        if (url.pathname === '/api/filters/remove') {
          const name = typeof body.name === 'string' ? body.name : '';
          const current = loadFilters(cfg.filtersFile);
          if (!current.some((f) => f.name === name)) return send(res, 404, { error: 'Filter not found' });
          saveFilters(cfg.filtersFile, current.filter((f) => f.name !== name));
          store.forgetFilter(name);
          log.info('filter removed from dashboard', { filter: name });
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      log.error('dashboard request failed', { error: (err as Error).message });
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        if (!deps.store) store.close();
      }),
  };
}
