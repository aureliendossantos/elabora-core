// Copies snapdom 3.8.3 (MIT), as its package ships it (one minified script that sets window.snapdom), into
// packages/node/vendor/: the miniatures' painter in a browser loads it where the browser cannot draw a page itself
// (drawElementImage), and only there (D139). Pinned: a new version is read again before it replaces this one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '3.8.3';
const root = path.resolve(import.meta.dirname, '..');
let dir = path.dirname(fileURLToPath(import.meta.resolve('@zumer/snapdom')));
while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== '@zumer/snapdom') {
  const parent = path.dirname(dir);
  if (parent === dir) throw new Error('@zumer/snapdom is not installed: pnpm install');
  dir = parent;
}
const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
if (version !== VERSION) throw new Error(`@zumer/snapdom ${version} installed; Elabora pins ${VERSION}.`);
const vendor = path.join(root, 'packages/node/vendor');
fs.mkdirSync(vendor, { recursive: true });
const code = fs.readFileSync(path.join(dir, 'dist/snapdom.js'), 'utf8');
fs.writeFileSync(path.join(vendor, `snapdom-${VERSION}.js`), code);
fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(vendor, 'snapdom-LICENSE.txt'));
console.log(`vendor/snapdom-${VERSION}.js ${(code.length / 1024).toFixed(0)} KB`);
