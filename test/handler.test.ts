import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { SOURCE } from '../src/engine.ts';
import type { FilterDef } from '../src/filters.ts';
import type { Job, JobSource, SearchPage } from '../src/sources/types.ts';
import { createHandler } from '../src/web/handler.ts';

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

async function start(env: Record<string, string> = { DASHBOARD_PASSWORD: PASSWORD, CRON_SECRET: CRON }) {
  const store = Store.open(':memory:');
  const src = new FakeSource();
  const cfg = loadConfig({ DATA_DIR: 'data', TURSO_DATABASE_URL: 'file::memory:', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), DELAY_BETWEEN_SEARCHES_MS: '0', ...env } as NodeJS.ProcessEnv);
  const handler = createHandler({ store, cfg, engine: { openSource: async () => src, sleep: async () => {} } });
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
    assert.equal((await t.call('POST', '/api/filters/remove', { body: { name: 'x' }, noCsrf: true })).status, 403);
    assert.equal((await t.call('POST', '/api/filters/remove', { body: { name: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);
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
    const s = (await t.call('GET', '/api/state')).body as { schedule: { lastSchedulerCall: string | null } };
    assert.ok(s.schedule.lastSchedulerCall, 'the dashboard can show when the scheduler last called');
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
    const ok = await t.call('POST', '/api/filters/add', { body: { url: link } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.name, 'React Native');
    const state = (await t.call('GET', '/api/state')).body as { running: unknown; filters: { name: string }[] };
    assert.ok(state.running, 'its first search is queued');
    const r = await t.call('POST', '/api/step', { body: {} });
    assert.equal(r.body.status, 'finished');
    const { jobs } = (await t.call('GET', '/api/jobs')).body as { jobs: { jobId: string; filters: string[] }[] };
    assert.deepEqual(jobs.map((j) => [j.jobId, j.filters]), [['job-React Native', ['React Native']]]);

    assert.match(String((await t.call('POST', '/api/filters/add', { body: { url: link } })).body.error), /already one of your filters/);
    const unsupported = await t.call('POST', '/api/filters/add', { body: { url: 'https://www.upwork.com/nx/search/jobs?q=x&contractor_tier=3' } });
    assert.equal(unsupported.status, 400);
    assert.match(String(unsupported.body.error), /contractor_tier/);
    assert.equal((await t.call('POST', '/api/filters/add', { body: { url: 'https://example.com/jobs?q=x' } })).status, 400);

    assert.equal((await t.call('POST', '/api/filters/remove', { body: { name: 'React Native' } })).status, 200);
    assert.deepEqual((await t.call('GET', '/api/jobs')).body.jobs, []);
    assert.equal(await t.store.isSeen(SOURCE, 'job-React Native'), false, 'forgotten, so re-adding the filter finds it again');
    assert.equal((await t.call('POST', '/api/filters/remove', { body: { name: 'Nope' } })).status, 404);
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
    assert.equal((await t.call('POST', '/api/jobs/state', { body: { source: SOURCE, jobId: 'job-React', state: 'saved' } })).status, 200);
    assert.equal((await t.call('POST', '/api/jobs/state', { body: { source: SOURCE, jobId: 'job-React', state: 'hacked' } })).status, 400);
    const saved = (await t.call('GET', '/api/jobs?state=saved')).body.jobs as { jobId: string }[];
    assert.deepEqual(saved.map((j) => j.jobId), ['job-React']);
  } finally {
    await t.close();
  }
});
