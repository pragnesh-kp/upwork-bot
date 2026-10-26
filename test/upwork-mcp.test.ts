import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { parseUpworkSearchUrl, type FilterDef } from '../src/filters.ts';
import { discover, type Discovery } from '../src/mcp/discover.ts';
import { LocalOAuthProvider, TokenVault, type VaultStorage } from '../src/mcp/oauth.ts';
import type { McpCaller } from '../src/mcp/session.ts';
import { SourceError } from '../src/sources/types.ts';
import { UpworkMcpSource } from '../src/sources/upwork-mcp.ts';
import { budgetText, safeUpworkUrl } from '../src/format.ts';

/** In-memory stand-in for the database row that holds the encrypted vault. */
function memoryStorage(): VaultStorage & { text: string | null } {
  const s = {
    text: null as string | null,
    load: async () => s.text,
    save: async (t: string) => void (s.text = t),
    remove: async () => void (s.text = null),
  };
  return s;
}

const p = parseUpworkSearchUrl('https://www.upwork.com/nx/search/jobs?q=Full%20stack%20developer&sort=recency&t=0,1');
if (!p.ok) throw new Error('bad');
const FILTER: FilterDef = { name: 'Full Stack', url: '', enabled: true, criteria: p.criteria, params: p.params };
const text = (o: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });

function fakeCaller(handler: (name: string, args: Record<string, unknown>) => unknown, tools = ['list_accounts', 'search_tools', 'get_tool_help', 'execute_tool']) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const caller: McpCaller = {
    async listTools() {
      return tools.map((name) => ({ name, description: name }));
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return handler(name, args) as never;
    },
    async close() {},
  };
  return { caller, calls };
}

const HELP = { tool: 'find_jobs', actions: [{ name: 'search', params: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, cursor: { type: 'string' } } } }] };

test('discovery follows Upwork\'s workflow and records only metadata', async () => {
  const { caller, calls } = fakeCaller((name) => {
    if (name === 'list_accounts') return text({ accounts: [{ name: 'Client Co', role: 'CLIENT', role_label: 'Client', org_uid: 'c1' }, { name: 'Me', role: 'TALENT', role_label: 'Freelancer', org_uid: 'f1' }] });
    if (name === 'get_tool_help') return text(HELP);
    throw new Error(`unexpected ${name}`);
  });
  const d = await discover(caller, { serverUrl: 'https://mcp.upwork.com/mcp', accountName: null });
  assert.equal(d.mode, 'compact');
  assert.deepEqual(d.account, { name: 'Me', roleLabel: 'Freelancer', role: 'TALENT', orgUid: 'f1' });
  assert.deepEqual(Object.keys(d.findJobs.paramSchema!.properties), ['query', 'limit', 'cursor']);
  assert.deepEqual(calls.map((c) => c.name), ['list_accounts', 'get_tool_help']); // no search, no writes
});

// The live server (26 Oct 2026) namespaces every tool with "upwork__".
const LIVE_TOOLS = 'boost_profile confirm_attachment_upload confirm_draft confirm_preview find_freelancers find_jobs find_saved_jobs get_account get_agency get_draft get_freelancer_dashboard get_freelancer_financials get_messages get_preview get_profile get_tool_help get_upload_status list_accounts list_contracts list_freelancer_proposals list_milestones list_offers manage_meetings manage_proposals respond_to_offer save_job send_message set_tool_mode set_tool_permission start_attachment_upload store_uploaded_files submit_feedback submit_milestones update_profile'
  .split(' ')
  .map((n) => `upwork__${n}`);

