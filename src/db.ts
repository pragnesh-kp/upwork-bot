import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client, type InStatement, type Row } from '@libsql/client';

export interface DashboardJob {
  source: string;
  jobId: string;
  title: string;
  url: string | null;
  budget: string | null;
  contractType: string | null;
  postedAt: string | null;
  snippet: string | null;
  skills: string[];
  clientCountry: string | null;
  clientPaymentVerified: boolean | null;
  proposals: string | null;
  baseline: boolean;
  reviewState: string;
  firstSeenAt: string;
  filters: string[];
}

export interface JobDetails {
  id: string;
  title: string;
  url: string | null;
  budget: string;
  contractType: string | null;
  postedAt: string | null;
  snippet: string | null;
  skills: string[];
  clientCountry?: string | null;
  clientPaymentVerified?: boolean | null;
  proposals?: string | null;
}

export interface StoredFilter {
  name: string;
  url: string;
  enabled: boolean;
}

export interface RunRow {
  id: number;
  source: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  summary: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen_jobs (
  source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source, job_id)
);
-- What the dashboard shows. Kept at most RETENTION_DAYS (<= 30, Upwork API & MCP Terms s.8.6).
CREATE TABLE IF NOT EXISTS job_details (
  source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  budget TEXT,
  contract_type TEXT,
  posted_at TEXT,
  snippet TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  client_country TEXT,
  payment_verified INTEGER,
  proposals TEXT,
  baseline INTEGER NOT NULL DEFAULT 0,
  review_state TEXT NOT NULL DEFAULT 'new',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source, job_id)
);
CREATE INDEX IF NOT EXISTS job_details_seen ON job_details (first_seen_at);
CREATE TABLE IF NOT EXISTS job_matches (
  source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  filter_name TEXT NOT NULL,
  matched_at TEXT NOT NULL,
  PRIMARY KEY (source, job_id, filter_name)
);
CREATE TABLE IF NOT EXISTS filter_baselines (
  source TEXT NOT NULL,
  filter_name TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (source, filter_name)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- The saved Upwork searches (managed from the dashboard).
CREATE TABLE IF NOT EXISTS filters (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
-- Small settings: the encrypted Upwork sign-in, the discovered tool schema, the running search.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_failures (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_at ON login_failures (at);
`;

const now = () => new Date().toISOString();
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/**
 * All persistent state, in a libSQL database: a local SQLite file for
 * development, or Turso (TURSO_DATABASE_URL) on Vercel. Every write that must
 * be all-or-nothing goes through one `batch` (a transaction).
 */
export class Store {
  readonly db: Client;
  private ready: Promise<void> | null = null;

  constructor(client: Client) {
    this.db = client;
  }

  static open(url: string, authToken?: string | null): Store {
    if (url.startsWith('file:') && !url.includes(':memory:')) {
      const path = url.startsWith('file:///') ? fileURLToPath(url) : url.slice('file:'.length);
      mkdirSync(dirname(path), { recursive: true });
    }
    return new Store(createClient({ url, ...(authToken ? { authToken } : {}) }));
  }

  /** Creates or upgrades the tables once per process. Every public method awaits it. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      await this.db.executeMultiple(SCHEMA);
      const cols = new Set((await this.db.execute('PRAGMA table_info(job_details)')).rows.map((r) => String(r.name)));
      for (const [name, type] of [['client_country', 'TEXT'], ['payment_verified', 'INTEGER'], ['proposals', 'TEXT']] as const) {
        if (!cols.has(name)) await this.db.execute(`ALTER TABLE job_details ADD COLUMN ${name} ${type}`);
      }
    })();
    return this.ready;
  }

  close(): void {
    this.db.close();
  }

  private async run(sql: string, args: (string | number | null)[] = []) {
    await this.init();
    return this.db.execute({ sql, args });
  }

  private async batch(stmts: InStatement[]): Promise<void> {
    await this.init();
    if (stmts.length) await this.db.batch(stmts, 'write');
  }

  // --- settings -------------------------------------------------------------

  async kvGet(key: string): Promise<string | null> {
    return str((await this.run('SELECT value FROM kv WHERE key = ?', [key])).rows[0]?.value);
  }

  async kvSet(key: string, value: string): Promise<void> {
    await this.run('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, value, now()]);
  }

  async kvDelete(key: string): Promise<void> {
    await this.run('DELETE FROM kv WHERE key = ?', [key]);
  }

  /** Keys starting with `prefix` (no LIKE, so "_" and "%" in keys are literal). */
  async kvKeys(prefix: string): Promise<string[]> {
    return (await this.run('SELECT key FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key', [prefix.length, prefix])).rows.map((r) => String(r.key));
  }

  // --- filters --------------------------------------------------------------

  async listFilters(): Promise<StoredFilter[]> {
    const rows = (await this.run('SELECT name, url, enabled FROM filters ORDER BY position, created_at')).rows;
    return rows.map((r) => ({ name: String(r.name), url: String(r.url), enabled: Number(r.enabled) === 1 }));
  }

  /** Adds a filter at the end of the list. Returns false when the name is taken. */
  async addFilter(f: StoredFilter): Promise<boolean> {
    const res = await this.run(
      'INSERT INTO filters (name, url, enabled, position, created_at) SELECT ?, ?, ?, COALESCE(MAX(position), 0) + 1, ? FROM filters WHERE true ON CONFLICT(name) DO NOTHING',
      [f.name, f.url, f.enabled ? 1 : 0, now()],
    );
    return res.rowsAffected === 1;
  }

  /** Removes a filter and forgets its matches, its baseline, and jobs no other filter returned. */
  async removeFilter(name: string): Promise<boolean> {
    if (!(await this.run('SELECT 1 FROM filters WHERE name = ?', [name])).rows.length) return false;
    const orphan = 'NOT EXISTS (SELECT 1 FROM job_matches m WHERE m.source = t.source AND m.job_id = t.job_id)';
    await this.batch([
      { sql: 'DELETE FROM filters WHERE name = ?', args: [name] },
      { sql: 'DELETE FROM job_matches WHERE filter_name = ?', args: [name] },
      { sql: 'DELETE FROM filter_baselines WHERE filter_name = ?', args: [name] },
      `DELETE FROM job_details AS t WHERE ${orphan}`,
      `DELETE FROM seen_jobs AS t WHERE ${orphan}`,
    ]);
    return true;
  }

  // --- locks ----------------------------------------------------------------

  /** One atomic statement: takes the lock if it is free or expired (a crashed holder's lock times out). */
  async acquireLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const res = await this.run(
      `INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE locks.expires_at <= ?`,
      [name, owner, new Date(Date.now() + ttlMs).toISOString(), now()],
    );
    return res.rowsAffected === 1;
  }

  async releaseLock(name: string, owner: string): Promise<void> {
    await this.run('DELETE FROM locks WHERE name = ? AND owner = ?', [name, owner]);
  }

  // --- jobs -----------------------------------------------------------------

  /** Which of these job ids were seen before (by any filter). */
  async seenIds(source: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = (await this.run(`SELECT job_id FROM seen_jobs WHERE source = ? AND job_id IN (${ids.map(() => '?').join(',')})`, [source, ...ids])).rows;
    return new Set(rows.map((r) => String(r.job_id)));
  }

  async isSeen(source: string, jobId: string): Promise<boolean> {
    return (await this.seenIds(source, [jobId])).has(jobId);
  }

  /**
   * Records one page of a filter's results in one transaction: the job is marked
   * seen, its dashboard fields are stored, and the filter is recorded as a match.
   * `baseline` marks jobs first found by a filter's first search.
   */
  async saveJobs(source: string, filterName: string, jobs: { details: JobDetails; baseline: boolean }[]): Promise<void> {
    const t = now();
    const stmts: InStatement[] = [];
    for (const { details: d, baseline } of jobs) {
      stmts.push(
        { sql: 'INSERT INTO seen_jobs (source, job_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET last_seen_at = excluded.last_seen_at', args: [source, d.id, t, t] },
        {
          sql: `INSERT INTO job_details (source, job_id, title, url, budget, contract_type, posted_at, snippet, skills, client_country, payment_verified, proposals, baseline, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source, job_id) DO UPDATE SET title = excluded.title, url = excluded.url, budget = excluded.budget,
                  contract_type = excluded.contract_type, posted_at = excluded.posted_at, snippet = excluded.snippet, skills = excluded.skills,
                  client_country = excluded.client_country, payment_verified = excluded.payment_verified, proposals = excluded.proposals, last_seen_at = excluded.last_seen_at`,
          args: [
            source,
            d.id,
            d.title,
            d.url,
            d.budget,
            d.contractType,
            d.postedAt,
            d.snippet,
            JSON.stringify(d.skills.slice(0, 12)),
            d.clientCountry ?? null,
            d.clientPaymentVerified === undefined || d.clientPaymentVerified === null ? null : d.clientPaymentVerified ? 1 : 0,
            d.proposals ?? null,
            baseline ? 1 : 0,
            t,
            t,
          ],
        },
        { sql: 'INSERT INTO job_matches (source, job_id, filter_name, matched_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', args: [source, d.id, filterName, t] },
      );
    }
    await this.batch(stmts);
  }

  /**
   * Jobs for the dashboard: only jobs that one of these filters' own searches returned,
   * each naming only these filters (removed filters never show up).
   */
  async listJobs(q: { filters: string[]; state?: string | null; limit?: number }): Promise<DashboardJob[]> {
    if (!q.filters.length) return [];
    const marks = q.filters.map(() => '?').join(',');
    const args: (string | number)[] = [...q.filters, ...q.filters];
    let where = `EXISTS (SELECT 1 FROM job_matches m WHERE m.source = d.source AND m.job_id = d.job_id AND m.filter_name IN (${marks}))`;
    if (q.state) {
      where += ' AND d.review_state = ?';
      args.push(q.state);
    }
    args.push(Math.min(2000, Math.max(1, q.limit ?? 200)));
    const sql = `SELECT d.*, (SELECT json_group_array(filter_name) FROM job_matches m WHERE m.source = d.source AND m.job_id = d.job_id AND m.filter_name IN (${marks})) AS filters
      FROM job_details d WHERE ${where}
      ORDER BY COALESCE(d.posted_at, d.first_seen_at) DESC LIMIT ?`;
    return (await this.run(sql, args)).rows.map((r: Row) => ({
      source: String(r.source),
      jobId: String(r.job_id),
      title: String(r.title),
      url: str(r.url),
      budget: str(r.budget),
      contractType: str(r.contract_type),
      postedAt: str(r.posted_at),
      snippet: str(r.snippet),
      skills: JSON.parse(String(r.skills ?? '[]')) as string[],
      clientCountry: str(r.client_country),
      clientPaymentVerified: r.payment_verified === null || r.payment_verified === undefined ? null : Number(r.payment_verified) === 1,
      proposals: str(r.proposals),
      baseline: Number(r.baseline) === 1,
      reviewState: String(r.review_state),
      firstSeenAt: String(r.first_seen_at),
      filters: (JSON.parse(String(r.filters ?? '[]')) as (string | null)[]).filter((x): x is string => !!x),
    }));
  }

  /** Unreviewed jobs returned by any of these filters, each job counted once. */
  async newJobCount(filters: string[]): Promise<number> {
    if (!filters.length) return 0;
    const res = await this.run(
      `SELECT COUNT(*) AS n FROM job_details d WHERE d.review_state = 'new' AND EXISTS (SELECT 1 FROM job_matches m WHERE m.source = d.source AND m.job_id = d.job_id AND m.filter_name IN (${filters.map(() => '?').join(',')}))`,
      filters,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async filterCounts(): Promise<{ filter: string; total: number; newCount: number }[]> {
    const rows = (
      await this.run(
        `SELECT m.filter_name AS filter, COUNT(*) AS total, SUM(CASE WHEN d.review_state = 'new' THEN 1 ELSE 0 END) AS newCount
         FROM job_matches m JOIN job_details d ON d.source = m.source AND d.job_id = m.job_id GROUP BY m.filter_name`,
      )
    ).rows;
    return rows.map((r) => ({ filter: String(r.filter), total: Number(r.total), newCount: Number(r.newCount ?? 0) }));
  }

  async setReviewState(source: string, jobId: string, state: 'new' | 'saved' | 'dismissed' | 'reviewed'): Promise<boolean> {
    return (await this.run('UPDATE job_details SET review_state = ? WHERE source = ? AND job_id = ?', [state, source, jobId])).rowsAffected === 1;
  }

  async baselineDone(source: string, filterName: string): Promise<boolean> {
    return (await this.run('SELECT 1 FROM filter_baselines WHERE source = ? AND filter_name = ?', [source, filterName])).rows.length > 0;
  }

  async completeBaseline(source: string, filterName: string): Promise<void> {
    await this.run('INSERT INTO filter_baselines (source, filter_name, completed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [source, filterName, now()]);
  }

  // --- runs -----------------------------------------------------------------

  async startRun(source: string): Promise<number> {
    return Number((await this.run("INSERT INTO runs (source, started_at, status) VALUES (?, ?, 'running')", [source, now()])).lastInsertRowid);
  }

  async finishRun(id: number, status: 'ok' | 'partial' | 'failed', summary: unknown): Promise<void> {
    await this.run('UPDATE runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?', [now(), status, JSON.stringify(summary), id]);
  }

  async lastRuns(limit = 5): Promise<RunRow[]> {
    return (await this.run('SELECT id, source, started_at, finished_at, status, summary FROM runs ORDER BY id DESC LIMIT ?', [limit])).rows.map((r) => ({
      id: Number(r.id),
      source: String(r.source),
      started_at: String(r.started_at),
      finished_at: str(r.finished_at),
      status: String(r.status),
      summary: str(r.summary),
    }));
  }

  async seenCount(): Promise<number> {
    return Number((await this.run('SELECT COUNT(*) AS n FROM seen_jobs')).rows[0]?.n ?? 0);
  }

  // --- login throttling -----------------------------------------------------

  async loginFailures(ip: string, sinceMs: number): Promise<{ ip: number; all: number }> {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const r = (await this.run('SELECT SUM(CASE WHEN ip = ? THEN 1 ELSE 0 END) AS mine, COUNT(*) AS everyone FROM login_failures WHERE at > ?', [ip, since])).rows[0];
    return { ip: Number(r?.mine ?? 0), all: Number(r?.everyone ?? 0) };
  }

  async recordLoginFailure(ip: string): Promise<void> {
    await this.batch([
      { sql: 'INSERT INTO login_failures (ip, at) VALUES (?, ?)', args: [ip, now()] },
      { sql: 'DELETE FROM login_failures WHERE at < ?', args: [new Date(Date.now() - 86_400_000).toISOString()] },
    ]);
  }

  async clearLoginFailures(ip: string): Promise<void> {
    await this.run('DELETE FROM login_failures WHERE ip = ?', [ip]);
  }

  // --- retention ------------------------------------------------------------

  /** Retention: drop job identifiers and history older than `days`. */
  async purge(days: number): Promise<void> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    await this.batch([
      // Counted from first retrieval, so re-seeing a job never extends how long its content is kept.
      { sql: 'DELETE FROM job_details WHERE first_seen_at < ?', args: [cutoff] },
      { sql: 'DELETE FROM seen_jobs WHERE last_seen_at < ?', args: [cutoff] },
      { sql: 'DELETE FROM job_matches WHERE matched_at < ?', args: [cutoff] },
      { sql: 'DELETE FROM runs WHERE started_at < ?', args: [cutoff] },
    ]);
  }
}
