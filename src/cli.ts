import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dbPath, discoveryPath, makeSender, runOnce } from './app.ts';
import { ConfigError, loadConfig, loadEnvFile } from './config.ts';
import { startDashboard } from './dashboard/server.ts';
import { Store } from './db.ts';
import { loadFilters, type FilterDef } from './filters.ts';
import { configureLog, log } from './log.ts';
import { discover, loadDiscovery, saveDiscovery } from './mcp/discover.ts';
import { connectUpwork, tokenVault } from './mcp/session.ts';
import type { RunSummary } from './run.ts';
import type { JobSource } from './sources/types.ts';
import { UpworkMcpSource } from './sources/upwork-mcp.ts';
import { escapeHtml } from './telegram.ts';
import { startWatch } from './watch.ts';

const out = (s = '') => process.stdout.write(`${s}\n`);

function args() {
  const a = process.argv.slice(2);
  const flag = (name: string) => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? (a[i + 1] ?? '') : null;
  };
  return { command: a[0] ?? 'help', filter: flag('filter') };
}

function printFilterReport(filters: FilterDef[], source: JobSource | null) {
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
  if (s.status === 'locked') {
    out('Another run is in progress (or crashed less than 30 minutes ago). Try again shortly.');
    return;
  }
  out(`\nRun finished: ${s.status.toUpperCase()}`);
  for (const f of s.filters) {
    const bits = [`${f.returned} returned`, `${f.accepted} matched`, f.rejectedLocally ? `${f.rejectedLocally} rejected by local check` : null, f.baselineRun ? 'first search of this filter' : null]
      .filter(Boolean)
      .join(', ');
    out(`  • ${f.name}: ${f.error ? `ERROR: ${f.error}` : bits}`);
    if (f.ignoredFilters.length) out(`      Upwork did NOT apply: ${f.ignoredFilters.join(', ')}`);
    if (f.emptyReason) out(`      Upwork: ${f.emptyReason}`);
    if (f.moreResultsNotFetched) out('      Upwork has older results that were not fetched (page limit: FIRST_RUN_MAX_PAGES / MAX_PAGES_PER_FILTER).');
  }
  out(`  New jobs: ${s.newJobs}, alerts queued: ${s.alertsQueued}, sent: ${s.delivery.sent}, retrying: ${s.delivery.retrying}, failed: ${s.delivery.failed}`);
  if (s.recoveredFromPreviousRun) out(`  Delivered ${s.recoveredFromPreviousRun} alert(s) left over from an earlier run.`);
  if (s.stoppedEarly) out(`  Stopped early: ${s.stoppedEarly}`);
}