test('discovery resolves the live server\'s namespaced tool names and searches with them', async () => {
  const { caller, calls } = fakeCaller((name, args) => {
    if (name === 'upwork__list_accounts') return text({ accounts: [{ name: 'Me', role: 'TALENT', role_label: 'Freelancer', org_uid: 'f1' }] });
    if (name === 'upwork__get_tool_help') return args.tool_name === 'find_jobs' ? text(HELP) : { isError: true, ...text({ error_code: 'not_found' }) };
    if (name === 'upwork__find_jobs') return text({ jobs: [{ ciphertext: '~02z', title: 'Full stack dev' }] });
    throw new Error(`unexpected tool ${name}`);
  }, LIVE_TOOLS);
  const d = await discover(caller, { serverUrl: 'https://mcp.upwork.com/mcp', accountName: null });
  assert.equal(d.mode, 'full');
  assert.deepEqual(d.toolNames, { findJobs: 'upwork__find_jobs', executeTool: null, listAccounts: 'upwork__list_accounts', getToolHelp: 'upwork__get_tool_help' });
  assert.ok(d.findJobs.paramSchema);

  const page = await new UpworkMcpSource(caller, d).search(FILTER, null, 20);
  assert.equal(page.jobs.length, 1);
  assert.equal(calls.at(-1)!.name, 'upwork__find_jobs');
  // Discovery itself never searched or wrote anything.
  assert.deepEqual(calls.slice(0, -1).map((c) => c.name), ['upwork__list_accounts', 'upwork__get_tool_help']);
});

test('discovery falls back to the find_jobs input schema when get_tool_help fails', async () => {
  const caller: McpCaller = {
    async listTools() {
      return LIVE_TOOLS.map((name) =>
        name === 'upwork__find_jobs'
          ? { name, inputSchema: { type: 'object', properties: { action: { enum: ['search', 'smart_search'] }, org_uid: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } } } }
          : { name },
      );
    },
    async callTool(name) {
      if (name === 'upwork__list_accounts') return text({ accounts: [{ name: 'Me', role: 'TALENT', org_uid: 'f1' }] }) as never;
      return { isError: true, ...text({ error_code: 'unavailable' }) } as never;
    },
    async close() {},
  };
  const d = await discover(caller, { serverUrl: 'x', accountName: null });
  assert.equal(d.findJobs.paramsLocation, 'top-level');
  assert.ok(d.findJobs.paramSchema && 'query' in d.findJobs.paramSchema.properties);
  assert.equal(d.findJobs.helpErrors.length, 4);
});

test('discovery refuses accounts without job search and suspended accounts', async () => {
  const onlyClient = fakeCaller(() => text({ accounts: [{ name: 'Client Co', role: 'CLIENT', org_uid: 'c1' }] }));
  await assert.rejects(discover(onlyClient.caller, { serverUrl: 'x', accountName: null }), /freelancer/);
  const suspended = fakeCaller(() => text({ accounts: [{ name: 'Me', role: 'TALENT', org_uid: 'f1', suspended: true }] }));
  await assert.rejects(discover(suspended.caller, { serverUrl: 'x', accountName: null }), /suspended/);
});

const DISCOVERY: Discovery = {
  discoveredAt: '',
  serverUrl: '',
  mode: 'compact',
  toolNames: { findJobs: null, executeTool: 'execute_tool', listAccounts: 'list_accounts', getToolHelp: 'get_tool_help' },
  account: { name: 'Me', roleLabel: 'Freelancer', role: 'TALENT', orgUid: 'f1' },
  otherAccounts: [],
  findJobs: { paramsLocation: 'nested', paramSchema: { properties: HELP.actions[0]!.params.properties }, inputSchema: null, help: HELP, helpErrors: [] },
  tools: [],
};

test('compact mode calls execute_tool with org_uid, role and schema-valid params', async () => {
  const { caller, calls } = fakeCaller(() => text({ jobs: [{ ciphertext: '~02a', title: 'Full stack dev' }], next_cursor: 'c2' }));
  const page = await new UpworkMcpSource(caller, DISCOVERY).search(FILTER, null, 20);
  assert.equal(page.jobs[0]!.url, 'https://www.upwork.com/jobs/~02a');
  assert.equal(page.nextCursor, 'c2');
  assert.deepEqual(calls[0], {
    name: 'execute_tool',
    args: { tool_name: 'find_jobs', action: 'search', org_uid: 'f1', role: 'TALENT', params: { query: 'Full stack developer', limit: 20 } },
  });
});

