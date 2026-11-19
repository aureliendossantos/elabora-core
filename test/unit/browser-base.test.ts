import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bundleForBrowser } from '../browser-bundle.ts';
import { ROOT } from '../helpers.ts';

// The session's base (packages/engine/src/base/, D100) and the browser engine (src/browser/, D103)
// bundled for a browser, as a Worker imports them: every one of their files, with what they import, and
// not one import of Node.

// The base (D100) and the browser engine (D103).
const FOLDERS = ['base', 'browser'];

test('the session\'s base and the browser engine bundle for a browser without Node', async () => {
  const files = FOLDERS.flatMap((folder) => fs.readdirSync(path.join(ROOT, 'packages/engine/src', folder)).filter((name) => name.endsWith('.ts')).sort().map((name) => `${folder}/${name}`));
  assert.ok(files.includes('base/session-cloud.ts') && files.includes('browser/session.ts'), files.join(', '));
  const source = files.map((file, i) => `export * as m${i} from '@elabora/engine/${file.replace(/\.ts$/, '')}';`).join('\n');
  const bundle = await bundleForBrowser({ source });
  for (const file of files) assert.ok(bundle.inputs.includes(`packages/engine/src/${file}`), `${file} is in the bundle`);
  assert.ok(bundle.inputs.some((input) => input.startsWith('packages/core/src/sync/')), 'with the core it imports');
  assert.deepEqual(bundle.inputs.filter((input) => input.startsWith('packages/node/')), []);
});

test('a bundle for a browser fails at an import of Node, naming it and what imports it', async () => {
  // The desktop's session is the folder's: it does not bundle.
  await assert.rejects(bundleForBrowser({ source: 'export * from \'@elabora/engine/session\';' }), (error: Error) => /Node in a browser's bundle: \S+, imported by packages\/engine\/src\//.test(error.message));
  await assert.rejects(bundleForBrowser({ source: 'import \'fs\';' }), /Node in a browser's bundle: fs, imported by entry\.ts/);
  await assert.rejects(bundleForBrowser({ source: 'import \'@elabora/node/cloud/link\';' }), /Node in a browser's bundle: @elabora\/node\/cloud\/link/);
});
