import type { Store } from '../db.ts';
import { SourceError } from '../sources/types.ts';
import { extractSearchParamSchema, toolError, toolPayload, type ParamSchema } from './schema.ts';
import type { McpCaller } from './session.ts';

export interface Discovery {
  discoveredAt: string;
  serverUrl: string;
  mode: 'full' | 'compact';
  /** Actual tool names on the server (they are namespaced, e.g. "upwork__find_jobs"). */
  toolNames: { findJobs: string | null; executeTool: string | null; listAccounts: string; getToolHelp: string | null };
  account: { name: string; roleLabel: string; role: string; orgUid: string };
  otherAccounts: { name: string; roleLabel: string }[];
  findJobs: {
    /** Where search parameters go in the call: under "params" or at the top level. */
    paramsLocation: 'nested' | 'top-level';
    paramSchema: ParamSchema | null;
    /** The find_jobs inputSchema from tools/list (full mode). */
    inputSchema: unknown;
    help: unknown;
    helpErrors: string[];
  };
  tools: { name: string; description: string }[];
}

interface Account {
  name: string;
  role: string;
  roleLabel: string;
  orgUid: string;
  suspended: boolean;
}

function findAccounts(payload: unknown): Account[] {
  const out: Account[] = [];
  const visit = (n: unknown, depth: number) => {
    if (depth > 4 || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) visit(x, depth + 1);
      return;
    }
    const o = n as Record<string, unknown>;
    if (typeof o.org_uid === 'string' && typeof o.role === 'string') {
      out.push({
        name: String(o.name ?? o.display_name ?? 'Upwork account'),
        role: o.role,
        roleLabel: String(o.role_label ?? o.role),
        orgUid: o.org_uid,
        suspended: o.suspended === true,
      });
      return;
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  visit(payload, 0);
  return out;
}

async function call(caller: McpCaller, name: string, args: Record<string, unknown>) {
  const res = await caller.callTool(name, args);
  const payload = toolPayload(res);
  return { payload, error: toolError(res, payload) };
}

/**
 * Follows Upwork's documented workflow: list_accounts → pick the freelancer
 * account → get_tool_help for find_jobs. Nothing is searched or written.
 */
export async function discover(caller: McpCaller, opts: { serverUrl: string; accountName: string | null }): Promise<Discovery> {
  const tools = await caller.listTools();
  const names = tools.map((t) => t.name);
  const findJobsName = resolveToolName(names, 'find_jobs');
  const executeToolName = resolveToolName(names, 'execute_tool');
  const listAccountsName = resolveToolName(names, 'list_accounts');
  const getToolHelpName = resolveToolName(names, 'get_tool_help');
  if (!findJobsName && !executeToolName) {
    throw new SourceError('permanent', `The MCP server exposes neither find_jobs nor execute_tool. Tools: ${names.join(', ')}`);
  }
  if (!listAccountsName) throw new SourceError('permanent', `The MCP server exposes no list_accounts tool. Tools: ${names.join(', ')}`);
  const mode: Discovery['mode'] = findJobsName ? 'full' : 'compact';

  const acc = await call(caller, listAccountsName, {});
  if (acc.error) throw new SourceError('permanent', `list_accounts failed: ${acc.error.message}${acc.error.traceId ? ` (trace ${acc.error.traceId})` : ''}`);
  const accounts = findAccounts(acc.payload);
  const freelancer = accounts.filter((a) => a.role === 'TALENT' || a.role === 'FL_AGENCY');
  const chosen = opts.accountName ? freelancer.find((a) => a.name === opts.accountName) : freelancer[0];
  if (!chosen) {
    throw new SourceError(
      'permanent',
      opts.accountName
        ? `No freelancer/agency account named "${opts.accountName}". Available: ${accounts.map((a) => `${a.name} (${a.roleLabel})`).join(', ')}`
        : `No freelancer or agency account found; job search is a freelancer tool. Accounts: ${accounts.map((a) => `${a.name} (${a.roleLabel})`).join(', ') || 'none'}`,
    );
  }
  if (chosen.suspended) throw new SourceError('permanent', `The account "${chosen.name}" is suspended; Upwork blocks or restricts actions under it.`);

  // get_tool_help may expect the bare or the prefixed tool name; try both, with and without account context.
  let help: Awaited<ReturnType<typeof call>> | null = null;
  const helpErrors: string[] = [];
  if (getToolHelpName) {
    const attempts = [...new Set(['find_jobs', findJobsName ?? 'find_jobs'])].flatMap((tool_name) => [
      { tool_name },
      { tool_name, role: chosen.role, org_uid: chosen.orgUid },
    ]);
    for (const args of attempts) {
      const r = await call(caller, getToolHelpName, args);
      if (!r.error) {
        help = r;
        break;
      }
      helpErrors.push(`${String(args.tool_name)}: ${r.error.message}`);
    }
  }

  const findJobsTool = findJobsName ? tools.find((t) => t.name === findJobsName) : undefined;
  const inputProps = (findJobsTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const paramSchema = (help ? extractSearchParamSchema(help.payload) : null) ?? (findJobsTool ? extractSearchParamSchema(findJobsTool.inputSchema) : null);
  if (!help && !paramSchema) {
    throw new SourceError('permanent', `Could not read the find_jobs parameters. get_tool_help: ${helpErrors.join(' | ') || 'not available'}`);
  }

  return {
    discoveredAt: new Date().toISOString(),
    serverUrl: opts.serverUrl,
    mode,
    toolNames: { findJobs: findJobsName, executeTool: executeToolName, listAccounts: listAccountsName, getToolHelp: getToolHelpName },
    account: { name: chosen.name, roleLabel: chosen.roleLabel, role: chosen.role, orgUid: chosen.orgUid },
    otherAccounts: accounts.filter((a) => a !== chosen).map((a) => ({ name: a.name, roleLabel: a.roleLabel })),
    findJobs: {
      paramsLocation: mode === 'compact' || 'params' in inputProps ? 'nested' : 'top-level',
      paramSchema,
      inputSchema: findJobsTool?.inputSchema ?? null,
      help: help?.payload ?? null,
      helpErrors,
    },
    tools: tools.map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 300) })),
  };
}

/**
 * Finds a tool by its documented base name. The live server namespaces tools
 * (e.g. "upwork__find_jobs"), so an exact match is preferred, then a
 * "<prefix>__<name>" match.
 */
export function resolveToolName(names: string[], base: string): string | null {
  return names.find((n) => n === base) ?? names.find((n) => n.endsWith(`__${base}`)) ?? null;
}

const DISCOVERY_KV_KEY = 'upwork_discovery';

export async function saveDiscovery(store: Store, d: Discovery): Promise<void> {
  await store.kvSet(DISCOVERY_KV_KEY, JSON.stringify(d));
}

export async function loadDiscovery(store: Store): Promise<Discovery | null> {
  const raw = await store.kvGet(DISCOVERY_KV_KEY);
  return raw ? (JSON.parse(raw) as Discovery) : null;
}
