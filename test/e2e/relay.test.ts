import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, webkit } from 'playwright-core';
import type { Browser, BrowserContext, Frame, Page } from 'playwright-core';
import { launchChromium } from '@elabora/node/emulator/browser';
import { startHosts } from '../relay-hosts.ts';
import type { Hosts } from '../relay-hosts.ts';
import { APP, CANVAS, FRAMES, MODULES, POLICY, REVIEW, SPACE, authorFiles, handlers, objectCode, reached, relay, scratch, setRelayDelay, setRelayScript, setRenderPatch } from '../relay-site.ts';
import * as esbuild from 'esbuild';
import { OBJECT_GLOBAL } from '@elabora/core/objects/bundle';

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

const canvasFrame = (page: Page): Frame => page.frames().find((frame) => frame.url().startsWith(`${CANVAS}/canvas/index.html`))!;
const objectFrames = (page: Page): Frame[] => page.frames().filter((frame) => frame.url().startsWith(`${FRAMES}/canvas/objects/`));

// The app's page on a module, the relay pages open, a screen shown and ready.
async function openApp(context: BrowserContext, module: 'a' | 'b', { show = true, parts = false, early = false, screen = MODULES[module]!.screen } = {}): Promise<{ page: Page; route: string; framesRoute: string }> {
  const page = await context.newPage();
  page.on('console', (message) => { if (process.env.RELAY_DEBUG) console.log('[console]', message.type(), message.text().slice(0, 200)); });
  page.on('pageerror', (error) => { if (process.env.RELAY_DEBUG) console.log('[pageerror]', String(error).slice(0, 200)); });
  await page.goto(`${APP}/?module=${module}&canvas=${encodeURIComponent(CANVAS)}&frames=${encodeURIComponent(FRAMES)}${parts ? '&parts=1' : ''}`);
  // The engine does not wait for the relay: with `early`, the first render is pushed as soon as the app exists.
  if (early) await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app, null, { timeout: 30000 });
  else await page.waitForFunction(() => (window as unknown as { app?: { log: Array<{ type: string }> } }).app?.log.filter((message) => message.type === 'relay/opened').length === 2, null, { timeout: 30000 }).catch(async (error) => { throw new Error(`${String(error).split('\n')[0]} ${JSON.stringify(await page.evaluate(() => (window as unknown as { app?: { log: unknown[] } }).app?.log))}`); });
  if (show) {
    const id = await page.evaluate((screen) => (window as unknown as { app: { show(screen: string): Promise<number> } }).app.show(screen), screen);
    for (let i = 0; i < 100 && !canvasFrame(page); i++) await page.waitForTimeout(100);
    if (!canvasFrame(page)) throw new Error(`no canvas frame among ${JSON.stringify(page.frames().map((frame) => frame.url()))}`);
    await canvasFrame(page).waitForFunction((wanted) => (window as unknown as { __elaboraCanvas: { layout(): { id: unknown } } }).__elaboraCanvas.layout().id === wanted, id, { timeout: 30000 });
  }
  // The route the host made for this view, from the address of its canvas page.
  const [route, framesRoute] = await page.evaluate(() => { const address = new URL((window as unknown as { app: { info: { url: string } } }).app.info.url); return [address.searchParams.get('route')!, address.searchParams.get('framesRoute')!]; });
  return { page, route: route!, framesRoute: framesRoute! };
}

