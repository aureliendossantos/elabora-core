import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import { build } from '@elabora/node/build';
import { testPackage } from '@elabora/node/emulator/run';
import { fitDiagnostics, measureFit } from '@elabora/node/fit';

// The sample courses (slow; pnpm run test:matrix). The clockwork sample: one free object carried from screen to screen, a screen layout,
// a numeric question. The emulator answers the numeric block and checks phone-width overflow.
test('the clockwork sample passes the emulator, without overflow at phone width', { timeout: 300000 }, async () => {
  const src = path.resolve(import.meta.dirname, '../../examples/clockwork');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-cw-'));
  fs.cpSync(src, dir, { recursive: true, filter: (f) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(f.slice(src.length)) });
  const b = await build(dir, { profiles: ['moodle'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')) });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error')));
  const r = await testPackage({ dir: b.dirPath, profiles: ['moodle'], modes: ['iframe'], accessibility: true, unloadVariants: false });
  assert.deepEqual(r.runs.filter((x) => !x.ok).map((x) => x.failures.map((f) => `${f.code}: ${f.message}`)), []);
  assert.ok(r.accessibility);
  assert.equal(r.accessibility.violations, 0, JSON.stringify(r.accessibility.details));
  assert.deepEqual(r.accessibility.overflow, []);
});

// Slides: every screen of the sample fits the reference window with all its steps.
test('the clockwork slides fit at 1600×900', { timeout: 300000 }, async () => {
  const src = path.resolve(import.meta.dirname, '../../examples/clockwork');
  const fit = await measureFit(src, { sizes: [{ role: 'reference', size: '1600x900' }], fresh: true }); // the sample itself: measured, never reused
  assert.ok(fit.ok);
  assert.equal(fit.mode, 'slides');
  const ref = fit.sizes.find((z) => z.role === 'reference');
  assert.ok(ref);
  assert.equal(ref.size, '1600x900');
  assert.deepEqual(ref.screens.filter((s) => s.overflow).map((s) => `${s.screen} +${s.overflow} px`), []);
  assert.deepEqual(fitDiagnostics(fit).filter((d) => d.severity !== 'info').map((d) => `${d.code} ${d.message}`), []);
});
