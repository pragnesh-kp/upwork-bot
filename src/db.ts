import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type OutboxStatus = 'pending' | 'sent' | 'failed';

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
  alertStatus: string | null;
}

export interface OutboxRow {
  id: number;
  source: string;
  job_id: string;
  chat_id: string;
  text: string | null;
  url: string | null;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
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
-- One alert per job per chat; the UNIQUE constraint is the deduplication guarantee.
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  text TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  telegram_message_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (source, job_id, chat_id)
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
`;

const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Adds columns introduced after a database was created. */
  private migrate(): void {
    const cols = new Set((this.db.prepare('PRAGMA table_info(job_details)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [['client_country', 'TEXT'], ['payment_verified', 'INTEGER'], ['proposals', 'TEXT']] as const) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE job_details ADD COLUMN ${name} ${type}`);
    }
    // Rows stored before Upwork's untrusted-content markers were stripped.
    this.db.exec(
      "UPDATE job_details SET snippet = trim(replace(replace(snippet, '<untrusted_participant_content>', ''), '</untrusted_participant_content>', '')) WHERE snippet LIKE '%untrusted_participant_content%'",
    );
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Single-run lock so two runs never search or send at the same time. Expired locks are taken over. */
  acquireLock(name: string, owner: string, ttlMs: number): boolean {
    const t = now();
    return this.transaction(() => {
      const row = this.db.prepare('SELECT owner, expires_at FROM locks WHERE name = ?').get(name) as { owner: string; expires_at: string } | undefined;
      if (row && row.expires_at > t) return false;
      this.db.prepare('INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at').run(
        name,
        owner,
        new Date(Date.now() + ttlMs).toISOString(),
      );
      return true;
    });
  }

  releaseLock(name: string, owner: string): void {
    this.db.prepare('DELETE FROM locks WHERE name = ? AND owner = ?').run(name, owner);
  }

  isSeen(source: string, jobId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen_jobs WHERE source = ? AND job_id = ?').get(source, jobId);
  }

  /** Returns true when the job was not seen before. */
  markSeen(source: string, jobId: string): boolean {
    const t = now();
    const res = this.db.prepare('INSERT INTO seen_jobs (source, job_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(source, jobId, t, t);
    if (res.changes === 0) this.db.prepare('UPDATE seen_jobs SET last_seen_at = ? WHERE source = ? AND job_id = ?').run(t, source, jobId);
    return res.changes === 1;
  }

  /** Stores the fields the dashboard displays. `baseline` marks jobs that existed before a filter's first run. */
  saveJobDetails(source: string, d: { id: string; title: string; url: string | null; budget: string; contractType: string | null; postedAt: string | null; snippet: string | null; skills: string[]; clientCountry?: string | null; clientPaymentVerified?: boolean | null; proposals?: string | null }, baseline: boolean): void {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO job_details (source, job_id, title, url, budget, contract_type, posted_at, snippet, skills, client_country, payment_verified, proposals, baseline, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, job_id) DO UPDATE SET title = excluded.title, url = excluded.url, budget = excluded.budget,
           contract_type = excluded.contract_type, posted_at = excluded.posted_at, snippet = excluded.snippet, skills = excluded.skills,
           client_country = excluded.client_country, payment_verified = excluded.payment_verified, proposals = excluded.proposals, last_seen_at = excluded.last_seen_at`,
      )
      .run(source, d.id, d.title, d.url, d.budget, d.contractType, d.postedAt, d.snippet, JSON.stringify(d.skills.slice(0, 12)), d.clientCountry ?? null, d.clientPaymentVerified === undefined || d.clientPaymentVerified === null ? null : d.clientPaymentVerified ? 1 : 0, d.proposals ?? null, baseline ? 1 : 0, t, t);
  }

  /**
   * Jobs for the dashboard. With `filters`, only jobs that one of these filters' own searches returned
   * are listed, and each job names only these filters (removed filters never show up).
   */
  listJobs(q: { filter?: string | null; filters?: string[]; state?: string | null; source?: string | null; search?: string | null; limit?: number }): DashboardJob[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const only = q.filters ? ` AND m.filter_name IN (${q.filters.map(() => '?').join(',') || "''"})` : '';
    const onlyArgs = q.filters ?? [];
    if (q.filters) {
      where.push(`EXISTS (SELECT 1 FROM job_matches m WHERE m.source = d.source AND m.job_id = d.job_id${only})`);
      args.push(...onlyArgs);
    }
    if (q.filter) {
      where.push('EXISTS (SELECT 1 FROM job_matches m WHERE m.source = d.source AND m.job_id = d.job_id AND m.filter_name = ?)');
      args.push(q.filter);
    }
    if (q.state) {
      where.push('d.review_state = ?');
      args.push(q.state);
    }
    if (q.source) {
      where.push('d.source = ?');
      args.push(q.source);
    }
    if (q.search) {
      where.push("(d.title LIKE ? ESCAPE '\\' OR d.snippet LIKE ? ESCAPE '\\')");
      const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like);
    }
    const sql = `SELECT d.*, (SELECT json_group_array(filter_name) FROM job_matches m WHERE m.source = d.source AND m.job_id = d.job_id${only}) AS filters,
        (SELECT status FROM outbox o WHERE o.source = d.source AND o.job_id = d.job_id ORDER BY (status = 'sent') DESC LIMIT 1) AS alert_status
      FROM job_details d ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(d.posted_at, d.first_seen_at) DESC LIMIT ?`;
    args.push(Math.min(2000, Math.max(1, q.limit ?? 200)));
    args.unshift(...onlyArgs); // the filters sub-select comes first in the SQL
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      source: String(r.source),
      jobId: String(r.job_id),
      title: String(r.title),
      url: (r.url as string | null) ?? null,
      budget: (r.budget as string | null) ?? null,
      contractType: (r.contract_type as string | null) ?? null,
      postedAt: (r.posted_at as string | null) ?? null,
      snippet: (r.snippet as string | null) ?? null,
      skills: JSON.parse(String(r.skills ?? '[]')) as string[],
      clientCountry: (r.client_country as string | null) ?? null,
      clientPaymentVerified: r.payment_verified === null || r.payment_verified === undefined ? null : r.payment_verified === 1,
      proposals: (r.proposals as string | null) ?? null,
      baseline: r.baseline === 1,
      reviewState: String(r.review_state),
      firstSeenAt: String(r.first_seen_at),
      filters: (JSON.parse(String(r.filters ?? '[]')) as (string | null)[]).filter((x): x is string => !!x),
      alertStatus: (r.alert_status as string | null) ?? null,
    }));
  }

  /** Forgets a removed filter: its matches, its baseline, and jobs no other filter returned. */
  forgetFilter(name: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM job_matches WHERE filter_name = ?').run(name);
      this.db.prepare('DELETE FROM filter_baselines WHERE filter_name = ?').run(name);
      const orphan = 'NOT EXISTS (SELECT 1 FROM job_matches m WHERE m.source = t.source AND m.job_id = t.job_id)';
      this.db.exec(`DELETE FROM job_details AS t WHERE ${orphan}`);
      this.db.exec(`DELETE FROM seen_jobs AS t WHERE ${orphan}`);
    });
  }

  /** Unreviewed jobs returned by any of these filters, each job counted once. */
  newJobCount(filters: string[]): number {
    if (!filters.length) return 0;
    return (this.db
      .prepare(`SELECT COUNT(*) AS n FROM job_details d WHERE d.review_state = 'new' AND EXISTS (SELECT 1 FROM job_matches m WHERE m.source = d.source AND m.job_id = d.job_id AND m.filter_name IN (${filters.map(() => '?').join(',')}))`)
      .get(...filters) as { n: number }).n;
  }

  filterCounts(): { filter: string; total: number; newCount: number }[] {
    return this.db
      .prepare(
        `SELECT m.filter_name AS filter, COUNT(*) AS total, SUM(CASE WHEN d.review_state = 'new' THEN 1 ELSE 0 END) AS newCount
         FROM job_matches m JOIN job_details d ON d.source = m.source AND d.job_id = m.job_id GROUP BY m.filter_name`,
      )
      .all() as { filter: string; total: number; newCount: number }[];
  }

  setReviewState(source: string, jobId: string, state: 'new' | 'saved' | 'dismissed' | 'reviewed'): boolean {
    return Number(this.db.prepare('UPDATE job_details SET review_state = ? WHERE source = ? AND job_id = ?').run(state, source, jobId).changes) === 1;
  }

  recordMatch(source: string, jobId: string, filterName: string): void {
    this.db.prepare('INSERT INTO job_matches (source, job_id, filter_name, matched_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(source, jobId, filterName, now());
  }

  baselineDone(source: string, filterName: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM filter_baselines WHERE source = ? AND filter_name = ?').get(source, filterName);
  }

  completeBaseline(source: string, filterName: string): void {
    this.db.prepare('INSERT INTO filter_baselines (source, filter_name, completed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(source, filterName, now());
  }

  /** Queues one alert per chat. Returns the number of NEW outbox rows (duplicates are ignored). */
  enqueue(source: string, jobId: string, chatIds: string[], text: string, url: string | null): number {
    let n = 0;
    const stmt = this.db.prepare(
      'INSERT INTO outbox (source, job_id, chat_id, text, url, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    );
    for (const chat of chatIds) n += Number(stmt.run(source, jobId, chat, text, url, now(), now()).changes);
    return n;
  }

  dueOutbox(limit = 100): OutboxRow[] {
    return this.db.prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?").all(now(), limit) as unknown as OutboxRow[];
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").get() as { n: number }).n;
  }

  /** Marks a row sent and drops the message body (job content is not kept longer than needed). */
  markSent(id: number, messageId: string): void {
    this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, telegram_message_id = ?, text = NULL, last_error = NULL, attempts = attempts + 1 WHERE id = ?").run(now(), messageId, id);
  }

  markRetry(id: number, error: string, delayMs: number, maxAttempts: number): 'pending' | 'failed' {
    const row = this.db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id) as { attempts: number };
    const attempts = row.attempts + 1;
    const status: OutboxStatus = attempts >= maxAttempts ? 'failed' : 'pending';
    this.db.prepare('UPDATE outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?').run(
      status,
      attempts,
      error.slice(0, 500),
      new Date(Date.now() + delayMs).toISOString(),
      id,
    );
    return status;
  }

  markFailed(id: number, error: string): void {
    this.db.prepare("UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?").run(error.slice(0, 500), id);
  }

  startRun(source: string): number {
    return Number(this.db.prepare("INSERT INTO runs (source, started_at, status) VALUES (?, ?, 'running')").run(source, now()).lastInsertRowid);
  }

  finishRun(id: number, status: 'ok' | 'partial' | 'failed', summary: unknown): void {
    this.db.prepare('UPDATE runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?').run(now(), status, JSON.stringify(summary), id);
  }

  /** Marks runs left "running" by a crash as interrupted. */
  recoverInterruptedRuns(): number {
    return Number(this.db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now()).changes);
  }

  stats() {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      seenJobs: one('SELECT COUNT(*) AS n FROM seen_jobs'),
      newJobs: one("SELECT COUNT(*) AS n FROM job_details WHERE review_state = 'new'"),
      alertsSent: one("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent'"),
      alertsPending: one("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'"),
      alertsFailed: one("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed'"),
      lastRuns: this.db.prepare('SELECT id, source, started_at, finished_at, status, summary FROM runs ORDER BY id DESC LIMIT 5').all(),
    };
  }

  /** Retention: drop job identifiers and finished alerts older than `days`. */
  purge(days: number): { details: number; seen: number; matches: number; outbox: number; runs: number } {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return {
      // Counted from first retrieval, so re-seeing a job never extends how long its content is kept.
      details: Number(this.db.prepare('DELETE FROM job_details WHERE first_seen_at < ?').run(cutoff).changes),
      seen: Number(this.db.prepare('DELETE FROM seen_jobs WHERE last_seen_at < ?').run(cutoff).changes),
      matches: Number(this.db.prepare('DELETE FROM job_matches WHERE matched_at < ?').run(cutoff).changes),
      outbox: Number(this.db.prepare("DELETE FROM outbox WHERE status <> 'pending' AND created_at < ?").run(cutoff).changes),
      runs: Number(this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(cutoff).changes),
    };
  }
}
