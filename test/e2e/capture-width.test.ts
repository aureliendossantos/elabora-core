import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '@elabora/node/emulator/server';
import { chromiumArgs } from '@elabora/node/emulator/browser';
import { findElectronRuntime, launchElectron } from '@elabora/node/emulator/electron';
import { build } from '@elabora/node/build';
import { capture, fullPageWithObjects } from '@elabora/node/capture';
import { startLooker } from '@elabora/node/look';
import { copyExample, readJSON, writeFixture, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';

// A capture at 375 px shows the page to its right edge, whatever the computer draws its scrollbars
// like: a classic scrollbar (macOS with a mouse plugged in, Windows, Linux) takes 15 px of the window,
// the page is laid out in the rest and a screenshot of it is 360 px wide. A block that goes edge to
// edge (width "bleed") has to reach the last column of pixels.

const WIDTH = 375;
const HEIGHT = 812;
// A band of one colour, an orange (Electron's colour management shifts a colour a little).
const BAND = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 400" width="1600" height="400"><rect width="1600" height="400" fill="#c2410c"/></svg>';
const isBand = (r: number, g: number, b: number) => r > 150 && g > 30 && g < 110 && b < 60;

// The reference course with the band first on its screen: in the first window of a phone.
function bleedCourse(): string {
  const dir = copyExample();
  writeFixture(dir, 'assets/images/band.svg', BAND);
  const chemin = readJSON(dir, 'screens/chemin.json');
  writeJSON(dir, 'screens/chemin.json', { ...chemin, blocks: [{ id: 'chemin-pleine-largeur', type: 'image', width: 'bleed', props: { presentation: 'band', asset: 'images/band.svg', alt: 'Une bande de couleur' } }, ...chemin.blocks] });
  return dir;
}

// The width of a PNG, the rows where its first pixel is the band's, and those of them where a pixel
// of the last 15 columns is not.
function edge(png: Buffer): { width: number; height: number; rows: number; short: number } {
  const { PNG } = createRequire(import.meta.url)('pngjs');
  const image = PNG.sync.read(png);
  const isBandAt = (x: number, y: number) => { const i = (y * image.width + x) * 4; return isBand(image.data[i], image.data[i + 1], image.data[i + 2]); };
  let rows = 0;
  let short = 0;
  for (let y = 0; y < image.height; y++) {
    if (!isBandAt(0, y)) continue;
    rows++;
    for (let x = image.width - 15; x < image.width; x++) if (!isBandAt(x, y)) { short++; break; }
  }
  return { width: image.width, height: image.height, rows, short };
}

function reaches(png: Buffer, label: string): void {
  const found = edge(png);
  assert.equal(found.width, WIDTH, `${label}: as wide as the window (${JSON.stringify(found)})`);
  assert.ok(found.rows >= 100, `${label}: the band is there (${JSON.stringify(found)})`);
  assert.equal(found.short, 0, `${label}: the band reaches the last column (${JSON.stringify(found)})`);
}

test('captures at 375 px: the full-bleed band reaches the last column, by screenshot and by the look server', { timeout: 240000 }, async () => {
  const dir = bleedCourse();
  try {
    const shots = await capture(dir, [{ screen: 'chemin', width: WIDTH, height: HEIGHT }, { screen: 'chemin', width: WIDTH, height: HEIGHT, fullPage: false }]);
    assert.ok(shots.shots?.every((shot) => shot.ok), JSON.stringify(shots.diagnostics ?? shots.shots?.map((shot) => (shot.ok ? null : shot.error))));
    const [page, window] = shots.shots.flatMap((shot) => (shot.ok ? [shot.png] : []));
    reaches(page, 'screenshot, the page');
    reaches(window, 'screenshot, the window');
    assert.equal(edge(window).height, HEIGHT);

    const looker = await startLooker(dir, { live: false });
    try {
      const whole = await looker.look({ screen: 'chemin', width: WIDTH, height: HEIGHT, type: 'png' });
      const viewed = await looker.look({ screen: 'chemin', width: WIDTH, height: HEIGHT, type: 'png', full: false });
      assert.ok(whole.ok && viewed.ok, JSON.stringify([whole, viewed]));
      reaches(whole.image, 'look, the page');
      reaches(viewed.image, 'look, the window');
    } finally {
      await looker.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// With Elabora's Electron (ELABORA_ELECTRON_EXECUTABLE: the installed app's, /Applications/Elabora.app/
// Contents/MacOS/Elabora, or a development worker with ELABORA_ELECTRON_ENTRY), on macOS, where
// -AppleShowScrollBars Always (an argument of this process only, no setting of the computer) draws the
// classic scrollbars a mouse plugged in does: the page is 375 px wide with the switch. Without it, a
// worker that does not hide scrollbars itself leaves 360 px; the app's worker hides them itself (since
// Elabora 0.2), and is 375 px wide either way.
test('with Elabora\'s Electron and classic scrollbars, a capture at 375 px is as wide as the window', { timeout: 240000, skip: (!process.env.ELABORA_ELECTRON_EXECUTABLE && 'no Electron (ELABORA_ELECTRON_EXECUTABLE)') || (process.platform !== 'darwin' && 'macOS draws classic scrollbars from -AppleShowScrollBars') }, async (t) => {
  const dir = bleedCourse();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-width-'));
  const server = await startServer();
  try {
    const built = await build(dir, { emit: 'dir', out, writeLock: false, debug: true });
    assert.ok(built.ok && built.dirPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
    server.addPackage('p', built.dirPath);
    const playwright = createRequire(import.meta.url)('playwright-core');
    const runtime = findElectronRuntime();
    assert.ok(runtime, 'an Electron runtime');
    const shot = async (args: string[]) => {
      const browser = await launchElectron(playwright, runtime, [...args, '-AppleShowScrollBars', 'Always'], false);
      try {
        const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, reducedMotion: 'reduce' });
        await page.goto(`${server.base}/pkg/p/index.html`);
        await page.waitForFunction(() => (window as PlayerWindow).__elabora);
        await page.evaluate(() => { (window as PlayerWindow).__elabora.go('chemin'); });
        await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
        const style = await page.addStyleTag({ content: '.t-bar { position: static !important; }' });
        const whole = await fullPageWithObjects(page, false);
        await style.evaluate((node) => { node.parentNode?.removeChild(node); });
        return { whole, window: await page.screenshot({ fullPage: false }) };
      } finally { await browser.close(); }
    };
    const without = await shot(chromiumArgs().filter((arg) => arg !== '--hide-scrollbars'));
    if (edge(without.whole).width === WIDTH) t.diagnostic('this worker hides scrollbars itself: no page without the switch to compare');
    else {
      assert.equal(edge(without.whole).width, WIDTH - 15, `without the switch, the scrollbar takes 15 px (${JSON.stringify(edge(without.whole))})`);
      assert.ok(edge(without.window).short > 0, `and shows its own strip in the window (${JSON.stringify(edge(without.window))})`);
    }
    const hidden = await shot(chromiumArgs());
    reaches(hidden.whole, 'with the switch, the page');
    reaches(hidden.window, 'with the switch, the window');
  } finally {
    await server.close();
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