async function main() {
  loadEnvFile();
  const a = args();
  const cfg = loadConfig(process.env);
  configureLog(cfg.logLevel, join(cfg.dataDir, 'app.log'));

  switch (a.command) {
    case 'connect': {
      if (!cfg.upwork.tokenKey) throw new ConfigError('Set TOKEN_ENCRYPTION_KEY in .env first (see .env.example).');
      out('Connecting to the official Upwork MCP server. You sign in to Upwork yourself in the browser;');
      out('this app never sees your password. Upwork currently grants the full MCP scope set to connected apps.');
      const caller = await connectUpwork(cfg, { interactive: true });
      const tools = await caller.listTools();
      await caller.close();
      out(`\nConnected. The server exposes ${tools.length} tool(s). Next: npm run discover`);
      return;
    }
    case 'discover': {
      const caller = await connectUpwork(cfg, { interactive: false });
      try {
        const d = await discover(caller, { serverUrl: cfg.upwork.mcpUrl, accountName: cfg.upwork.accountName });
        saveDiscovery(discoveryPath(cfg), d);
        out(`Mode: ${d.mode} · Account: ${d.account.name} (${d.account.roleLabel})`);
        if (d.otherAccounts.length) out(`Other accounts: ${d.otherAccounts.map((x) => `${x.name} (${x.roleLabel})`).join(', ')} — set UPWORK_ACCOUNT_NAME to choose.`);
        out(`find_jobs search parameters found: ${d.findJobs.paramSchema ? Object.keys(d.findJobs.paramSchema.properties).join(', ') : 'NONE (inspect data/discovery.json)'}`);
        out(`Saved ${discoveryPath(cfg)}. No job search was performed.`);
        if (existsSync(cfg.filtersFile)) printFilterReport(loadFilters(cfg.filtersFile), new UpworkMcpSource(caller, d));
        else out('No filters.json yet: copy filters.example.json to filters.json, then run "npm run filters" to see the mapping.');
      } finally {
        await caller.close();
      }
      return;
    }
    case 'filters': {
      const filters = loadFilters(cfg.filtersFile);
      const d = loadDiscovery(discoveryPath(cfg));
      const src = d ? new UpworkMcpSource({ listTools: async () => [], callTool: async () => ({}), close: async () => {} }, d) : null;
      out(`Filters (${filters.length}) — interpretation${src ? ` and what is sent to ${src.name}` : ' (run "npm run discover" to see the live mapping)'}:`);
      printFilterReport(filters, src);
      out('\nAnything NOT SENT is still enforced by the local check on returned jobs, but jobs the server never returns cannot be recovered.');
      return;
    }
    case 'search': {
      const store = new Store(dbPath(cfg));
      try {
        const s = await runOnce(cfg, store, a.filter);
        printSummary(s);
        if (cfg.telegram.dryRun && cfg.telegram.chatIds.length) out(`\nTelegram dry run: messages written to ${join(cfg.dataDir, 'telegram-dry-run.log')}`);
        process.exitCode = s.status === 'ok' ? 0 : s.status === 'partial' ? 2 : 1;
      } finally {
        store.close();
      }
      return;
    }
    case 'dashboard': {
      const { url } = await startDashboard(cfg, { port: cfg.watch.dashboardPort });
      out(`Job alerts dashboard: ${url}`);
      out('It listens on this computer only. Searches run when you press "Search now"; press Ctrl+C to stop.');
      return;
    }
    case 'watch': {
      const store = new Store(dbPath(cfg));
      let stop: () => Promise<void>;
      try {
        stop = await startWatch(cfg, store);
      } catch (err) {
        store.close();
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          throw new Error(`Port ${cfg.watch.dashboardPort} is busy: the watcher is probably already running (or "npm run dashboard" is open). Stop it first.`);
        }
        throw err;
      }
      out(`Searching every ~${cfg.watch.intervalMinutes} min. Dashboard: http://127.0.0.1:${cfg.watch.dashboardPort}/ · Ctrl+C to stop.`);
      const shutdown = () => {
        log.info('watch: stopping');
        void stop().finally(() => {
          store.close();
          process.exit(0);
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      return;
    }
    case 'test-telegram': {
      if (!cfg.telegram.chatIds.length) throw new ConfigError('Set TELEGRAM_CHAT_ID in .env');
      const s = makeSender(cfg);
      for (const chat of cfg.telegram.chatIds) {
        const r = await s.send(chat, `✅ <b>Upwork Job Alert Lite</b>\nTest message to chat ${escapeHtml(chat)} at ${new Date().toISOString()}.`);
        out(`Sent to ${chat} (message ${r.messageId})${cfg.telegram.dryRun ? ' — DRY RUN, nothing was sent to Telegram' : ''}`);
      }
      return;
    }
    case 'status': {
      const store = new Store(dbPath(cfg));
      const s = store.stats();
      store.close();
      const d = loadDiscovery(discoveryPath(cfg));
      out(`Upwork discovery: ${d ? `${d.discoveredAt} (${d.account.name})` : 'not done'}`);
      out(`Seen jobs: ${s.seenJobs} · alerts sent: ${s.alertsSent}, pending: ${s.alertsPending}, failed: ${s.alertsFailed}`);
      for (const r of s.lastRuns as { id: number; source: string; started_at: string; status: string }[]) out(`  run #${r.id} ${r.started_at} ${r.source} ${r.status}`);
      return;
    }
    case 'purge': {
      const store = new Store(dbPath(cfg));
      out(`Purged: ${JSON.stringify(store.purge(cfg.retentionDays))}`);
      store.close();
      return;
    }
    case 'disconnect': {
      tokenVault(cfg).delete();
      out('Local Upwork tokens deleted. Also revoke the app in Upwork: Account Settings → Connected Apps.');
      return;
    }
    default:
      out('Commands: connect | discover | filters | search [--filter NAME] | watch | dashboard | test-telegram | status | purge | disconnect');
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error('command failed', { error: msg });
  process.stderr.write(`\nError: ${msg}\n`);
  process.exitCode = 1;
});
