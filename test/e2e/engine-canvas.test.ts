import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Browser } from 'playwright-core';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { openProject } from '@elabora/engine';
import type { CanvasApi } from '@elabora/player/canvas';
import { ROOT } from '../helpers.ts';

// The engine and its canvas in Chrome: an edit (a command of the app, an agent's own file write)
// reaches the canvas page without a reload, the free object of the screen keeps running, view
// changes go through requests. Timings from the edit to the text in the page's DOM are reported.
// ELABORA_LARGE_COURSE=<folder> (scripts/make-large-course.ts) measures on a large course, copied
// first; by default the planetary-gearset sample.

type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi; seen?: Promise<number>; mark?: string };

function course(): string {
  const source = process.env.ELABORA_LARGE_COURSE ?? path.join(ROOT, 'examples/planetary-gearset');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-engine-canvas-')), 'course');
  // Clones on APFS: a large course costs no copy.
  if (process.platform === 'darwin') execFileSync('cp', ['-c', '-R', source, dir]);
  else fs.cpSync(source, dir, { recursive: true });
  fs.rmSync(path.join(dir, '.elabora'), { recursive: true, force: true });
  return dir;
}

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return `median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms (n=${sorted.length})`;
};

test('engine canvas: edits reach the page in place, timed from the edit to the DOM', { timeout: 300000 }, async (t) => {
  const dir = course();
  // No versions: the first one of a large course (every video hashed and stored) would be timed with the first edit.
  const session = await openProject(dir, { backups: { enabled: false, prune: false }, media: { enabled: false } });
  const browser: Browser = await launchBrowser('chromium');
  try {
    const canvas = await session.openCanvas();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let frames = 0;
    page.on('framenavigated', (frame) => { if (frame.url().includes('/frame.html')) frames++; });
    await page.goto(canvas.url);
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
    // Waits in the page for a text in a block; resolves with the wall-clock time it appeared.
    const watch = (block: string, needle: string) => page.evaluate(({ block, text }) => {
      (window as CanvasWindow).seen = new Promise((resolve) => {
        const found = () => document.querySelector(`[data-block="${block}"]`)?.innerHTML.includes(text);
        if (found()) { resolve(performance.timeOrigin + performance.now()); return; }
        const observer = new MutationObserver(() => {
          if (!found()) return;
          observer.disconnect();
          resolve(performance.timeOrigin + performance.now());
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      });
    }, { block, text: needle });
    const seen = () => page.evaluate(() => (window as CanvasWindow).seen!);

    // Commands of the app, on a screen with a free object (a 3D bench: software WebGL in headless
    // Chrome competes with the page's main thread) and on a screen without.
    const timeCommands = async (screen: string, block: string) => {
      if (session.summary().outline.flatMap((section) => section.screens).every((entry) => entry.id !== screen)) return [];
      const view = await session.canvasView({ screen });
      await page.waitForFunction((id) => (window as CanvasWindow).__elaboraCanvas.layout().id === id, view.id);
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        await watch(block, `<strong>edit ${i}</strong>`);
        const started = performance.timeOrigin + performance.now();
        const result = await session.run('update_block', { block, props: { markdown: `Choose the held member, **edit ${i}**.` } });
        const ran = performance.timeOrigin + performance.now() - started;
        times.push((await seen()) - started);
        if (process.env.ELABORA_DEBUG_TIMINGS) t.diagnostic(`${screen} edit ${i}: run ${ran.toFixed(1)} ms, DOM ${times.at(-1)?.toFixed(1)} ms`);
        await page.waitForFunction((id) => (window as CanvasWindow).__elaboraCanvas.layout().id === id, result.change?.seq);
      }
      t.diagnostic(`command → canvas DOM updated (${screen}): ${stats(times)}`);
      return times;
    };
    await timeCommands('anatomy', 'anatomy-members');
    // The lab: its free object runs, and must keep running while its screen is edited.
    const shown = await session.canvasView({ screen: 'lab' });
    await page.waitForFunction((id) => (window as CanvasWindow).__elaboraCanvas.layout().id === id, shown.id);
    await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.ready());
    const framesBefore = frames;
    const frame = page.frames().find((candidate) => candidate.url().includes('/frame.html'))!;
    await frame.evaluate(() => { (window as CanvasWindow).mark = 'running'; });
    const commands = await timeCommands('lab', 'lab-brief');

    // An agent's own writes (through the watcher and its debounce).
    const external: number[] = [];
    const file = path.join(dir, 'screens/lab.json');
    for (let i = 0; i < 5; i++) {
      const screen = JSON.parse(fs.readFileSync(file, 'utf8'));
      const brief = [...(screen.blocks ?? []), ...(screen.layers ?? []).flatMap((layer: { blocks: unknown[] }) => layer.blocks)].find((block: { id: string }) => block.id === 'lab-brief');
      brief.props.markdown = `Written by an agent, **write ${i}**.`;
      await watch('lab-brief', `<strong>write ${i}</strong>`);
      const started = performance.timeOrigin + performance.now();
      fs.writeFileSync(file, JSON.stringify(screen, null, 2));
      external.push((await seen()) - started);
    }
    t.diagnostic(`external write → canvas DOM updated (lab): ${stats(external)}`);

    assert.equal(frames, framesBefore, 'the object frame was not loaded again');
    assert.equal(await frame.evaluate(() => (window as CanvasWindow).mark), 'running');
    const sorted = [...commands].sort((a, b) => a - b);
    assert.ok(sorted[Math.floor(sorted.length / 2)] < 500, stats(commands));

    // View changes through requests: the step, the state, another screen.
    const steps = await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout().steps);
    if (steps.length > 1) {
      const view = await session.canvasView({ step: steps[0] });
      await page.waitForFunction(({ id, step }) => { const layout = (window as CanvasWindow).__elaboraCanvas.layout(); return layout.id === id && layout.step === step; }, { id: view.id, step: steps[0] });
    }
    const other = await session.canvasView({ screen: 'intro', step: null });
    await page.waitForFunction((id) => (window as CanvasWindow).__elaboraCanvas.layout().id === id, other.id);
    assert.equal(await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout().screen), 'intro');
    assert.deepEqual(errors.filter((error) => !/GL Driver|WebGL|PCFSoftShadowMap/.test(error)), []);
  } finally {
    await browser.close();
    await session.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
