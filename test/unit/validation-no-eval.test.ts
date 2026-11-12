import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createProjectFiles } from '@elabora/core/project/files';
import { loadProject } from '@elabora/core/project/load';
import { validateProject } from '@elabora/core/validate/index';
import { exampleNames, snapshotOfExample } from '../validation-corpus.ts';

// A Cloudflare Worker refuses `eval` and `new Function`; the project room validates there (D80).
test('validateProject runs where code generation from strings is forbidden, with the same findings', () => {
  const child = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', path.join(import.meta.dirname, '../validation-no-eval-child.ts')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  const found = JSON.parse(child.stdout) as Record<string, { ok: boolean; summary: unknown; diagnostics: unknown }>;
  assert.ok(!('flagIgnored' in found), 'node did not forbid new Function: the test would prove nothing');
  for (const name of exampleNames()) {
    const result = validateProject(loadProject(createProjectFiles(snapshotOfExample(name)), { root: '' }));
    assert.deepEqual(found[name], JSON.parse(JSON.stringify({ ok: result.ok, summary: result.summary, diagnostics: result.diagnostics })), name);
  }
});