for (const name of wanted) {
  test(`relay (${name}): the canvas shown from files no host has, a medium by ranges, an object's frame and code, each tab by its own module, a frame without the app above it refused, a version replaced`, { timeout: 600000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const browser = await launch(name, hosts);
    if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
    try {
      // 1. The canvas: its page and the player's files are the host's; the module's files, the relay's.
      const { page, route, framesRoute } = await openApp(context, 'a');
      const canvas = canvasFrame(page);
      assert.deepEqual(reached.filter((file) => file.startsWith('canvas/canvas/') && !file.includes('favicon')), [], 'no file of the module reached a host');

      // What the relay puts on its answers.
      const answered = await canvas.evaluate(async () => {
        const response = await fetch('/canvas/course.json');
        const headers = Object.fromEntries(['content-security-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'referrer-policy', 'x-content-type-options', 'cache-control', 'content-type'].map((key) => [key, response.headers.get(key)]));
        return { status: response.status, headers, text: (await response.text()).slice(0, 20) };
      });
      assert.equal(answered.status, 200);
      assert.equal(answered.headers['content-security-policy'], `${POLICY.canvas}; sandbox`, 'what is built from a module\'s file is inert as a page, with the host\'s policy');
      assert.match(answered.headers['content-security-policy']!, /frame-ancestors https:\/\/app\.elabora\.studio; sandbox$/);
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

      // A page that asks for a file of the module in its first task, its route open after: the request waits for the route, and is
      // answered by the port, never left to the network (which has none of the module's files).
      const lateRoute = await page.evaluate(() => (window as unknown as { app: { lateCanvas(): string } }).app.lateCanvas());
      const late = await (async () => { for (let i = 0; i < 100; i++) { const found = page.frames().find((frame) => frame.url().includes(`route=${lateRoute}`)); if (found) return found; await page.waitForTimeout(100); } throw new Error('no late canvas'); })();
      const asking = late.evaluate(async () => { const response = await fetch('/canvas/course.json'); return { status: response.status, start: (await response.text()).slice(0, 1) }; });
      await page.waitForTimeout(1500);
      const unanswered = await Promise.race([asking.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 50))]);
      assert.equal(unanswered, 'waiting', 'a request whose route is not open waits');
      await page.evaluate((route) => (window as unknown as { app: { openLate(route: string): void } }).app.openLate(route), lateRoute);
      assert.deepEqual(await asking, { status: 200, start: '{' });

      // 3. A free object: its frame page by the relay, with the route in its address, its code bundled by the engine.
      await page.waitForFunction(() => document.querySelectorAll('iframe').length >= 2);
      const frames = await (async () => { for (let i = 0; i < 300; i++) { const found = objectFrames(page); if (found.length) return found; await page.waitForTimeout(100); } return []; })();
      assert.ok(frames.length >= 1, 'the object frame');
      const frame = frames[0]!;
      assert.match(frame.url(), new RegExp(`^${FRAMES}/canvas/objects/diagnostic-reseau/frame\\.html\\?route=${framesRoute}$`));
      assert.notEqual(framesRoute, route, 'the canvas and the frames have a route each, and the canvas\'s is not in an object\'s address');
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
      // frames a space, which frames the frames host's page of an object (the security review's M1). The app's own frame is the control.
      // A file of the module is not a page at all: framed under the app, the canvas host's relay refuses it.
      const target = `${FRAMES}/canvas/objects/diagnostic-reseau/frame.html?route=${framesRoute}`;
      const read = async (host: Page): Promise<string | null> => {
        const probe = host.frames().find((frame) => frame.url().startsWith(target));
        if (!probe) return null;
        return probe.evaluate(() => (document.querySelector('meta[http-equiv="Content-Security-Policy"]') ? 'shown' : 'empty')).catch(() => null);
      };
      await page.evaluate((url) => { const control = document.createElement('iframe'); control.id = 'control'; control.src = url; document.body.append(control); }, target);
      await page.waitForTimeout(1500);
      assert.equal(await read(page), 'shown', 'under the app the frame page shows');
      const asFile = `${CANVAS}/canvas/course.json?route=${route}`;
      await page.evaluate((url) => { const file = document.createElement('iframe'); file.id = 'as-file'; file.src = url; document.body.append(file); }, asFile);
      await page.waitForTimeout(1500);
      assert.equal(await page.frames().find((frame) => frame.url().startsWith(asFile))?.evaluate(() => document.body?.innerText ?? '').catch(() => 'blocked'), 'forbidden', 'a file of the module is never given as a page, under the app either');
      const review = await context.newPage();
      await review.goto(`${REVIEW}/`);
      await review.waitForFunction(() => document.getElementById('space'));
      const space = review.frames().find((frame) => frame.url().startsWith(SPACE))!;
      await space.waitForLoadState('load');
      await review.evaluate((url) => (document.getElementById('space') as HTMLIFrameElement).contentWindow!.postMessage({ frame: url }, '*'), target);
      await review.waitForTimeout(2500);
      assert.notEqual(await read(review), 'shown', 'under the review page and a space the frame page must not show');
      await review.close();

      // The canvas host for a page: what the canvas says arrives read as data, a question is answered, a page loaded again is
      // given its render again, and what a window or a frame that is not the canvas's says is nothing.
      const layouts = await page.evaluate(() => (window as unknown as { app: { messages: Array<{ type: string; id?: unknown; blocks?: unknown[] }> } }).app.messages.filter((message) => message.type === 'elabora/layout').map((message) => ({ id: message.id, blocks: message.blocks?.length })));
      assert.ok(layouts.length > 0 && layouts.at(-1)!.blocks! > 0, JSON.stringify(layouts.slice(-1)));
      const measured = await page.evaluate(() => (window as unknown as { app: { host: { ask(name: string, params: object): Promise<{ overflow: number; fields: unknown[] }> } } }).app.host.ask('measure', { id: 1 }));
      assert.ok(typeof measured.overflow === 'number' && Array.isArray(measured.fields));
      const heard = () => page.evaluate(() => (window as unknown as { app: { messages: unknown[]; log: unknown[] } }).app.messages.length + (window as unknown as { app: { log: unknown[] } }).app.log.length);
      const quiet = await heard();
      await page.evaluate(() => {
        // From the app's own window, and from a frame that is not the canvas's (srcdoc: the app's origin): not the canvas frame's window.
        postMessage({ type: 'relay/ready', protocol: 'elabora-relay/1', version: 'forged', host: 'canvas' }, '*');
        postMessage({ type: 'elabora/error', id: null, message: 'forged' }, '*');
        const stranger = document.createElement('iframe');
        stranger.srcdoc = '<script>parent.postMessage({ type: "elabora/error", id: null, message: "forged" }, "*"); parent.postMessage({ type: "relay/opened", protocol: "elabora-relay/1", route: "k3J0aXq9Zr1T5mYb8WcD7g" }, "*");</script>';
        document.body.append(stranger);
      });
      await page.waitForTimeout(800);
      assert.equal(await heard(), quiet, 'nothing a window that is not the canvas\'s says is heard');
      const again = await page.evaluate(() => { const app = (window as unknown as { app: { messages: unknown[]; reload(): void } }).app; const count = app.messages.length; app.reload(); return count; });
      await page.waitForFunction((count) => (window as unknown as { app: { log: Array<{ type: string }> } }).app.log.filter((message) => message.type === 'relay/opened').length >= count, 3, { timeout: 30000 }).catch(async (error) => { throw new Error(`${String(error).split('\n')[0]} ${JSON.stringify(await page.evaluate(() => (window as unknown as { app: { log: Array<{ from: string; type: string }>; host: { relays(): unknown } } }).app.log.map((message) => `${message.from}:${message.type}`).concat([JSON.stringify((window as unknown as { app: { host: { relays(): unknown } } }).app.host.relays())])))}`); });
      await page.waitForFunction((count) => (window as unknown as { app: { messages: Array<{ type: string }> } }).app.messages.slice(count).some((message) => message.type === 'elabora/layout'), again, { timeout: 30000 });
      const afterReload = await canvasFrame(page).evaluate(async () => { const response = await fetch('/canvas/course.json'); return { status: response.status, screen: (window as unknown as { __elaboraCanvas: { screen: string | null } }).__elaboraCanvas.screen }; });
      assert.deepEqual(afterReload, { status: 200, screen: MODULES.a!.screen }, 'a page loaded again has its route open again and its render');

      // 6. A version of the relay replaced without reloading the app.
      await page.evaluate(() => { (window as unknown as { marker?: string }).marker = 'kept'; });
      const before = await page.evaluate(() => (window as unknown as { app: { versions(): { canvas?: string; frames?: string } } }).app.versions());
      assert.ok(before.canvas && before.frames);
      const next = relay['relay.js']!.replaceAll(before.canvas!, `${before.canvas}-next`);
      assert.notEqual(next, relay['relay.js']);
      setRelayScript(next);
      // Events keep coming to the script being replaced, from a frame of the frames host and from the canvas page, as pages load
      // their scripts: the browser stops the running script to activate the new one, and an event that reaches it then brings it
      // back (found in the test's passes: the new script then waited for the running one's idle time). The relay's page asks the
      // waiting script to skip waiting again until it has taken over.
      const hammering = [objectFrames(page)[0], canvasFrame(page)].map((frame) => frame?.evaluate(async () => { for (let i = 0; i < 400; i++) await fetch(`/canvas/elabora/${i % 2 ? 'object-frame.js' : 'player.css'}`).then((response) => response.status).catch(() => 0); }).catch(() => undefined));
      await page.evaluate(() => (window as unknown as { app: { update(): void } }).app.update());
      await page.waitForFunction((was) => { const now = (window as unknown as { app: { versions(): { canvas?: string; frames?: string } } }).app.versions(); return now.canvas === `${was}-next` && now.frames === `${was}-next`; }, before.canvas, { timeout: 30000 });
      await Promise.all(hammering);
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

for (const name of wanted) {
  test(`relay (${name}): on a first visit, the first draw asks the relay for the module's pictures, never the network`, { timeout: 300000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const browser = await launch(name, hosts);
    if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
    // A browser that has no relay yet: the pages are not controlled when they load, and the first render must wait for the relay.
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
    try {
      const missesBefore = reached.length;
      // The relay's script comes slowly: the pages are drawn long before it controls them.
      setRelayDelay(2000);
      const { page } = await openApp(context, 'a', { screen: 'accueil', early: true });
      const canvas = canvasFrame(page);
      await canvas.waitForFunction(() => [...document.images].some((image) => image.currentSrc.includes('/canvas/assets/')), null, { timeout: 30000 });
      await canvas.waitForFunction(() => [...document.images].filter((image) => image.currentSrc.includes('/canvas/assets/')).every((image) => image.complete && image.naturalWidth > 0), null, { timeout: 30000 }).catch(async (error) => {
        // What the relay says of its refusals (relay/fault), and what reached the hosts' network.
        const faults = await page.evaluate(() => (window as unknown as { app: { log: Array<{ type: string }> } }).app.log.filter((message) => message.type === 'relay/fault'));
        throw new Error(`${String(error).split('\n')[0]} faults: ${JSON.stringify(faults)} network: ${JSON.stringify(reached.slice(missesBefore))}`);
      });
      const files = await page.evaluate(() => (window as unknown as { app: { requests: Array<{ kind: string; path?: string }> } }).app.requests.filter((request) => request.kind === 'file').map((request) => request.path));
      assert.ok(files.some((file) => file?.startsWith('assets/images/')), `the picture came from the engine: ${JSON.stringify(files)}`);
      assert.deepEqual(reached.slice(missesBefore).filter((file) => file.startsWith('canvas/canvas/')), [], 'no file of the module was asked of the canvas host\'s network');
    } finally {
      setRelayDelay(0);
      await context.close();
      await browser.close();
      hosts.close();
    }
  });
}

// An object of the author's (code on the frames host, with allow-same-origin, which reaches the app's hidden relay page by `top[i]`),
// as the security review wrote it, compiled as an object is.
const attacker = async (body: string): Promise<string> => (await esbuild.build({ stdin: { contents: body, loader: 'js' }, bundle: true, format: 'iife', globalName: OBJECT_GLOBAL, write: false, logLevel: 'silent' })).outputFiles[0]!.text;
const ESCAPE = `export function mount() {
  const W = globalThis;
  const T = W['to' + 'p'];
  const route = new URLSearchParams(location.search).get('route');
  let relay = null;
  for (let i = 0; i < T.length; i++) { try { if (T[i].location.pathname === '/relay.html') relay = T[i]; } catch (e) {} }
  if (relay) W['set' + 'Timeout'](() => {
    // A link of the relay page's own document: its navigation is the relay page's, which no sandbox of the object binds.
    const a = relay.document.createElement('a');
    a.href = '${CANVAS}/canvas/assets/poc.html?route=' + route;
    relay.document.body.append(a);
    a.click();
    console.log('OBJECT sent the relay page to the canvas origin');
  }, 500);
  return { getState() { return {}; }, dispose() {} };
}`;

for (const name of wanted) {
  test(`relay (${name}): an author's files never run on the canvas host, whatever an object does with the app's relay page`, { timeout: 300000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const browser = await launch(name, hosts);
    if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
    try {
      authorFiles.set('assets/poc.html', '<!doctype html><title>author</title><p>author page</p><script src="poc.js"></script>');
      authorFiles.set('assets/poc.js', "console.log('AUTHOR-SCRIPT-RAN ' + location.origin);");
      objectCode.set('a/diagnostic-reseau', await attacker(ESCAPE));
      const heard: string[] = [];
      context.on('page', (page) => page.on('console', (message) => heard.push(message.text())));
      const { page, route, framesRoute } = await openApp(context, 'a');
      page.on('console', (message) => heard.push(message.text()));
      // The route of the canvas is the canvas page's alone: not the frames', so not in the address of an object's frame nor of the frames host's page.
      assert.notEqual(route, framesRoute);
      const frame = await (async () => { for (let i = 0; i < 300; i++) { const found = objectFrames(page)[0]; if (found) return found; await page.waitForTimeout(100); } throw new Error('no object frame'); })();
      assert.ok(page.frames().filter((each) => each.url().startsWith(FRAMES)).every((each) => !each.url().includes(route)), 'no page of the frames host has the canvas route in its address');
      assert.equal(new URL(frame.url()).searchParams.get('route'), framesRoute);
      // The object sends the app's hidden relay page to an author's page of the canvas origin: nothing of the author's runs there.
      await page.waitForTimeout(5000);
      assert.ok(heard.some((text) => text.includes('OBJECT sent the relay page')), `the object did what it could: ${JSON.stringify(heard.slice(-5))}`);
      assert.deepEqual(heard.filter((text) => text.includes('AUTHOR-SCRIPT-RAN')), [], 'no script of the author runs on the canvas origin');
      const asked = await page.evaluate(() => (window as unknown as { app: { requests: Array<{ kind: string; path?: string }> } }).app.requests.filter((request) => request.kind === 'file' && /poc\./.test(request.path ?? '')).map((request) => request.path));
      assert.deepEqual(asked, [], 'the engine was not even asked for the author\'s page');
      // From the canvas page itself: a file of the module is given to what shows it, never as a script, a page or a worker.
      const canvas = canvasFrame(page);
      const outcome = await canvas.evaluate(async () => {
        const result: Record<string, unknown> = {};
        const response = await fetch('/canvas/assets/poc.js');
        result.fetched = { status: response.status, type: response.headers.get('content-type'), sniff: response.headers.get('x-content-type-options'), csp: /; sandbox$/.test(response.headers.get('content-security-policy') ?? '') };
        result.script = await new Promise((resolve) => { const script = document.createElement('script'); script.src = '/canvas/assets/poc.js'; script.onload = () => resolve('loaded'); script.onerror = () => resolve('refused'); document.head.append(script); setTimeout(() => resolve('timeout'), 5000); });
        result.worker = await new Promise((resolve) => { try { const worker = new Worker('/canvas/assets/poc.js'); worker.onerror = () => resolve('refused'); worker.onmessage = () => resolve('ran'); setTimeout(() => resolve('refused-late'), 3000); } catch { resolve('refused'); } });
        result.page = await new Promise((resolve) => { const frame = document.createElement('iframe'); frame.onload = () => { try { resolve(frame.contentDocument?.body?.innerText ?? 'empty'); } catch { resolve('blocked'); } }; frame.src = '/canvas/assets/poc.html'; document.body.append(frame); setTimeout(() => resolve('timeout'), 5000); });
        return result;
      });
      assert.deepEqual(outcome.fetched, { status: 200, type: 'text/javascript', sniff: 'nosniff', csp: true }, 'a plain read is served, inert if a browser loaded it as a page');
      assert.equal(outcome.script, 'refused', 'a script of the author is not loaded on the canvas host');
      assert.notEqual(outcome.worker, 'ran', 'nor a worker');
      assert.ok(!String(outcome.page).includes('author page'), 'nor a page');
      // Under the app, whose frame the host admits, an author's page is refused as a page, and its script does not run.
      const authorPage = `${CANVAS}/canvas/assets/poc.html?route=${route}`;
      await page.evaluate((url) => { const author = document.createElement('iframe'); author.src = url; document.body.append(author); }, authorPage);
      await page.waitForTimeout(1500);
      assert.equal(await page.frames().find((each) => each.url().startsWith(authorPage))?.evaluate(() => document.body?.innerText ?? '').catch(() => 'blocked'), 'forbidden', 'an author\'s page is refused as a page under the app too');
      assert.deepEqual(heard.filter((text) => text.includes('AUTHOR-SCRIPT-RAN')), [], 'still nothing ran');
    } finally {
      authorFiles.clear();
      objectCode.clear();
      await context.close();
      await browser.close();
      hosts.close();
    }
  });

  test(`relay (${name}): an object's sandbox words are the player's list, whatever its manifest says: it cannot move the tab`, { timeout: 300000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const browser = await launch(name, hosts);
    if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
    try {
      // A manifest that asks for everything an object could use to leave its frame (it passes through a copy that is not validated).
      setRenderPatch((render) => { const object = render.course?.objects?.['diagnostic-reseau']; if (object) object.permissions = ['top-navigation', 'popups', 'popups-to-escape-sandbox', 'downloads', 'modals', 'pointer-lock', 'pointer-lock allow-top-navigation']; });
      objectCode.set('a/diagnostic-reseau', await attacker(`export function mount() {
        const W = globalThis;
        W['set' + 'Timeout'](() => { try { W['to' + 'p'].location.href = '${REVIEW}/?moved'; console.log('OBJECT moved the tab'); } catch (error) { console.log('OBJECT blocked ' + error.name); } }, 500);
        return { getState() { return {}; }, dispose() {} };
      }`));
      const heard: string[] = [];
      context.on('page', (page) => page.on('console', (message) => heard.push(message.text())));
      const { page } = await openApp(context, 'a');
      page.on('console', (message) => heard.push(message.text()));
      await page.waitForTimeout(4000);
      const sandboxes = await canvasFrame(page).evaluate(() => [...document.querySelectorAll('iframe')].map((each) => each.getAttribute('sandbox')));
      assert.deepEqual(sandboxes, ['allow-scripts allow-pointer-lock allow-same-origin'], 'the words of the list, and the frames host\'s own');
      assert.ok(page.url().startsWith(APP), `the tab was not moved: ${page.url()}`);
      assert.ok(!heard.some((text) => text.includes('OBJECT moved the tab')), JSON.stringify(heard.slice(-5)));
    } finally {
      setRenderPatch(null);
      objectCode.clear();
      await context.close();
      await browser.close();
      hosts.close();
    }
  });
}

const DRIVE = `export function mount() {
  const W = globalThis;
  const T = W['to' + 'p'];
  let relay = null;
  for (let i = 0; i < T.length; i++) { try { if (T[i].location.pathname === '/relay.html') relay = T[i]; } catch (e) {} }
  console.log('OBJECT holds the relay page: ' + !!relay);
  if (relay) W['set' + 'Timeout'](() => {
    // What the object's own frame cannot do, asked of the hidden page of the app that it holds: a notice in the author's words, a file saved, windows opened.
    try { relay['al' + 'ert']('Votre session Elabora a expir\u00e9'); } catch (e) {}
    try {
      const a = relay.document.createElement('a');
      a.href = relay.URL.createObjectURL(new relay.Blob(['x']));
      a.download = 'session.txt';
      relay.document.body.append(a);
      a.click();
    } catch (e) {}
    try { relay.open('${REVIEW}/?one'); relay.open('${REVIEW}/?two'); } catch (e) {}
    console.log('OBJECT asked the relay page for a notice, a download and two windows');
  }, 500);
  return { getState() { return {}; }, dispose() {} };
}`;

for (const name of wanted) {
  test(`relay (${name}): an object that holds the frames host's relay page gets no notice, no download and no window out of it`, { timeout: 300000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const browser = await launch(name, hosts);
    if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow', acceptDownloads: true });
    try {
      objectCode.set('a/diagnostic-reseau', await attacker(DRIVE));
      const heard: string[] = [];
      const dialogs: string[] = [];
      const downloads: string[] = [];
      const pages: Page[] = [];
      context.on('page', (page) => {
        pages.push(page);
        page.on('console', (message) => heard.push(message.text()));
        page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
        page.on('download', (download) => downloads.push(download.suggestedFilename()));
      });
      const { page } = await openApp(context, 'a');
      await page.waitForFunction(() => true);
      for (let i = 0; i < 100 && !heard.some((text) => text.includes('OBJECT asked the relay page')); i++) await page.waitForTimeout(100);
      assert.ok(heard.some((text) => text.includes('OBJECT holds the relay page: true')), `the object holds the relay page: ${JSON.stringify(heard.slice(-6))}`);
      assert.ok(heard.some((text) => text.includes('OBJECT asked the relay page')), 'the object did what it could');
      await page.waitForTimeout(2000);
      assert.deepEqual(dialogs, [], 'no notice');
      assert.deepEqual(downloads, [], 'no download');
      assert.equal(pages.length, 1, `no window out of it: ${JSON.stringify(pages.map((each) => each.url()))}`);
      assert.ok(page.url().startsWith(APP));
      // What the relay page still does with its sandbox: it holds the routes (the frame's page and its code came by it).
      assert.ok(await page.evaluate(() => (window as unknown as { app: { requests: Array<{ kind: string }> } }).app.requests.some((request) => request.kind === 'object-code')));
    } finally {
      objectCode.clear();
      await context.close();
      await browser.close();
      hosts.close();
    }
  });
}

test('relay: the files made for the tests are removed', () => { fs.rmSync(scratch, { recursive: true, force: true }); });
