import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyExample } from '../helpers.ts';
import { build } from '@elabora/node/build';
import { validateDir } from '@elabora/node/project-reader';
import { testPackage } from '@elabora/node/emulator/run';
import { fitDiagnostics, measureFit } from '@elabora/node/fit';
import { testObject } from '@elabora/node/objects/test';

// The canal-locks sample (slow; pnpm run test:matrix): a short slide module with no recorded media,
// one 3D free object that serves four screens (explore, explain, a dialogue's consequences), a
// component of its own and a watercolour backdrop.
const SOURCE = path.resolve(import.meta.dirname, '../../examples/canal-locks');
const copy = () => copyExample(SOURCE);

test('the canal-locks sample validates and passes the emulator with axe-core, without overflow at phone width', { timeout: 400000 }, async () => {
  const dir = copy();
  const validation = validateDir(dir);
  assert.equal(validation.summary.errors, 0, JSON.stringify(validation.diagnostics.filter((d) => d.severity === 'error')));
  const b = await build(dir, { profiles: ['moodle'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')) });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error')));
  const r = await testPackage({ dir: b.dirPath, profiles: ['moodle'], modes: ['iframe'], accessibility: true, unloadVariants: false });
  assert.deepEqual(r.runs.filter((run) => !run.ok).map((run) => run.failures.map((failure) => `${failure.code}: ${failure.message}`)), []);
  assert.ok(r.accessibility);
  assert.equal(r.accessibility.violations, 0, JSON.stringify(r.accessibility.details));
  assert.deepEqual(r.accessibility.overflow, []);
});

test('the canal-locks slides fit at 1600×900 and 1280×720', { timeout: 400000 }, async () => {
  const fit = await measureFit(copy(), { fresh: true });
  assert.ok(fit.ok, JSON.stringify(fit.diagnostics));
  assert.equal(fit.mode, 'slides');
  assert.ok(['1600x900', '1280x720'].every((size) => fit.sizes.some((measured) => measured.size === size)));
  assert.deepEqual(fitDiagnostics(fit).filter((d) => d.severity !== 'info').map((d) => `${d.code} ${d.message}`), []);
});

test('the lock of canal-locks passes its gates', { timeout: 900000 }, async () => {
  const r = await testObject(copy(), 'canal-lock');
  assert.ok(r.ok, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'), null, 1));
});
