import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConfigError, loadConfig, loadEnvFile, type Config } from './config.ts';
import { Store, type JobDetails } from './db.ts';
import { getCycle, requestSearch, SOURCE, step, type RunSummary } from './engine.ts';
import { loadFilters, toFilterDefs, type FilterDef } from './filters.ts';
import { configureLog, log } from './log.ts';
import { discover, loadDiscovery, saveDiscovery, type Discovery } from './mcp/discover.ts';
import { connectUpwork, OAUTH_KV_KEY, tokenVault } from './mcp/session.ts';
import { UpworkMcpSource } from './sources/upwork-mcp.ts';
import { startDevServer } from './web/dev.ts';

const out = (s = '') => process.stdout.write(`${s}\n`);

function args() {
  const a = process.argv.slice(2);
  const flag = (name: string) => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? (a[i + 1] ?? '') : null;
  };
  return { command: a[0] ?? 'help', filter: flag('filter'), from: flag('from'), noScheduler: a.includes('--no-scheduler') };
}

function where(cfg: Config): string {
  return cfg.db.url.startsWith('file:') ? `local database ${cfg.db.url}` : `Turso database ${new URL(cfg.db.url).host}`;
}

function printFilterReport(filters: FilterDef[], discovery: Discovery | null) {
  const source = discovery ? new UpworkMcpSource({ listTools: async () => [], callTool: async () => ({}), close: async () => {} }, discovery) : null;
  for (const f of filters) {
    out(`\n■ ${f.name}${f.enabled ? '' : ' (disabled)'}`);
    out(`  ${f.url}`);
    for (const p of f.params) out(`  ${p.status.padEnd(11)} ${p.key}=${p.value}  →  ${p.note}`);
    if (source) {
      const m = source.describeMapping(f);
      for (const a of m.applied) out(`  sent       ${a}`);
      for (const n of m.notApplied) out(`  NOT SENT   ${n}`);
    }
  }
}

function printSummary(s: RunSummary) {
  out(`\nSearch finished: ${s.status.toUpperCase()}`);
  for (const f of s.filters) {
    const bits = [`${f.returned} returned`, `${f.accepted} matched`, `${f.newJobs} new`, f.rejectedLocally ? `${f.rejectedLocally} rejected by local check` : null, f.firstRun ? 'first search of this filter' : null]
      .filter(Boolean)
      .join(', ');
    out(`  • ${f.name}: ${f.error ? `ERROR: ${f.error}` : bits}`);
    if (f.ignoredFilters.length) out(`      Upwork did NOT apply: ${f.ignoredFilters.join(', ')}`);
    if (f.emptyReason) out(`      Upwork: ${f.emptyReason}`);
    if (f.moreResultsNotFetched) out('      Upwork has older results that were not fetched (page limit: FIRST_RUN_MAX_PAGES / MAX_PAGES_PER_FILTER).');
  }
  out(`  New jobs: ${s.newJobs}`);
  if (s.stoppedEarly) out(`  Stopped early: ${s.stoppedEarly}`);
}

/**
 * Copies what the old file-based version kept on this PC into the database:
 * filters.json, the encrypted Upwork sign-in, the discovered schema, and the saved jobs.
 */
