import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, webkit } from 'playwright-core';
import type { Browser, BrowserContext, Frame, Page } from 'playwright-core';
import { launchChromium } from '@elabora/node/emulator/browser';
import { startHosts } from '../relay-hosts.ts';
import type { Hosts } from '../relay-hosts.ts';
import { APP, CANVAS, FRAMES, MODULES, POLICY, REVIEW, SPACE, handlers, reached, relay, scratch, setRelayScript } from '../relay-site.ts';

// The relay of the web app (D118, D119) in real browsers, on the app's real names (an app, a canvas and a
// frames host, two sites): the canvas shown from files that no host has, which a stand-in for the engine gives
// through the relay's ports (relay-site.ts). ELABORA_RELAY_BROWSERS=chromium,webkit picks the browsers
// (Chromium alone by default; WebKit is Playwright's, found where PLAYWRIGHT_BROWSERS_PATH says). Playwright's
// Firefox does not follow frames of other origins that a worker answers for, so Firefox is tried by the
// WebDriver BiDi script of the web canvas report, not here.
const wanted = (process.env.ELABORA_RELAY_BROWSERS ?? 'chromium').split(',').map((name) => name.trim()).filter(Boolean);

// ── Browsers ────────────────────────────────────────────────────────────────────────────────────
async function launch(name: string, hosts: Hosts): Promise<Browser | null> {
  const proxy = { server: `http://127.0.0.1:${hosts.proxyPort}` };
  try {
    if (name === 'chromium') {
      // Playwright turns off Chrome's partitioning of a frame's storage by its top site; its own list again, without it.
      const features = '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints';
      return await launchChromium(chromium, ['playwright'], { headless: true, proxy, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', `--ignore-certificate-errors-spki-list=${hosts.spki}`, features] });
    }
    if (name === 'webkit') return await webkit.launch({ headless: true, proxy });
  } catch (error) {
    console.log(`# ${name} did not start here: ${String(error).split('\n')[0]}`);
  }
  return null;
}

let counter = 0;
const newRoute = () => `route${String(++counter).padStart(4, '0')}${'A'.repeat(18)}`;
const canvasFrame = (page: Page): Frame => page.frames().find((frame) => frame.url().startsWith(`${CANVAS}/canvas/index.html`))!;
const objectFrames = (page: Page): Frame[] => page.frames().filter((frame) => frame.url().startsWith(`${FRAMES}/canvas/objects/`));

// The app's page on a module, the relay pages open, a screen shown and ready.
async function openApp(context: BrowserContext, module: 'a' | 'b', { show = true, parts = false } = {}): Promise<{ page: Page; route: string }> {
  const route = newRoute();
  const page = await context.newPage();
  page.on('console', (message) => { if (process.env.RELAY_DEBUG) console.log('[console]', message.type(), message.text().slice(0, 200)); });
  page.on('pageerror', (error) => { if (process.env.RELAY_DEBUG) console.log('[pageerror]', String(error).slice(0, 200)); });
  await page.goto(`${APP}/?module=${module}&route=${route}&canvas=${encodeURIComponent(CANVAS)}&frames=${encodeURIComponent(FRAMES)}${parts ? '&parts=1' : ''}`);
  await page.waitForFunction(() => (window as unknown as { app?: { log: Array<{ type: string }> } }).app?.log.filter((message) => message.type === 'relay/opened').length === 2, null, { timeout: 30000 }).catch(async (error) => { throw new Error(`${String(error).split('\n')[0]} ${JSON.stringify(await page.evaluate(() => (window as unknown as { app?: { log: unknown[] } }).app?.log))}`); });
  if (show) {
    const id = await page.evaluate((screen) => (window as unknown as { app: { show(screen: string): Promise<number> } }).app.show(screen), MODULES[module]!.screen);
    for (let i = 0; i < 100 && !canvasFrame(page); i++) await page.waitForTimeout(100);
    if (!canvasFrame(page)) throw new Error(`no canvas frame among ${JSON.stringify(page.frames().map((frame) => frame.url()))}`);
    await canvasFrame(page).waitForFunction((wanted) => (window as unknown as { __elaboraCanvas: { layout(): { id: unknown } } }).__elaboraCanvas.layout().id === wanted, id, { timeout: 30000 });
  }
  return { page, route };
}

for (const name of wanted) {
  test(`relay (${name}): the canvas shown from files no host has, a medium by ranges, an object's frame and code, each tab by its own module, a frame without the app above it refused, a version replaced`, { timeout: 600000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const browser = await launch(name, hosts);
    if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
    try {
      // 1. The canvas: its page and the player's files are the host's; the module's files, the relay's.
      const { page, route } = await openApp(context, 'a');
      const canvas = canvasFrame(page);
      assert.deepEqual(reached.filter((file) => file.startsWith('canvas/canvas/') && !file.includes('favicon')), [], 'no file of the module reached a host');

      // What the relay puts on its answers.
      const answered = await canvas.evaluate(async () => {
        const response = await fetch('/canvas/course.json');
        const headers = Object.fromEntries(['content-security-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'referrer-policy', 'x-content-type-options', 'cache-control', 'content-type'].map((key) => [key, response.headers.get(key)]));
        return { status: response.status, headers, text: (await response.text()).slice(0, 20) };
      });
      assert.equal(answered.status, 200);
      assert.equal(answered.headers['content-security-policy'], POLICY.canvas);
      assert.match(answered.headers['content-security-policy']!, /frame-ancestors https:\/\/app\.elabora\.studio$/);
      assert.equal(answered.headers['cross-origin-embedder-policy'], 'require-corp');
      assert.equal(answered.headers['cross-origin-resource-policy'], 'cross-origin');
      assert.equal(answered.headers['referrer-policy'], 'no-referrer');
      assert.equal(answered.headers['x-content-type-options'], 'nosniff');
      assert.match(answered.text, /^\{/);

      // 2. Ranges: one range is 206 whatever the browser, none is never 206 or 416, several are the whole file.
      const ranges = await canvas.evaluate(async () => {
        const get = async (range?: string) => { const response = await fetch('/canvas/assets/video/essai.webm', range ? { headers: { range } } : {}); const body = await response.arrayBuffer(); return { status: response.status, length: body.byteLength, contentRange: response.headers.get('content-range'), accept: response.headers.get('accept-ranges') }; };
        return { whole: await get(), first: await get('bytes=0-99'), open: await get('bytes=1000-'), last: await get('bytes=-50'), several: await get('bytes=0-1,5-9'), past: await get('bytes=99999999-'), malformed: await get('bytes=abc') };
      });
      const size = ranges.whole.length;
      assert.ok(size > 10000);
      assert.deepEqual(ranges.whole, { status: 200, length: size, contentRange: null, accept: 'bytes' });
      assert.deepEqual(ranges.first, { status: 206, length: 100, contentRange: `bytes 0-99/${size}`, accept: 'bytes' });
      assert.deepEqual({ status: ranges.open.status, contentRange: ranges.open.contentRange }, { status: 206, contentRange: `bytes 1000-${size - 1}/${size}` });
      assert.deepEqual({ status: ranges.last.status, length: ranges.last.length, contentRange: ranges.last.contentRange }, { status: 206, length: 50, contentRange: `bytes ${size - 50}-${size - 1}/${size}` });
      assert.equal(ranges.several.status, 200);
      assert.equal(ranges.malformed.status, 200);
      assert.equal(ranges.past.status, 416);
      assert.equal(ranges.past.contentRange, `bytes */${size}`);
      // A medium in a <video>: the browser asks as it likes, and plays.
      const played = await canvas.evaluate(async () => {
        const video = document.createElement('video');
        video.muted = true; video.preload = 'auto'; video.src = '/canvas/assets/video/essai.webm';
        document.body.append(video);
        await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error('video error')); setTimeout(() => reject(new Error('no metadata')), 15000); });
        video.currentTime = 12;
        await new Promise<void>((resolve) => { video.onseeked = () => resolve(); setTimeout(resolve, 8000); });
        return { duration: video.duration, time: video.currentTime };
      });
      assert.ok(played.duration > 19 && played.time >= 11, JSON.stringify(played));

      // 3. A free object: its frame page by the relay, with the route in its address, its code bundled by the engine.
      await page.waitForFunction(() => document.querySelectorAll('iframe').length >= 2);
      const frames = await (async () => { for (let i = 0; i < 300; i++) { const found = objectFrames(page); if (found.length) return found; await page.waitForTimeout(100); } return []; })();
      assert.ok(frames.length >= 1, 'the object frame');
      const frame = frames[0]!;
      assert.match(frame.url(), new RegExp(`^${FRAMES}/canvas/objects/diagnostic-reseau/frame\\.html\\?route=${route}$`));
      await frame.waitForFunction(() => typeof (window as unknown as { __elaboraObject?: unknown }).__elaboraObject === 'object' && typeof (window as unknown as { ELABORA_THREE?: unknown }).ELABORA_THREE === 'object', null, { timeout: 30000 });
      const facts = await frame.evaluate(() => ({ title: document.title, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') }));
      assert.match(facts.csp!, /connect-src 'none'/);
      const kinds = await page.evaluate(() => (window as unknown as { app: { requests: Array<{ kind: string }> } }).app.requests.map((request) => request.kind));
      assert.ok(kinds.includes('object-frame') && kinds.includes('object-code'));

      // 4. Two tabs, two modules: each frame is served by the port of its own tab.
      const second = await openApp(context, 'b');
      const clockwork = await (async () => { for (let i = 0; i < 300; i++) { const found = objectFrames(second.page); if (found.length) return found[0]!; await second.page.waitForTimeout(100); } throw new Error('no frame in the second tab'); })();
      assert.match(clockwork.url(), /\/objects\/clockwork\/frame\.html\?route=/);
      await clockwork.waitForFunction(() => typeof (window as unknown as { __elaboraObject?: unknown }).__elaboraObject === 'object', null, { timeout: 30000 });
      assert.notEqual(await clockwork.evaluate(() => document.title), facts.title);
      const askedBy = async (tab: Page) => (await tab.evaluate(() => (window as unknown as { app: { requests: Array<{ kind: string; object?: string }> } }).app.requests.filter((request) => request.kind === 'object-code').map((request) => request.object)));
      assert.deepEqual(await askedBy(page), ['diagnostic-reseau']);
      assert.deepEqual(await askedBy(second.page), ['clockwork']);
      // The canvas page asks by the route in its own address, whatever a request says of itself.
      const strangers = await canvas.evaluate(async () => (await Promise.all(['/canvas/course.json?route=nobody', '/canvas/objects/clockwork/object.js'].map(async (url) => (await fetch(url)).status))));
      assert.deepEqual(strangers, [200, 403], 'the canvas page of a tab asks by its own route, and its port asks files only (an object\'s code is the frames host\'s)');
      assert.equal(await (async () => { const withoutRoute = await second.page.context().newPage(); const response = await withoutRoute.goto(`${FRAMES}/canvas/objects/clockwork/frame.html`); const status = response?.status(); await withoutRoute.close(); return status; })(), 404, 'a navigation at the top, with no route');

      // 5. A frame that has not the app above it is refused, the route known or not: the review page of the app's site
      // frames a space, which frames the canvas's answer (the security review's M1). The app's own frame is the control.
      const target = `${CANVAS}/canvas/course.json?route=${route}`;
      const read = async (host: Page, where: string): Promise<string | null> => {
        const probe = host.frames().find((frame) => frame.url().startsWith(target));
        if (!probe) return null;
        return probe.evaluate(() => document.body?.innerText ?? '').catch(() => null);
      };
      await page.evaluate((url) => { const control = document.createElement('iframe'); control.id = 'control'; control.src = url; document.body.append(control); }, target);
      await page.waitForTimeout(1500);
      assert.match(String(await read(page, 'app')), /^\s*\{/, 'under the app the answer shows');
      const review = await context.newPage();
      await review.goto(`${REVIEW}/`);
      await review.waitForFunction(() => document.getElementById('space'));
      const space = review.frames().find((frame) => frame.url().startsWith(SPACE))!;
      await space.waitForLoadState('load');
      await review.evaluate((url) => (document.getElementById('space') as HTMLIFrameElement).contentWindow!.postMessage({ frame: url }, '*'), target);
      await review.waitForTimeout(2500);
      const shown = await read(review, 'review');
      assert.ok(shown === null || !/^\s*\{/.test(shown), `under the review page and a space the answer must not show: ${shown?.slice(0, 40)}`);
      await review.close();

      // 6. A version of the relay replaced without reloading the app.
      await page.evaluate(() => { (window as unknown as { marker?: string }).marker = 'kept'; });
      const before = await page.evaluate(() => (window as unknown as { app: { versions(): { canvas?: string; frames?: string } } }).app.versions());
      assert.ok(before.canvas && before.frames);
      const next = relay['relay.js']!.replaceAll(before.canvas!, `${before.canvas}-next`);
      assert.notEqual(next, relay['relay.js']);
      setRelayScript(next);
      await page.evaluate(() => (window as unknown as { app: { update(): void } }).app.update());
      await page.waitForFunction((was) => { const now = (window as unknown as { app: { versions(): { canvas?: string; frames?: string } } }).app.versions(); return now.canvas === `${was}-next` && now.frames === `${was}-next`; }, before.canvas, { timeout: 30000 });
      assert.equal(await page.evaluate(() => (window as unknown as { marker?: string }).marker), 'kept');
      const after = await canvasFrame(page).evaluate(async () => { const response = await fetch('/canvas/course.json'); return { status: response.status, text: (await response.text()).slice(0, 1) }; });
      assert.deepEqual(after, { status: 200, text: '{' });
      setRelayScript(relay['relay.js']!);
    } finally {
      await context.close();
      await browser.close();
      hosts.close();
    }
  });
}

test('relay: the files made for the tests are removed', () => { fs.rmSync(scratch, { recursive: true, force: true }); });
