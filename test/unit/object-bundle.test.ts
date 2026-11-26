import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as wasm from 'esbuild-wasm';
import { readProjectFiles } from '@elabora/node/project-reader';
import { compileObjectCode, objectLibrarySources } from '@elabora/node/bundles';
import { compileObjectFromFiles, objectFrameHtml } from '@elabora/core/objects/bundle';
import type { ObjectLibraries } from '@elabora/core/objects/bundle';
import { ROOT } from '../helpers.ts';

// The same object bundled by the native esbuild from its folder and by esbuild-wasm from the project's
// files (what a browser's worker does): the code a browser makes for an object is the code a package
// carries. Both are the version pinned in package.json.
// The examples are copied out of this repository first: esbuild reads the nearest package.json of an
// object's folder, and one with "type": "module" (this repository's) makes it bundle the object's imports of
// CommonJS as Node's ES modules do (a "use strict" and a flag to its interop helper), as it never does in a
// module of the author's library, where the objects are bundled.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-object-bundle-'));
const examples = fs.readdirSync(path.join(ROOT, 'examples')).sort().map((name) => { const copy = path.join(scratch, name); fs.cpSync(path.join(ROOT, 'examples', name), copy, { recursive: true }); return copy; });
// esbuild-wasm starts once per process.
const started = wasm.initialize({});
const objectsOf = (root: string) => (fs.existsSync(path.join(root, 'objects')) ? fs.readdirSync(path.join(root, 'objects')).filter((id) => fs.existsSync(path.join(root, 'objects', id, 'object.js'))).sort() : []);

test('free objects: esbuild-wasm bundles an object from a table of files to the code the native esbuild bundles from its folder, minified or not', { timeout: 300000 }, async () => {
  await started;
  const sources = await objectLibrarySources();
  const libraries: ObjectLibraries = { d3: { contents: sources.d3 }, charts: { contents: sources.charts } };
  const compared: string[] = [];
  const differing: string[] = [];
  for (const root of examples) {
    const objects = objectsOf(root);
    if (objects.length === 0) continue;
    const { files } = readProjectFiles(root);
    for (const id of objects) {
      for (const minify of [true, false]) {
        const native = await compileObjectCode(path.join(root, 'objects', id), { minify });
        const browser = await compileObjectFromFiles(wasm, files, id, libraries, { minify });
        compared.push(`${path.basename(root)}/${id}${minify ? '' : ' (not minified)'}`);
        // Not minified, esbuild names each file it bundles in a comment, by its path in the folder or in the table: those lines apart, the code is the same.
        const same = (text: string) => text.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
        if (same(native) !== same(browser)) differing.push(`${path.basename(root)}/${id}${minify ? '' : ' (not minified)'}: ${native.length} bytes native, ${browser.length} with esbuild-wasm`);
      }
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  assert.ok(compared.length >= 6, `objects compared: ${compared.join(', ')}`);
  assert.deepEqual(differing, []);
});

test('free objects: a file an object imports that the table lacks and an add-on that is not vendored fail with their reasons; relative imports and JSON resolve in the table', async () => {
  await started;
  const libraries: ObjectLibraries = { d3: { contents: 'export const x = 1;' }, charts: { contents: 'export const y = 1;' } };
  const text = (value: string) => ({ kind: 'text' as const, text: value });
  const files = new Map([['objects/o/object.js', text("import './missing.js';")], ['objects/p/object.js', text("import 'three/addons/loaders/Evil.js';")], ['objects/q/object.js', text("import { a } from './lib/a.js'; import data from '../shared.json'; console.log(a, data);")], ['objects/q/lib/a.js', text('export const a = 1;')], ['objects/shared.json', text('{"x":1}')]]);
  await assert.rejects(compileObjectFromFiles(wasm, files, 'o', libraries), /No text file \/objects\/o\/missing\.js/);
  await assert.rejects(compileObjectFromFiles(wasm, files, 'p', libraries), /three addon "loaders\/Evil\.js" is not vendored/);
  const code = await compileObjectFromFiles(wasm, files, 'q', libraries, { minify: false });
  assert.match(code, /__elaboraObject/);
  assert.match(code, /x: 1/);
});

test('free objects: the frame page names the object\'s script, three when it needs it, and no network', () => {
  const html = objectFrameHtml({ title: 'A <b>lab</b>', requires: { three: 'r186' } }, { language: 'fr' });
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /<title>A &lt;b&gt;lab&lt;\/b&gt;<\/title>/);
  assert.match(html, /connect-src 'none'/);
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)">/g)].map((match) => match[1]), ['../../elabora/vendor/three-r186.js', 'object.js', '../../elabora/object-frame.js']);
  assert.doesNotMatch(objectFrameHtml({ title: 'Plain' }), /three/);
});
