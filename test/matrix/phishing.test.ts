import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '@elabora/node/build';
import { validateDir } from '@elabora/node/project-reader';
import { testPackage } from '@elabora/node/emulator/run';
import { fitDiagnostics, measureFit } from '@elabora/node/preview';

// The charts sample (slow; pnpm run test:matrix): twelve chart blocks on narrated slides, their items
// brought by the voice's words, a trend the learner predicts, a step that opens once answered, a
// check question and a decision, in a theme of its own.
const SOURCE = path.resolve(import.meta.dirname, '../../examples/phishing-by-numbers');
const copy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-pn-'));
  fs.cpSync(SOURCE, dir, { recursive: true, filter: (file) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(file.slice(SOURCE.length)) });
  return dir;
};

test('the phishing-by-numbers sample validates and passes the emulator with axe-core, without overflow at phone width', { timeout: 400000 }, async () => {
  const dir = copy();
  const validation = validateDir(dir, { release: true });
  assert.equal(validation.summary.errors, 0, JSON.stringify(validation.diagnostics.filter((d) => d.severity === 'error')));
  const charts = new Set(fs.readdirSync(path.join(dir, 'screens')).flatMap((file) => JSON.parse(fs.readFileSync(path.join(dir, 'screens', file), 'utf8')).blocks.map((block: { type: string }) => block.type)));
  for (const type of ['key-figures', 'bars', 'donut', 'trend', 'proportion', 'before-after', 'levels', 'process', 'cycle', 'matrix', 'milestones', 'diagram']) assert.ok(charts.has(type), `no ${type} in the sample`);
  const b = await build(dir, { profiles: ['moodle'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')), release: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error')));
  const r = await testPackage({ dir: b.dirPath, profiles: ['moodle'], modes: ['iframe'], accessibility: true, unloadVariants: false });
  assert.deepEqual(r.runs.filter((run) => !run.ok).map((run) => run.failures.map((failure) => `${failure.code}: ${failure.message}`)), []);
  assert.ok(r.accessibility);
  assert.equal(r.accessibility.violations, 0, JSON.stringify(r.accessibility.details));
  assert.deepEqual(r.accessibility.overflow, []);
});

test('the phishing-by-numbers slides fit 1600×900 and 1280×720', { timeout: 400000 }, async () => {
  const fit = await measureFit(copy());
  assert.ok(fit.ok, JSON.stringify(fit.diagnostics));
  assert.equal(fit.mode, 'slides');
  assert.deepEqual(fitDiagnostics(fit).map((d) => `${d.code} ${d.message}`), []);
});
