import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { build } from '@elabora/node/build';
import type { WebBuildOptions } from '@elabora/node/build';
import { launchBrowser } from '@elabora/node/emulator/browser';
import type { Browser, Page } from 'playwright-core';
import { copyExample } from '../helpers.ts';
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

    // local: the learner comes back where they left
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

    // none: nothing kept anywhere
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

    // free: every screen open, nothing done first
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
