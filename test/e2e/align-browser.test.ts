import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';
import { findMediaTools } from '@elabora/node/media/index';
import type { Alignment } from '@elabora/core/align/align';
import { ALIGNER_MODELS } from '@elabora/core/align/models';
import { narrationLines } from '@elabora/core/narration/narration';
import { loadProjectFromDir, readProjectFiles } from '@elabora/node/project-reader';
import { bundleForBrowser } from '../browser-bundle.ts';
import { emptyStorage, ISOLATED, pageWithStorage, watchMemory } from '../browser-page.ts';
import { desktopAlignment } from '../native-models.ts';
import { ROOT } from '../helpers.ts';

// The word aligner in a browser's Worker (D114, ELABORA_BROWSER: chromium, firefox or webkit), the page isolated as the app's host serves it (C105): its model downloaded from the models' origin into
// the origin's private file system (store.ts) and timing an English line with onnxruntime-web, against
// the desktop's (onnxruntime-node, the same core code): every word's start and end within a frame
// (20 ms). ELABORA_ALIGNER_TEST_MODELS names a folder holding the English model's files (95 MB,
// downloaded once from the models' mirror, D57); without it, the test is skipped.

const run = promisify(execFile);
const MODELS = process.env.ELABORA_ALIGNER_TEST_MODELS;
const ORIGIN = 'https://app.elabora.test';
// The models' origin, as the host would name one (C110), served by the test in ranges as R2 and the
// mirror serve them.
const MODELS_ORIGIN = 'https://models.elabora.test';
const ORT = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
// ELABORA_MODELS_LANGUAGE: the language of the model and of the lines (en by default, fr).
const LANGUAGE = process.env.ELABORA_MODELS_LANGUAGE ?? 'en';
const aligner = ALIGNER_MODELS.find((model) => model.language === LANGUAGE)!;
const EXAMPLE = path.join(ROOT, 'examples/canal-locks');
// A frame of the model (20 ms), the times being rounded to the millisecond on both sides.
const FRAME = 0.02 + 0.001;
const exampleFiles = readProjectFiles(EXAMPLE).files;
const exampleMedia = new Map([...exampleFiles].flatMap(([rel, file]) => (file.kind === 'binary' && file.hash ? [[file.hash, fs.readFileSync(path.join(EXAMPLE, rel))] as [string, Buffer]] : [])));

const BROWSER = process.env.ELABORA_BROWSER ?? 'chromium';
let browser: Awaited<ReturnType<typeof pageWithStorage>> | undefined;
let page: Page;
const asked: string[] = [];
// What onnxruntime-web writes to the console: its errors only (the models Worker sets its log level).
const runtimeSaid: string[] = [];

