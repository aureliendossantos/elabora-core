import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as esbuild from 'esbuild';
import { FORMAT } from '@elabora/format';
import { sha256 } from '@elabora/core/util/sha256';
import * as paths from '@elabora/core/util/paths';
import { createProjectFiles, binaryFile, fileHash, readText, hasFile } from '@elabora/core/project/files';
import { loadProject } from '@elabora/core/project/load';
import { validateProject } from '@elabora/core/validate/index';
import { generatorInputs, listGenerators } from '@elabora/core/project/generators';
import { readProjectFiles, loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { ROOT, EXAMPLE, codes } from '../helpers.ts';

import { bytes as fixtureBytes } from '../bytes.ts';
import { resources } from '../resources.ts';

test('sha256 gives the digests of node:crypto', () => {
  const ref = (d: string | Uint8Array) => crypto.createHash('sha256').update(d).digest('hex');
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70000]) {
    const bytes = fixtureBytes(n, n + 1);
    assert.equal(sha256(bytes), ref(bytes), `${n} bytes`);
  }
  for (const s of ['', 'abc', 'Équation ✓ 𝄞 日本語', 'x'.repeat(5000)]) assert.equal(sha256(s), ref(s));
});

test('POSIX path helpers follow node:path', () => {
  const cases = ['', '.', '..', '...', '/', 'a', 'a/', 'a//b', './a', 'a/./b', 'a/../b', '../a', 'a/b/../../..', '/a/../..', 'a/b/c.d.e', '.hidden', 'x.svg', 'theme//fonts/../a.woff2', '///a', 'a/..', 'foo.', '..foo'];
  for (const c of cases) {
    for (const f of ['normalize', 'dirname', 'basename', 'extname', 'isAbsolute'] as const) assert.equal(paths[f](c), path.posix[f](c), `${f}(${JSON.stringify(c)})`);
    for (const d of cases) assert.equal(paths.join(c, d), path.posix.join(c, d), `join(${JSON.stringify(c)}, ${JSON.stringify(d)})`);
  }
});

test('a project loads and validates from files in memory, as from its folder', () => {
  const { files } = readProjectFiles(EXAMPLE);
  // A copy made of plain entries: nothing in the core may need the folder.
  const copy = createProjectFiles([...files].map(([p, f]) => [p, f.kind === 'text' ? f.text : binaryFile(f.size)] as const));
  const inMemory = validateProject(loadProject(copy), { profiles: ['moodle'] });
  const fromDir = validateDir(EXAMPLE, { profiles: ['moodle'] });
  assert.deepEqual(inMemory.diagnostics, fromDir.diagnostics);
  assert.equal(loadProject(copy).root, '');
  assert.equal(loadProjectFromDir(EXAMPLE).root, EXAMPLE);

  const course = { format: FORMAT, id: 'mini', title: 'Mini', language: 'en', version: '1.0.0', sections: [{ id: 's', title: 'S', screens: ['a'] }] };
  const project = loadProject(createProjectFiles([['course.json', JSON.stringify(course)], ['screens/a.json', '{ "id": "a",']]));
  assert.deepEqual(project.loadErrors.map((e) => `${e.code} ${e.file}`), ['E_FILE_MISSING plan.json', 'E_JSON_PARSE screens/a.json']);
  assert.match(project.loadErrors[1].message, /line 1, column/);
  assert.throws(() => createProjectFiles([['../x.json', '{}']]), /project-relative/);
});

test('the snapshot normalises paths and hashes text and binary files', () => {
  const files = createProjectFiles([['assets/a.svg', '<svg/>'], ['assets/b.png', binaryFile(3, { hash: 'sha256:abc' })], ['assets/c.png', binaryFile(3)]]);
  assert.ok(hasFile(files, 'theme/../assets/a.svg') && hasFile(files, './assets/a.svg') && hasFile(files, '/assets/a.svg'));
  assert.ok(!hasFile(files, '../assets/a.svg') && !hasFile(files, 'assets'));
  assert.equal(readText(files, 'assets/b.png'), null);
  assert.equal(fileHash(files, 'assets/a.svg'), `sha256:${crypto.createHash('sha256').update('<svg/>').digest('hex')}`);
  assert.equal(fileHash(files, 'assets/b.png'), 'sha256:abc');
  assert.equal(fileHash(files, 'assets/c.png'), null);
});

