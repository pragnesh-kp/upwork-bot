// Builds the always-on Node server (Hostinger Node.js Web Apps, or any VPS) into dist/.
// Hostinger runs this as the build command ("npm run build:hostinger", see HOSTINGER.md); the
// entry file is dist/server.mjs. dist/ is complete on its own (server + dashboard files),
// so it runs even where only the output directory is kept, with no node_modules.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
import { stampAssets } from './stamp-assets.mjs';

rmSync('dist', { recursive: true, force: true });
cpSync('public', 'dist/public', { recursive: true });
stampAssets('dist/public');
const result = await build({
  entryPoints: ['src/web/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/server.mjs',
  // MySQL on Hostinger. Turso, if used instead, is reached over HTTP: no native module needed.
  alias: { '@libsql/client': '@libsql/client/web' },
  // Bundled CommonJS packages (mysql2) still call require() for Node's own modules.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`Built dist/server.mjs (${(bytes / 1024).toFixed(0)} KB). Start it with: node dist/server.mjs`);
