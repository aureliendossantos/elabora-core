import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { readProjectFiles } from '@elabora/node/project-reader';
import { wavBytes } from '@elabora/core/voice/wav';
import { aacEncoderModule } from '@elabora/engine/aac-encoder';
import { bundleForBrowser } from '../browser-bundle.ts';
import { emptyStorage } from '../browser-page.ts';
import { NETWORK_SAMPLE } from '../helpers.ts';

// The browser engine in WebKit: a medium the app ships is taken, checked, kept, then served from what is
// kept, one at a time and all at once. In a profile on disk, it is kept in the origin's private file
// system, which WebKit moves a file of only by move(folder, name). In a private window, which has no
// such file system (getDirectory() throws), it is kept in IndexedDB, and a master is made in memory;
// Firefox's private browsing has none either (a SecurityError), and is kept the same way.

const ORIGIN = 'https://engine.elabora.test';
const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };
const { files } = readProjectFiles(NETWORK_SAMPLE);
const shipped = new Map<string, Buffer>();
for (const [rel, file] of files) if (file.kind === 'binary' && file.hash) shipped.set(file.hash, fs.readFileSync(path.join(NETWORK_SAMPLE, rel)));
// A narration's lines: what the canvas host serves without a render (servedFileKind).
const media = [...files].filter(([rel, file]) => file.kind === 'binary' && rel.startsWith('assets/narration/')).map(([rel]) => rel).slice(0, 4);
// Two seconds of a tone, as a recording comes: a WAV a narration line is made from.
const recording = Buffer.from(wavBytes(Float32Array.from({ length: 2 * 48000 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000)), 48000));

async function serve(page: Page): Promise<void> {
  const engine = await bundleForBrowser({ source: `import { provideMedia } from './packages/engine/src/browser/worker.ts';
provideMedia(async (hash) => { const response = await fetch('/media/' + hash); return response.ok ? response.blob() : null; });` });
  const mediaWorker = await bundleForBrowser({ file: 'packages/engine/src/browser/media/worker.ts' });
  // Firefox has no AAC encoder under macOS: Mediabunny's (D107, D135).
  const aac = await aacEncoderModule();
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname;
    if (name === '/worker.js') return route.fulfill({ contentType: 'text/javascript', body: engine.code });
    if (name === '/media-worker.js') return route.fulfill({ contentType: 'text/javascript', body: mediaWorker.code });
    if (name === '/aac.js') return route.fulfill({ contentType: 'text/javascript', body: aac });
    if (name === '/recording.wav') return route.fulfill({ contentType: 'audio/wav', body: recording });
    const bytes = name.startsWith('/media/') ? shipped.get(name.slice('/media/'.length)) : undefined;
    if (bytes) return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>engine</title>' });
  });
  await page.goto(`${ORIGIN}/`);
  // WebKit keeps an origin's storage outside the profile it is given: what an earlier run kept goes.
  await emptyStorage(page);
}

// The media taken by the engine's Worker and served through its relay, once taken then from what it kept.
async function keptAndServed(page: Page): Promise<void> {
  const answers = await page.evaluate(async ([seed, paths]) => {
    const w = new Worker('/worker.js', { type: 'module' });
    await new Promise((resolve) => { w.onmessage = ({ data }) => resolve(data); w.postMessage({ kind: 'open', team: 'tm_test', project: 'webkit', seed, api: 'http://localhost:1', offline: true }); });
    const { port1, port2 } = new MessageChannel();
    const opened = new Promise((resolve) => w.addEventListener('message', ({ data }) => { if (data.kind === 'response' && data.id === 'relay') resolve(data.ok); }));
    w.postMessage({ kind: 'request', id: 'relay', type: 'relayPort', params: { host: 'canvas' } }, [port1]);
    await opened;
    port2.start();
    let next = 0;
    const ask = (path: string) => new Promise<string>((resolve) => {
      const id = ++next;
      port2.addEventListener('message', function listen({ data }) { if (data.type === 'relay/answer' && data.id === id) { port2.removeEventListener('message', listen); resolve(`${data.answer.status} ${data.answer.body?.size ?? ''}`.trim()); } });
      port2.postMessage({ type: 'relay/request', id, request: { kind: 'file', path } });
    });
    const once = [];
    for (const path of paths as string[]) once.push(await ask(path));
    return { once, kept: await Promise.all((paths as string[]).map(ask)) };
  }, [{ link, confirmed: [...files] }, media] as unknown as [object, string[]]);
  const sizes = media.map((rel) => `ok ${fs.statSync(path.join(NETWORK_SAMPLE, rel)).size}`);
  assert.deepEqual(answers.once, sizes, 'taken from the app, checked, kept');
  assert.deepEqual(answers.kept, sizes, 'served from what is kept');
}

