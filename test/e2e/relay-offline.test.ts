import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright-core';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { startHosts } from '../relay-hosts.ts';
import { canvasFrame, objectFrames } from '../relay-browsers.ts';
import { APP, CANVAS, FRAMES, MODULES, handlers, relay, setHostsDown } from '../relay-site.ts';

// The canvas without the network (D131): after a first visit, the relay keeps its host's own files (the canvas page, the player's,
// the relay page's), so that the canvas page and an object's frame open when their hosts cannot be reached; a file of its cache that
// is not the bytes the relay names (an object's code can write in the frames host's cache) is never served. The app's page and the
// engine's stand-in stay reachable (the app's own service worker and the engine keep those). ELABORA_RELAY_BROWSERS picks the
// browsers (Chromium and WebKit by default; Playwright's Firefox does not follow frames a worker answers for).
const wanted = (process.env.ELABORA_RELAY_BROWSERS ?? 'chromium,webkit').split(',').map((name) => name.trim()).filter(Boolean);
const KEPT = Object.keys(relay).filter((file) => file !== 'relay.js').map((file) => `/${file}`).sort();

type Log = Array<{ type: string; from?: string }>;
const opened = (page: Page) => page.evaluate(() => (window as unknown as { app: { log: Log } }).app.log.filter((message) => message.type === 'relay/opened').length);
const keptIn = (frame: Frame) => frame.evaluate(async () => { const names = (await caches.keys()).filter((name) => name.startsWith('elabora-relay-')); const cache = names.length === 1 ? await caches.open(names[0]!) : null; return { names, paths: cache ? (await cache.keys()).map((request) => new URL(request.url).pathname).sort() : [] }; });

