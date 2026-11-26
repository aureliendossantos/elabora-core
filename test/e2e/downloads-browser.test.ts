import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Route } from 'playwright-core';
import { bundleForBrowser } from '../browser-bundle.ts';
import { emptyStorage, ISOLATED, pageWithStorage } from '../browser-page.ts';

// « Éléments téléchargés » in a browser (D38, D113; ELABORA_BROWSER: chromium, firefox or webkit), run
// by the window itself with no session, as Réglages runs it with no module open: two small models in
// the core's shape (a voice's and an aligner's), listed, downloaded with their progress heard on the
// origin's channel, refused removal while a session holds one, removed with the bytes it freed; a
// download stopped midway, what it left removed. It says whether a Worker can ask to keep the storage.

const BROWSER = process.env.ELABORA_BROWSER ?? 'chromium';
const APP = 'https://app.elabora.test';
const MODELS = 'https://models.elabora.test';
const file = (name: string, url: string, bytes: Buffer) => ({ name, url, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes });
const files = {
  voice: [file('a.bin', 'tiny-voice/a.bin', crypto.randomBytes(3 * 1024 * 1024 + 17)), file('b.bin', 'tiny-voice/b.bin', crypto.randomBytes(1000))],
  aligner: [file('model.onnx', 'tiny-aligner/model.onnx', crypto.randomBytes(1024 * 1024)), file('vocab.json', 'tiny-aligner/vocab.json', Buffer.from('{"a":1}'))]
};
const strip = (list: typeof files.voice) => list.map(({ bytes: _bytes, ...rest }) => rest);
const voices = [{ id: 'tiny-voice', version: '1', language: 'xx', model: 'tiny/voice@1', files: strip(files.voice) }];
const aligners = [{ id: 'tiny-aligner', version: '1', language: 'xx', model: 'tiny/aligner@1', credit: 'a test', files: strip(files.aligner), startShift: 0, endShift: 0 }];

let browser: Awaited<ReturnType<typeof pageWithStorage>> | undefined;
after(async () => { await browser?.close(); });

