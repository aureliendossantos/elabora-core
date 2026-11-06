import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { startCanvasHost } from '@elabora/node/canvas/host';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { CanvasApi } from '@elabora/player/canvas';
import type { LayoutMessage } from '@elabora/player/canvas-protocol';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';

type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi };

// Blocks placed by hand (D72): out of the flow, where their place puts them in the frame (the
// reference window at the width of the screen's area), their anchor kept in the page (the reading
// order); below presentation.fit.minimum, on phones and with larger text, in the flow at their anchor.
// In scroll presentation a placed block moves with the text before it. The editor's canvas lifts a
// block it drags and reports the frame and the places of the flow.

const FIXTURE = path.join(ROOT, 'test/fixtures/placement');
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

interface Box { x: number; y: number; width: number; height: number; placed: boolean }

async function player(run: (page: Page, size: (width: number, height: number) => Promise<void>) => Promise<void>, prepare?: (dir: string) => void) {
  const dir = copyExample(FIXTURE);
  prepare?.(dir);
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-placement-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.base}/pkg/p/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    await run(page, async (width, height) => {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

const boxes = (page: Page): Promise<Record<string, Box>> => page.evaluate(() => {
  const out: Record<string, Box> = {};
  for (const node of document.querySelectorAll<HTMLElement>('#t-main .t-block[data-block]')) {
    const box = node.getBoundingClientRect();
    out[node.dataset.block ?? ''] = { x: Math.round(box.x), y: Math.round(box.y + scrollY), width: Math.round(box.width), height: Math.round(box.height), placed: node.hasAttribute('data-t-place') };
  }
  return out;
});
// The frame: #t-main's padding box, at most the reference width, its height at the reference ratio,
// centred in a slide.
const frame = (page: Page) => page.evaluate(() => {
  const main = document.getElementById('t-main')!;
  const box = main.getBoundingClientRect();
  const width = Math.min(main.clientWidth, 1600);
  const height = (width * 900) / 1600;
  return { x: box.x + (main.clientWidth - width) / 2, y: box.y + scrollY + (main.clientHeight - height) / 2, width, height, top: box.y + scrollY, bottom: box.y + scrollY + main.clientHeight };
});
const near = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) <= 1.5, `${message}: ${actual} instead of ${expected}`);

test('slides: placed blocks sit in the frame at the reference and the minimum, in the flow below it, on phones and with larger text', async () => {
  await player(async (page, size) => {
    for (const [width, height] of [[1600, 900], [1280, 720]]) {
      await size(width, height);
      const shown = await boxes(page);
      const at = await frame(page);
      assert.ok(shown['sketch-keep'].placed && shown['sketch-figure'].placed && !shown['sketch-intro'].placed, `${width}: ${JSON.stringify(shown)}`);
      near(shown['sketch-keep'].x, Math.round(at.x + 0.62 * at.width), `${width}: x of the callout`);
      near(shown['sketch-keep'].width, Math.round(0.3 * at.width), `${width}: its width`);
      // Kept inside the slide: its bars take room from the frame.
      near(shown['sketch-keep'].y, Math.round(Math.min(at.y + 0.6 * at.height, at.bottom - shown['sketch-keep'].height)), `${width}: y of the callout`);
      near(shown['sketch-figure'].height, Math.round(0.3 * at.height), `${width}: the figure's height`);
      near(shown['sketch-figure'].x, Math.round(at.x + 0.06 * at.width), `${width}: x of the figure`);
      // The flow closes around them: the second text follows the first.
      assert.ok(shown['sketch-more'].y - (shown['sketch-intro'].y + shown['sketch-intro'].height) < 40, JSON.stringify(shown));
    }
    // The reading order stays the page's: the callout is read after the first text.
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#t-main .t-block[data-block]')].map((node) => node.dataset.block)), ['sketch-intro', 'sketch-keep', 'sketch-figure', 'sketch-more']);
    // The figure, higher in the stack, is drawn over the callout.
    const z = await page.evaluate(() => ['sketch-keep', 'sketch-figure'].map((id) => Number(getComputedStyle(document.querySelector(`[data-block="${id}"]`)!).zIndex)));
    assert.ok(z[1] > z[0], JSON.stringify(z));
    for (const [width, height] of [[1200, 800], [390, 844]]) {
      await size(width, height);
      const shown = await boxes(page);
      assert.ok(!shown['sketch-keep'].placed && !shown['sketch-figure'].placed, `${width}: ${JSON.stringify(shown)}`);
      assert.ok(shown['sketch-keep'].y > shown['sketch-intro'].y && shown['sketch-figure'].y > shown['sketch-keep'].y && shown['sketch-more'].y > shown['sketch-figure'].y, `${width}: in the flow, ${JSON.stringify(shown)}`);
    }
    await size(1600, 900);
    await page.evaluate(() => { document.getElementById('elabora-app')!.dataset.textSize = 'large'; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    assert.equal((await boxes(page))['sketch-keep'].placed, false, 'larger text: in the flow');
  });
});

test('scroll: a placed block moves with the text before it, at the reference and the minimum', async () => {
  await player(async (page, size) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('page'));
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    for (const [width, height] of [[1600, 900], [1280, 720]]) {
      await size(width, height);
      const shown = await boxes(page);
      const at = await frame(page);
      assert.ok(shown['page-note'].placed, `${width}: ${JSON.stringify(shown)}`);
      // y 0: where it would start in the flow, the top of the block after it.
      near(shown['page-note'].y, shown['page-three'].y, `${width}: the note at its anchor`);
      near(shown['page-note'].x, Math.round(at.x + 0.76 * at.width), `${width}: its x`);
    }
    // The text before it grows: the note moves with the text after it.
    const before = await boxes(page);
    await page.evaluate(() => { const text = document.querySelector('[data-block="page-one"] .t-text, [data-block="page-one"]')!; text.append(Object.assign(document.createElement('p'), { textContent: 'One more line. '.repeat(30) })); });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await boxes(page);
    assert.ok(after['page-three'].y > before['page-three'].y + 20, JSON.stringify({ before, after }));
    near(after['page-note'].y, after['page-three'].y, 'the note followed');
  }, (dir) => {
    const course = readJSON(dir, 'course.json');
    course.presentation = { mode: 'scroll' };
    writeJSON(dir, 'course.json', course);
  });
});

