import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser, Frame, Page } from 'playwright-core';
import { build } from '@elabora/node/build';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { narrationWords } from '@elabora/core/narration/words';
import { narrationSidecarPath } from '@elabora/core/narration/narration';
import { REVIEW_PROTOCOL } from '@elabora/player/review-protocol';
import type { BlocksMessage, LayoutMessage, LocationMessage, ModuleMessage, ReadyMessage } from '@elabora/player/review-protocol';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';
import { narrate, hasFfmpeg } from '../narration.ts';

// The review bridge in Chrome (docs/review-bridge.md, D42): a host page of one origin shows a module
// built for the Revue, served from another origin, in an iframe, as revue.elabora.studio shows a module
// of elabora.page. The page hears ready, layout, location and blocks; go reaches a step, a layer, a
// word and a time; pause holds the narration; layout moves the column into the margin without
// resizing it; a page of another origin, and a frame that is not the page, are not heard.

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const L2 = "Ni l'imprimante, ni le partage de fichiers ne marchent.";

// "accueil" narrated in two steps (sine tones), word times 0.3 s apart on l2; slides.
function reviewedCourse(): string {
  const dir = copyExample();
  const data = readJSON(dir, 'course.json');
  data.presentation = { mode: 'slides' };
  writeJSON(dir, 'course.json', data);
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[2].step = 2;
  writeJSON(dir, 'screens/accueil.json', screen);
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', seconds: 2 },
    { id: 'l2', text: L2, speaker: 'marc', seconds: 3 },
    { id: 'l3', step: 2, text: 'Ça bloque toute la comptabilité !', seconds: 1.5 }
  ], { speakers: [{ id: 'marc', name: 'Marc' }] });
  const sidecar = readJSON(dir, narrationSidecarPath('fr', 'accueil', 'l2'));
  sidecar.words = narrationWords(L2, 'fr').map((word, index) => ({ text: word.text, start: Math.round(index * 300) / 1000, end: Math.round(index * 300 + 280) / 1000 }));
  writeJSON(dir, narrationSidecarPath('fr', 'accueil', 'l2'), sidecar);
  return dir;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.m4a': 'audio/mp4', '.vtt': 'text/vtt' };

// A static server: the files of a folder, or the pages given.
async function serve(handler: (pathname: string) => { type: string; body: Buffer | string } | null): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const found = handler(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname));
    if (!found) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': found.type }).end(found.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
