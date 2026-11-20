import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { findMediaTools } from '@elabora/node/media/index';
import { loadOrt } from '@elabora/node/voice/pocket/runtime';
import { loadWav2Vec2 } from '@elabora/node/align/wav2vec2';
import { wav2vec2Emissions } from '@elabora/core/align/wav2vec2';
import { alignEmissions } from '@elabora/core/align/align';
import type { Alignment } from '@elabora/core/align/align';
import { ALIGNER_MODELS } from '@elabora/core/align/models';
import { narrationLines } from '@elabora/core/narration/narration';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { bundleForBrowser } from '../browser-bundle.ts';
import { ROOT } from '../helpers.ts';

// The word aligner in a Worker of Chromium (D114): its model downloaded from the models' origin into
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
const english = ALIGNER_MODELS.find((model) => model.language === 'en')!;
const EXAMPLE = path.join(ROOT, 'examples/canal-locks');
const FRAME = 0.02;

let browser: Browser;
let page: Page;
const asked: string[] = [];

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
  assert.deepEqual(models.inputs.filter((input) => input.includes('onnxruntime')), [], 'onnxruntime-web is loaded by address, never bundled');
  browser = await launchBrowser('chromium');
  page = await browser.newPage();
  await page.route(`${MODELS_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const file = english.files.find((each) => url.pathname === `/${each.url}`);
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
    if (name === '/installer.js') return route.fulfill({ contentType: 'text/javascript', body: installer.code });
    if (name === '/models.js') return route.fulfill({ contentType: 'text/javascript', body: models.code });
    if (name.startsWith('/ort/')) return route.fulfill({ contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: fs.readFileSync(path.join(ORT, path.basename(name))) });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>align</title>' });
  });
  page.on('pageerror', (error) => console.error('page:', error.message));
  await page.goto(`${ORIGIN}/`);
});

after(async () => { await browser?.close(); });

const inWorker = (script: string, message: unknown) => page.evaluate(([url, m]) => new Promise<Record<string, unknown>>((resolve) => {
  const worker = new Worker(url as string, { type: 'module' });
  worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
  worker.onerror = (event) => resolve({ error: event.message || 'the Worker did not load' });
  worker.postMessage(m);
}), [script, message] as unknown as [string, unknown]);

// The models Worker, as the engine's Worker speaks to it.
const align = (samples: Float32Array, text: string) => page.evaluate(async ([values, words]) => {
  const worker = new Worker('/models.js', { type: 'module' });
  worker.postMessage({ kind: 'init', init: { ort: '/ort/ort.wasm.min.mjs', wasm: '/ort/' } });
  const started = performance.now();
  const answer = await new Promise<{ alignment?: Alignment; error?: string }>((resolve) => {
    worker.onmessage = ({ data }) => resolve(data.answer);
    worker.onerror = (event) => resolve({ error: event.message || 'the Worker did not load' });
    worker.postMessage({ kind: 'ask', id: 1, ask: { op: 'align', model: (window as unknown as { model: unknown }).model, samples: new Float32Array(values as number[]), text: words, language: 'en' } });
  });
  worker.terminate();
  return { ...answer, ms: Math.round(performance.now() - started) };
}, [Array.from(samples), text] as unknown as [number[], string]);

test('the word aligner in a Worker of Chromium: downloaded, kept, then the desktop\'s words within a frame', { timeout: 600_000 }, async (t) => {
  if (!MODELS) return t.skip('ELABORA_ALIGNER_TEST_MODELS names no folder of the English aligner\'s files');
  const tools = await findMediaTools();
  await page.evaluate((model) => { (window as unknown as { model: unknown }).model = model; }, english as unknown as object);
  // Downloaded from the models' origin, checked, kept; asked again, nothing is downloaded.
  const installed = await inWorker('/installer.js', { op: 'install', model: english, base: MODELS_ORIGIN });
  assert.equal(installed.installed, true, `${String(installed.error)}; asked: ${asked.join(', ')}`);
  const downloads = asked.length;
  assert.equal((await inWorker('/installer.js', { op: 'install', model: english, base: MODELS_ORIGIN })).installed, true);
  assert.equal(asked.length, downloads, 'kept: not downloaded again');

  const project = loadProjectFromDir(EXAMPLE);
  const screen = [...project.screens.keys()].find((id) => narrationLines(project, id, 'en')?.some((line) => line.audio && line.text))!;
  const lines = narrationLines(project, screen, 'en')!.filter((line) => line.audio && line.text).slice(0, 2);
  const ort = await loadOrt();
  const native = await loadWav2Vec2(ort, path.join(MODELS, 'model.onnx'), path.join(MODELS, 'vocab.json'));
  for (const line of lines) {
    const { stdout } = await run(tools.ffmpeg, ['-v', 'error', '-i', path.join(EXAMPLE, line.audio), '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
    const samples = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length / 4).slice();
    const desktop = alignEmissions(await wav2vec2Emissions(native, samples), line.text!, 'en', native, { startShift: english.startShift, endShift: english.endShift });
    const here = await align(samples, line.text!);
    assert.ok(here.alignment, here.error);
    assert.equal(here.alignment.words.length, desktop.words.length, line.id);
    const gaps = here.alignment.words.flatMap((word, i) => [Math.abs(word.start - desktop.words[i]!.start), Math.abs(word.end - desktop.words[i]!.end)]);
    const worst = Math.max(...gaps);
    assert.ok(worst <= FRAME + 1e-9, `${line.id}: ${worst * 1000} ms at worst`);
    t.diagnostic(`${line.id}: ${desktop.words.length} words, ${(gaps.reduce((s, g) => s + g, 0) / gaps.length * 1000).toFixed(1)} ms apart on average, ${Math.round(worst * 1000)} ms at worst; ${here.ms} ms for ${desktop.duration} s of audio, one thread`);
  }

  // Erased by the browser: missing, then downloaded again without an error.
  assert.equal((await inWorker('/installer.js', { op: 'remove', model: english })).removed, true);
  assert.equal((await inWorker('/installer.js', { op: 'installed', model: english })).installed, false);
  assert.equal((await inWorker('/installer.js', { op: 'install', model: english, base: MODELS_ORIGIN })).installed, true);
});
