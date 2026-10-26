import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { log } from '../log.ts';

interface Vault {
  client?: OAuthClientInformationMixed;
  /** The redirect URL the client above was registered with (CLI: 127.0.0.1; dashboard: the site). */
  clientRedirectUrl?: string;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

/** Where the encrypted vault text lives (a database row in production, memory in tests). */
export interface VaultStorage {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
  remove(): Promise<void>;
}

/**
 * Encrypted (AES-256-GCM) store for the OAuth client registration and tokens.
 * Upwork's terms treat these tokens as sensitive; they currently grant the full
 * MCP scope set for your account, so they are encrypted with
 * TOKEN_ENCRYPTION_KEY before they are stored, and never logged. The text
 * format ("iv.tag.data", base64url) is the same as the old data/upwork-oauth.enc file.
 */
export class TokenVault {
  private readonly storage: VaultStorage;
  private readonly key: Buffer;
  constructor(storage: VaultStorage, key: Buffer) {
    this.storage = storage;
    this.key = key;
  }

  async read(): Promise<Vault> {
    const text = await this.storage.load();
    if (!text) return {};
    const [iv, tag, data] = text.trim().split('.');
    if (!iv || !tag || !data) throw new Error('Stored Upwork sign-in is corrupt; run "npm run disconnect" then "npm run connect"');
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')) as Vault;
    } catch {
      throw new Error('Cannot decrypt the stored Upwork sign-in (TOKEN_ENCRYPTION_KEY changed?). Press "Connect Upwork" on the dashboard to sign in again.');
    }
  }

  async write(v: Vault): Promise<void> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
    await this.storage.save([iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.'));
  }

  async update(patch: Partial<Vault>): Promise<void> {
    await this.write({ ...(await this.read()), ...patch });
  }

  async delete(): Promise<void> {
    await this.storage.remove();
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    // On a server without a desktop (no xdg-open) spawning fails asynchronously; ignore it.
    spawn(cmd, args, { stdio: 'ignore', detached: true })
      .on('error', () => undefined)
      .unref();
  } catch {
    // The URL is printed as well.
  }
}

/**
 * OAuth client for the Upwork MCP server. Two sign-in flows use it:
 * - CLI (`npm run connect`): Upwork redirects to a one-shot server on 127.0.0.1.
 * - Dashboard ("Connect Upwork"): Upwork redirects to the site's /api/upwork/callback
 *   (`redirectUrl` + `onRedirect`), possibly in another serverless invocation.
 * Searches use it non-interactively: tokens are refreshed, never re-authorized.
 */
export class LocalOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  private readonly vault: TokenVault;
  private readonly port: number;
  private readonly interactive: boolean;
  private readonly webRedirectUrl: string | null;
  private readonly onRedirect: ((url: URL) => void) | null;

  constructor(opts: { vault: TokenVault; port: number; interactive: boolean; clientMetadataUrl?: string | null; redirectUrl?: string; onRedirect?: (url: URL) => void }) {
    this.vault = opts.vault;
    this.port = opts.port;
    this.interactive = opts.interactive;
    this.webRedirectUrl = opts.redirectUrl ?? null;
    this.onRedirect = opts.onRedirect ?? null;
    if (opts.clientMetadataUrl) this.clientMetadataUrl = opts.clientMetadataUrl;
  }

  get redirectUrl(): string {
    return this.webRedirectUrl ?? `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Upwork Job Alert Lite (self-hosted)',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  async state(): Promise<string> {
    const state = randomBytes(24).toString('base64url');
    await this.vault.update({ state });
    return state;
  }

  async clientInformation() {
    const v = await this.vault.read();
    // A new sign-in needs a client registered for this redirect URL; refreshing tokens needs
    // the client that issued them, whatever its redirect.
    if (this.interactive && v.clientRedirectUrl !== this.redirectUrl) return undefined;
    return v.client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed) {
    await this.vault.update({ client, clientRedirectUrl: this.redirectUrl });
  }
  async tokens() {
    return (await this.vault.read()).tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    await this.vault.update({ tokens });
  }
  async saveCodeVerifier(codeVerifier: string) {
    await this.vault.update({ codeVerifier });
  }
  async codeVerifier(): Promise<string> {
    const v = (await this.vault.read()).codeVerifier;
    if (!v) throw new Error('Missing PKCE code verifier; run "npm run connect" again');
    return v;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const v = await this.vault.read();
    if (scope === 'all') await this.vault.write({});
    else if (scope === 'client') await this.vault.write({ ...v, client: undefined, tokens: undefined });
    else if (scope === 'tokens') await this.vault.write({ ...v, tokens: undefined });
    else if (scope === 'verifier') await this.vault.write({ ...v, codeVerifier: undefined });
  }

  redirectToAuthorization(url: URL): void {
    if (this.onRedirect) return this.onRedirect(url);
    if (!this.interactive) {
      throw new Error('Upwork authorization is required. Press "Connect Upwork" on the dashboard (or run "npm run connect").');
    }
    process.stdout.write(`\nOpen this URL to sign in to Upwork and authorize the connection:\n\n  ${url.toString()}\n\n`);
    openBrowser(url.toString());
  }

  /** Waits for Upwork to redirect back with an authorization code, verifying the OAuth state. */
  waitForCallback(timeoutMs = 5 * 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = createServer(async (req, res) => {
        const u = new URL(req.url ?? '/', this.redirectUrl);
        if (u.pathname !== '/callback' || settled) {
          res.writeHead(404, { connection: 'close' }).end();
          return;
        }
        const expected = (await this.vault.read()).state ?? '';
        const got = u.searchParams.get('state') ?? '';
        const stateOk = expected.length > 0 && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
        const code = u.searchParams.get('code');
        const error = u.searchParams.get('error');
        const done = (status: number, msg: string) => {
          settled = true;
          // Connection: close so a keep-alive socket cannot outlive this one-shot server.
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(msg);
          clearTimeout(timer);
          server.close();
          server.closeAllConnections();
        };
        if (error) {
          done(400, `Authorization failed: ${error}. You can close this tab.`);
          reject(new Error(`Upwork returned: ${error}`));
        } else if (!stateOk || !code) {
          done(400, 'Invalid authorization response. You can close this tab.');
          reject(new Error('OAuth state mismatch or missing code; the authorization was rejected for safety'));
        } else {
          done(200, 'Upwork connected. You can close this tab and return to the terminal.');
          resolve(code);
        }
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('Timed out waiting for the Upwork authorization'));
      }, timeoutMs);
      server.on('error', reject);
      server.listen(this.port, '127.0.0.1', () => log.debug('oauth callback server listening', { port: this.port }));
    });
  }
}
