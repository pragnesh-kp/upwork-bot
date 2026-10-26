import { join } from 'node:path';
import { ConfigError, type Config } from './config.ts';
import type { Store } from './db.ts';
import { loadFilters } from './filters.ts';
import { loadDiscovery } from './mcp/discover.ts';
import { connectUpwork } from './mcp/session.ts';
import { runSearch, type RunSummary } from './run.ts';
import type { JobSource } from './sources/types.ts';
import { UpworkMcpSource } from './sources/upwork-mcp.ts';
import { dryRunSender, telegramClient, type TelegramSender } from './telegram.ts';

export const discoveryPath = (cfg: Config) => join(cfg.dataDir, 'discovery.json');
export const dbPath = (cfg: Config) => join(cfg.dataDir, 'jobs.sqlite');

export function makeSender(cfg: Config): TelegramSender {
  if (cfg.telegram.dryRun || !cfg.telegram.token) return dryRunSender(join(cfg.dataDir, 'telegram-dry-run.log'));
  return telegramClient(cfg.telegram.token, cfg.telegram.apiBase);
}

export async function openSource(cfg: Config): Promise<JobSource> {
  const d = loadDiscovery(discoveryPath(cfg));
  if (!d) throw new ConfigError('No Upwork MCP discovery yet. Run "npm run connect" and then "npm run discover".');
  return new UpworkMcpSource(await connectUpwork(cfg, { interactive: false }), d);
}

/** One search run over the enabled filters (CLI, dashboard button or the watch loop). */
export async function runOnce(cfg: Config, store: Store, onlyFilter: string | null = null): Promise<RunSummary> {
  const filters = loadFilters(cfg.filtersFile);
  const source = await openSource(cfg);
  try {
    return await runSearch({
      store,
      source,
      filters,
      sender: makeSender(cfg),
      chatIds: cfg.telegram.chatIds,
      maxPagesPerFilter: cfg.search.maxPagesPerFilter,
      firstRunMaxPages: cfg.search.firstRunMaxPages,
      pageSize: cfg.search.pageSize,
      delayBetweenSearchesMs: cfg.search.delayBetweenSearchesMs,
      alertOnFirstRun: cfg.search.alertOnFirstRun,
      descriptionMaxChars: cfg.descriptionMaxChars,
      retentionDays: cfg.retentionDays,
      onlyFilter,
    });
  } finally {
    await source.close();
  }
}
