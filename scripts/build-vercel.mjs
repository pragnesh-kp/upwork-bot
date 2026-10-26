// Builds the Vercel deployment (Build Output API v3) into .vercel/output.
// Vercel runs this as the project's build command ("npm run build", see vercel.json).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '.vercel/output';
const ROUTES = ['api/login', 'api/logout', 'api/state', 'api/jobs', 'api/jobs/state', 'api/search', 'api/step', 'api/filters/add', 'api/filters/remove', 'api/cron', 'api/upwork/connect', 'api/upwork/callback', 'api/upwork/client-metadata'];
// These run search work: give them Vercel Hobby's maximum (300 s); the engine stops itself earlier.
const LONG = new Set(['api/search', 'api/step', 'api/cron', 'api/upwork/connect', 'api/upwork/callback']);
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'static'), { recursive: true });
cpSync('public', join(OUT, 'static'), { recursive: true });

const bundle = join(OUT, 'bundle.tmp.js');
const result = await build({
  entryPoints: ['src/web/vercel.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundle,
  // The web client talks to Turso over HTTP/WebSockets and needs no native module.
  alias: { '@libsql/client': '@libsql/client/web' },
  legalComments: 'none',
  // Vercel's Node launcher calls module.exports (like the official example); keep .default as well.
  footer: { js: 'module.exports = Object.assign(module.exports.default, { default: module.exports.default });' },
  logLevel: 'warning',
  metafile: true,
});
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);

for (const route of ROUTES) {
  const dir = join(OUT, 'functions', `${route}.func`);
  mkdirSync(dir, { recursive: true });
  cpSync(bundle, join(dir, 'index.js'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(
    join(dir, '.vc-config.json'),
    JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.js', launcherType: 'Nodejs', shouldAddHelpers: false, ...(LONG.has(route) ? { maxDuration: 300 } : {}) }, null, 2),
  );
}
rmSync(bundle);

writeFileSync(
  join(OUT, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: '/(.*)', headers: SECURITY_HEADERS, continue: true }, { handle: 'filesystem' }],
      // Backup only: Vercel Hobby runs crons once a day. The every-few-minutes calls come from an
      // external scheduler (see DEPLOY.md). Vercel sends "Authorization: Bearer $CRON_SECRET".
      crons: [{ path: '/api/cron', schedule: '0 6 * * *' }],
    },
    null,
    2,
  ),
);
console.log(`Built ${OUT}: ${ROUTES.length} functions (bundle ${(bytes / 1024).toFixed(0)} KB) + static page.`);

