import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '@elabora/node/build';
import { validateDir } from '@elabora/node/project-reader';
import { testPackage } from '@elabora/node/emulator/run';
import { fitDiagnostics, measureFit } from '@elabora/node/fit';
import { testObject } from '@elabora/node/objects/test';

// The scroll sample (slow; pnpm run test:matrix): long pages with scroll-driven design, Continue
// buttons in the page, steps that open once answered, Previous and Next at the end of the page,
// and a 3D chart table that appears as the page scrolls to it.
const SOURCE = path.resolve(import.meta.dirname, '../../examples/medieval-charts');
const copy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-mc-'));
  fs.cpSync(SOURCE, dir, { recursive: true, filter: (file) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(file.slice(SOURCE.length)) });
  return dir;
};

test('the medieval-charts sample validates and passes the emulator with axe-core, without overflow at phone width', { timeout: 400000 }, async () => {
  const dir = copy();
  const validation = validateDir(dir, { release: true });
  assert.equal(validation.summary.errors, 0, JSON.stringify(validation.diagnostics.filter((d) => d.severity === 'error')));
  const b = await build(dir, { profiles: ['moodle'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')), release: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error')));
  const r = await testPackage({ dir: b.dirPath, profiles: ['moodle'], modes: ['iframe'], accessibility: true, unloadVariants: false });
  assert.deepEqual(r.runs.filter((run) => !run.ok).map((run) => run.failures.map((failure) => `${failure.code}: ${failure.message}`)), []);
  assert.ok(r.accessibility);
  assert.equal(r.accessibility.violations, 0, JSON.stringify(r.accessibility.details));
  assert.deepEqual(r.accessibility.overflow, []);
});

test('the medieval-charts pages read well down their whole length, animations on or off', { timeout: 400000 }, async () => {
  const fit = await measureFit(copy());
  assert.ok(fit.ok, JSON.stringify(fit.diagnostics));
  assert.equal(fit.mode, 'scroll');
  assert.deepEqual(fitDiagnostics(fit).map((d) => `${d.code} ${d.message}`), []);
});

test('the chart table of medieval-charts passes its gates', { timeout: 400000 }, async () => {
  const r = await testObject(copy(), 'chart-table');
  assert.ok(r.ok, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'), null, 1));
});
