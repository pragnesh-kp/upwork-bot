import { log } from '../log.ts';
import { searchTargets, type FilterDef, type SearchTarget } from '../filters.ts';
import type { Discovery } from '../mcp/discover.ts';
import { buildSearchParams, normalizeSearchPayload, toolError, toolPayload } from '../mcp/schema.ts';
import type { McpCaller } from '../mcp/session.ts';
import { SourceError, type JobCheck, type JobSource, type SearchPage } from './types.ts';

/** Error codes and messages that clearly mean "this job is gone from Upwork". */
const GONE_CODE = /not_?found|gone|deleted|removed|closed|unavailable|no_longer|does_not_exist/;
const GONE_TEXT = /no longer (available|exists|active|open)|not found|does ?n[o']t exist|(has been|was|been) (removed|deleted|closed|cancell?ed|withdrawn)|job (is )?(closed|private)|private job/i;
/** Job statuses that mean the posting is no longer open. */
const GONE_STATUS = /closed|cancell?ed|deleted|removed|expired|archived|filled|inactive|private|unavailable|withdrawn/i;

/**
 * The job's own status in a find_jobs `get` answer, e.g. "CLOSED" (the top-level `status`
 * "ok" / "success" is the call's result, not the job's). A true closed/deleted flag counts too.
 */
export function jobStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const nested = ['job', 'data', 'posting', 'result', 'jobPosting', 'job_posting'].map((k) => p[k]).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  const inner = nested.flatMap((o) => [o, ...['job', 'posting'].map((k) => o[k]).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))]);
  for (const o of [...inner, p]) {
    for (const k of ['job_status', 'jobStatus', 'posting_status', 'postingStatus', 'status', 'state']) {
      const v = o[k];
      if (typeof v === 'string' && v && !(o === p && /^(ok|success|succeeded|error)$/i.test(v))) return v;
    }
    for (const k of ['closed', 'is_closed', 'isClosed', 'deleted', 'is_deleted', 'isDeleted', 'removed']) if (o[k] === true) return k.replace(/^is_?/i, '').toLowerCase();
  }
  return null;
}

/**
 * Job search through the official Upwork MCP server (`find_jobs`, action
 * `search`), using only parameters present in the discovered live schema.
 */
export class UpworkMcpSource implements JobSource {
  readonly name = 'upwork-mcp' as const;
  private readonly caller: McpCaller;
  private readonly discovery: Discovery;

  constructor(caller: McpCaller, discovery: Discovery) {
    this.caller = caller;
    this.discovery = discovery;
  }

  describeMapping(filter: FilterDef) {
    const schema = this.discovery.findJobs.paramSchema;
    if (!schema) return { applied: [], notApplied: ['everything: the find_jobs search schema could not be read; run "npm run discover" and review data/discovery.json'] };
    const applied = new Set<string>();
    const notApplied = new Set<string>();
    for (const target of searchTargets(filter.criteria)) {
      const m = buildSearchParams(filter.criteria, schema, { pageSize: 10, cursor: null, target });
      m.applied.forEach((a) => applied.add(a));
      m.notApplied.forEach((n) => notApplied.add(n));
    }
    return { applied: [...applied], notApplied: [...notApplied] };
  }

  /** Calls find_jobs with one action, in the call shape the live server uses. */
  private callFindJobs(action: 'search' | 'get', params: Record<string, unknown>) {
    const { account, mode, findJobs } = this.discovery;
    const args =
      mode === 'compact'
        ? { tool_name: 'find_jobs', action, org_uid: account.orgUid, role: account.role, params }
        : findJobs.paramsLocation === 'nested'
          ? { action, org_uid: account.orgUid, params }
          : { action, org_uid: account.orgUid, ...params };
    // Discovery records the server's real (namespaced) tool names, e.g. "upwork__find_jobs".
    const names = this.discovery.toolNames;
    const tool = mode === 'compact' ? (names?.executeTool ?? 'execute_tool') : (names?.findJobs ?? 'find_jobs');
    return this.caller.callTool(tool, args);
  }