async function importLegacy(cfg: Config, store: Store, from: string) {
  const dir = resolve(from);
  const filtersFile = existsSync(join(dir, 'filters.json')) ? join(dir, 'filters.json') : resolve('filters.json');
  if (existsSync(filtersFile)) {
    let added = 0;
    const existing = await store.listFilters();
    for (const f of loadFilters(filtersFile)) {
      // Skip filters already added in the dashboard: same link, or same name in other capitals.
      const dup = existing.find((e) => e.url.trim() === f.url.trim() || e.name.toLowerCase() === f.name.toLowerCase());
      if (dup) out(`  kept "${dup.name}" (already in the dashboard${dup.url.trim() === f.url.trim() ? ', same link' : ''}); skipped "${f.name}"`);
      else if (await store.addFilter({ name: f.name, url: f.url, enabled: f.enabled })) added++;
    }
    out(`Filters: ${added} added from ${filtersFile}.`);
  } else out('Filters: no filters.json found; add filters in the dashboard instead.');

  const data = existsSync(join(dir, 'data')) ? join(dir, 'data') : dir;
  const oauth = join(data, 'upwork-oauth.enc');
  if (existsSync(oauth)) {
    // Same encrypted text format, same TOKEN_ENCRYPTION_KEY: copied as is, never decrypted here.
    await store.kvSet(OAUTH_KV_KEY, readFileSync(oauth, 'utf8').trim());
    out('Upwork sign-in: copied (still encrypted with your TOKEN_ENCRYPTION_KEY).');
  } else out('Upwork sign-in: none found; run "npm run connect".');
  const disc = join(data, 'discovery.json');
  if (existsSync(disc)) {
    await saveDiscovery(store, JSON.parse(readFileSync(disc, 'utf8')) as Discovery);
    out('Upwork discovery: copied.');
  }

  const legacyDb = join(data, 'jobs.sqlite');
  if (existsSync(legacyDb)) {
    const old = new DatabaseSync(legacyDb, { readOnly: true });
    const rows = old.prepare('SELECT d.*, (SELECT json_group_array(filter_name) FROM job_matches m WHERE m.source = d.source AND m.job_id = d.job_id) AS filters FROM job_details d').all() as Record<string, unknown>[];
    let jobs = 0;
    for (const r of rows) {
      const details: JobDetails = {
        id: String(r.job_id),
        title: String(r.title),
        url: (r.url as string | null) ?? null,
        budget: String(r.budget ?? ''),
        contractType: (r.contract_type as string | null) ?? null,
        postedAt: (r.posted_at as string | null) ?? null,
        snippet: (r.snippet as string | null) ?? null,
        skills: JSON.parse(String(r.skills ?? '[]')) as string[],
        clientCountry: (r.client_country as string | null) ?? null,
        clientPaymentVerified: r.payment_verified === null || r.payment_verified === undefined ? null : r.payment_verified === 1,
        proposals: (r.proposals as string | null) ?? null,
      };
      for (const filter of JSON.parse(String(r.filters ?? '[]')) as string[]) await store.saveJobs(SOURCE, filter, [{ details, baseline: r.baseline === 1 }]);
      if (r.review_state !== 'new') await store.setReviewState(SOURCE, details.id, String(r.review_state) as 'saved');
      jobs++;
    }
    for (const b of old.prepare('SELECT filter_name FROM filter_baselines').all() as { filter_name: string }[]) await store.completeBaseline(SOURCE, b.filter_name);
    old.close();
    out(`Saved jobs: ${jobs} copied (they keep their 30-day limit from the time they are copied).`);
  }
}