test('the folder snapshot hashes binary content and invalidates it after a file changes', (t) => {
  const dir = resources(t).copyExample();
  const png = path.join(dir, 'assets', 'pixel.png');
  // Written a minute ago: a file modified just before it is hashed is not cached (racy, as in git).
  const write = (bytes: number[]) => { fs.writeFileSync(png, Buffer.from(bytes)); const t = new Date('2020-01-01'); fs.utimesSync(png, t, t); };
  const digest = () => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(png)).digest('hex')}`;
  write([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  let snap = readProjectFiles(dir);
  const entry = snap.files.get('assets/pixel.png');
  assert.equal(entry?.kind, 'binary');
  assert.equal(entry?.kind === 'binary' && entry.size, 7);
  assert.equal(snap.files.get('course.json')?.kind, 'text');
  const before = fileHash(snap.files, 'assets/pixel.png');
  assert.equal(before, digest());
  assert.equal(fileHash(readProjectFiles(dir).files, 'assets/pixel.png'), before);

  write([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);
  snap = readProjectFiles(dir);
  assert.equal(fileHash(snap.files, 'assets/pixel.png'), digest());
  assert.ok(![...snap.files.keys()].some((p) => p.startsWith('.elabora/')), '.elabora/ is not part of the project');

  const missing = readProjectFiles(path.join(dir, 'no-such-folder'));
  assert.equal(missing.files.size, 0);
  assert.equal(codes(validateDir(path.join(dir, 'no-such-folder')).diagnostics).filter((c: string) => c === 'E_FILE_MISSING').length, 2);
});

test('files left by sync services are reported, not loaded', (t) => {
  const dir = resources(t).copyExample();
  fs.copyFileSync(path.join(dir, 'screens', 'accueil.json'), path.join(dir, 'screens', 'accueil (conflicted copy 2026-10-06).json'));
  fs.writeFileSync(path.join(dir, 'assets', '.notes.md.icloud'), '');
  const project = loadProjectFromDir(dir);
  assert.ok(![...project.screens.keys()].some((id) => id.includes('conflicted')));
  const found = validateProject(project).diagnostics.filter((d) => d.code === 'W_SYNC_CONFLICT_COPY');
  assert.deepEqual(found.map((d) => d.file).sort(), ['assets/.notes.md.icloud', 'screens/accueil (conflicted copy 2026-10-06).json']);
  assert.ok(found.every((d) => d.severity === 'warning' && d.fix));
  assert.match(found.find((d) => d.file?.startsWith('screens/'))?.message ?? '', /copy of screens\/accueil\.json/);
});

test('generator inputs are found from the snapshot as esbuild finds them', () => {
  for (const ex of ['planetary-gearset', 'orbital-rendezvous']) {
    const dir = path.join(ROOT, 'examples', ex);
    const { files } = readProjectFiles(dir);
    const generators = listGenerators({ files });
    assert.ok(generators.length);
    for (const g of generators) {
      const bundled = esbuild.buildSync({ entryPoints: [path.join(dir, g)], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, metafile: true, logLevel: 'silent', absWorkingDir: dir });
      assert.deepEqual(generatorInputs(files, g).inputs, Object.keys(bundled.metafile.inputs).sort(), `${ex}/${g}`);
    }
  }
  const files = createProjectFiles([['generators/a.mjs', "import { x } from './_lib';\nexport { y } from '../data/y.json';\nimport 'node:fs';\nimport three from 'three';\nexport default () => import('./missing.mjs');"], ['generators/_lib.js', 'export const x = 1;'], ['data/y.json', '{}']]);
  assert.deepEqual(generatorInputs(files, 'generators/a.mjs'), { error: 'Could not resolve "./missing.mjs"' });
});
