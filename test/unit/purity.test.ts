import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers.ts';
import { builtinTemplatesModule, OUTPUT } from '../../scripts/gen-builtin-templates.ts';
import { PROFILE_FILES, listProfiles } from '@elabora/core/lms/profiles';

// format, player, fonts and core run in browsers and workers too: no Node module, no process, no
// Buffer, and no import of the Node packages (docs/architecture.md, Packages).
const PURE = ['packages/format/src', 'packages/player/src', 'packages/fonts/src', 'packages/core/src'];
const FORBIDDEN: [RegExp, string][] = [
  [/\bfrom\s+['"]node:|\bimport\s*\(\s*['"]node:|\bimport\s+['"]node:/, 'a node: import'],
  [/\bfrom\s+['"](fs|path|os|url|crypto|child_process|module)['"]/, 'a Node module import'],
  [/['"]@elabora\/(node|cli|engine)(\/[^'"]*)?['"]/, 'an import of a Node package'],
  [/\bBuffer\b/, 'Buffer'],
  // The global, not a file or an import named process (the process chart: process.ts).
  [/(?<![\w/.'"-])process\./, 'process']
];
// Comments may name what the code must not use.
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

const sources = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = `${dir}/${e.name}`;
  if (e.isDirectory()) return sources(rel);
  return /\.(ts|js|mjs)$/.test(e.name) ? [rel] : [];
});

test('format, player, fonts and core use no Node API and no Node package', () => {
  const found: string[] = [];
  for (const dir of PURE) {
    for (const file of sources(dir)) {
      const lines = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8')).split('\n');
      lines.forEach((line, i) => { for (const [re, what] of FORBIDDEN) if (re.test(line)) found.push(`${file}:${i + 1} ${what}: ${line.trim().slice(0, 100)}`); });
    }
  }
  assert.deepEqual(found, []);
  for (const pkg of ['format', 'player', 'fonts', 'core']) {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', pkg, 'tsconfig.json'), 'utf8'));
    assert.deepEqual(tsconfig.compilerOptions?.types ?? JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.base.json'), 'utf8')).compilerOptions.types, [], `${pkg}: "types": [] so that Node types are not available`);
  }
});

test('the built-in templates module is generated from the current templates', () => {
  assert.equal(fs.readFileSync(OUTPUT, 'utf8'), builtinTemplatesModule(), 'run npm run generate');
});

test('every LMS profile file is imported, in file name order', () => {
  const onDisk = fs.readdirSync(path.join(ROOT, 'packages/core/profiles')).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(PROFILE_FILES.map(([f]) => f), onDisk, 'add the profile to packages/core/src/lms/profiles.ts');
  for (const [f, p] of PROFILE_FILES) assert.deepEqual(p, JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/core/profiles', f), 'utf8')));
  assert.equal(listProfiles().length, onDisk.length);
});