async function main() {
  loadEnvFile();
  const a = args();
  const cfg = loadConfig(process.env);
  configureLog(cfg.logLevel, join(cfg.dev.dataDir, 'app.log'));
  const store = Store.open(cfg.db.url, cfg.db.authToken);

  switch (a.command) {
    case 'connect': {
      if (!cfg.upwork.tokenKey) throw new ConfigError('Set TOKEN_ENCRYPTION_KEY in .env first (see .env.example).');
      out(`Connecting to the official Upwork MCP server (sign-in saved in the ${where(cfg)}).`);
      out('You sign in to Upwork yourself in the browser; this app never sees your password.');
      const caller = await connectUpwork(cfg, store, { interactive: true });
      const tools = await caller.listTools();
      await caller.close();
      out(`\nConnected. The server exposes ${tools.length} tool(s). Next: npm run discover`);
      return;
    }
    case 'discover': {
      const caller = await connectUpwork(cfg, store, { interactive: false });
      try {
        const d = await discover(caller, { serverUrl: cfg.upwork.mcpUrl, accountName: cfg.upwork.accountName });
        await saveDiscovery(store, d);
        out(`Mode: ${d.mode} · Account: ${d.account.name} (${d.account.roleLabel})`);
        if (d.otherAccounts.length) out(`Other accounts: ${d.otherAccounts.map((x) => `${x.name} (${x.roleLabel})`).join(', ')} — set UPWORK_ACCOUNT_NAME to choose.`);
        out(`find_jobs search parameters found: ${d.findJobs.paramSchema ? Object.keys(d.findJobs.paramSchema.properties).join(', ') : 'NONE'}`);
        out(`Saved in the ${where(cfg)}. No job search was performed.`);
        printFilterReport(toFilterDefs(await store.listFilters()), d);
      } finally {
        await caller.close();
      }
      return;
    }
    case 'import': {
      out(`Importing into the ${where(cfg)}…`);
      await importLegacy(cfg, store, a.from ?? '.');
      return;
    }
    case 'filters': {
      const filters = toFilterDefs(await store.listFilters());
      const d = await loadDiscovery(store);
      out(`Filters (${filters.length}) — interpretation${d ? ' and what is sent to Upwork' : ' (run "npm run discover" to see the live mapping)'}:`);
      printFilterReport(filters, d);
      return;
    }
    case 'search': {
      await requestSearch(store, a.filter);
      for (;;) {
        // No request timeout here, unlike a scheduler call: work in longer slices.
        const r = await step({ store, cfg }, 240_000);
        if (r.status === 'finished') {
          printSummary(r.summary);
          process.exitCode = r.summary.status === 'ok' ? 0 : r.summary.status === 'partial' ? 2 : 1;
          return;
        }
        if (r.status === 'idle') return out('Nothing to search: add a filter first (dashboard or "npm run import").');
        if (r.status === 'busy') out('Another search is running; waiting…');
        else out(`…${r.progress.tasksDone}/${r.progress.tasksTotal} searches done, ${r.progress.newJobs} new so far`);
        await new Promise((ok) => setTimeout(ok, r.status === 'continued' ? 0 : 15_000));
      }
    }
    case 'dev': {
      const { url } = await startDevServer(cfg, store, { scheduler: !a.noScheduler });
      out(`Dashboard: ${url} (this computer only)${a.noScheduler ? '' : ` · searching every ~${cfg.intervalMinutes} min while this runs`}`);
      out(`Database: ${where(cfg)} · Ctrl+C to stop.`);
      return;
    }
    case 'status': {
      const d = await loadDiscovery(store);
      out(`Database: ${where(cfg)}`);
      out(`Upwork: ${d ? `connected as ${d.account.name} (discovered ${d.discoveredAt})` : 'not connected (npm run connect, then npm run discover)'}`);
      out(`Filters: ${(await store.listFilters()).map((f) => f.name).join(', ') || 'none'}`);
      out(`Jobs seen (last ${cfg.retentionDays} days): ${await store.seenCount()}`);
      const c = await getCycle(store);
      if (c) out(`Search in progress since ${c.startedAt}: ${c.tasks.filter((t) => t.done).length}/${c.tasks.length} done`);
      for (const r of await store.lastRuns()) out(`  run #${r.id} ${r.started_at} ${r.status}`);
      return;
    }
    case 'purge': {
      await store.purge(cfg.retentionDays);
      out(`Deleted job data older than ${cfg.retentionDays} days.`);
      return;
    }
    case 'disconnect': {
      await tokenVault(cfg, store).delete();
      out('Stored Upwork sign-in deleted. Also revoke the app in Upwork: Account Settings → Connected Apps.');
      return;
    }
    default:
      out('Commands: connect | discover | import [--from DIR] | filters | search [--filter NAME] | dev [--no-scheduler] | status | purge | disconnect');
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error('command failed', { error: msg });
  process.stderr.write(`\nError: ${msg}\n`);
  process.exitCode = 1;
});