test('full mode calls find_jobs directly', async () => {
  const { caller, calls } = fakeCaller(() => text({ jobs: [] }));
  await new UpworkMcpSource(caller, { ...DISCOVERY, mode: 'full', toolNames: { ...DISCOVERY.toolNames, findJobs: 'find_jobs' }, findJobs: { ...DISCOVERY.findJobs, paramsLocation: 'top-level' } }).search(FILTER, 'c2', 20);
  assert.deepEqual(calls[0], { name: 'find_jobs', args: { action: 'search', org_uid: 'f1', query: 'Full stack developer', limit: 20, cursor: 'c2' } });
});

test('maps Upwork tool errors to retry / stop decisions', async () => {
  const cases: [unknown, SourceError['kind']][] = [
    [{ isError: true, ...text({ error_code: 'rate_limited', retry_after_seconds: 30 }) }, 'rate_limited'],
    [{ isError: true, ...text({ error_code: 'token_expired' }) }, 'auth'],
    [{ isError: true, ...text({ status: 'needs_details', error_code: 'needs_details' }) }, 'permanent'],
    [{ isError: true, ...text({ error_code: 'upstream_unavailable', trace_id: 'tr-9' }) }, 'temporary'],
  ];
  for (const [result, kind] of cases) {
    const { caller } = fakeCaller(() => result);
    const err = await new UpworkMcpSource(caller, DISCOVERY).search(FILTER, null, 20).catch((e: unknown) => e);
    assert.ok(err instanceof SourceError);
    assert.equal(err.kind, kind);
  }
});

test('token vault encrypts before storing and rejects a wrong key', async () => {
  const storage = memoryStorage();
  const v = new TokenVault(storage, Buffer.alloc(32, 1));
  await v.write({ tokens: { access_token: 'secret-access', token_type: 'Bearer' } });
  assert.equal((await v.read()).tokens?.access_token, 'secret-access');
  assert.doesNotMatch(storage.text!, /secret-access/);
  assert.equal(storage.text!.split('.').length, 3, 'same iv.tag.data format as the old upwork-oauth.enc file');
  await assert.rejects(new TokenVault(storage, Buffer.alloc(32, 2)).read(), /decrypt/);
});

function hit(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

test('OAuth callback accepts only the matching state', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const provider = new LocalOAuthProvider({ vault: new TokenVault(memoryStorage(), Buffer.alloc(32, 3)), port, interactive: true });
  const state = await provider.state();

  const bad = assert.rejects(provider.waitForCallback(5000), /state/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await hit(port, '/callback?code=abc&state=forged'), 400);
  await bad;

  const good = provider.waitForCallback(5000);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await hit(port, `/callback?code=abc&state=${state}`), 200);
  assert.equal(await good, 'abc');
});

test('non-interactive runs never open a browser sign-in', () => {
  const provider = new LocalOAuthProvider({ vault: new TokenVault(memoryStorage(), Buffer.alloc(32, 4)), port: 1, interactive: false });
  assert.throws(() => provider.redirectToAuthorization(new URL('https://www.upwork.com/ab/account-security/oauth2/authorize')), /npm run connect/);
});

test('only https upwork.com links are kept; budgets are labelled, missing data says so', () => {
  assert.equal(safeUpworkUrl('javascript:alert(1)'), null);
  assert.equal(safeUpworkUrl('https://evil.example/jobs/1'), null);
  assert.equal(safeUpworkUrl('http://www.upwork.com/jobs/~01'), null);
  assert.equal(safeUpworkUrl('https://www.upwork.com/jobs/~01'), 'https://www.upwork.com/jobs/~01');
  const base = { id: '1', title: 't', url: null, description: null, postedAt: null, fixedBudget: null, hourlyMin: null, hourlyMax: null, currency: 'USD', budgetLabel: null, skills: [] };
  assert.equal(budgetText({ ...base, contractType: 'FIXED', fixedBudget: 2500 }), 'Fixed price · $2,500');
  assert.equal(budgetText({ ...base, contractType: 'HOURLY', hourlyMin: 15, hourlyMax: 45 }), 'Hourly · $15–$45/hr');
  assert.equal(budgetText({ ...base, contractType: null }), 'Not provided');
});