test('WebKit: the media an app ships are kept and served by the engine\'s Worker', { timeout: 180_000 }, async (t) => {
  const playwright = await import('playwright-core');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-webkit-'));
  let context: Awaited<ReturnType<typeof playwright.webkit.launchPersistentContext>>;
  try {
    context = await playwright.webkit.launchPersistentContext(profile, {});
  } catch (error) {
    fs.rmSync(profile, { recursive: true, force: true });
    return t.skip(`WebKit is not installed: ${(error as Error).message.split('\n')[0]}`);
  }
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await serve(page);
    await keptAndServed(page);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

// A private window: no private file system, the media kept in IndexedDB, a line's master made in memory.
async function privateWindow(t: { skip(message: string): void; diagnostic(message: string): void }, name: 'webkit' | 'firefox', refused: string): Promise<void> {
  const playwright = await import('playwright-core');
  let browser: Awaited<ReturnType<typeof playwright.webkit.launch>>;
  try {
    // WebKit's context without a profile on disk is a private window's state; Firefox's private browsing is a mode.
    browser = name === 'webkit' ? await playwright.webkit.launch() : await playwright.firefox.launch({ firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true } });
  } catch (error) {
    return t.skip(`${name} is not installed: ${(error as Error).message.split('\n')[0]}`);
  }
  try {
    const page = await (await browser.newContext()).newPage();
    await serve(page);
    assert.equal(await page.evaluate(() => navigator.storage.getDirectory().then(() => 'a file system', (error: Error) => error.name)), refused, 'no private file system here');
    await keptAndServed(page);
    // A narration line from a recording: the media Worker writes its master in memory.
    const line = await page.evaluate(async (aacEncoder) => {
      const file = await (await fetch('/recording.wav')).blob();
      const w = new Worker('/media-worker.js', { type: 'module' });
      w.postMessage({ kind: 'init', init: aacEncoder ? { aacEncoder } : {} });
      const { answer } = await new Promise<{ answer: { master?: { file: Blob; action: string }; error?: string } }>((resolve) => {
        w.onmessage = ({ data }) => resolve(data);
        w.postMessage({ kind: 'ask', id: 1, ask: { op: 'master', kind: 'line', file, name: 'recording.wav', trim: true } });
      });
      w.terminate();
      return answer.master ? { action: answer.master.action, size: answer.master.file.size, head: Array.from(new Uint8Array(await answer.master.file.slice(4, 8).arrayBuffer())) } : { error: answer.error };
    }, name === 'firefox' ? `${ORIGIN}/aac.js` : null);
    assert.equal(line.action, 'encode', JSON.stringify(line));
    assert.equal(String.fromCharCode(...line.head!), 'ftyp', 'an MP4');
    t.diagnostic(`a line made from a two-second recording: ${line.size} bytes, in memory`);
  } finally {
    await browser.close();
  }
}

test('WebKit, a private window: without the origin\'s file system, the media are kept in IndexedDB and a master is made in memory', { timeout: 180_000 }, (t) => privateWindow(t, 'webkit', 'UnknownError'));

test('Firefox, private browsing: without the origin\'s file system, the media are kept in IndexedDB and a master is made in memory', { timeout: 180_000 }, (t) => privateWindow(t, 'firefox', 'SecurityError'));
