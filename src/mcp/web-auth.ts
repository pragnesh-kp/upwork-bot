import { timingSafeEqual } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from '../config.ts';
import type { Store } from '../db.ts';
import { discover, saveDiscovery, type Discovery } from './discover.ts';
import { LocalOAuthProvider } from './oauth.ts';
import { connectUpwork, tokenVault } from './session.ts';

/** Path of the client metadata document; its full https URL is the client_id. */
export const CLIENT_METADATA_PATH = '/api/upwork/client-metadata';

/**
 * OAuth Client ID Metadata Document for this site. Upwork accepts self-registered clients only
 * with loopback redirects, but supports URL-based client ids (client_id_metadata_document_supported),
 * which is how a hosted site identifies itself and its https redirect.
 */
export function clientMetadata(origin: string): OAuthClientMetadata & { client_id: string } {
  return {
    client_id: `${origin}${CLIENT_METADATA_PATH}`,
    client_name: 'Upwork Job Alert Lite',
    client_uri: origin,
    redirect_uris: [`${origin}/api/upwork/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/** https sites use their metadata document as client id; loopback (local) redirects self-register. */
function clientIdFor(cfg: Config, redirectUrl: string): string | null {
  if (cfg.upwork.clientMetadataUrl) return cfg.upwork.clientMetadataUrl;
  const u = new URL(redirectUrl);
  return u.protocol === 'https:' ? `${u.origin}${CLIENT_METADATA_PATH}` : null;
}

/**
 * "Connect Upwork" from the dashboard, in two requests (they may run in different
 * serverless instances; everything in between lives in the encrypted vault):
 * 1. start: returns Upwork's sign-in URL (or "already connected" when the stored sign-in works);
 * 2. finish: Upwork redirects back with ?code&state; the state must match the one saved in
 *    step 1 (single use), the code is exchanged for tokens, and the account is discovered.
 */
export async function startUpworkSignIn(cfg: Config, store: Store, redirectUrl: string): Promise<{ url: string } | { connected: Discovery }> {
  let target: URL | null = null;
  const provider = new LocalOAuthProvider({
    vault: tokenVault(cfg, store),
    port: 0,
    interactive: true,
    redirectUrl,
    clientMetadataUrl: clientIdFor(cfg, redirectUrl),
    onRedirect: (url) => void (target = url),
  });
  // With a working refresh token this just refreshes; otherwise it registers a client for
  // this redirect URL (if needed), saves the PKCE verifier and state, and asks for a redirect.
  const result = await auth(provider, { serverUrl: cfg.upwork.mcpUrl });
  if (result === 'REDIRECT' && target) return { url: String(target) };
  return { connected: await discoverAndSave(cfg, store) };
}

export async function finishUpworkSignIn(cfg: Config, store: Store, redirectUrl: string, code: string, state: string): Promise<Discovery> {
  const vault = tokenVault(cfg, store);
  const expected = (await vault.read()).state ?? '';
  const ok = expected.length > 0 && state.length === expected.length && timingSafeEqual(Buffer.from(state), Buffer.from(expected));
  // Single use, whether or not it matched.
  await vault.update({ state: undefined });
  if (!ok) throw new Error('This sign-in link is invalid or was already used. Press "Connect Upwork" again.');
  const provider = new LocalOAuthProvider({
    vault,
    port: 0,
    interactive: true,
    redirectUrl,
    clientMetadataUrl: clientIdFor(cfg, redirectUrl),
    onRedirect: () => {
      throw new Error('Upwork asked to sign in again. Press "Connect Upwork" again.');
    },
  });
  const result = await auth(provider, { serverUrl: cfg.upwork.mcpUrl, authorizationCode: code });
  if (result !== 'AUTHORIZED') throw new Error('Upwork did not complete the sign-in. Press "Connect Upwork" again.');
  await vault.update({ codeVerifier: undefined });
  return discoverAndSave(cfg, store);
}

/** Read-only: finds the freelancer account and the live find_jobs schema (no job search). */
async function discoverAndSave(cfg: Config, store: Store): Promise<Discovery> {
  const caller = await connectUpwork(cfg, store, { interactive: false });
  try {
    const d = await discover(caller, { serverUrl: cfg.upwork.mcpUrl, accountName: cfg.upwork.accountName });
    await saveDiscovery(store, d);
    return d;
  } finally {
    await caller.close();
  }
}
