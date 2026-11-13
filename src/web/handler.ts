import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import type { Store } from '../db.ts';
import { checkOneJob, continueSearch, getCycle, hasPendingWork, progressOf, requestSearch, schedulesOf, step, tick, type EngineDeps } from '../engine.ts';
import { defaultFilterName, filterProblems, MAX_FILTERS, parseUpworkSearchUrl, toFilterDefs } from '../filters.ts';
import { log } from '../log.ts';
import { buildInsights, MAX_TREND_DAYS } from '../insights.ts';
import { loadDiscovery } from '../mcp/discover.ts';
import { finishUpworkSignInFromUrl, startUpworkSignIn } from '../mcp/web-auth.ts';

const STATES = new Set(['new', 'saved', 'reviewed']);
/** Review states that take a job off the "All" tab. */
const DONE_STATES = ['reviewed'];
const COOKIE = 'ja_session';
const SESSION_DAYS = 30;
export const LAST_CRON_KEY = 'last_cron_call';
/** Wrong passwords allowed per 15 minutes, per IP and in total. */
const LOGIN_LIMIT = { window: 15 * 60_000, perIp: 8, total: 40 };
/** Jobs sent to the page at once (newest first); older ones are reached by picking a day. */
export const JOB_LIST_LIMIT = 2000;
/** Search work after the scheduler has been answered (ms); the function's limit is 300 s. */
export const BACKGROUND_BUDGET_MS = 230_000;

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
  /**
   * True on an always-on server that runs the searches itself (dist/server.mjs): a search
   * started from the dashboard then runs in the background and the page only watches its
   * progress, instead of pushing it forward with /api/step.
   */
  selfScheduling?: boolean;
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

  /**
   * Origin, when the browser sends one, must be this site. Behind a reverse proxy
   * (Hostinger) the public host may arrive as X-Forwarded-Host; a browser cannot set
   * that header on a cross-site request, so accepting it keeps the check sound.
   */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = new URL(origin).host;
      return host === req.headers.host || host === String(req.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim();
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

  /**
   * Starts the requested searches in the background (always-on server only). A search that
   * is already running absorbs the request; if another call holds the search lock, wait for it.
   */
  const kick = (): boolean => {
    const bg = deps.selfScheduling ? deps.background?.() : null;
    if (!bg) return false;
    const pause = engine.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    bg(
      (async () => {
        for (let i = 0; i < 60; i++) {
          const r = await continueSearch(engine, BACKGROUND_BUDGET_MS);
          if (r?.status !== 'busy') return;
          await pause(3000);
        }
      })().catch((err: Error) => log.error('background search failed', { error: err.message })),
    );
    return true;
  };

  const state = async () => {
    const [{ defs, error }, countRows, discovery, cycle, last, lastSearches, lastSchedulerCall] = await Promise.all([
      filterDefs(),
      store.filterCounts(),
      loadDiscovery(store),
      getCycle(store),
      store.lastRuns(1).then((r) => r[0]),
      store.filterLastSearches(),
      store.kvGet(LAST_CRON_KEY),
    ]);
    const enabled = defs.filter((f) => f.enabled).map((f) => f.name);
    const counts = new Map(countRows.map((c) => [c.filter, c]));
    const [totals, pending, removedFromUpwork] = await Promise.all([store.jobTotals(enabled), cycle ? false : hasPendingWork(store), store.removedCount(enabled)]);
    const schedules = new Map(schedulesOf(enabled, lastSearches, cfg.intervalMinutes, (engine.now ?? Date.now)()).map((s) => [s.name, s]));
    const nextDue = [...schedules.values()].map((s) => s.nextDueAt).sort()[0] ?? null;
    const lastFinished = [...schedules.values()].map((s) => s.lastSearch?.finishedAt ?? '').sort().at(-1) || null;
    return {
      account: discovery ? `${discovery.account.name} (${discovery.account.roleLabel})` : null,
      /** Why the last search could not reach Upwork (e.g. an expired sign-in), if it could not. */
      upworkProblem: last?.summary ? ((JSON.parse(last.summary) as { stoppedEarly?: string | null }).stoppedEarly ?? null) : null,
      /** Stored jobs that are no longer on Upwork (still listed, with a banner). */
      removedFromUpwork,
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
      totals,
      schedule: {
        intervalMinutes: cfg.intervalMinutes,
        /** Earliest next automatic search among the enabled filters. */
        nextDueAt: nextDue,
        /** Most recent finished search of any enabled filter. */
        lastSearchAt: lastFinished,
        lastSchedulerCall,
        /** The server starts due searches itself; the page only watches. */
        selfScheduling: !!deps.selfScheduling,
      },
      lastRun: last ? { id: last.id, startedAt: last.started_at, finishedAt: last.finished_at, status: last.status, summary: last.summary ? (JSON.parse(last.summary) as unknown) : null } : null,
      running: cycle ? progressOf(cycle) : pending ? { pending: true } : null,
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
        if (cfg.onVercel) return send(res, 503, { error: "Set DASHBOARD_PASSWORD in the hosting settings (Vercel project or Hostinger app's environment variables), then redeploy." });
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
      if (req.method === 'GET' && path === '/api/insights') {
        const day = url.searchParams.get('day');
        const tz = Number(url.searchParams.get('tz') ?? 0);
        const days = Number(url.searchParams.get('days') ?? 14);
        const dayParam = (name: string) => url.searchParams.get(name) || null;
        const [compareDay, trendFrom, trendTo] = [dayParam('compare'), dayParam('from'), dayParam('to')];
        for (const d of [day || null, compareDay, trendFrom, trendTo]) {
          if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return send(res, 400, { error: 'Days must be YYYY-MM-DD' });
        }
        if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) return send(res, 400, { error: 'Invalid time zone' });
        return send(res, 200, await buildInsights(engine, {
          day: day || null,
          tzOffsetMinutes: tz,
          days: Number.isInteger(days) ? Math.min(Math.max(days, 1), MAX_TREND_DAYS) : 14,
          compareDay,
          trendFrom,
          trendTo,
        }));
      }
      if (req.method === 'GET' && path === '/api/jobs') {
        const { defs } = await filterDefs();
        const enabled = defs.filter((f) => f.enabled).map((f) => f.name);
        const one = url.searchParams.get('filter');
        const stateParam = url.searchParams.get('state');
        const reviewState = stateParam && STATES.has(stateParam) ? stateParam : null;
        // Optional posting-time range (the page's "Posted on" day, as ISO times in the viewer's time zone).
        const iso = (name: string) => {
          const v = url.searchParams.get(name);
          return v && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
        };
        // "All" lists the jobs still open: a reviewed job moves to its own tab. Jobs are kept
        // forever, so only the newest JOB_LIST_LIMIT come at once; a day shows that day's jobs.
        const rows = await store.listJobs({
          filters: one ? enabled.filter((n) => n === one) : enabled,
          state: reviewState,
          excludeStates: reviewState ? [] : DONE_STATES,
          limit: JOB_LIST_LIMIT + 1,
          postedFrom: iso('from'),
          postedTo: iso('to'),
        });
        return send(res, 200, { jobs: rows.slice(0, JOB_LIST_LIMIT), more: rows.length > JOB_LIST_LIMIT, limit: JOB_LIST_LIMIT });
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        // POST /api/jobs sets a review state, or deletes the job for good with { delete: true }
        // (one function per path; Vercel Hobby allows 12).
        if (path === '/api/jobs') {
          if (typeof body.source !== 'string' || typeof body.jobId !== 'string') return send(res, 400, { error: 'Invalid request' });
          // { check: true }: ask Upwork now whether this job is still there.
          if (body.check === true) {
            try {
              const r = await checkOneJob(engine, body.source, body.jobId);
              return r ? send(res, 200, { ok: true, ...r }) : send(res, 404, { error: 'Job not found' });
            } catch (err) {
              return send(res, 502, { error: `Could not check this job on Upwork: ${(err as Error).message}` });
            }
          }
          if (body.delete === true) {
            const ok = await store.deleteJob(body.source, body.jobId);
            return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Job not found' });
          }
          const s = String(body.state ?? '');
          if (!STATES.has(s)) return send(res, 400, { error: 'Invalid request' });
          const ok = await store.setReviewState(body.source, body.jobId, s as 'new' | 'saved' | 'reviewed');
          return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Job not found' });
        }
        if (path === '/api/search') {
          const filter = typeof body.filter === 'string' && body.filter ? body.filter : null;
          await requestSearch(store, filter, 'manual');
          if (kick()) return send(res, 200, { status: 'started' });
          return send(res, 200, await step(engine, interactiveMs));
        }
        if (path === '/api/upwork/connect') {
          try {
            const r = await startUpworkSignIn(cfg, store);
            if ('url' in r) return send(res, 200, { url: r.url });
            // The stored sign-in still works: nothing to sign in to; search with it.
            await requestSearch(store, null, 'connect');
            kick();
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
            await requestSearch(store, null, 'connect');
            kick();
            return send(res, 200, { connected: `${d.account.name} (${d.account.roleLabel})` });
          } catch (err) {
            log.error('Upwork sign-in failed', { error: (err as Error).message });
            return send(res, 400, { error: (err as Error).message });
          }
        }
        // While the dashboard is open it also starts searches that are due, so they run on time
        // even when the external scheduler is not calling.
        if (path === '/api/step') return send(res, 200, await tick(engine, interactiveMs, 'dashboard'));
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
          await requestSearch(store, name, 'new-filter');
          kick();
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