for (const name of wanted) {
  test(`relay offline (${name}): after a first visit the canvas page and an object's frame open with their hosts unreachable, and a kept file that is not the relay's bytes is never served`, { timeout: 300000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-relay-offline-'));
    let context: BrowserContext | null = null;
    try {
      context = await ({ chromium, webkit } as Record<string, typeof webkit>)[name]!.launchPersistentContext(profile, { headless: true, proxy: { server: `http://127.0.0.1:${hosts.proxyPort}` }, ignoreHTTPSErrors: true, args: name === 'chromium' ? ['--ignore-certificate-errors'] : [], viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
    } catch (error) {
      hosts.close();
      fs.rmSync(profile, { recursive: true, force: true });
      return t.skip(`${name} is not here: ${String(error).split('\n')[0]}`);
    }
    try {
      // 1. A first visit: the module with an object, shown; each host's relay keeps its host's files, under its version's name.
      const page = context.pages()[0] ?? await context.newPage();
      if (process.env.RELAY_DEBUG) { page.on('console', (message) => console.log('[console]', message.type(), message.text().slice(0, 300))); page.on('pageerror', (error) => console.log('[pageerror]', String(error).slice(0, 300))); }
      await page.goto(`${APP}/?module=b&canvas=${encodeURIComponent(CANVAS)}&frames=${encodeURIComponent(FRAMES)}`);
      await page.waitForFunction(() => (window as unknown as { app?: { log: Log } }).app?.log.filter((message) => message.type === 'relay/opened').length === 2, null, { timeout: 30000 });
      const id = await page.evaluate((screen) => (window as unknown as { app: { show(screen: string): Promise<number> } }).app.show(screen), MODULES.b!.screen);
      await page.waitForFunction(() => document.querySelector('iframe#canvas') !== null);
      for (let i = 0; i < 100 && !canvasFrame(page); i++) await page.waitForTimeout(100);
      await canvasFrame(page).waitForFunction((wanted) => (window as unknown as { __elaboraCanvas: { layout(): { id: unknown } } }).__elaboraCanvas.layout().id === wanted, id, { timeout: 30000 });
      for (let i = 0; i < 200 && !objectFrames(page).length; i++) await page.waitForTimeout(100);
      const object = objectFrames(page)[0]!;
      await object.waitForFunction(() => typeof (window as unknown as { __elaboraObject?: unknown }).__elaboraObject === 'object', null, { timeout: 60000 });
      const relayPage = page.frames().find((frame) => frame.url().startsWith(`${FRAMES}/relay.html`))!;
      for (const frame of [canvasFrame(page), relayPage]) {
        await frame.waitForFunction(async (count) => { const names = (await caches.keys()).filter((name) => name.startsWith('elabora-relay-')); return names.length === 1 && (await (await caches.open(names[0]!)).keys()).length === count; }, KEPT.length, { timeout: 30000, polling: 200 });
        const kept = await keptIn(frame);
        assert.deepEqual(kept.paths, KEPT, `${new URL(frame.url()).host} keeps its own files`);
      }

      // 2. The hosts unreachable: the canvas page loaded again opens from what its relay kept, is given its render again, and the
      // object's frame comes back with the player's object code and three.js.
      setHostsDown(true);
      const before = await opened(page);
      await page.evaluate(() => (window as unknown as { app: { reload(): void } }).app.reload());
      await page.waitForFunction((count) => (window as unknown as { app: { log: Log } }).app.log.filter((message) => message.type === 'relay/opened').length > count, before, { timeout: 30000 });
      for (let i = 0; i < 100 && !canvasFrame(page); i++) await page.waitForTimeout(100);
      await canvasFrame(page).waitForFunction((screen) => (window as unknown as { __elaboraCanvas?: { screen: string | null } }).__elaboraCanvas?.screen === screen, MODULES.b!.screen, { timeout: 30000 });
      await page.waitForFunction(() => !!document.querySelector('iframe#canvas'));
      for (let i = 0; i < 200 && !objectFrames(page).some((frame) => !frame.isDetached()); i++) await page.waitForTimeout(100);
      await objectFrames(page).find((frame) => !frame.isDetached())!.waitForFunction(() => typeof (window as unknown as { __elaboraObject?: unknown }).__elaboraObject === 'object' && typeof (window as unknown as { ELABORA_THREE?: unknown }).ELABORA_THREE === 'object', null, { timeout: 60000 });

      // 3. What an object's code writes in the frames host's cache in place of a kept file is not served once the relay wakes
      // again: with the host unreachable that file fails, and the others still come; with the host back, the host's file comes.
      if (name !== 'chromium') return;
      const poisoned = '/canvas/elabora/vendor/three-r186.js';
      await objectFrames(page).find((frame) => !frame.isDetached())!.evaluate(async (file) => {
        const names = (await caches.keys()).filter((each) => each.startsWith('elabora-relay-'));
        await (await caches.open(names[0]!)).put(file, new Response('window.POISONED = true;', { headers: { 'content-type': 'text/javascript' } }));
      }, poisoned);
      // The service workers stopped (as the browser does when they are idle): what they held in memory goes.
      const cdp = await context.newCDPSession(page);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      // Asked as a frame of an object asks them (a script: the frames host's pages may not fetch).
      const asked = () => relayPage.evaluate(async (files) => Promise.all(files.map((file) => new Promise<{ status: number; poisoned: boolean }>((resolve) => {
        (window as unknown as { POISONED?: boolean }).POISONED = false;
        const script = document.createElement('script');
        script.src = `${file}?probe=${Math.random()}`;
        script.onload = () => resolve({ status: 200, poisoned: !!(window as unknown as { POISONED?: boolean }).POISONED });
        script.onerror = () => resolve({ status: 0, poisoned: false });
        document.head.append(script);
      }))), [poisoned, '/canvas/elabora/object-frame.js']);
      const down = await asked();
      assert.equal(down[0]!.poisoned, false, 'the bytes an object wrote are not served');
      assert.notEqual(down[0]!.status, 200, 'with the host unreachable, the poisoned file is not served at all');
      assert.equal(down[1]!.status, 200, 'the others still come from what the relay kept');
      setHostsDown(false);
      const up = await asked();
      assert.deepEqual(up.map((answer) => [answer.status, answer.poisoned]), [[200, false], [200, false]], 'with the host back, its own file');
    } finally {
      setHostsDown(false);
      await context.close();
      hosts.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
