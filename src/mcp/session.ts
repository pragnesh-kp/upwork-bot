import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Config } from '../config.ts';
import type { Store } from '../db.ts';
import { SourceError } from '../sources/types.ts';
import { LocalOAuthProvider, TokenVault } from './oauth.ts';
import type { ToolCallResult } from './schema.ts';

/** The subset of an MCP client the app needs; tests substitute a fake. */
export interface McpCaller {
  listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

/** Database key of the encrypted Upwork sign-in (same text format as the old data/upwork-oauth.enc). */
export const OAUTH_KV_KEY = 'upwork_oauth';

export function tokenVault(cfg: Config, store: Store): TokenVault {
  if (!cfg.upwork.tokenKey) throw new SourceError('auth', 'TOKEN_ENCRYPTION_KEY is not set');
  return new TokenVault(
    { load: () => store.kvGet(OAUTH_KV_KEY), save: (text) => store.kvSet(OAUTH_KV_KEY, text), remove: () => store.kvDelete(OAUTH_KV_KEY) },
    cfg.upwork.tokenKey,
  );
}

/**
 * Connects to the official Upwork MCP server. With `interactive`, a missing or
 * expired authorization starts the browser sign-in (npm run connect); otherwise
 * it fails fast with an "auth" error so searches never prompt unexpectedly.
 */
export async function connectUpwork(cfg: Config, store: Store, opts: { interactive: boolean }): Promise<McpCaller> {
  const provider = new LocalOAuthProvider({
    vault: tokenVault(cfg, store),
    port: cfg.upwork.callbackPort,
    interactive: opts.interactive,
    clientMetadataUrl: cfg.upwork.clientMetadataUrl,
  });
  const url = new URL(cfg.upwork.mcpUrl);
  const newClient = () => new Client({ name: 'upwork-job-alert-lite', version: '0.1.0' });

  let client = newClient();
  let transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  const callback = opts.interactive ? provider.waitForCallback() : null;
  // Avoid an unhandled rejection if authorization is not needed.
  callback?.catch(() => undefined);
  try {
    await client.connect(transport);
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) {
      throw new SourceError('temporary', `Could not connect to the Upwork MCP server: ${(err as Error).message}`);
    }
    if (!callback) throw new SourceError('auth', 'Upwork sign-in is missing or expired. Press "Connect Upwork" on the dashboard.');
    const code = await callback;
    await transport.finishAuth(code);
    client = newClient();
    transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    await client.connect(transport);
  }

  const wrap = (e: unknown): never => {
    if (e instanceof UnauthorizedError) throw new SourceError('auth', 'Upwork sign-in expired or was revoked. Press "Connect Upwork" on the dashboard.');
    throw new SourceError('temporary', `Upwork MCP request failed: ${(e as Error).message}`);
  };
  return {
    async listTools() {
      const out: { name: string; description?: string; inputSchema?: unknown }[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined).catch(wrap);
        out.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    },
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args }).catch(wrap)) as ToolCallResult;
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
