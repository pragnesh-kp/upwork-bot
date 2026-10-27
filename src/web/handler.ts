import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import type { Store } from '../db.ts';
import { continueSearch, filterSchedules, getCycle, hasPendingWork, progressOf, requestSearch, step, tick, type EngineDeps } from '../engine.ts';
import { defaultFilterName, filterProblems, MAX_FILTERS, parseUpworkSearchUrl, toFilterDefs } from '../filters.ts';
import { log } from '../log.ts';
import { loadDiscovery } from '../mcp/discover.ts';
import { finishUpworkSignInFromUrl, startUpworkSignIn } from '../mcp/web-auth.ts';

const STATES = new Set(['new', 'saved', 'reviewed', 'dismissed']);
/** Review states that take a job off the "All" tab. */
const DONE_STATES = ['reviewed', 'dismissed'];
const COOKIE = 'ja_session';
const SESSION_DAYS = 30;
const LAST_CRON_KEY = 'last_cron_call';
/** Wrong passwords allowed per 15 minutes, per IP and in total. */
const LOGIN_LIMIT = { window: 15 * 60_000, perIp: 8, total: 40 };
/** Search work after the scheduler has been answered (ms); the function's limit is 300 s. */
const BACKGROUND_BUDGET_MS = 230_000;

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export interface HandlerDeps {
  store: Store;
  cfg: Config;
  /** Search work done inside one dashboard request (ms); the page keeps calling /api/step for the rest. */
  interactiveBudgetMs?: number;
  /** Test hooks for the search engine (fake source, no sleeping). */
  engine?: Pick<EngineDeps, 'openSource' | 'sleep' | 'now'>;
  /**
   * Keeps the function running after the response until the promise settles (Vercel's
   * waitUntil), read per request. Null where unavailable: the search then continues on
   * the next scheduler call instead.
   */
  background?: () => ((p: Promise<unknown>) => void) | null;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * The dashboard API, used by the Vercel function and by `npm run dev`.
 *
 * Security: with DASHBOARD_PASSWORD set (required on Vercel), every API call needs a
 * signed session cookie (HttpOnly, SameSite=Strict). State-changing calls also need a
 * custom header, which other websites cannot send without a CORS preflight that this
 * API never allows. /api/cron accepts only "Authorization: Bearer <CRON_SECRET>".
 * Without a password (local only) requests must be addressed to 127.0.0.1/localhost,
 * which blocks DNS rebinding. Job data is returned as JSON and rendered as text.
 */
export function createHandler(deps: HandlerDeps): Handler {
  const { store, cfg } = deps;
  const engine: EngineDeps = { store, cfg, ...deps.engine };
  const interactiveMs = deps.interactiveBudgetMs ?? cfg.stepBudgetSeconds * 1000;
  // Changing the password (or the encryption key) signs everyone out.
  const sessionKey = createHmac('sha256', cfg.upwork.tokenKey ?? Buffer.alloc(0))
    .update(`session:${cfg.dashboardPassword ?? ''}`)
    .digest();

  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra });
    res.end(JSON.stringify(body));
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

  const sign = (value: string) => createHmac('sha256', sessionKey).update(value).digest('base64url');
  const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const cookieOf = (req: IncomingMessage, name: string): string | null => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return null;
  };

  const sessionCookie = (value: string, maxAgeS: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${cfg.onVercel ? '; Secure' : ''}`;

  const loggedIn = (req: IncomingMessage): boolean => {
    const c = cookieOf(req, COOKIE);
    if (!c) return false;
    const [exp, sig] = c.split('.');
    return !!exp && !!sig && Number(exp) > Date.now() && safeEqual(sig, sign(exp));
  };

  const clientIp = (req: IncomingMessage): string =>
    String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || String(req.headers['x-real-ip'] ?? '') || req.socket.remoteAddress || 'unknown';

  const localHostOk = (req: IncomingMessage): boolean => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host ?? ''));

  /** Origin, when the browser sends one, must be this site. */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const filterDefs = async () => {
    try {
      return { defs: toFilterDefs(await store.listFilters()), error: null as string | null };
    } catch (err) {
      return { defs: [], error: (err as Error).message };
    }
  };

  const state = async () => {
    const { defs, error } = await filterDefs();
    const enabled = defs.filter((f) => f.enabled).map((f) => f.name);
    const counts = new Map((await store.filterCounts()).map((c) => [c.filter, c]));
    const discovery = await loadDiscovery(store);
    const cycle = await getCycle(store);
    const last = (await store.lastRuns(1))[0];
    const shown = await store.listJobs({ filters: enabled, limit: 2000 });
    const schedules = new Map((await filterSchedules(engine)).map((s) => [s.name, s]));
    const nextDue = [...schedules.values()].map((s) => s.nextDueAt).sort()[0] ?? null;
    const lastFinished = [...schedules.values()].map((s) => s.lastSearch?.finishedAt ?? '').sort().at(-1) || null;
    return {
      account: discovery ? `${discovery.account.name} (${discovery.account.roleLabel})` : null,
      /** Why the last search could not reach Upwork (e.g. an expired sign-in), if it could not. */
      upworkProblem: last?.summary ? ((JSON.parse(last.summary) as { stoppedEarly?: string | null }).stoppedEarly ?? null) : null,
      retentionDays: cfg.retentionDays,
      filters: defs.map((f) => ({
        name: f.name,
        url: f.url,
        enabled: f.enabled,
        problems: filterProblems(f.params),
        total: counts.get(f.name)?.total ?? 0,
        newCount: counts.get(f.name)?.newCount ?? 0,
        lastSearch: schedules.get(f.name)?.lastSearch ?? null,
        nextDueAt: schedules.get(f.name)?.nextDueAt ?? null,
      })),
      filtersError: error,
      totals: { seen: shown.length, newJobs: await store.newJobCount(enabled) },
      schedule: {
        intervalMinutes: cfg.intervalMinutes,
        /** Earliest next automatic search among the enabled filters. */
        nextDueAt: nextDue,
        /** Most recent finished search of any enabled filter. */
        lastSearchAt: lastFinished,
        lastSchedulerCall: await store.kvGet(LAST_CRON_KEY),
      },
      lastRun: last ? { startedAt: last.started_at, finishedAt: last.finished_at, status: last.status, summary: last.summary ? (JSON.parse(last.summary) as unknown) : null } : null,
      running: cycle ? progressOf(cycle) : (await hasPendingWork(store)) ? { pending: true } : null,
    };
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      // --- scheduler (no session; secret header) ---------------------------------
      if (path === '/api/cron') {
        const auth = String(req.headers.authorization ?? '');
        if (!cfg.cronSecret || !safeEqual(auth, `Bearer ${cfg.cronSecret}`)) return send(res, 401, { error: 'Unauthorized' });
        await store.kvSet(LAST_CRON_KEY, new Date().toISOString());
        const r = await tick(engine);
        // cron-job.org gives up after 30 s, so answer now and keep searching in the background:
        // a whole search then fits in one call instead of moving 20 s forward every 5 minutes.
        const bg = r.status === 'continued' ? deps.background?.() : null;
        if (bg) {
          bg(continueSearch(engine, BACKGROUND_BUDGET_MS).catch((err: Error) => log.error('background search failed', { error: err.message })));
          return send(res, 200, { ...r, continuesInBackground: true });
        }
        return send(res, 200, r);
      }

      // --- access control ----------------------------------------------------------
      if (!cfg.dashboardPassword) {
        if (cfg.onVercel) return send(res, 503, { error: 'Set DASHBOARD_PASSWORD in the Vercel project settings, then redeploy.' });
        if (!localHostOk(req)) return send(res, 421, { error: 'Unexpected Host header' });
      }
      if (req.method === 'POST' && (req.headers['x-requested-with'] !== 'job-alerts' || !sameOrigin(req))) return send(res, 403, { error: 'Forbidden' });

      if (req.method === 'POST' && path === '/api/login') {
        if (!cfg.dashboardPassword) return send(res, 200, { ok: true });
        const ip = clientIp(req);
        const fails = await store.loginFailures(ip, LOGIN_LIMIT.window);
        if (fails.ip >= LOGIN_LIMIT.perIp || fails.all >= LOGIN_LIMIT.total) return send(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
        const body = await readJson(req);
        const given = typeof body.password === 'string' ? body.password : '';
        const ok = safeEqual(createHmac('sha256', sessionKey).update(given).digest('hex'), createHmac('sha256', sessionKey).update(cfg.dashboardPassword).digest('hex'));
        if (!ok) {
          await store.recordLoginFailure(ip);
          log.warn('dashboard login failed', { ip });
          return send(res, 401, { error: 'Wrong password' });
        }
        await store.clearLoginFailures(ip);
        const exp = String(Date.now() + SESSION_DAYS * 86_400_000);
        return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(`${exp}.${sign(exp)}`, SESSION_DAYS * 86_400) });
      }
      if (req.method === 'POST' && path === '/api/logout') return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });

      if (cfg.dashboardPassword && !loggedIn(req)) return send(res, 401, { error: 'Login required', loginRequired: true });

      // --- dashboard API ----------------------------------------------------------
      if (req.method === 'GET' && path === '/api/state') return send(res, 200, await state());
      if (req.method === 'GET' && path === '/api/jobs') {
        const { defs } = await filterDefs();
        const enabled = defs.filter((f) => f.enabled).map((f) => f.name);
        const one = url.searchParams.get('filter');
        const stateParam = url.searchParams.get('state');
        const reviewState = stateParam && STATES.has(stateParam) ? stateParam : null;
        // "All" lists the jobs still open: a reviewed or dismissed job moves to its own tab.
        const jobs = await store.listJobs({ filters: one ? enabled.filter((n) => n === one) : enabled, state: reviewState, excludeStates: reviewState ? [] : DONE_STATES, limit: 2000 });
        return send(res, 200, { jobs });
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        // POST /api/jobs sets a review state (one function per path; Vercel Hobby allows 12).
        if (path === '/api/jobs') {
          const s = String(body.state ?? '');
          if (!STATES.has(s) || typeof body.source !== 'string' || typeof body.jobId !== 'string') return send(res, 400, { error: 'Invalid request' });
          const ok = await store.setReviewState(body.source, body.jobId, s as 'new' | 'saved' | 'reviewed' | 'dismissed');
          return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Job not found' });
        }
        if (path === '/api/search') {
          const filter = typeof body.filter === 'string' && body.filter ? body.filter : null;
          await requestSearch(store, filter);
          return send(res, 200, await step(engine, interactiveMs));
        }
        if (path === '/api/upwork/connect') {
          try {
            const r = await startUpworkSignIn(cfg, store);
            if ('url' in r) return send(res, 200, { url: r.url });
            // The stored sign-in still works: nothing to sign in to; search with it.
            await requestSearch(store, null);
            return send(res, 200, { connected: `${r.connected.account.name} (${r.connected.account.roleLabel})` });
          } catch (err) {
            log.error('Upwork sign-in could not start', { error: (err as Error).message });
            return send(res, 502, { error: `Could not start the Upwork sign-in: ${(err as Error).message}` });
          }
        }
        // The address the browser landed on after "Allow" on Upwork (http://127.0.0.1/callback?code=…).
        if (path === '/api/upwork/finish') {
          try {
            const d = await finishUpworkSignInFromUrl(cfg, store, typeof body.url === 'string' ? body.url : '');
            log.info('Upwork connected from the dashboard', { account: d.account.name });
            await requestSearch(store, null);
            return send(res, 200, { connected: `${d.account.name} (${d.account.roleLabel})` });
          } catch (err) {
            log.error('Upwork sign-in failed', { error: (err as Error).message });
            return send(res, 400, { error: (err as Error).message });
          }
        }
        // While the dashboard is open it also starts searches that are due, so they run on time
        // even when the external scheduler is not calling.
        if (path === '/api/step') return send(res, 200, await tick(engine, interactiveMs));
        // POST /api/filters with action "add" or "remove".
        if (path === '/api/filters' && body.action === 'add') {
          const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
          const parsed = parseUpworkSearchUrl(rawUrl);
          if (!parsed.ok) return send(res, 400, { error: `That link is not an Upwork job search: ${parsed.error}.` });
          const bad = parsed.params.filter((p) => p.status === 'unsupported' || p.status === 'invalid').map((p) => p.key);
          if (bad.length) {
            return send(res, 400, {
              error: `Not added: this link uses Upwork filter(s) the bot can't apply yet (${bad.join(', ')}). Without them the bot would also list jobs outside your filter. Remove those filters on Upwork and copy the link again.`,
            });
          }
          const current = await store.listFilters();
          if (current.length >= MAX_FILTERS) return send(res, 400, { error: `At most ${MAX_FILTERS} filters. Remove one first.` });
          if (current.some((f) => f.url.trim() === rawUrl)) return send(res, 400, { error: 'This link is already one of your filters.' });
          const name = (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : defaultFilterName(parsed.criteria, current.length + 1)).slice(0, 60);
          if (current.some((f) => f.name.toLowerCase() === name.toLowerCase()) || !(await store.addFilter({ name, url: rawUrl, enabled: true }))) {
            return send(res, 400, { error: `A filter named "${name}" already exists. Pick another name.` });
          }
          log.info('filter added from dashboard', { filter: name });
          // Its first search starts now; the page keeps calling /api/step until it finishes.
          await requestSearch(store, name);
          return send(res, 200, { ok: true, name });
        }
        if (path === '/api/filters' && body.action === 'remove') {
          const name = typeof body.name === 'string' ? body.name : '';
          if (!(await store.removeFilter(name))) return send(res, 404, { error: 'Filter not found' });
          log.info('filter removed from dashboard', { filter: name });
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      log.error('request failed', { error: (err as Error).message });
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  };
}
