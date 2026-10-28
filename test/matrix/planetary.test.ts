import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import { build } from '@elabora/node/build';
import { testPackage } from '@elabora/node/emulator/run';
import { fitDiagnostics, measureFit } from '@elabora/node/fit';
import type { PlayerWindow } from '../helpers.ts';

// The sample courses (slow; pnpm run test:matrix). The design sample: layouts, theme stylesheet and fonts, slides, maths, numeric answers, a
// responsive free object. The emulator answers the numeric blocks and checks phone-width overflow.
test('the planetary sample passes the emulator with its design layer, without overflow at phone width', { timeout: 300000 }, async () => {
  const src = path.resolve(import.meta.dirname, '../../examples/planetary-gearset');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-pg-'));
  fs.cpSync(src, dir, { recursive: true, filter: (f) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(f.slice(src.length)) });
  const b = await build(dir, { profiles: ['moodle'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')) });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error')));
  const r = await testPackage({ dir: b.dirPath, profiles: ['moodle'], modes: ['iframe'], accessibility: true, unloadVariants: false });
  assert.deepEqual(r.runs.filter((x) => !x.ok).map((x) => x.failures.map((f) => `${f.code}: ${f.message}`)), []);
  assert.ok(r.accessibility);
  assert.equal(r.accessibility.violations, 0, JSON.stringify(r.accessibility.details));
  assert.deepEqual(r.accessibility.overflow, []);
});

// Slides: every screen of the sample fits the reference window with all its steps; steps reveal
// with Continue, take focus, and a screen counts as viewed only once its last step is shown.
test('the planetary slides fit at 1600×900, and steps reveal with Continue', { timeout: 300000 }, async () => {
  const { startServer } = await import('@elabora/node/emulator/server');
  const { launchBrowser } = await import('@elabora/node/emulator/browser');
  const src = path.resolve(import.meta.dirname, '../../examples/planetary-gearset');
  const fit = await measureFit(src, { sizes: [{ role: 'reference', size: '1600x900' }], fresh: true }); // the sample itself: measured, never reused
  assert.ok(fit.ok);
  assert.equal(fit.mode, 'slides');
  const ref = fit.sizes.find((z) => z.role === 'reference');
  assert.ok(ref);
  assert.equal(ref.size, '1600x900');
  assert.deepEqual(ref.screens.filter((s) => s.overflow).map((s) => `${s.screen} +${s.overflow} px`), []);
  assert.deepEqual(fitDiagnostics(fit).filter((d) => d.severity !== 'info').map((d) => `${d.code} ${d.message}`), []);

  const b = await build(src, { emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')), writeLock: false });
  assert.ok(b.ok && b.dirPath);
  const server = await startServer();
  server.addPackage('steps', b.dirPath);
  const browser: Browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(`${server.base}/pkg/steps/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    const state = () => page.evaluate(() => {
      const t = (window as PlayerWindow).__elabora;
      return {
        screen: t.screen, step: t.step.revealed,
        label: document.querySelector('.t-nav-btn--next .t-nav-label:not([aria-hidden])')!.textContent,
        pending: [...document.querySelectorAll<HTMLElement>('[data-t-pending]')].map((n) => n.dataset.block),
        viewed: t.engine.screenComplete(t.engine.screens[0]),
        focus: (document.activeElement as HTMLElement | null)?.dataset?.block || null
      };
    });
    let s = await state();
    assert.deepEqual([s.screen, s.step, s.label, s.viewed], ['intro', 1, 'Continue', false]);
    assert.deepEqual(s.pending, ['intro-reduce', 'intro-speed-up', 'intro-reverse']);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-block="intro-reduce"]')!).visibility), 'hidden', 'slides keep the place of a pending step');
    await page.click('.t-nav-btn--next');
    s = await state();
    assert.deepEqual([s.screen, s.step, s.label, s.viewed, s.focus], ['intro', 2, 'Next', true, 'intro-reduce']);
    assert.deepEqual(s.pending, []);
    await page.click('.t-nav-btn--next');
    await page.click('.t-nav-btn--next');
    await page.click('.t-nav-btn--next');
    s = await state();
    assert.deepEqual([s.screen, s.step, s.label], ['practice', 1, 'Continue']);
    await page.click('.t-nav-btn--next');
    // Last step of practice: its question must be answered first (lockUntilComplete).
    assert.equal(await page.getAttribute('.t-nav-btn--next', 'aria-disabled'), 'true');
    await page.click('.t-nav-btn--previous');
    s = await state();
    assert.deepEqual([s.screen, s.pending], ['anatomy', []], 'a visited screen shows every step');
  } finally {
    await browser.close();
    await server.close();
  }
});
