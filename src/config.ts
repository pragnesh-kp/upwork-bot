import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Config {
  /** MySQL (mysql://…) on Hostinger, Turso (libsql://…) on Vercel, a local SQLite file otherwise. */
  db: { url: string; authToken: string | null };
  /** True on Vercel (VERCEL=1) or Hostinger (HOSTED=1): the dashboard requires a password and a secure cookie. */
  onVercel: boolean;
  /** Dashboard password (DASHBOARD_PASSWORD). Required when hosted; optional locally. */
  dashboardPassword: string | null;
  /** Secret the scheduler sends as "Authorization: Bearer <CRON_SECRET>". */
  cronSecret: string | null;
  upwork: {
    mcpUrl: string;
    callbackPort: number;
    clientMetadataUrl: string | null;
    accountName: string | null;
    tokenKey: Buffer | null;
  };
  search: { maxPagesPerFilter: number; firstRunMaxPages: number; pageSize: number; delayBetweenSearchesMs: number };
  /** Minutes between automatic searches; the scheduler calls /api/cron more often than this. */
  intervalMinutes: number;
  /** Insights: a scan starting this many minutes after its due time counts as delayed. */
  scanGraceMinutes: number;
  /**
   * Search work per scheduler or dashboard call (seconds); the rest continues on the next call.
   * Default 20: cron-job.org's free plan cuts a call off after 30 s.
   */
  stepBudgetSeconds: number;
  /** Local `npm run dev` only. */
  dev: { port: number; dataDir: string };
  /**
   * Jobs posted longer ago than this are not fetched. Stored jobs are never cleared automatically:
   * all data is kept until you delete it on the dashboard.
   */
  maxJobAgeDays: number;
  /** Re-checking stored jobs on Upwork, to mark the ones removed there. */
  removalCheck: {
    /** Jobs checked per round (0 = never check). */
    batch: number;
    /** A job is re-checked at most once per this many hours. */
    everyHours: number;
    /** Only jobs found in the last this many days are checked. */
    maxAgeDays: number;
  };
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

const str = (env: NodeJS.ProcessEnv, key: string): string | null => env[key]?.trim() || null;

/**
 * Finds the Turso settings. Vercel's Marketplace integration lets you pick a custom
 * prefix for the variable names, so besides TURSO_DATABASE_URL any setting whose value
 * is a libsql:// address works, paired with the *AUTH_TOKEN that has the same prefix.
 */
export function tursoSettings(env: NodeJS.ProcessEnv): { url: string | null; token: string | null } {
  const keys = Object.keys(env).sort();
  const urlKey = str(env, 'TURSO_DATABASE_URL')
    ? 'TURSO_DATABASE_URL'
    : (keys.find((k) => k.endsWith('_TURSO_DATABASE_URL') && str(env, k)) ?? keys.find((k) => /^libsql:\/\//i.test(str(env, k) ?? '')));
  if (urlKey) {
    const prefix = urlKey.replace(/(TURSO_)?(DATABASE_)?(URL|URI)$/i, '');
    const token = ['AUTH_TOKEN', 'TURSO_AUTH_TOKEN', 'DATABASE_AUTH_TOKEN', 'TOKEN'].map((s) => str(env, `${prefix}${s}`)).find(Boolean) ?? str(env, 'TURSO_AUTH_TOKEN');
    return { url: str(env, urlKey), token: token ?? null };
  }
  return { url: str(env, 'DATABASE_URL'), token: str(env, 'DATABASE_AUTH_TOKEN') };
}

/**
 * MySQL settings (Hostinger): MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE (and
 * MYSQL_PORT), or one DATABASE_URL=mysql://user:password@host:3306/database. Separate
 * values need no URL encoding, so a password with @ or # in it just works.
 */
export function mysqlUrl(env: NodeJS.ProcessEnv): string | null {
  const url = str(env, 'DATABASE_URL');
  if (url && /^mysql:\/\//i.test(url)) return url;
  const host = str(env, 'MYSQL_HOST');
  if (!host) return null;
  const missing = ['MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'].filter((k) => !str(env, k));
  if (missing.length) throw new ConfigError(`MYSQL_HOST is set, but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing`);
  const e = (k: string) => encodeURIComponent(str(env, k) ?? '');
  return `mysql://${e('MYSQL_USER')}:${e('MYSQL_PASSWORD')}@${host}:${int(env, 'MYSQL_PORT', 3306, 1, 65535)}/${e('MYSQL_DATABASE')}`;
}

/** Validates configuration. Error messages never include secret values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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

  const onVercel = !!str(env, 'VERCEL') || !!str(env, 'HOSTED');
  const dataDir = resolve(str(env, 'DATA_DIR') ?? 'data');
  const mysql = mysqlUrl(env);
  const turso = mysql ? { url: null, token: null } : tursoSettings(env);
  const dbUrl = mysql ?? turso.url ?? (onVercel ? null : pathToFileURL(resolve(dataDir, 'local.db')).href);
  if (!dbUrl) {
    // Names only (never values), to spot a misnamed setting or a deployment made before the settings existed.
    const seen = Object.keys(env)
      .filter((k) => /TURSO|LIBSQL|DATABASE|MYSQL|STORAGE|_URL$|TOKEN|DASHBOARD|CRON|UPWORK/i.test(k) && !k.startsWith('VERCEL') && str(env, k))
      .sort();
    const version = str(env, 'VERCEL_GIT_COMMIT_SHA')?.slice(0, 7);
    const what = str(env, 'VERCEL')
      ? 'TURSO_DATABASE_URL is not set. In Vercel: connect a Turso database to this project (Storage), then Redeploy (see DEPLOY.md, steps 3-4).'
      : "No database is set. On Hostinger: add MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD and MYSQL_DATABASE to the app's environment variables, then redeploy (see HOSTINGER.md).";
    throw new ConfigError(`${what} Settings this deployment can see: ${seen.length ? seen.join(', ') : 'none'}.${version ? ` (code version ${version})` : ''}`);
  }
  if (!/^(libsql|https?|wss?|file|mysql):/i.test(dbUrl)) throw new ConfigError('TURSO_DATABASE_URL must start with libsql://, https:// or file:');

  const password = str(env, 'DASHBOARD_PASSWORD');
  if (password && password.length < 10) throw new ConfigError('DASHBOARD_PASSWORD must be at least 10 characters');
  const cronSecret = str(env, 'CRON_SECRET');
  if (cronSecret && cronSecret.length < 16) throw new ConfigError('CRON_SECRET must be at least 16 characters');

  return {
    db: { url: dbUrl, authToken: turso.token },
    onVercel,
    dashboardPassword: password,
    cronSecret,
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
      delayBetweenSearchesMs: int(env, 'DELAY_BETWEEN_SEARCHES_MS', 3000, 0, 60_000),
    },
    intervalMinutes: int(env, 'SEARCH_INTERVAL_MINUTES', 30, 10, 1440),
    scanGraceMinutes: int(env, 'SCAN_GRACE_MINUTES', 10, 1, 720),
    stepBudgetSeconds: int(env, 'STEP_BUDGET_SECONDS', 20, 5, 280),
    dev: { port: int(env, 'DASHBOARD_PORT', 5174, 1024, 65535), dataDir },
    maxJobAgeDays: int(env, 'MAX_JOB_AGE_DAYS', 3, 1, 30),
    removalCheck: {
      batch: int(env, 'REMOVAL_CHECK_BATCH', 5, 0, 50),
      everyHours: int(env, 'REMOVAL_CHECK_HOURS', 24, 1, 720),
      maxAgeDays: int(env, 'REMOVAL_CHECK_DAYS', 14, 1, 365),
    },
    logLevel: level,
  };
}
