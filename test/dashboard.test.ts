import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { startDashboard } from '../src/dashboard/server.ts';
import { Store } from '../src/db.ts';
import type { RunSummary } from '../src/run.ts';

const dir = mkdtempSync(join(tmpdir(), 'dash-'));
writeFileSync(join(dir, 'filters.json'), JSON.stringify([
  { name: 'Full Stack', url: 'https://www.upwork.com/nx/search/jobs?q=full%20stack&sort=recency', enabled: true },
  { name: 'Shopify', url: 'https://www.upwork.com/nx/search/jobs?q=shopify', enabled: false },
]));
const cfg = loadConfig({ DATA_DIR: dir, FILTERS_FILE: join(dir, 'filters.json') } as NodeJS.ProcessEnv);
const store = new Store(':memory:');
let runs = 0;
const fakeSummary: RunSummary = { status: 'ok', source: 'upwork-mcp', filters: [], newJobs: 0, alertsQueued: 0, delivery: { sent: 0, retrying: 0, failed: 0 }, recoveredFromPreviousRun: 0, stoppedEarly: null };
let dash: Awaited<ReturnType<typeof startDashboard>>;
let token = '';

function call(method: string, path: string, opts: { body?: unknown; token?: string; host?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: '127.0.0.1',
        port: dash.port,
        path,
        method,
        headers: {
          host: opts.host ?? `127.0.0.1:${dash.port}`,
          ...(data ? { 'content-type': 'application/json' } : {}),
          ...(opts.token ? { 'x-dashboard-token': opts.token } : {}),
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

before(async () => {
  store.saveJobDetails('upwork-mcp', { id: 'j1', title: '<img src=x onerror=alert(1)> Full stack dev', url: 'https://www.upwork.com/jobs/~021', budget: 'Hourly · $10–$30/hr', contractType: 'HOURLY', postedAt: new Date().toISOString(), snippet: 's', skills: ['React'], clientCountry: 'Germany', clientPaymentVerified: true, proposals: 'Fewer than 5' }, false);
  store.recordMatch('upwork-mcp', 'j1', 'Full Stack');
  store.saveJobDetails('upwork-mcp', { id: 'j2', title: 'Old job', url: null, budget: 'Not provided', contractType: null, postedAt: null, snippet: null, skills: [] }, true);
  store.recordMatch('upwork-mcp', 'j2', 'Full Stack');
  dash = await startDashboard(cfg, { port: 0 }, { store, run: async () => { runs++; return fakeSummary; } });
  const page = await call('GET', '/');
  token = /name="dashboard-token" content="([^"]+)"/.exec(page.body)![1]!;
});
after(async () => {
  await dash.close();
  store.close();
});

test('serves the page with a per-process token and strict headers', async () => {
  assert.ok(token.length >= 20);
  const js = await call('GET', '/app.js');
  assert.equal(js.status, 200);
  // Data is only ever rendered as text: no HTML-injection sinks in the client.
  assert.doesNotMatch(js.body, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/);
});

test('rejects requests with an unexpected Host header (DNS rebinding)', async () => {
  assert.equal((await call('GET', '/api/state', { host: 'evil.example:80' })).status, 421);
});

test('state lists filters with counts (every unreviewed job counts as new)', async () => {
  const s = JSON.parse((await call('GET', '/api/state')).body);
  assert.deepEqual(s.filters.map((f: { name: string; total: number; newCount: number; enabled: boolean }) => [f.name, f.total, f.newCount, f.enabled]), [
    ['Full Stack', 2, 2, true],
    ['Shopify', 0, 0, false],
  ]);
  assert.equal(s.telegram.dryRun, true);
});

test('lists jobs by filter and state, returning raw text for safe rendering', async () => {
  const { jobs } = JSON.parse((await call('GET', '/api/jobs?filter=Full%20Stack&state=new')).body);
  assert.equal(jobs.length, 2);
  const j = jobs.find((x: { jobId: string }) => x.jobId === 'j1');
  assert.equal(j.title, '<img src=x onerror=alert(1)> Full stack dev');
  assert.deepEqual([j.clientCountry, j.clientPaymentVerified, j.proposals, j.filters], ['Germany', true, 'Fewer than 5', ['Full Stack']]);
});

test('state-changing requests need the page token', async () => {
  assert.equal((await call('POST', '/api/jobs/state', { body: { source: 'upwork-mcp', jobId: 'j1', state: 'saved' } })).status, 403);
  assert.equal((await call('POST', '/api/search', { body: {}, token: 'wrong-token-value-xxxxxxxxx' })).status, 403);
  assert.equal(runs, 0);
});

test('saves a job and filters by review state', async () => {
  assert.equal((await call('POST', '/api/jobs/state', { body: { source: 'upwork-mcp', jobId: 'j1', state: 'saved' }, token })).status, 200);
  assert.equal((await call('POST', '/api/jobs/state', { body: { source: 'upwork-mcp', jobId: 'j1', state: 'hacked' }, token })).status, 400);
  const { jobs } = JSON.parse((await call('GET', '/api/jobs?state=saved')).body);
  assert.deepEqual(jobs.map((j: { jobId: string }) => j.jobId), ['j1']);
});

test('"Search now" runs exactly one user-started search', async () => {
  const r = await call('POST', '/api/search', { body: { filter: 'Full Stack' }, token });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).status, 'ok');
  assert.equal(runs, 1);
});

