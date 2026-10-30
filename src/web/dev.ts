import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.ts';
import type { Store } from '../db.ts';
import { tick } from '../engine.ts';
import { log } from '../log.ts';
import { createHandler, SECURITY_HEADERS } from './handler.ts';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const ASSETS: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/insights.js': ['insights.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

/**
 * Local stand-in for Vercel (`npm run dev`): serves public/ and the same API on
 * 127.0.0.1 only, and plays the external scheduler by calling the cron logic every
 * few minutes.
 */
export async function startDevServer(cfg: Config, store: Store, opts: { scheduler: boolean; port?: number }): Promise<{ url: string; close: () => Promise<void> }> {
  const api = createHandler({ store, cfg });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const asset = req.method === 'GET' ? ASSETS[path] : undefined;
    if (asset) {
      res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store', ...SECURITY_HEADERS }).end(readFileSync(join(PUBLIC_DIR, asset[0])));
      return;
    }
    await api(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? cfg.dev.port, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  let timer: NodeJS.Timeout | null = null;
  if (opts.scheduler) {
    const run = () =>
      tick({ store, cfg })
        .then((r) => r.status !== 'idle' && log.info('scheduler tick', { status: r.status }))
        .catch((err: Error) => log.error('scheduler tick failed', { error: err.message }));
    void run();
    timer = setInterval(run, 5 * 60_000);
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        if (timer) clearInterval(timer);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
