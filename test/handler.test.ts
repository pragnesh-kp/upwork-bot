import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { SOURCE } from '../src/engine.ts';
import type { FilterDef } from '../src/filters.ts';
import type { Job, JobSource, SearchPage } from '../src/sources/types.ts';
import { createHandler, type HandlerDeps } from '../src/web/handler.ts';

const PASSWORD = 'correct horse battery';
const CRON = 'cron-secret-0123456789';

class FakeSource implements JobSource {
  readonly name = 'upwork-mcp' as const;
  calls = 0;
  describeMapping() {
    return { applied: [], notApplied: [] };
  }
  async search(f: FilterDef): Promise<SearchPage> {
    this.calls++;
    const j: Job = { id: `job-${f.name}`, title: `${f.name} job`, url: 'https://www.upwork.com/jobs/~01', description: null, postedAt: new Date().toISOString(), contractType: 'FIXED', fixedBudget: 5000, hourlyMin: null, hourlyMax: null, currency: 'USD', budgetLabel: null, skills: [] };
    return { jobs: [j], nextCursor: null, ignoredFilters: [], emptyReason: null, invalidRecords: 0 };
  }
  async close() {}
}

async function start(env: Record<string, string> = { DASHBOARD_PASSWORD: PASSWORD, CRON_SECRET: CRON }, extra: Pick<HandlerDeps, 'background'> & { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const store = Store.open(':memory:');
  const src = new FakeSource();
  const cfg = loadConfig({ DATA_DIR: 'data', TURSO_DATABASE_URL: 'file::memory:', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), DELAY_BETWEEN_SEARCHES_MS: '0', ...env } as NodeJS.ProcessEnv);
  const handler = createHandler({ store, cfg, background: extra.background, engine: { openSource: async () => src, sleep: extra.sleep ?? (async () => {}), ...(extra.now ? { now: extra.now } : {}) } });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let cookie = '';
  const call = (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; noCsrf?: boolean } = {}) =>
    new Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            ...(data ? { 'content-type': 'application/json' } : {}),
            ...(method === 'POST' && !opts.noCsrf ? { 'x-requested-with': 'job-alerts' } : {}),
            ...(cookie ? { cookie } : {}),
            ...opts.headers,
          },
        },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => {
            const set = res.headers['set-cookie']?.[0];
            if (set) cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
            resolve({ status: res.statusCode ?? 0, body: b ? (JSON.parse(b) as Record<string, unknown>) : {}, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  const login = () => call('POST', '/api/login', { body: { password: PASSWORD } });
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { store, src, call, login, close };
}

test('every API call needs a login; a wrong password is throttled; logout ends the session', async () => {
  const t = await start();
  try {
    assert.equal((await t.call('GET', '/api/state')).status, 401);
    assert.equal((await t.call('POST', '/api/login', { body: { password: 'nope' } })).status, 401);
    const ok = await t.login();
    assert.equal(ok.status, 200);
    assert.match(String(ok.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.equal((await t.call('GET', '/api/state')).status, 200);
    assert.equal((await t.call('POST', '/api/logout', { body: {} })).status, 200);
    assert.equal((await t.call('GET', '/api/state')).status, 401);

    for (let i = 0; i < 8; i++) await t.call('POST', '/api/login', { body: { password: `wrong-${i}` } });
    assert.equal((await t.login()).status, 429, 'even the right password waits after 8 failures');
  } finally {
    await t.close();
  }
});

test('changes need the custom header and a same-origin request', async () => {
  const t = await start();
  try {
    assert.equal((await t.call('POST', '/api/login', { body: { password: PASSWORD }, noCsrf: true })).status, 403);
    await t.login();
    assert.equal((await t.call('POST', '/api/filters', { body: { action: 'remove', name: 'x' }, noCsrf: true })).status, 403);
    assert.equal((await t.call('POST', '/api/filters', { body: { action: 'remove', name: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);
  } finally {
    await t.close();
  }
});

test('the scheduler endpoint needs the secret and then runs a due search', async () => {
  const t = await start();
  try {
    await t.store.addFilter({ name: 'React', url: 'https://www.upwork.com/nx/search/jobs?q=react', enabled: true });
    assert.equal((await t.call('GET', '/api/cron')).status, 401);
    assert.equal((await t.call('GET', '/api/cron', { headers: { authorization: 'Bearer wrong-wrong-wrong-wrong' } })).status, 401);
    const r = await t.call('GET', '/api/cron', { headers: { authorization: `Bearer ${CRON}` } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'finished');
    assert.equal(t.src.calls, 1);
    const again = await t.call('GET', '/api/cron', { headers: { authorization: `Bearer ${CRON}` } });
    assert.equal(again.body.status, 'idle', 'not due again yet');
    await t.login();
    const s = (await t.call('GET', '/api/state')).body as {
      schedule: { lastSchedulerCall: string | null; lastSearchAt: string | null; nextDueAt: string | null };
      filters: { name: string; lastSearch: { finishedAt: string; status: string } | null; nextDueAt: string | null }[];
    };
    assert.ok(s.schedule.lastSchedulerCall, 'the dashboard can show when the scheduler last called');
    const f = s.filters[0]!;
    assert.equal(f.lastSearch?.status, 'ok');
    assert.equal(s.schedule.lastSearchAt, f.lastSearch?.finishedAt, 'last scan time');
    assert.equal(Date.parse(f.nextDueAt!) - Date.parse(f.lastSearch!.finishedAt) <= 30 * 60_000, true);
    assert.equal(s.schedule.nextDueAt, f.nextDueAt, 'next scan time');
  } finally {
    await t.close();
  }
});

test('the scheduler answers quickly and finishes a long search in the background', async () => {
  const clock = { t: Date.now() };
  const pending: Promise<unknown>[] = [];
  const t = await start(
    { DASHBOARD_PASSWORD: PASSWORD, CRON_SECRET: CRON, DELAY_BETWEEN_SEARCHES_MS: '6000', STEP_BUDGET_SECONDS: '5' },
    { background: () => (p) => void pending.push(p), now: () => clock.t, sleep: async (ms) => void (clock.t += ms) },
  );
  try {
    for (const n of ['A', 'B', 'C']) await t.store.addFilter({ name: n, url: `https://www.upwork.com/nx/search/jobs?q=${n}`, enabled: true });
    const r = await t.call('GET', '/api/cron', { headers: { authorization: `Bearer ${CRON}` } });
    assert.equal(r.body.status, 'continued');
    assert.equal(r.body.continuesInBackground, true);
    assert.equal((r.body.progress as { tasksDone: number }).tasksDone, 1, 'the response did not wait for the whole search');
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.equal(t.src.calls, 3, 'the background work searched the remaining filters');
    assert.equal((await t.store.filterLastSearches()).size, 3);
  } finally {
    await t.close();
  }
});

test('without a password the API only answers requests addressed to this computer', async () => {
  const t = await start({});
  try {
    assert.equal((await t.call('GET', '/api/state', { headers: { host: 'evil.example' } })).status, 421);
    assert.equal((await t.call('GET', '/api/state')).status, 200);
  } finally {
    await t.close();
  }
});

test('on Vercel the dashboard refuses to run without a password', async () => {
  const t = await start({ VERCEL: '1', CRON_SECRET: CRON });
  try {
    assert.equal((await t.call('GET', '/api/state')).status, 503);
  } finally {
    await t.close();
  }
});

test('adds a filter from an Upwork link and searches it; refuses bad, duplicate or unsupported links; removes it with its jobs', async () => {
  const t = await start();
  try {
    await t.login();
    const link = 'https://www.upwork.com/nx/search/jobs?q=react%20native&amount=1000-50000&t=1';
    const ok = await t.call('POST', '/api/filters', { body: { action: 'add', url: link } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.name, 'React Native');
    const state = (await t.call('GET', '/api/state')).body as { running: unknown; filters: { name: string }[] };
    assert.ok(state.running, 'its first search is queued');
    const r = await t.call('POST', '/api/step', { body: {} });
    assert.equal(r.body.status, 'finished');
    const { jobs } = (await t.call('GET', '/api/jobs')).body as { jobs: { jobId: string; filters: string[] }[] };
    assert.deepEqual(jobs.map((j) => [j.jobId, j.filters]), [['job-React Native', ['React Native']]]);

    assert.match(String((await t.call('POST', '/api/filters', { body: { action: 'add', url: link } })).body.error), /already one of your filters/);
    const unsupported = await t.call('POST', '/api/filters', { body: { action: 'add', url: 'https://www.upwork.com/nx/search/jobs?q=x&contractor_tier=3' } });
    assert.equal(unsupported.status, 400);
    assert.match(String(unsupported.body.error), /contractor_tier/);
    assert.equal((await t.call('POST', '/api/filters', { body: { action: 'add', url: 'https://example.com/jobs?q=x' } })).status, 400);

    assert.equal((await t.call('POST', '/api/filters', { body: { action: 'remove', name: 'React Native' } })).status, 200);
    assert.deepEqual((await t.call('GET', '/api/jobs')).body.jobs, []);
    assert.equal(await t.store.isSeen(SOURCE, 'job-React Native'), false, 'forgotten, so re-adding the filter finds it again');
    assert.equal((await t.call('POST', '/api/filters', { body: { action: 'remove', name: 'Nope' } })).status, 404);
  } finally {
    await t.close();
  }
});

test('"Search now" searches the chosen filter; review states filter the list', async () => {
  const t = await start();
  try {
    await t.login();
    await t.store.addFilter({ name: 'React', url: 'https://www.upwork.com/nx/search/jobs?q=react', enabled: true });
    await t.store.addFilter({ name: 'Node', url: 'https://www.upwork.com/nx/search/jobs?q=node', enabled: true });
    const r = await t.call('POST', '/api/search', { body: { filter: 'React' } });
    assert.equal(r.body.status, 'finished');
    assert.equal(t.src.calls, 1);
    assert.equal((await t.call('POST', '/api/jobs', { body: { source: SOURCE, jobId: 'job-React', state: 'saved' } })).status, 200);
    assert.equal((await t.call('POST', '/api/jobs', { body: { source: SOURCE, jobId: 'job-React', state: 'hacked' } })).status, 400);
    const saved = (await t.call('GET', '/api/jobs?state=saved')).body.jobs as { jobId: string }[];
    assert.deepEqual(saved.map((j) => j.jobId), ['job-React']);
  } finally {
    await t.close();
  }
});

test('a reviewed job moves to its own tab; a deleted job is gone and never fetched again', async () => {
  const t = await start();
  try {
    await t.login();
    for (const n of ['React', 'Node', 'Vue']) await t.store.addFilter({ name: n, url: `https://www.upwork.com/nx/search/jobs?q=${n}`, enabled: true });
    await t.call('POST', '/api/search', { body: {} });
    const ids = async (q = '') => ((await t.call('GET', `/api/jobs${q}`)).body.jobs as { jobId: string }[]).map((j) => j.jobId).sort();
    assert.deepEqual(await ids(), ['job-Node', 'job-React', 'job-Vue']);

    await t.call('POST', '/api/jobs', { body: { source: SOURCE, jobId: 'job-React', state: 'reviewed' } });
    assert.equal((await t.call('POST', '/api/jobs', { body: { source: SOURCE, jobId: 'job-Node', state: 'dismissed' } })).status, 400, 'no more "dismissed"');
    assert.equal((await t.call('POST', '/api/jobs', { body: { source: SOURCE, jobId: 'job-Node', delete: true } })).status, 200);
    assert.equal((await t.call('POST', '/api/jobs', { body: { source: SOURCE, jobId: 'job-Node', delete: true } })).status, 404);
    await t.call('POST', '/api/jobs', { body: { source: SOURCE, jobId: 'job-Vue', state: 'saved' } });
    assert.deepEqual(await ids(), ['job-Vue'], 'saved jobs stay in All; reviewed and deleted ones move out');
    assert.deepEqual(await ids('?state=reviewed'), ['job-React']);

    await t.call('POST', '/api/search', { body: { filter: 'Node' } });
    assert.deepEqual(await ids('?filter=Node'), [], 'a deleted job is not fetched again');
    assert.deepEqual(await ids('?filter=React'), [], 'also when one filter is selected');
    const s = (await t.call('GET', '/api/state')).body as { filters: { name: string; total: number }[] };
    assert.deepEqual(s.filters.map((f) => [f.name, f.total]), [['React', 0], ['Node', 0], ['Vue', 1]], 'sidebar counts match the All list');

    await t.call('POST', '/api/jobs', { body: { source: SOURCE, jobId: 'job-React', state: 'new' } });
    assert.deepEqual(await ids(), ['job-React', 'job-Vue'], '"Mark new" brings it back');
  } finally {
    await t.close();
  }
});

test('"Connect Upwork": needs a login; finishing accepts only a loopback callback with its own single-use state', async () => {
  const t = await start();
  try {
    assert.equal((await t.call('POST', '/api/upwork/connect', { body: {} })).status, 401);
    assert.equal((await t.call('POST', '/api/upwork/finish', { body: { url: 'http://127.0.0.1:53682/callback?code=a&state=b' } })).status, 401);
    await t.login();
    const finish = async (url: string) => String((await t.call('POST', '/api/upwork/finish', { body: { url } })).body.error);
    assert.match(await finish('not a url'), /not a web address/);
    assert.match(await finish('https://evil.example/callback?code=a&state=b'), /not the address Upwork sent you to/);
    assert.match(await finish('http://127.0.0.1:53682/callback?error=access_denied'), /Upwork returned: access_denied/);
    assert.match(await finish('http://127.0.0.1:53682/callback?state=x'), /no sign-in code/);
    // A code from another (or a finished) attempt never reaches Upwork.
    assert.match(await finish('http://127.0.0.1:53682/callback?code=abc&state=forged'), /older or already finished attempt/);
  } finally {
    await t.close();
  }
});
