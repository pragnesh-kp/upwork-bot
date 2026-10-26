import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigError, loadConfig } from '../config.ts';
import { Store } from '../db.ts';
import { configureLog, log } from '../log.ts';
import { createHandler, SECURITY_HEADERS } from './handler.ts';

let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;

/**
 * Vercel function entry (bundled by scripts/build-vercel.mjs). One instance can serve
 * many requests, so the configuration and the database client are created once.
 */
export default async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!handler) {
    try {
      const cfg = loadConfig(process.env);
      configureLog(cfg.logLevel, null);
      handler = createHandler({ store: Store.open(cfg.db.url, cfg.db.authToken), cfg });
    } catch (err) {
      // Configuration messages never contain secret values.
      const msg = err instanceof ConfigError ? err.message : 'Server configuration error';
      log.error('startup failed', { error: (err as Error).message });
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS }).end(JSON.stringify({ error: msg }));
      return;
    }
  }
  await handler(req, res);
}
