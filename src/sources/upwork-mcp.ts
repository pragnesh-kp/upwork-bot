import { log } from '../log.ts';
import { searchTargets, type FilterDef, type SearchTarget } from '../filters.ts';
import type { Discovery } from '../mcp/discover.ts';
import { buildSearchParams, normalizeSearchPayload, toolError, toolPayload } from '../mcp/schema.ts';
import type { McpCaller } from '../mcp/session.ts';
import { SourceError, type JobSource, type SearchPage } from './types.ts';

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

  async search(filter: FilterDef, cursor: string | null, pageSize: number, target: SearchTarget = {}): Promise<SearchPage> {
    const schema = this.discovery.findJobs.paramSchema;
    if (!schema) throw new SourceError('permanent', 'No find_jobs search schema recorded. Run "npm run discover".');
    const { params } = buildSearchParams(filter.criteria, schema, { pageSize, cursor, target });
    const { account, mode, findJobs } = this.discovery;
    const args =
      mode === 'compact'
        ? { tool_name: 'find_jobs', action: 'search', org_uid: account.orgUid, role: account.role, params }
        : findJobs.paramsLocation === 'nested'
          ? { action: 'search', org_uid: account.orgUid, params }
          : { action: 'search', org_uid: account.orgUid, ...params };

    // Discovery records the server's real (namespaced) tool names, e.g. "upwork__find_jobs".
    const names = this.discovery.toolNames;
    const tool = mode === 'compact' ? (names?.executeTool ?? 'execute_tool') : (names?.findJobs ?? 'find_jobs');
    const res = await this.caller.callTool(tool, args);
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