test('the editor canvas: placed at any width but a phone\'s, the frame and the flow reported, a block lifted and let go on the next render', async () => {
  const dir = copyExample(FIXTURE);
  const project = loadProjectFromDir(dir);
  const context = createRenderContext(project, { fields: true });
  const host = await startCanvasHost({ root: dir });
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${host.url}&placing=editor`);
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
    const render = renderScreen(project, 'sketch', {}, context);
    host.push(render, { id: 1 });
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas.screen === 'sketch');
    await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.ready());
    const layout = async () => page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout()) as Promise<LayoutMessage>;
    let shown = await layout();
    assert.ok(shown.placing, 'the frame is reported');
    near(shown.placing!.frame.width, 1600, 'the frame at the reference');
    const keep = shown.blocks.find((block) => block.id === 'sketch-keep')!;
    assert.equal(keep.placed, true);
    assert.ok(keep.anchor && Math.abs(keep.anchor.y - shown.blocks.find((block) => block.id === 'sketch-more')!.rect.y) < 2, JSON.stringify(keep));
    const column = shown.placing!.flows.find((flow) => flow.slot === null)!;
    assert.deepEqual(column.places.map((place) => place.after), [null, 'sketch-intro', 'sketch-more'], 'the places of the flow, without the placed blocks');
    assert.ok(shown.placing!.columns && shown.placing!.columns.half < shown.placing!.columns.full && shown.placing!.columns.full <= shown.placing!.columns.wide, JSON.stringify(shown.placing!.columns));
    // At 1100 px the editor still places them; at a phone's width, the flow.
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await layout()).blocks.find((block) => block.id === 'sketch-keep')!.placed, true, '1100 px in the editor');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await layout()).blocks.find((block) => block.id === 'sketch-keep')!.placed, undefined, 'a phone: in the flow');
    await page.setViewportSize({ width: 1600, height: 900 });
    // A text of the flow lifted: out of the flow at the box asked, its room kept (nothing around it moves
    // until it is let go), its home reported, the flow's place over it and under it both « where it was ».
    const before = shown.blocks.find((block) => block.id === 'sketch-more')!.rect;
    const was = shown.blocks.find((block) => block.id === 'sketch-intro')!.rect;
    await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.receive({ type: 'elabora/lift', block: 'sketch-intro', at: { x: 700, y: 300, width: 500, height: 0 } }));
    shown = await layout();
    const lifted = shown.blocks.find((block) => block.id === 'sketch-intro')!;
    assert.equal(lifted.lifted, true);
    near(lifted.rect.x, 700, 'lifted at x');
    near(lifted.rect.y, 300, 'lifted at y');
    near(lifted.rect.width, 500, 'its width');
    assert.deepEqual(shown.placing!.flows.find((flow) => flow.slot === null)!.places.map((place) => place.after), [null, null, 'sketch-more']);
    near(shown.blocks.find((block) => block.id === 'sketch-more')!.rect.y, before.y, 'the next block stays');
    near(lifted.home!.y, was.y, 'its home where it was');
    near(lifted.home!.height, was.height, 'its room kept');
    // Let go until the render of the change: it stays where it is, then takes its new place.
    await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.receive({ type: 'elabora/lift', block: 'sketch-intro', at: null, release: 'render' }));
    assert.equal((await layout()).blocks.find((block) => block.id === 'sketch-intro')!.lifted, true, 'held until the render');
    const screen = readJSON(dir, 'screens/sketch.json');
    screen.blocks[0].place = { x: 0.4375, y: 0.3333, width: 0.3125 };
    writeJSON(dir, 'screens/sketch.json', screen);
    const placed = loadProjectFromDir(dir);
    host.push(renderScreen(placed, 'sketch', {}, createRenderContext(placed, { fields: true })), { id: 2 });
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas.layout().id === 2);
    const landed = (await layout()).blocks.find((block) => block.id === 'sketch-intro')!;
    assert.equal(landed.lifted, undefined);
    assert.equal(landed.placed, true);
    near(landed.rect.x, 700, 'placed where it was let go');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await host.close();
  }
});
