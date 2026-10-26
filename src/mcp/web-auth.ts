import { timingSafeEqual } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Config } from '../config.ts';
import type { Store } from '../db.ts';
import { discover, saveDiscovery, type Discovery } from './discover.ts';
import { LocalOAuthProvider } from './oauth.ts';
import { connectUpwork, tokenVault } from './session.ts';

/**
 * "Connect Upwork" from the dashboard.
 *
 * Upwork lets apps self-register only loopback redirects (http://127.0.0.1/…) and refuses
 * hosted sites ("Client not found or disabled"). So the dashboard uses the same loopback
 * client as `npm run connect`: after you allow access, Upwork sends your browser to
 * http://127.0.0.1:<port>/callback?code=…&state=…, which nothing answers. You paste that
 * address into the dashboard, and the server finishes the sign-in. In between, the PKCE
 * verifier and the single-use state wait in the encrypted vault (requests may run in
 * different serverless instances).
 */
function provider(cfg: Config, store: Store, onRedirect: (url: URL) => void): LocalOAuthProvider {
  return new LocalOAuthProvider({
    vault: tokenVault(cfg, store),
    port: cfg.upwork.callbackPort,
    interactive: true,
    clientMetadataUrl: cfg.upwork.clientMetadataUrl,
    onRedirect,
  });
}

/** Returns Upwork's sign-in URL, or the account when the stored sign-in still works. */
export async function startUpworkSignIn(cfg: Config, store: Store): Promise<{ url: string } | { connected: Discovery }> {
  let target: URL | null = null;
  // With a working refresh token this just refreshes; otherwise it registers the loopback client
  // (if needed), saves the PKCE verifier and state, and asks for a redirect.
  const result = await auth(
    provider(cfg, store, (url) => void (target = url)),
    { serverUrl: cfg.upwork.mcpUrl },
  );
  if (result === 'REDIRECT' && target) return { url: String(target) };
  return { connected: await discoverAndSave(cfg, store) };
}

/** Finishes the sign-in from the address the browser landed on after "Allow". */
export async function finishUpworkSignInFromUrl(cfg: Config, store: Store, landedOn: string): Promise<Discovery> {
  let u: URL;
  try {
    u = new URL(landedOn.trim());
  } catch {
    throw new Error('That is not a web address. Copy the whole address from the tab Upwork sent you to (it starts with http://127.0.0.1).');
  }
  if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname) || u.pathname !== '/callback') {
    throw new Error('That is not the address Upwork sent you to. It starts with http://127.0.0.1 and contains "/callback?code=".');
  }
  const error = u.searchParams.get('error');
  if (error) throw new Error(`Upwork returned: ${error.slice(0, 100)}`);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  if (!code || !state) throw new Error('The address has no sign-in code. Copy it again after clicking "Allow" on Upwork.');
  return finishUpworkSignIn(cfg, store, code, state);
}

export async function finishUpworkSignIn(cfg: Config, store: Store, code: string, state: string): Promise<Discovery> {
  const vault = tokenVault(cfg, store);
  const expected = (await vault.read()).state ?? '';
  const ok = expected.length > 0 && state.length === expected.length && timingSafeEqual(Buffer.from(state), Buffer.from(expected));
  // Single use, whether or not it matched.
  await vault.update({ state: undefined });
  if (!ok) throw new Error('This sign-in code is from an older or already finished attempt. Press "Connect Upwork" again.');
  const result = await auth(
    provider(cfg, store, () => {
      throw new Error('Upwork asked to sign in again. Press "Connect Upwork" again.');
    }),
    { serverUrl: cfg.upwork.mcpUrl, authorizationCode: code },
  );
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