const folder = (root: string) => (pathname: string) => {
  const file = path.join(root, pathname.replace(/^\/m\//, '/') || 'index.html');
  return file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? { type: TYPES[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) } : null;
};

// The host page: shows the module in an iframe, keeps what it hears, and posts to it. A sibling frame
// of another origin can post to the module too (it must not be heard).
const hostPage = (moduleUrl: string, moduleOrigin: string, evilUrl: string) => `<!doctype html><meta charset="utf-8"><title>Revue</title>
<style>body{margin:0} iframe{display:block;border:0}</style>
<div style="height:46px">Revue</div>
<iframe id="module" src="${moduleUrl}" style="width:1600px;height:744px"></iframe>
<iframe id="evil" src="${evilUrl}" style="width:10px;height:10px"></iframe>
<script>
window.received = [];
window.addEventListener('message', (event) => { if (event.origin === ${JSON.stringify(moduleOrigin)} && event.data && event.data.protocol === ${JSON.stringify(REVIEW_PROTOCOL)}) window.received.push(event.data); });
window.send = (message) => document.getElementById('module').contentWindow.postMessage({ protocol: ${JSON.stringify(REVIEW_PROTOCOL)}, ...message }, ${JSON.stringify(moduleOrigin)});
</script>`;
// A frame of another origin: posts what it is told to its parent's first frame (the module), or embeds the module.
const evilPage = (moduleUrl: string | null) => `<!doctype html><meta charset="utf-8"><title>Autre</title>
${moduleUrl ? `<iframe id="module" src="${moduleUrl}" style="width:1200px;height:700px;border:0"></iframe>` : ''}
<script>
window.received = [];
window.addEventListener('message', (event) => { if (event.data && event.data.protocol) window.received.push(event.data); });
window.toSibling = (message) => window.parent.frames[0].postMessage({ protocol: ${JSON.stringify(REVIEW_PROTOCOL)}, ...message }, '*');
window.toChild = (message) => document.getElementById('module').contentWindow.postMessage({ protocol: ${JSON.stringify(REVIEW_PROTOCOL)}, ...message }, '*');
</script>`;

type Received = ModuleMessage & { re?: string | number };
// The last message of a type the host page heard (after `since` messages), waited for: 30 s at most,
// as a loaded computer may take more than 10 s to send it.
async function heard<T extends Received>(page: Page, type: T['type'], check: (message: T) => boolean = () => true, since = 0): Promise<T> {
  const deadline = Date.now() + 30000;
  for (;;) {
    const all = await page.evaluate(() => (window as unknown as { received: Received[] }).received);
    const found = all.slice(since).filter((message) => message.type === type).reverse().find((message) => check(message as T));
    if (found) return found as T;
    if (Date.now() > deadline) throw new Error(`No ${type} message${since ? ` after #${since}` : ''}: ${JSON.stringify(all.slice(since).slice(-6))}`);
    await page.waitForTimeout(50);
  }
}
const count = (page: Page) => page.evaluate(() => (window as unknown as { received: unknown[] }).received.length);
const send = (page: Page, message: Record<string, unknown>) => page.evaluate((m) => (window as unknown as { send(m: unknown): void }).send(m), message);

test('the review bridge: a page of another origin hears the module, takes it to a step, a layer, a word and a time, pauses it and moves its column', { skip: NO_FFMPEG, timeout: 240000 }, async () => {
  const dir = reviewedCourse();
  let modulePort = 0;
  let evilPort = 0;
  let moduleRoot = '';
  const moduleServer = await serve((pathname) => folder(moduleRoot)(pathname));
  modulePort = moduleServer.port;
  const evilServer = await serve((pathname) => pathname === '/sibling.html' ? { type: TYPES['.html'], body: evilPage(null) } : pathname === '/embed.html' ? { type: TYPES['.html'], body: evilPage(`http://127.0.0.1:${modulePort}/m/index.html`) } : null);
  evilPort = evilServer.port;
  // Three servers, three origins (their ports): the page, the module, and a page the build does not name.
  const hostServer = await serve((pathname) => pathname === '/host.html' ? { type: TYPES['.html'], body: hostPage(`http://127.0.0.1:${modulePort}/m/index.html`, `http://127.0.0.1:${modulePort}`, `http://127.0.0.1:${evilPort}/sibling.html`) } : null);
  const hostOrigin = `http://127.0.0.1:${hostServer.port}`;
  const built = await build(dir, { target: 'web', web: { review: { origins: [hostOrigin] } }, emit: 'dir', out: tmp('elabora-review-'), writeLock: false, debug: true });
  assert.ok(built.ok && built.dirPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  moduleRoot = built.dirPath;
  const data = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'elabora/course.js'), 'utf8').replace(/^window\.ELABORA_COURSE = /, '').replace(/;\n$/, ''));
  const keyOf = (id: string): string => data.screens.find((screen: { id: string; key: string }) => screen.id === id).key;

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser('chromium');
    const context = await browser.newContext({ viewport: { width: 1700, height: 900 } });
    await context.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    // Errors in the module's frame (pageerror is the page's own).
    await context.addInitScript(() => { const errors: string[] = []; (window as Window & { frameErrors?: string[] }).frameErrors = errors; addEventListener('error', (event) => errors.push(event.message)); });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${hostOrigin}/host.html`);
    const frameOf = async (): Promise<Frame> => { for (;;) { const found = page.frames().find((frame) => frame.url().startsWith(`http://127.0.0.1:${modulePort}/m/`)); if (found) return found; await page.waitForTimeout(50); } };
    const module = await frameOf();

    // ── ready, layout, location, blocks ───────────────────────────────
    const ready = await heard<ReadyMessage>(page, 'ready');
    assert.equal(ready.protocol, REVIEW_PROTOCOL);
    assert.deepEqual({ build: ready.build, course: ready.course, language: ready.language, languages: ready.languages, presentation: ready.presentation },
      { build: { id: data.build.id }, course: { id: 'diagnostic-reseau', version: data.version, title: data.title }, language: 'fr', languages: ['fr'], presentation: 'slides' });
    assert.deepEqual(ready.screens.map((screen) => [screen.key, screen.title]), data.screens.map((screen: { key: string; title: string }) => [screen.key, screen.title]));
    const layout = await heard<LayoutMessage>(page, 'layout');
    assert.deepEqual({ frame: layout.frame, fontSize: layout.fontSize, base: layout.baseFontSize, widest: layout.widest, inset: layout.inset }, { frame: { width: 1600, height: 744 }, fontSize: 14, base: 16, widest: 962.5, inset: { right: 0, shifted: false } });
    assert.ok(layout.column.width > 700 && layout.column.width <= 962.5 && layout.column.max === 962.5, JSON.stringify(layout.column));
    assert.ok(layout.chrome.top > 30 && layout.chrome.bottom > 30, JSON.stringify(layout.chrome));
    const first = await heard<LocationMessage>(page, 'location');
    assert.deepEqual({ screen: first.screen, index: first.index, step: first.step, steps: first.steps, layer: first.layer, held: first.held }, { screen: keyOf('accueil'), index: 0, step: 1, steps: [1, 2], layer: null, held: false });
    assert.equal(typeof first.time, 'number');
    const blocks = await heard<BlocksMessage>(page, 'blocks', (message) => message.blocks.some((block) => block.rect.width > 0));
    assert.equal(blocks.screen, keyOf('accueil'));
    assert.deepEqual(blocks.blocks.map((block) => [block.id, block.kind, block.order, block.hidden]), [['accueil-situation', 'text', 1, false], ['accueil-illustration', 'image', 2, false], ['accueil-objectifs', 'callout', 3, true]]);
    const image = blocks.blocks[1];
    assert.match(image.name, /^Image · .+/, image.name);
    assert.ok(image.label && image.label.length <= 41, String(image.label));
    // Once the screen has settled (its image decoded), the last boxes heard are the page's.
    await module.evaluate(() => (window as unknown as { __elabora: { ready(): Promise<unknown> } }).__elabora.ready());
    const box = await module.evaluate(() => { const r = document.querySelector('[data-block="accueil-illustration"]')!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const near = (rect: { x: number; y: number; width: number; height: number }) => Math.abs(rect.x - box.x) < 1 && Math.abs(rect.y - box.y) < 1 && Math.abs(rect.width - box.width) < 1 && Math.abs(rect.height - box.height) < 1;
    await heard<BlocksMessage>(page, 'blocks', (message) => message.blocks.length === 3 && near(message.blocks[1].rect));

    // ── go: a step ────────────────────────────────────────────────────
    let since = await count(page);
    await send(page, { type: 'go', id: 'g1', anchor: { screen: keyOf('accueil'), step: 2 } });
    assert.deepEqual(await heard(page, 'went', (message) => message.re === 'g1', since), { protocol: REVIEW_PROTOCOL, type: 'went', re: 'g1', ok: true, missing: [] });
    await heard<LocationMessage>(page, 'location', (message) => message.step === 2, since);
    await heard<BlocksMessage>(page, 'blocks', (message) => message.blocks.find((block) => block.id === 'accueil-objectifs')?.hidden === false, since);

    // ── go: a word, then a time, on a narrated screen ─────────────────
    since = await count(page);
    await send(page, { type: 'go', id: 'g2', anchor: { screen: keyOf('accueil'), line: 'l2', word: 'imprimante' } });
    await heard(page, 'went', (message) => message.re === 'g2' && message.type === 'went' && message.ok, since);
    const said = await heard<LocationMessage>(page, 'location', (message) => message.word === 'imprimante', since);
    assert.equal(said.line, 'l2');
    assert.deepEqual([said.said, said.speaker], [L2, 'Marc'], 'the line\'s text and its speaker, as the captions show them');
    assert.equal(said.playing, false, 'going to a moment shows it still');
    const l2Start = data.screens[0].narration.lines[1].start;
    assert.ok(Math.abs((said.time ?? 0) - (l2Start + 0.6)) < 0.01, `« imprimante » is the third word of l2: ${said.time} vs ${l2Start + 0.6}`);
    since = await count(page);
    await send(page, { type: 'go', id: 'g3', anchor: { screen: keyOf('accueil'), time: l2Start + 0.95 } });
    const at = await heard<LocationMessage>(page, 'location', (message) => message.time !== undefined && Math.abs(message.time - (l2Start + 0.95)) < 0.01, since);
    assert.deepEqual([at.line, at.word, at.occurrence], ['l2', 'ni', 2], 'the second « ni » of the line');
    since = await count(page);
    await send(page, { type: 'go', id: 'g4', anchor: { screen: keyOf('accueil'), line: 'l2', word: 'serveur', block: 'nulle-part' } });
    const missed = await heard(page, 'went', (message) => message.re === 'g4', since);
    assert.deepEqual(missed.type === 'went' && [missed.ok, missed.missing], [false, ['block', 'word']]);

    // ── key C inside the module: the page's « Commenter » ─────────────
    since = await count(page);
    await module.locator('[data-block="accueil-situation"]').click();
    await page.keyboard.press('c');
    assert.deepEqual(await heard(page, 'key', () => true, since), { protocol: REVIEW_PROTOCOL, type: 'key', key: 'c' });
    // Typed in a field, with a modifier, or taken by the module: not the page's.
    await module.evaluate(() => {
      const field = document.createElement('input');
      field.id = 'typed';
      document.querySelector('#t-main')!.append(field);
      addEventListener('keydown', (event) => { if (event.key === 'C' && event.shiftKey) event.preventDefault(); }, { capture: true });
    });
    since = await count(page);
    await module.locator('#typed').focus();
    await page.keyboard.press('c');
    await module.locator('[data-block="accueil-situation"]').click();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Shift+C');
    await page.waitForTimeout(400);
    assert.equal((await page.evaluate(() => (window as unknown as { received: Received[] }).received)).slice(since).filter((message) => message.type === 'key').length, 0);
    await module.evaluate(() => document.getElementById('typed')?.remove());

    // ── pause and resume ──────────────────────────────────────────────
    await module.evaluate(() => (window as unknown as { __elabora: { timeline: { play(): void } } }).__elabora.timeline.play());
    await heard<LocationMessage>(page, 'location', (message) => message.playing === true);
    since = await count(page);
    await send(page, { type: 'pause' });
    const held = await heard<LocationMessage>(page, 'location', (message) => message.playing === false && message.held, since);
    // Something that plays it again (a screen that starts, a click): paused at once while held.
    await module.evaluate(() => (window as unknown as { __elabora: { timeline: { play(): void } } }).__elabora.timeline.play());
    await module.waitForFunction(() => !(window as unknown as { __elabora: { timeline: { state(): { playing: boolean } } } }).__elabora.timeline.state().playing);
    await module.evaluate(() => (window as unknown as { __elabora: { timeline: { advance(s: number): void } } }).__elabora.timeline.advance(1));
    assert.equal(await module.evaluate(() => (window as unknown as { __elabora: { timeline: { state(): { time: number; playing: boolean } } } }).__elabora.timeline.state().playing), false);
    assert.ok(Math.abs((await module.evaluate(() => (window as unknown as { __elabora: { timeline: { state(): { time: number } } } }).__elabora.timeline.state().time)) - (held.time ?? 0)) < 0.01, 'held: the clock does not move');
    since = await count(page);
    await send(page, { type: 'resume' });
    await heard<LocationMessage>(page, 'location', (message) => message.playing === true && !message.held, since);
    await send(page, { type: 'pause' });

    // ── go: a layer, and a block highlighted ──────────────────────────
    since = await count(page);
    await send(page, { type: 'go', id: 'g5', anchor: { screen: keyOf('premier-reflexe'), layer: 'rappel-regle', block: 'rappel-texte' } });
    await heard(page, 'went', (message) => message.re === 'g5' && message.type === 'went' && message.ok, since);
    const layered = await heard<LocationMessage>(page, 'location', (message) => message.screen === keyOf('premier-reflexe') && message.layer === 'rappel-regle', since);
    assert.equal(layered.held, true, 'the page still holds the narration');
    const inLayer = await heard<BlocksMessage>(page, 'blocks', (message) => message.blocks.some((block) => block.id === 'rappel-texte'), since);
    assert.deepEqual(inLayer.blocks.find((block) => block.id === 'rappel-texte')?.layer, 'rappel-regle');
    assert.equal(await module.evaluate(() => document.querySelector('[data-block="rappel-texte"]')?.hasAttribute('data-elabora-review-target')), true, 'highlighted');
    since = await count(page);
    await send(page, { type: 'go', id: 'g6', anchor: { screen: keyOf('premier-reflexe') } });
    await heard<LocationMessage>(page, 'location', (message) => message.screen === keyOf('premier-reflexe') && message.layer === null, since);

    // ── layout: the column moves into the margin, its width kept ──────
    const column = () => module.evaluate(() => { const r = document.querySelector('#t-main > article.t-screen')!.getBoundingClientRect(); return { left: r.left, width: r.width, font: getComputedStyle(document.documentElement).fontSize }; });
    const before = await column();
    const firstX = await module.evaluate(() => document.querySelector('#t-main [data-block]')!.getBoundingClientRect().x);
    since = await count(page);
    await send(page, { type: 'layout', id: 'l1', inset: { right: 320 } });
    const moved = await heard<LayoutMessage>(page, 'layout', (message) => message.re === 'l1', since);
    assert.deepEqual([moved.inset, moved.fontSize, moved.widest], [{ right: 320, shifted: true }, 14, 962.5]);
    // The column glides (0.25 s): measured once it has arrived (getAnimations flushes the styles).
    const settled = () => module.waitForFunction(() => document.querySelector('#t-main > article.t-screen')!.getAnimations().length === 0);
    await settled();
    const after = await column();
    const room = await module.evaluate(() => document.documentElement.clientWidth) - 320;
    assert.ok(Math.abs(after.width - before.width) < 0.01, `the same width: ${after.width} vs ${before.width}`);
    assert.equal(after.font, before.font, 'the same text size');
    assert.ok(Math.abs(after.left + after.width / 2 - room / 2) < 1, `centred in the room left: ${after.left} + ${after.width}/2 vs ${room}/2`);
    // The boxes the page gets follow the column, once it has moved.
    await heard<BlocksMessage>(page, 'blocks', (message) => message.blocks.length > 0 && Math.abs(message.blocks[0].rect.x - (firstX + after.left - before.left)) < 1, since);
    // A margin the column does not fit beside: it does not move.
    since = await count(page);
    await send(page, { type: 'layout', id: 'l2', inset: { right: 700 } });
    assert.deepEqual((await heard<LayoutMessage>(page, 'layout', (message) => message.re === 'l2', since)).inset, { right: 700, shifted: false });
    await settled();
    const back = await column();
    assert.ok(Math.abs(back.left - before.left) < 0.01 && Math.abs(back.width - before.width) < 0.01 && back.font === before.font, JSON.stringify([back, before]));
    await send(page, { type: 'layout', inset: { right: 0 } });

    // ── measure: another frame ────────────────────────────────────────
    since = await count(page);
    await send(page, { type: 'measure', id: 'm1', frame: { width: 1280, height: 744 } });
    const measured = await heard(page, 'measured', (message) => message.re === 'm1', since);
    assert.deepEqual(measured.type === 'measured' && [measured.fontSize, measured.widest], [14, 962.5]);
    since = await count(page);
    await send(page, { type: 'measure', id: 'm2', frame: { width: 1600, height: 900 } });
    const larger = await heard(page, 'measured', (message) => message.re === 'm2', since);
    assert.deepEqual(larger.type === 'measured' && [larger.fontSize, larger.widest], [16, 1100]);

    // ── another origin is not heard ───────────────────────────────────
    since = await count(page);
    const sibling = page.frames().find((frame) => frame.url().endsWith('/sibling.html'));
    assert.ok(sibling);
    await sibling.evaluate(() => (window as unknown as { toSibling(m: unknown): void }).toSibling({ type: 'go', id: 'evil', anchor: { screen: 'x' } }));
    await sibling.evaluate((key) => (window as unknown as { toSibling(m: unknown): void }).toSibling({ type: 'go', id: 'evil2', anchor: { screen: key } }), keyOf('bilan'));
    await page.waitForTimeout(500);
    assert.equal(await module.evaluate(() => (window as unknown as { __elabora: { screen: string } }).__elabora.screen), 'premier-reflexe', 'a frame that is not the page moves nothing');
    assert.equal((await page.evaluate(() => (window as unknown as { received: Received[] }).received)).slice(since).filter((message) => message.re === 'evil' || message.re === 'evil2').length, 0);
    // A page of an origin the build did not name: the module says nothing to it and does nothing it asks.
    const evil = await context.newPage();
    await evil.goto(`http://127.0.0.1:${evilPort}/embed.html`);
    const embedded = await (async () => { for (;;) { const found = evil.frames().find((frame) => frame.url().includes('/m/index.html')); if (found) return found; await evil.waitForTimeout(50); } })();
    await embedded.waitForFunction(() => (window as unknown as { __elabora?: { screen?: string } }).__elabora?.screen !== undefined);
    await evil.evaluate((key) => (window as unknown as { toChild(m: unknown): void }).toChild({ type: 'go', anchor: { screen: key } }), keyOf('bilan'));
    await evil.evaluate(() => (window as unknown as { toChild(m: unknown): void }).toChild({ type: 'hello' }));
    await evil.waitForTimeout(500);
    assert.deepEqual(await evil.evaluate(() => (window as unknown as { received: unknown[] }).received), []);
    assert.equal(await embedded.evaluate(() => (window as unknown as { __elabora: { screen: string } }).__elabora.screen), 'accueil');
    assert.deepEqual(errors, []);
    assert.deepEqual(await module.evaluate(() => (window as Window & { frameErrors?: string[] }).frameErrors), []);
  } finally {
    await browser?.close();
    await Promise.all([moduleServer.close(), evilServer.close(), hostServer.close()]);
  }
});
