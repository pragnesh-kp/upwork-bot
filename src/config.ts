import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  dataDir: string;
  filtersFile: string;
  telegram: { token: string | null; chatIds: string[]; dryRun: boolean; apiBase: string };
  upwork: {
    mcpUrl: string;
    callbackPort: number;
    clientMetadataUrl: string | null;
    accountName: string | null;
    tokenKey: Buffer | null;
  };
  search: { maxPagesPerFilter: number; firstRunMaxPages: number; pageSize: number; delayBetweenSearchesMs: number; alertOnFirstRun: boolean };
  /** `npm run watch`: minutes between automatic searches, and the dashboard port. */
  watch: { intervalMinutes: number; dashboardPort: number };
  retentionDays: number;
  descriptionMaxChars: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {}

/** Loads `.env` from the working directory (Node built-in, no dependency). Real env vars win. */
export function loadEnvFile(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return def;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false`);
}

const str = (env: NodeJS.ProcessEnv, key: string): string | null => env[key]?.trim() || null;

/** Validates configuration. Error messages never include secret values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = str(env, 'TELEGRAM_BOT_TOKEN');
  if (token && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new ConfigError('TELEGRAM_BOT_TOKEN does not look like a BotFather token');
  const chatIds = (str(env, 'TELEGRAM_CHAT_ID') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of chatIds) {
    if (!/^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/.test(id)) throw new ConfigError(`TELEGRAM_CHAT_ID entry "${id}" is not a numeric chat id or @channel`);
  }

  let tokenKey: Buffer | null = null;
  const rawKey = str(env, 'TOKEN_ENCRYPTION_KEY');
  if (rawKey) {
    tokenKey = Buffer.from(rawKey, 'base64');
    if (tokenKey.length !== 32) throw new ConfigError('TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded');
  }

  const metadataUrl = str(env, 'MCP_CLIENT_METADATA_URL');
  if (metadataUrl && !/^https:\/\/[^/]+\/.+/.test(metadataUrl)) throw new ConfigError('MCP_CLIENT_METADATA_URL must be an https URL with a path');

  const level = (str(env, 'LOG_LEVEL') ?? 'info') as Config['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new ConfigError('LOG_LEVEL must be debug, info, warn or error');

  return {
    dataDir: resolve(str(env, 'DATA_DIR') ?? 'data'),
    filtersFile: resolve(str(env, 'FILTERS_FILE') ?? 'filters.json'),
    telegram: {
      token,
      chatIds,
      dryRun: bool(env, 'TELEGRAM_DRY_RUN', !token),
      apiBase: str(env, 'TELEGRAM_API_BASE') ?? 'https://api.telegram.org',
    },
    upwork: {
      mcpUrl: str(env, 'UPWORK_MCP_URL') ?? 'https://mcp.upwork.com/mcp',
      callbackPort: int(env, 'OAUTH_CALLBACK_PORT', 53682, 1024, 65535),
      clientMetadataUrl: metadataUrl,
      accountName: str(env, 'UPWORK_ACCOUNT_NAME'),
      tokenKey,
    },
    search: {
      // Pages per search target on a normal run. Paging also stops at the first page with no new jobs.
      maxPagesPerFilter: int(env, 'MAX_PAGES_PER_FILTER', 3, 1, 20),
      // Pages per search target on a filter's first run (after adding it or resetting the data).
      firstRunMaxPages: int(env, 'FIRST_RUN_MAX_PAGES', 10, 1, 30),
      // The live find_jobs returns at most 10 jobs per page.
      pageSize: int(env, 'PAGE_SIZE', 10, 1, 10),
      delayBetweenSearchesMs: int(env, 'DELAY_BETWEEN_SEARCHES_MS', 5000, 0, 120_000),
      alertOnFirstRun: bool(env, 'ALERT_ON_FIRST_RUN', false),
    },
    watch: {
      intervalMinutes: int(env, 'SEARCH_INTERVAL_MINUTES', 30, 10, 1440),
      dashboardPort: int(env, 'DASHBOARD_PORT', 5174, 1024, 65535),
    },
    // Upwork's API & MCP Terms (s. 8.6): MCP outputs may be kept no longer than 30 days.
    retentionDays: int(env, 'RETENTION_DAYS', 30, 1, 30),
    descriptionMaxChars: int(env, 'DESCRIPTION_MAX_CHARS', 500, 0, 2000),
    logLevel: level,
  };
}
