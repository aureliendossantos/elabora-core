import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { build } from '@elabora/node/build';
import type { WebBuildOptions } from '@elabora/node/build';
import { launchBrowser } from '@elabora/node/emulator/browser';
import type { Browser, Page } from 'playwright-core';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { labelsFor } from '@elabora/player/labels';

// A module built for the web (docs/decisions.md D41), served by a plain static server as a web host
// would serve it, in the browser the app supplies (D26): no LMS, no banner, no Quit; progress local
// survives a reload, progress none keeps nothing, free navigation reaches the last screen at once.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.vtt': 'text/vtt'
};

// Serves each module's folder under /<name>/, files only, as a static host does.
async function staticServer(sites: Record<string, string>): Promise<{ base: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const [, name, ...rest] = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname).split('/');
    const root = sites[name];
    const file = root && path.join(root, rest.join('/') || 'index.html');
    if (!root || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const player = (page: Page) => page.waitForFunction(() => (window as PlayerWindow).__elabora?.screen !== undefined);
const screenOf = (page: Page) => page.evaluate(() => (window as PlayerWindow).__elabora.screen);

test('a module for the web on a static server: local progress survives a reload, none keeps nothing, free navigation reaches the last screen', { timeout: 240000 }, async () => {
  const dir = copyExample();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-web-e2e-'));
  const made: Record<string, string> = {};
  const settings: Record<string, WebBuildOptions> = { local: { progress: 'local' }, none: { progress: 'none' }, free: { progress: 'none', navigation: 'free' } };
  for (const [name, web] of Object.entries(settings)) {
    const built = await build(dir, { target: 'web', web, out: path.join(out, name), writeLock: false });
    assert.ok(built.ok && built.dirPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
    made[name] = built.dirPath;
  }
  const server = await staticServer(made);
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser('chromium');

    // ── local: the learner comes back where they left ───────────────
    const local = await browser.newContext();
    const page = await local.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.base}/local/index.html`);
    await player(page);
    const shown = await page.evaluate(() => {
      const t = (window as PlayerWindow & { __elabora: { lms: { kind: string } } }).__elabora;
      const quit = document.querySelector<HTMLElement>('.t-quit');
      return { kind: t.lms.kind, banner: document.querySelector('.t-banner') !== null, quitHidden: quit === null || quit.hidden };
    });
    assert.deepEqual(shown, { kind: 'web', banner: false, quitHidden: true });
    const left = await page.evaluate(() => {
      const t = (window as PlayerWindow).__elabora;
      const screen = t.engine.screens[1];
      t.go(screen.id);
      return { id: screen.id, key: screen.key, storage: `elabora:web:${t.course.id}` };
    });
    assert.equal(await screenOf(page), left.id);
    await page.waitForFunction(({ storage, key }) => JSON.parse(localStorage.getItem(storage) || '{}')['cmi.core.lesson_location'] === key, left);
    assert.equal(await page.evaluate(() => sessionStorage.length), 0, 'the preview\'s session storage is not used');
    await page.reload();
    await player(page);
    assert.equal(await screenOf(page), left.id, 'resumed on the screen left');
    assert.equal(await page.evaluate(() => (window as PlayerWindow).__elabora.state().status), 'incomplete');
    // The outline says, at its end, that the progress stays in this browser.
    await page.click('.t-outline-btn');
    assert.equal(await page.locator('.t-menu .t-progress-note p').textContent(), labelsFor('fr').progressKept);
    assert.equal(await page.locator('.t-menu .t-progress-note .t-link-btn').textContent(), labelsFor('fr').clearProgress);
    await page.keyboard.press('Escape');
    // A visit later, in a new tab of the same browser.
    const later = await local.newPage();
    await later.goto(`${server.base}/local/index.html`);
    await player(later);
    assert.equal(await screenOf(later), left.id);
    // Quitting (an event's exit action; the button is hidden) says where the progress is kept.
    await page.close();
    await later.evaluate(() => (window as PlayerWindow & { __elabora: { quit(): void } }).__elabora.quit());
    assert.equal(await later.locator('.t-ended > p').textContent(), labelsFor('fr').webEndedKept);
    // « Effacer ma progression », confirmed: the module starts again from its first screen.
    await later.locator('.t-ended .t-link-btn').click();
    assert.equal(await later.locator('#t-clear-question').textContent(), labelsFor('fr').clearProgressConfirm);
    await Promise.all([later.waitForEvent('load'), later.locator('.t-clear-progress').click()]);
    await player(later);
    const start = await later.evaluate(() => { const first = (window as PlayerWindow).__elabora.engine.screens[0]; return { id: first.id, key: first.key }; });
    assert.equal(await screenOf(later), start.id, 'started again');
    assert.equal(await later.evaluate((storage) => JSON.parse(localStorage.getItem(storage) || '{}')['cmi.core.lesson_location'] ?? null, left.storage), start.key);
    assert.deepEqual(errors, []);
    await local.close();

    // ── none: nothing kept anywhere ─────────────────────────────────
    const none = await browser.newContext();
    const visit = await none.newPage();
    await visit.goto(`${server.base}/none/index.html`);
    await player(visit);
    const first = await screenOf(visit);
    const second = await visit.evaluate(() => { const t = (window as PlayerWindow).__elabora; t.go(1); return t.screen; });
    assert.notEqual(second, first);
    // A commit happened (go syncs at once): nothing reached the browser's storage, nor a cookie.
    assert.deepEqual(await visit.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie })), { local: 0, session: 0, cookie: '' });
    await visit.reload();
    await player(visit);
    assert.equal(await screenOf(visit), first, 'a reload starts again');
    // As designed: the last screen is locked in the outline until the learner gets there.
    await visit.click('.t-outline-btn');
    assert.equal(await visit.locator('.t-menu-item').last().getAttribute('aria-disabled'), 'true');
    assert.equal(await visit.locator('.t-progress-note').count(), 0, 'nothing kept, nothing to clear');
    // Quitting does not claim that progress is saved: nothing was, nor is now.
    await visit.keyboard.press('Escape');
    await visit.evaluate(() => (window as PlayerWindow & { __elabora: { quit(): void } }).__elabora.quit());
    assert.equal(await visit.locator('.t-ended > p').textContent(), labelsFor('fr').webEndedNotKept);
    assert.equal(await visit.locator('.t-progress-note').count(), 0);
    assert.deepEqual(await visit.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie })), { local: 0, session: 0, cookie: '' });
    await none.close();

    // ── free: every screen open, nothing done first ─────────────────
    const free = await browser.newContext();
    const tour = await free.newPage();
    await tour.goto(`${server.base}/free/index.html`);
    await player(tour);
    const last = await tour.evaluate(() => { const screens = (window as PlayerWindow).__elabora.engine.screens; return screens[screens.length - 1].id; });
    assert.equal(await tour.locator('.t-nav-btn--next').getAttribute('aria-disabled'), 'false', 'Next is not locked');
    await tour.click('.t-outline-btn');
    await tour.locator('.t-menu-item').last().click();
    await tour.waitForFunction((id) => (window as PlayerWindow).__elabora.screen === id, last);
    assert.equal(await screenOf(tour), last);
    await free.close();
  } finally {
    await browser?.close();
    await server.close();
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A PNG of the given size, one colour (for the pictures the build sizes and the page holds).
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x88)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('the pictures of a module for the web: sized by the build, a scroll page\'s far ones loaded as the learner comes near, the next slide\'s loaded ahead', { timeout: 240000 }, async () => {
  const dir = copyExample();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-web-pictures-'));
  fs.writeFileSync(path.join(dir, 'assets/images/far.png'), png(1200, 800));
  fs.writeFileSync(path.join(dir, 'assets/images/next.png'), png(600, 300));
  // The first screen grows long, the far picture at its end; the second screen has the next one.
  const accueil = readJSON(dir, 'screens/accueil.json');
  const words = 'Le chemin d\'une impression passe par le poste, le commutateur, le routeur et le serveur. '.repeat(12);
  for (let i = 0; i < 6; i++) accueil.blocks.push({ id: `accueil-long-${i}`, type: 'callout', props: { variant: 'info', markdown: words } });
  accueil.blocks.push({ id: 'accueil-far', type: 'image', props: { asset: 'images/far.png', alt: 'Une image loin dans la page.' } });
  writeJSON(dir, 'screens/accueil.json', accueil);
  const chemin = readJSON(dir, 'screens/chemin.json');
  chemin.blocks.push({ id: 'chemin-next', type: 'image', props: { asset: 'images/next.png', alt: 'Une image de l\'écran suivant.' } });
  writeJSON(dir, 'screens/chemin.json', chemin);
  const made: Record<string, string> = {};
  for (const mode of ['scroll', 'slides']) {
    const course = readJSON(dir, 'course.json');
    writeJSON(dir, 'course.json', { ...course, presentation: { ...course.presentation, mode } });
    const built = await build(dir, { target: 'web', web: { progress: 'none', navigation: 'free' }, out: path.join(out, mode), writeLock: false });
    assert.ok(built.ok && built.dirPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
    made[mode] = built.dirPath;
  }
  const data = fs.readFileSync(path.join(made.scroll, 'elabora/course.js'), 'utf8');
  assert.match(data, /<img width=\\"1200\\" height=\\"800\\" data-t-sized[^>]*far\.png/, 'the build writes the size of the PNG');
  const server = await staticServer(made);
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser('chromium');
    const fetched = (page: Page) => { const urls: string[] = []; page.on('request', (request) => urls.push(request.url())); return urls; };
    // The far picture's size, its place in the page, and its place under the block before it: what is
    // higher up may still settle (the network's 3D object takes its height once ready, later on a slow
    // runner: 361 px on GitHub's macOS, 6 Nov 2026), which the picture's own arrival must not do.
    const box = (page: Page) => page.evaluate(() => {
      const image = document.querySelector<HTMLImageElement>('img[src$="far.png"], img[data-t-src$="far.png"]')!;
      const { width, height, top } = image.getBoundingClientRect();
      const above = document.querySelector('[data-block="accueil-long-5"]')!.getBoundingClientRect().bottom;
      return { width: Math.round(width), height: Math.round(height), top: Math.round(top + window.scrollY), under: Math.round(top - above) };
    });
    const still = ({ top, ...rest }: { top: number; width: number; height: number; under: number }) => rest;

    // ── scroll: the far picture waits, in its room, until the learner comes near ──
    const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
    const urls = fetched(page);
    await page.goto(`${server.base}/scroll/index.html`);
    await player(page);
    await page.waitForLoadState('networkidle');
    assert.equal(urls.filter((url) => url.endsWith('far.png')).length, 0, 'the far picture is not loaded with the page');
    const held = await box(page);
    assert.ok(held.top > 1500, `the picture is far down the page (${held.top} px)`);
    assert.ok(held.width > 0 && Math.abs(held.height - held.width * 800 / 1200) <= 1, `its room is kept: ${held.width}×${held.height}`);
    await page.evaluate((top) => window.scrollTo(0, top - 1000), held.top);
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[src$="far.png"]')?.complete === true);
    assert.equal(urls.filter((url) => url.endsWith('far.png')).length, 1, 'loaded once the learner is near');
    assert.deepEqual(still(await box(page)), still(held), 'nothing moves when it arrives');
    await page.close();

    // ── slides: the next screen's picture is there before the learner goes on ──
    const slides = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const asked = fetched(slides);
    await slides.goto(`${server.base}/slides/index.html`);
    await player(slides);
    await slides.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('next.png') && (entry as PerformanceResourceTiming).responseEnd > 0), undefined, { timeout: 15000 });
    assert.equal(await screenOf(slides), 'accueil', 'still on the first screen');
    const shown = await slides.evaluate(() => {
      const t = (window as PlayerWindow).__elabora;
      t.go(t.engine.screens[1].id);
      const image = document.querySelector<HTMLImageElement>('img[src$="next.png"]');
      return { found: !!image, complete: !!image?.complete && image.naturalWidth > 0 };
    });
    assert.deepEqual(shown, { found: true, complete: true }, 'the next screen shows its picture at once');
    assert.equal(asked.filter((url) => url.endsWith('next.png')).length, 1, 'asked for once');
    await slides.close();
  } finally {
    await browser?.close();
    await server.close();
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