test('adds a filter from an Upwork link, searches it, and refuses bad or duplicate links', async () => {
  const before = runs;
  const link = 'https://www.upwork.com/nx/search/jobs?q=react%20native&hourly_rate=20-80&t=0';
  const ok = await call('POST', '/api/filters/add', { body: { url: link }, token });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).name, 'React Native');
  const saved = JSON.parse(readFileSync(join(dir, 'filters.json'), 'utf8')) as { name: string; url: string }[];
  assert.deepEqual(saved.map((f) => f.name), ['Full Stack', 'Shopify', 'React Native']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs, before + 1, 'the new filter is searched right away');

  const dup = await call('POST', '/api/filters/add', { body: { url: link }, token });
  assert.match(JSON.parse(dup.body).error, /already one of your filters/);
  const unsupported = await call('POST', '/api/filters/add', { body: { url: 'https://www.upwork.com/nx/search/jobs?q=x&contractor_tier=3' }, token });
  assert.equal(unsupported.status, 400);
  assert.match(JSON.parse(unsupported.body).error, /contractor_tier/);
  const notUpwork = await call('POST', '/api/filters/add', { body: { url: 'https://example.com/jobs?q=x' }, token });
  assert.equal(notUpwork.status, 400);
  assert.equal((await call('POST', '/api/filters/add', { body: { url: link } })).status, 403, 'needs the dashboard token');
});

test('removing a filter drops it from filters.json and its jobs from the dashboard', async () => {
  store.saveJobDetails('upwork-mcp', { id: 'rn1', title: 'RN app', url: null, budget: '', contractType: null, postedAt: null, snippet: null, skills: [] }, false);
  store.recordMatch('upwork-mcp', 'rn1', 'React Native');
  assert.ok(JSON.parse((await call('GET', '/api/jobs')).body).jobs.some((j: { jobId: string }) => j.jobId === 'rn1'));
  assert.equal((await call('POST', '/api/filters/remove', { body: { name: 'React Native' }, token })).status, 200);
  const saved = JSON.parse(readFileSync(join(dir, 'filters.json'), 'utf8')) as { name: string }[];
  assert.deepEqual(saved.map((f) => f.name), ['Full Stack', 'Shopify']);
  assert.ok(!JSON.parse((await call('GET', '/api/jobs')).body).jobs.some((j: { jobId: string }) => j.jobId === 'rn1'));
  assert.equal(store.isSeen('upwork-mcp', 'rn1'), false, 'forgotten, so re-adding the filter finds it again');
  assert.equal((await call('POST', '/api/filters/remove', { body: { name: 'Nope' }, token })).status, 404);
});