before(async () => {
  if (!MODELS) return;
  const installer = await bundleForBrowser({ source: `import { installModel, modelInstalled, removeModel } from './packages/engine/src/browser/models/store.ts';
self.onmessage = async ({ data }) => {
  try {
    if (data.op === 'remove') return self.postMessage({ removed: await removeModel(data.model) });
    if (data.op === 'installed') return self.postMessage({ installed: await modelInstalled(data.model) });
    let last = 0;
    await installModel(data.model, data.base, { onProgress: ({ received }) => { last = received; } });
    self.postMessage({ installed: await modelInstalled(data.model), received: last });
  } catch (error) { self.postMessage({ error: String(error && error.message || error), code: error && error.code }); }
};` });
  const models = await bundleForBrowser({ file: 'packages/engine/src/browser/models/worker.ts' });
  const media = await bundleForBrowser({ file: 'packages/engine/src/browser/media/worker.ts' });
  // The app's engine Worker for an example opened offline: its media given by hash (provideMedia).
  const engine = await bundleForBrowser({ source: `import { provideMedia } from './packages/engine/src/browser/worker.ts';
provideMedia(async (hash) => { const response = await fetch('/example-media/' + hash); return response.ok ? response.blob() : null; });` });
  assert.deepEqual(models.inputs.filter((input) => input.includes('onnxruntime')), [], 'onnxruntime-web is loaded by address, never bundled');
  browser = await pageWithStorage(BROWSER);
  ({ page } = browser);
  await page.route(`${MODELS_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const file = aligner.files.find((each) => url.pathname === `/${each.url}`);
    const range = /^bytes=(\d+)-(\d+)?$/.exec(route.request().headers().range ?? '');
    asked.push(`${url.pathname.split('/').pop()} ${range ? range[0] : 'whole'}`);
    const headers = { 'access-control-allow-origin': ORIGIN, 'access-control-expose-headers': 'content-range', 'content-type': 'application/octet-stream' };
    if (!file) return route.fulfill({ status: 404, headers, body: '' });
    const whole = path.join(MODELS!, file.name);
    const size = fs.statSync(whole).size;
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    const handle = fs.openSync(whole, 'r');
    const body = Buffer.alloc(end - start + 1);
    fs.readSync(handle, body, 0, body.length, start);
    fs.closeSync(handle);
    return route.fulfill({ status: range ? 206 : 200, headers: { ...headers, ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) }, body });
  });
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname;
    if (name === '/installer.js') return route.fulfill({ headers: ISOLATED, contentType: 'text/javascript', body: installer.code });
    if (name === '/models.js') return route.fulfill({ headers: ISOLATED, contentType: 'text/javascript', body: models.code });
    if (name === '/media.js') return route.fulfill({ headers: ISOLATED, contentType: 'text/javascript', body: media.code });
    if (name === '/engine.js') return route.fulfill({ headers: ISOLATED, contentType: 'text/javascript', body: engine.code });
    if (name.startsWith('/example-media/')) {
      const bytes = exampleMedia.get(name.slice('/example-media/'.length));
      return bytes ? route.fulfill({ headers: ISOLATED, contentType: 'application/octet-stream', body: bytes }) : route.fulfill({ status: 404, body: '' });
    }
    if (name.startsWith('/ort/')) return route.fulfill({ headers: ISOLATED, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: fs.readFileSync(path.join(ORT, path.basename(name))) });
    return route.fulfill({ headers: ISOLATED, contentType: 'text/html', body: '<!doctype html><title>align</title>' });
  });
  page.on('pageerror', (error) => console.error('page:', error.message));
  page.on('console', (message) => { if (/onnxruntime/i.test(message.text())) runtimeSaid.push(message.text()); });
  await page.goto(`${ORIGIN}/`);
  await emptyStorage(page);
});

after(async () => { await browser?.close(); });

const inWorker = (script: string, message: unknown) => page.evaluate(([url, m]) => new Promise<Record<string, unknown>>((resolve) => {
  const worker = new Worker(url as string, { type: 'module' });
  worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
  worker.onerror = (event) => resolve({ error: event.message || 'the Worker did not load' });
  worker.postMessage(m);
}), [script, message] as unknown as [string, unknown]);

// The models Worker, as the engine's Worker speaks to it.
const align = (samples: Float32Array, text: string) => page.evaluate(async ([values, words, language]) => {
  // The runtime's threads are Workers its Worker starts, which do not go through the test's routes: blob addresses.
  const blob = async (url: string, type = 'text/javascript') => URL.createObjectURL(new Blob([await (await fetch(url)).arrayBuffer()], { type }));
  const wasm = { mjs: await blob('/ort/ort-wasm-simd-threaded.mjs'), wasm: await blob('/ort/ort-wasm-simd-threaded.wasm', 'application/wasm') };
  const worker = new Worker('/models.js', { type: 'module' });
  worker.postMessage({ kind: 'init', init: { ort: '/ort/ort.wasm.min.mjs', wasm } });
  const ask = (id: number) => new Promise<{ alignment?: Alignment; error?: string }>((resolve) => {
    worker.onmessage = ({ data }) => resolve(data.answer);
    worker.onerror = (event) => resolve({ error: event.message || 'the Worker did not load' });
    worker.postMessage({ kind: 'ask', id, ask: { op: 'align', model: (window as unknown as { model: unknown }).model, samples: new Float32Array(values as number[]), text: words, language } });
  });
  // Timed twice: the first with the runtime and the model loaded, the second the alignment alone.
  const started = performance.now();
  const answer = await ask(1);
  const ms = Math.round(performance.now() - started);
  const again = performance.now();
  await ask(2);
  const warm = Math.round(performance.now() - again);
  worker.terminate();
  // The threads the models Worker takes (threadsHere).
  const threads = crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1;
  return { ...answer, ms, warm, threads };
}, [Array.from(samples), text, LANGUAGE] as unknown as [number[], string, string]);

test(`the word aligner in a Worker of ${BROWSER}: downloaded, kept, then the desktop's words within a frame`, { timeout: 600_000 }, async (t) => {
  if (!MODELS) return t.skip('ELABORA_ALIGNER_TEST_MODELS names no folder of the English aligner\'s files');
  const tools = await findMediaTools();
  await page.evaluate((model) => { (window as unknown as { model: unknown }).model = model; }, aligner as unknown as object);
  // Downloaded from the models' origin, checked, kept; asked again, nothing is downloaded.
  const installed = await inWorker('/installer.js', { op: 'install', model: aligner, base: MODELS_ORIGIN });
  assert.equal(installed.installed, true, `${String(installed.error)}; asked: ${asked.join(', ')}`);
  const downloads = asked.length;
  assert.equal((await inWorker('/installer.js', { op: 'install', model: aligner, base: MODELS_ORIGIN })).installed, true);
  assert.equal(asked.length, downloads, 'kept: not downloaded again');
  const granted = await page.evaluate(async () => ({ ...(await navigator.storage.estimate()), persisted: await navigator.storage.persisted() }));
  t.diagnostic(`${LANGUAGE}: the origin uses ${((granted.usage ?? 0) / 1e6).toFixed(0)} MB of the ${((granted.quota ?? 0) / 1e9).toFixed(1)} GB the browser grants it (kept for good: ${granted.persisted})`);

  const project = loadProjectFromDir(EXAMPLE);
  const screen = [...project.screens.keys()].find((id) => narrationLines(project, id, LANGUAGE)?.some((line) => line.audio && line.text))!;
  const lines = narrationLines(project, screen, LANGUAGE)!.filter((line) => line.audio && line.text).slice(0, 2);
  for (const line of lines) {
    const { stdout } = await run(tools.ffmpeg, ['-v', 'error', '-i', path.join(EXAMPLE, line.audio), '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
    const samples = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length / 4).slice();
    const { alignment: desktop, ms: desktopMs } = await desktopAlignment(MODELS, samples, line.text!, LANGUAGE, aligner);
    const watch = watchMemory();
    const here = await align(samples, line.text!);
    const peak = watch.stop();
    assert.ok(here.alignment, here.error);
    assert.equal(here.alignment.words.length, desktop.words.length, line.id);
    const gaps = here.alignment.words.flatMap((word, i) => [Math.abs(word.start - desktop.words[i]!.start), Math.abs(word.end - desktop.words[i]!.end)]);
    const worst = Math.max(...gaps);
    assert.ok(worst <= FRAME + 1e-9, `${line.id}: ${worst * 1000} ms at worst`);
    t.diagnostic(`${line.id}: ${desktop.words.length} words, ${(gaps.reduce((s, g) => s + g, 0) / gaps.length * 1000).toFixed(1)} ms apart on average, ${Math.round(worst * 1000)} ms at worst; ${here.warm} ms for ${desktop.duration} s of audio on ${here.threads} thread(s) (${here.ms} ms with the runtime and the model loaded), the desktop's ${desktopMs} ms; the browser's memory at its peak ${peak} MB (its processes' RSS)`);
  }

  // Erased by the browser: missing, then downloaded again without an error.
  assert.equal((await inWorker('/installer.js', { op: 'remove', model: aligner })).removed, true);
  assert.equal((await inWorker('/installer.js', { op: 'installed', model: aligner })).installed, false);
  assert.equal((await inWorker('/installer.js', { op: 'install', model: aligner, base: MODELS_ORIGIN })).installed, true);
});

// The session's align service, as the window asks it: the example's lines timed in the engine's Worker,
// their words written by set_narration_words, the desktop's words within a frame.
test('the align service of a browser\'s session: a screen\'s lines timed, the desktop\'s words within a frame', { timeout: 600_000 }, async (t) => {
  if (!MODELS) return t.skip('ELABORA_ALIGNER_TEST_MODELS names no folder of the English aligner\'s files');
  const tools = await findMediaTools();
  const project = loadProjectFromDir(EXAMPLE);
  const screen = [...project.screens.keys()].find((id) => narrationLines(project, id, LANGUAGE)?.some((line) => line.audio && line.text))!;
  const lines = narrationLines(project, screen, LANGUAGE)!.filter((line) => line.audio && line.text).slice(0, 2);
  const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };
  const result = await page.evaluate(async ([seed, screenId, ids, base, paths, language]) => {
    // A Worker a Worker starts does not go through the test's routes: the page gives its scripts by blob addresses.
    const blob = async (url: string, type = 'text/javascript') => URL.createObjectURL(new Blob([await (await fetch(url)).arrayBuffer()], { type }));
    const open = {
      kind: 'open', team: 'tm_test', project: 'aligned', seed, api: 'http://localhost:1', offline: true, services: ['media', 'align'],
      mediaWorker: await blob('/media.js'), modelsWorker: await blob('/models.js'), ort: await blob('/ort/ort.wasm.min.mjs'),
      ortWasm: { mjs: await blob('/ort/ort-wasm-simd-threaded.mjs'), wasm: await blob('/ort/ort-wasm-simd-threaded.wasm', 'application/wasm') }, models: base
    };
    const w = new Worker('/engine.js', { type: 'module' });
    const progress: string[] = [];
    const answers = new Map<string, (data: { ok: boolean; result?: unknown; error?: { message: string } }) => void>();
    w.onmessage = ({ data }) => {
      if (data.kind === 'response') answers.get(data.id)?.(data);
      if (data.kind === 'event' && data.event.type === 'alignProgress') progress.push(data.event.progress.phase);
    };
    const ask = (type: string, params: unknown) => new Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>((resolve) => { const id = `${type}${Math.random()}`; answers.set(id, resolve); w.postMessage({ kind: 'request', id, type, params }); });
    await new Promise((resolve) => { const first = (event: MessageEvent) => { if (event.data.kind === 'opened' || event.data.kind === 'failed') { w.removeEventListener('message', first); resolve(event.data); } }; w.addEventListener('message', first); w.postMessage(open); });
    const aligners = await ask('aligners', { language });
    const aligned = await ask('alignNarration', { screen: screenId, lines: ids, language, force: true });
    const sidecars = [];
    for (const sidecar of paths as string[]) sidecars.push(await ask('readFile', { path: sidecar }));
    return { aligners, aligned, sidecars, progress };
  }, [{ link, confirmed: [...exampleFiles] }, screen, lines.map((line) => line.id), MODELS_ORIGIN, lines.map((line) => line.sidecar), LANGUAGE] as unknown as [object, string, string[], string, string[], string]);
  assert.ok(result.aligned.ok, JSON.stringify(result.aligned.error));
  const aligned = result.aligned.result as { lines: { line: string; status: string }[]; changes: number[] };
  assert.deepEqual(aligned.lines.map((line) => line.status), lines.map(() => 'aligned'), JSON.stringify(aligned.lines));
  assert.equal(aligned.changes.length, lines.length, 'one change a line');
  for (const [i, line] of lines.entries()) {
    const { stdout } = await run(tools.ffmpeg, ['-v', 'error', '-i', path.join(EXAMPLE, line.audio), '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
    const { alignment: desktop } = await desktopAlignment(MODELS, new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length / 4).slice(), line.text!, LANGUAGE, aligner);
    const read = (result.sidecars as { result?: { text?: string } }[])[i]?.result;
    const sidecar = JSON.parse(read?.text ?? '{}') as { words?: { start: number; end: number }[]; aligner?: string };
    assert.equal(sidecar.aligner, aligner.model, `${line.id}: its aligner`);
    const words = sidecar.words ?? [];
    assert.equal(words.length, desktop.words.length, line.id);
    const worst = Math.max(...words.flatMap((word, i) => [Math.abs(word.start - desktop.words[i]!.start), Math.abs(word.end - desktop.words[i]!.end)]));
    // The session reads its samples with its own resampler, the desktop with ffmpeg's: a word's edge lies
    // on the model's frames, and the desktop's aligner itself moves an edge by a frame between the two
    // (nell2: « heaving » and « inch », 20 ms). Within two frames.
    assert.ok(worst <= 2 * FRAME + 1e-9, `${line.id}: ${worst * 1000} ms at worst`);
    t.diagnostic(`${line.id}: ${words.length} words written, ${Math.round(worst * 1000)} ms from the desktop's at worst`);
  }
  t.diagnostic(`progress: ${[...new Set(result.progress)].join(', ')}`);
  assert.deepEqual(runtimeSaid, [], 'onnxruntime-web said nothing but its errors (not « Unknown CPU vendor » under macOS)');
});