test(`downloads in ${BROWSER}: listed, downloaded, held, removed and stopped by the window with no session`, { timeout: 180_000 }, async () => {
  const code = (await bundleForBrowser({ source: `import { BrowserDownloads } from './packages/engine/src/browser/downloads.ts';
globalThis.BrowserDownloads = BrowserDownloads;` })).code;
  browser = await pageWithStorage(BROWSER);
  const { page } = browser;
  // The aligner's vocabulary waits until the test lets it go: its download is stopped meanwhile.
  const stalled: Route[] = [];
  await page.route(`${MODELS}/**`, (route) => {
    const url = new URL(route.request().url());
    const found = [...files.voice, ...files.aligner].find((one) => url.pathname === `/${one.url}`);
    const headers = { 'access-control-allow-origin': APP, 'access-control-expose-headers': 'content-range', 'content-type': 'application/octet-stream' };
    if (!found) return route.fulfill({ status: 404, headers, body: '' });
    if (found.name === 'vocab.json' && !process.env.LET_GO) { stalled.push(route); return; }
    const range = /^bytes=(\d+)-(\d+)?$/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(found.size - 1, Number(range[2])) : found.size - 1;
    return route.fulfill({ status: range ? 206 : 200, headers: { ...headers, ...(range ? { 'content-range': `bytes ${start}-${end}/${found.size}` } : {}) }, body: found.bytes.subarray(start, end + 1) });
  });
  await page.route(`${APP}/**`, (route) => {
    const name = new URL(route.request().url()).pathname;
    if (name === '/downloads.js') return route.fulfill({ headers: ISOLATED, contentType: 'text/javascript', body: code });
    if (name === '/voices/voices.json') return route.fulfill({ headers: ISOLATED, contentType: 'application/json', body: JSON.stringify({ voices: [{ id: 'ada', name: 'Ada', language: 'xx', gender: 'female', bundle: 'tiny-voice', file: 'ada.bin', frames: 1, sha256: '0' }] }) });
    return route.fulfill({ headers: ISOLATED, contentType: 'text/html', body: '<!doctype html><title>réglages</title><script type="module" src="/downloads.js"></script>' });
  });
  page.on('pageerror', (error) => console.error('page:', error.message));
  await page.goto(`${APP}/`);
  await emptyStorage(page);
  await page.waitForFunction(() => 'BrowserDownloads' in globalThis);

  const result = await page.evaluate(async ([models, voiceModels, alignerModels]) => {
    type Downloads = {
      list(): Promise<{ id: string; installed: boolean; size: number; supported?: boolean; inUse: boolean; installing: unknown; contents?: unknown }[]>;
      install(id: string, options?: { onProgress?: (p: { received: number; total: number }) => void }): Promise<{ installed: boolean }>;
      cancel(id: string): Promise<{ cancelled: boolean }>;
      uninstall(id: string): Promise<{ freed: number }>;
      storage(): Promise<{ used: number; quota: number; persisted: boolean }>;
      onChange(listener: (change: { id: string; progress?: { received: number; total: number }; changed?: true }) => void): () => void;
    };
    const Made = (globalThis as unknown as { BrowserDownloads: new (host: object) => Downloads }).BrowserDownloads;
    const downloads = new Made({ models, catalogue: '/voices/', voices: voiceModels, aligners: alignerModels });
    const heard: { id: string; progress?: { received: number; total: number }; changed?: true }[] = [];
    const off = downloads.onChange((change) => heard.push(change));
    const caught = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: unknown; name?: string; message?: string }) => (typeof error.code === 'string' ? error.code : error.name ?? error.message ?? 'error'));
    const listed = await downloads.list();
    const unknown = await caught(downloads.install('voices-zz'));
    const progress: number[] = [];
    const installed = await downloads.install('voices-xx', { onProgress: (p) => progress.push(p.received) });
    const afterInstall = await downloads.list();
    // A session saying lines holds the model (models/store.ts holdModel): its removal is refused.
    let release!: () => void;
    await new Promise<void>((held) => { void navigator.locks.request('elabora-model-use:tiny-voice', { mode: 'shared' }, () => { held(); return new Promise<void>((done) => { release = done; }); }); });
    const whileHeld = await downloads.list();
    const refused = await caught(downloads.uninstall('voices-xx'));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const removed = await downloads.uninstall('voices-xx');
    const afterRemove = await downloads.list();
    // The aligner's download, stopped once its first file is there.
    const stopped = caught(downloads.install('aligner-xx'));
    while (!heard.some((change) => change.id === 'aligner-xx' && change.progress && change.progress.received >= 1024 * 1024)) await new Promise((resolve) => setTimeout(resolve, 20));
    const during = (await downloads.list()).find((view) => view.id === 'aligner-xx');
    const cancelled = await downloads.cancel('aligner-xx');
    const stoppedWith = await stopped;
    const afterCancel = (await downloads.list()).find((view) => view.id === 'aligner-xx');
    let left: string[] = [];
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('elabora-models');
      for await (const name of (root as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) left.push(name);
    } catch { left = []; }
    const storage = await downloads.storage();
    await new Promise((resolve) => setTimeout(resolve, 100));
    off();
    // Whether a Worker can ask to keep the storage (persist), or only a window.
    const workerPersist = await new Promise<string>((resolve) => {
      const worker = new Worker(URL.createObjectURL(new Blob(['postMessage(typeof navigator.storage.persist)'], { type: 'text/javascript' })));
      worker.onmessage = ({ data }) => { resolve(data); worker.terminate(); };
    });
    return { listed, unknown, installed, progress, afterInstall, whileHeld, refused, removed, afterRemove, during, cancelled, stoppedWith, afterCancel, left, storage, heard, workerPersist, windowPersist: typeof navigator.storage.persist };
  }, [MODELS, voices, aligners] as const);
  for (const route of stalled) await route.abort().catch(() => {});

  const voice = (views: typeof result.listed) => views.find((view) => view.id === 'voices-xx')!;
  assert.deepEqual(result.listed.map((view) => [view.id, view.installed, view.supported, view.size]), [['voices-xx', false, true, files.voice[0]!.size + files.voice[1]!.size], ['aligner-xx', false, true, files.aligner[0]!.size + files.aligner[1]!.size]], JSON.stringify(result.listed));
  assert.deepEqual(voice(result.listed).contents, [{ id: 'ada', name: 'Ada', gender: 'female' }]);
  assert.equal(result.unknown, 'E_DOWNLOAD_UNKNOWN');
  assert.equal(result.installed.installed, true);
  assert.equal(result.progress.at(-1), voice(result.listed).size);
  assert.ok(result.heard.some((change) => change.id === 'voices-xx' && change.changed), 'the channel says it is kept');
  assert.equal(voice(result.afterInstall).installed, true);
  assert.equal(voice(result.whileHeld).inUse, true, 'held by a session');
  assert.equal(result.refused, 'E_VOICE_IN_USE');
  assert.equal(result.removed.freed, voice(result.listed).size);
  assert.deepEqual([voice(result.afterRemove).installed, voice(result.afterRemove).inUse], [false, false]);
  assert.ok(result.during?.installing, 'being downloaded');
  assert.deepEqual(result.cancelled, { cancelled: true });
  assert.equal(result.stoppedWith, 'AbortError');
  assert.deepEqual([result.afterCancel?.installed, result.afterCancel?.installing], [false, null]);
  assert.deepEqual(result.left, [], 'what the stopped download left is removed');
  assert.ok(result.storage.quota > 0);
  console.log(`${BROWSER}: a Worker's navigator.storage.persist is ${result.workerPersist}, a window's ${result.windowPersist}; the browser grants ${(result.storage.quota / 1e9).toFixed(1)} GB`);
});
