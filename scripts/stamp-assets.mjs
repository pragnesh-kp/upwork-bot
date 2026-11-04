// Adds a content hash to the CSS/JS links in a built index.html (app.css?v=1a2b3c4d), so a
// browser never pairs a new page with an old file from its cache after a deploy.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function stampAssets(dir) {
  const page = join(dir, 'index.html');
  const html = readFileSync(page, 'utf8').replace(/(src|href)="\/(app\.css|app\.js|insights\.js|favicon\.svg)"/g, (_, attr, file) => {
    const v = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex').slice(0, 10);
    return `${attr}="/${file}?v=${v}"`;
  });
  writeFileSync(page, html);
}
