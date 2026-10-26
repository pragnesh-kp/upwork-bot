import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { log } from '../log.ts';

interface Vault {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

/**
 * Encrypted (AES-256-GCM) local store for the OAuth client registration and
 * tokens. Upwork's terms treat these tokens as sensitive; they currently grant
 * the full MCP scope set for your account, so the file is encrypted with
 * TOKEN_ENCRYPTION_KEY and never logged.
 */
export class TokenVault {
  private readonly path: string;
  private readonly key: Buffer;
  constructor(path: string, key: Buffer) {
    this.path = path;
    this.key = key;
  }

  read(): Vault {
    if (!existsSync(this.path)) return {};
    const [iv, tag, data] = readFileSync(this.path, 'utf8').trim().split('.');
    if (!iv || !tag || !data) throw new Error('Token file is corrupt; run "npm run disconnect" then "npm run connect"');
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')) as Vault;
    } catch {
      throw new Error('Cannot decrypt the token file (TOKEN_ENCRYPTION_KEY changed?). Run "npm run disconnect" then "npm run connect".');
    }
  }

  write(v: Vault): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
    writeFileSync(this.path, [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.'), { mode: 0o600 });
  }

  update(patch: Partial<Vault>): void {
    this.write({ ...this.read(), ...patch });
  }

  delete(): void {
    rmSync(this.path, { force: true });
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

export class LocalOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  private readonly vault: TokenVault;
  private readonly port: number;
  private readonly interactive: boolean;

  constructor(opts: { vault: TokenVault; port: number; interactive: boolean; clientMetadataUrl?: string | null }) {
    this.vault = opts.vault;
    this.port = opts.port;
    this.interactive = opts.interactive;
    if (opts.clientMetadataUrl) this.clientMetadataUrl = opts.clientMetadataUrl;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
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

  state(): string {
    const state = randomBytes(24).toString('base64url');
    this.vault.update({ state });
    return state;
  }

  clientInformation() {
    return this.vault.read().client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.vault.update({ client });
  }
  tokens() {
    return this.vault.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.vault.update({ tokens });
  }
  saveCodeVerifier(codeVerifier: string) {
    this.vault.update({ codeVerifier });
  }
  codeVerifier(): string {
    const v = this.vault.read().codeVerifier;
    if (!v) throw new Error('Missing PKCE code verifier; run "npm run connect" again');
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const v = this.vault.read();
    if (scope === 'all') this.vault.write({});
    else if (scope === 'client') this.vault.write({ ...v, client: undefined, tokens: undefined });
    else if (scope === 'tokens') this.vault.write({ ...v, tokens: undefined });
    else if (scope === 'verifier') this.vault.write({ ...v, codeVerifier: undefined });
  }

  redirectToAuthorization(url: URL): void {
    if (!this.interactive) {
      throw new Error('Upwork authorization is required. Run "npm run connect" to sign in.');
    }
    process.stdout.write(`\nOpen this URL to sign in to Upwork and authorize the connection:\n\n  ${url.toString()}\n\n`);
    openBrowser(url.toString());
  }

  /** Waits for Upwork to redirect back with an authorization code, verifying the OAuth state. */
  waitForCallback(timeoutMs = 5 * 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', this.redirectUrl);
        if (u.pathname !== '/callback' || settled) {
          res.writeHead(404, { connection: 'close' }).end();
          return;
        }
        const expected = this.vault.read().state ?? '';
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