  /**
   * Is this job still on Upwork? Uses find_jobs `get` (read-only, one job). Only a clear
   * answer marks a job removed: an error that says the job is not found / no longer
   * available, or a job status such as closed or cancelled. Anything unclear throws, and
   * the job is simply checked again later.
   */
  async checkJob(jobId: string): Promise<JobCheck> {
    const res = await this.callFindJobs('get', { id: jobId });
    const payload = toolPayload(res);
    const err = toolError(res, payload);
    if (err) {
      const code = (err.code ?? '').toLowerCase();
      const trace = err.traceId ? ` (trace ${err.traceId})` : '';
      if (err.retryAfterSeconds !== null || /rate|throttl|limit|quota/.test(code)) {
        throw new SourceError('rate_limited', `Upwork rate limit: ${err.message}${trace}`, { retryAfterSeconds: err.retryAfterSeconds ?? 60, traceId: err.traceId });
      }
      if (/auth|token|unauthori[sz]ed/.test(code)) throw new SourceError('auth', `Upwork authorization problem: ${err.message}${trace}`, { traceId: err.traceId });
      if (GONE_CODE.test(code) || GONE_TEXT.test(err.message)) {
        log.debug('job check: removed from Upwork', { job: jobId, code: err.code });
        return { removed: true, reason: err.message.slice(0, 300) };
      }
      throw new SourceError('temporary', `Upwork job check failed: ${err.message}${trace}`, { traceId: err.traceId });
    }
    if (payload === null || payload === undefined || payload === '' || (typeof payload === 'object' && 'job' in payload && !(payload as { job: unknown }).job)) {
      throw new SourceError('invalid_response', 'Upwork returned no job data');
    }
    const status = jobStatus(payload);
    log.debug('job check', { job: jobId, status, topLevelKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [] });
    if (status && GONE_STATUS.test(status)) return { removed: true, reason: `Upwork status: ${status}` };
    return { removed: false, reason: null };
  }

  async search(filter: FilterDef, cursor: string | null, pageSize: number, target: SearchTarget = {}): Promise<SearchPage> {
    const schema = this.discovery.findJobs.paramSchema;
    if (!schema) throw new SourceError('permanent', 'No find_jobs search schema recorded. Run "npm run discover".');
    const { params } = buildSearchParams(filter.criteria, schema, { pageSize, cursor, target });
    const res = await this.callFindJobs('search', params);
    const payload = toolPayload(res);
    const err = toolError(res, payload);
    if (err) {
      const trace = err.traceId ? ` (trace ${err.traceId}; include it if you contact Upwork Support)` : '';
      const code = (err.code ?? '').toLowerCase();
      if (err.retryAfterSeconds !== null || /rate|throttl|limit|quota/.test(code)) {
        throw new SourceError('rate_limited', `Upwork rate limit: ${err.message}${trace}`, { retryAfterSeconds: err.retryAfterSeconds ?? 60, traceId: err.traceId });
      }
      if (/auth|token|expired|unauthori[sz]ed|forbidden/.test(code)) throw new SourceError('auth', `Upwork authorization problem: ${err.message}${trace}`, { traceId: err.traceId });
      if (/needs_details|invalid|validation|bad_request|not_found|unsupported/.test(code)) {
        throw new SourceError('permanent', `Upwork rejected the search parameters: ${err.message}${trace}. Review the mapping with "npm run filters".`, { traceId: err.traceId });
      }
      throw new SourceError('temporary', `Upwork search failed: ${err.message}${trace}`, { traceId: err.traceId });
    }
    const page = normalizeSearchPayload(payload);
    // Field names only (never content), to diagnose parsing against the live response shape.
    if (payload && typeof payload === 'object') {
      const first = Object.values(payload as Record<string, unknown>).find((v) => Array.isArray(v) && v[0] && typeof v[0] === 'object') as Record<string, unknown>[] | undefined;
      log.debug('find_jobs response shape', {
        topLevelKeys: Object.keys(payload as Record<string, unknown>),
        jobKeys: first?.[0] ? Object.keys(first[0]) : [],
        nestedKeys: first?.[0] ? Object.fromEntries(Object.entries(first[0]).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => [k, Object.keys(v as object)])) : {},
      });
    }
    return page;
  }

  async close(): Promise<void> {
    await this.caller.close();
  }
}
