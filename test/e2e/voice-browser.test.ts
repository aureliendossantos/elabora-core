import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { findMediaTools } from '@elabora/node/media/index';
import { loadOrt, PocketModel, readEmbeddings } from '@elabora/node/voice/pocket/runtime';
import { loadWav2Vec2 } from '@elabora/node/align/wav2vec2';
import { wav2vec2Emissions } from '@elabora/core/align/wav2vec2';
import { alignEmissions } from '@elabora/core/align/align';
import { spokenWords } from '@elabora/core/align/spoken';
import { ALIGNER_MODELS } from '@elabora/core/align/models';
import { bundleFor, DEFAULT_TEMPERATURE } from '@elabora/core/voice/pocket/models';
import { withoutDirections } from '@elabora/core/narration/directions';
import { narrationLines } from '@elabora/core/narration/narration';
import { loadProjectFromDir, readProjectFiles } from '@elabora/node/project-reader';
import { bundleForBrowser } from '../browser-bundle.ts';
import { aacEncoderModule } from '@elabora/engine/aac-encoder';
import { wavBytes } from '@elabora/core/voice/wav';
import { ROOT } from '../helpers.ts';

// A local voice in a browser's session (D25, D114): Pocket TTS's English model downloaded from the
// models' origin into the origin's private file system, a speaker's voice set, a line said in the
// models Worker by onnxruntime-web, its take kept and its audio written; the take judged by the
// desktop's word aligner (every word said, none swallowed, as the native voice's takes score); the
// model erased by the browser, then downloaded again as the next line is said, without an error.
// ELABORA_VOICE_TEST_MODELS names a folder holding the English model's files (126 MB) and
// ELABORA_ALIGNER_TEST_MODELS the English aligner's (95 MB), both from the models' mirror (D57);
// without them, the test is skipped.

const run = promisify(execFile);
const VOICE = process.env.ELABORA_VOICE_TEST_MODELS;
const ALIGNER = process.env.ELABORA_ALIGNER_TEST_MODELS;
const ORIGIN = 'https://app.elabora.test';
const MODELS_ORIGIN = 'https://models.elabora.test';
const ORT = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
const VOICES = path.join(ROOT, 'packages/node/voices/pocket-tts');
const EXAMPLE = path.join(ROOT, 'examples/canal-locks');
const bundle = bundleFor('en')!;
const english = ALIGNER_MODELS.find((model) => model.language === 'en')!;
const exampleFiles = readProjectFiles(EXAMPLE).files;
const exampleMedia = new Map([...exampleFiles].flatMap(([rel, file]) => (file.kind === 'binary' && file.hash ? [[file.hash, fs.readFileSync(path.join(EXAMPLE, rel))] as [string, Buffer]] : [])));

let browser: Browser;
let page: Page;
const asked: string[] = [];

before(async () => {
  if (!VOICE || !ALIGNER) return;
  const models = await bundleForBrowser({ file: 'packages/engine/src/browser/models/worker.ts' });
  const media = await bundleForBrowser({ file: 'packages/engine/src/browser/media/worker.ts' });
  const engine = await bundleForBrowser({ source: `import { provideMedia } from './packages/engine/src/browser/worker.ts';
provideMedia(async (hash) => { const response = await fetch('/example-media/' + hash); return response.ok ? response.blob() : null; });` });
  // This Chromium (Linux) has no AAC encoder: Mediabunny's, as the media tests give it (D107).
  const aac = await aacEncoderModule();
  browser = await launchBrowser('chromium');
  page = await browser.newPage();
  // The models' origin, in ranges as R2 and the mirror serve them.
  await page.route(`${MODELS_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const file = bundle.files.find((each) => url.pathname === `/${each.url}`);
    const range = /^bytes=(\d+)-(\d+)?$/.exec(route.request().headers().range ?? '');
    asked.push(`${url.pathname.split('/').pop()} ${range ? range[0] : 'whole'}`);
    const headers = { 'access-control-allow-origin': ORIGIN, 'access-control-expose-headers': 'content-range', 'content-type': 'application/octet-stream' };
    if (!file) return route.fulfill({ status: 404, headers, body: '' });
    const whole = path.join(VOICE!, file.name);
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
    const scripts: Record<string, string> = { '/models.js': models.code, '/media.js': media.code, '/engine.js': engine.code, '/aac.js': aac };
    if (scripts[name]) return route.fulfill({ contentType: 'text/javascript', body: scripts[name] });
    if (name.startsWith('/voices/')) {
      const file = path.join(VOICES, name.slice('/voices/'.length));
      return fs.existsSync(file) ? route.fulfill({ contentType: 'application/octet-stream', body: fs.readFileSync(file) }) : route.fulfill({ status: 404, body: '' });
    }
    if (name.startsWith('/example-media/')) {
      const bytes = exampleMedia.get(name.slice('/example-media/'.length));
      return bytes ? route.fulfill({ contentType: 'application/octet-stream', body: bytes }) : route.fulfill({ status: 404, body: '' });
    }
    if (name.startsWith('/ort/')) return route.fulfill({ contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: fs.readFileSync(path.join(ORT, path.basename(name))) });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>voices</title>' });
  });
  page.on('pageerror', (error) => console.error('page:', error.message));
  await page.goto(`${ORIGIN}/`);
});

after(async () => { await browser?.close(); });

test('a local voice in a browser\'s session: its model downloaded and kept, a line said and written, the take saying every word; erased, downloaded again', { timeout: 900_000 }, async (t) => {
  if (!VOICE || !ALIGNER) return t.skip('ELABORA_VOICE_TEST_MODELS and ELABORA_ALIGNER_TEST_MODELS name no folders of the English voice\'s and aligner\'s files');
  const project = loadProjectFromDir(EXAMPLE);
  const screen = [...project.screens.keys()].find((id) => (narrationLines(project, id, 'en')?.filter((line) => line.text).length ?? 0) >= 2)!;
  const lines = narrationLines(project, screen, 'en')!.filter((line) => line.text).slice(0, 2);
  const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };
  const result = await page.evaluate(async ([seed, screenId, ids, base, speaker, folder]) => {
    // A Worker a Worker starts does not go through the test's routes: the page gives its scripts by blob addresses.
    const blob = async (url: string, type = 'text/javascript') => URL.createObjectURL(new Blob([await (await fetch(url)).arrayBuffer()], { type }));
    const open = {
      kind: 'open', team: 'tm_test', project: 'voiced', seed, api: 'http://localhost:1', offline: true, services: ['media', 'voices'],
      mediaWorker: await blob('/media.js'), aacEncoder: await blob('/aac.js'), modelsWorker: await blob('/models.js'), ort: await blob('/ort/ort.wasm.min.mjs'),
      ortWasm: { mjs: await blob('/ort/ort-wasm-simd-threaded.mjs'), wasm: await blob('/ort/ort-wasm-simd-threaded.wasm', 'application/wasm') }, models: base, voices: '/voices/'
    };
    const w = new Worker('/engine.js', { type: 'module' });
    const progress: string[] = [];
    const answers = new Map<string, (data: { ok: boolean; result?: unknown; error?: { message: string; code?: string } }) => void>();
    w.onmessage = ({ data }) => {
      if (data.kind === 'response') answers.get(data.id)?.(data);
      if (data.kind === 'event' && data.event.type === 'voiceProgress') progress.push(data.event.progress.phase);
    };
    const ask = (type: string, params: unknown) => new Promise<{ ok: boolean; result?: unknown; error?: { message: string; code?: string } }>((resolve) => { const id = `${type}${Math.random()}`; answers.set(id, resolve); w.postMessage({ kind: 'request', id, type, params }); });
    await new Promise((resolve) => { const first = (event: MessageEvent) => { if (event.data.kind === 'opened' || event.data.kind === 'failed') { w.removeEventListener('message', first); resolve(event.data); } }; w.addEventListener('message', first); w.postMessage(open); });
    const take = async (file: string) => {
      const parts = file.slice('opfs:'.length).split('/');
      let dir = await navigator.storage.getDirectory();
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return Array.from(new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).arrayBuffer()));
    };
    const before = await ask('voices', { language: 'en' });
    const installed = await ask('installVoices', { language: 'en' });
    const set = await ask('setSpeakerVoice', { speaker, voice: 'grace', provider: 'pocket-tts', language: 'en' });
    const started = performance.now();
    const first = await ask('generateVoice', { screen: screenId, lines: [ids[0]] });
    const ms = performance.now() - started;
    const takes = await ask('voiceTakes', { screen: screenId, line: ids[0] });
    const last = (takes.result as { takes: { file: string; seed: number }[] } | undefined)?.takes.at(-1);
    if (!last) return { before, installed, set, first, takes, failed: true };
    const said = await take(last.file);
    // The browser erases the model: the next line downloads it again first.
    await (await (await navigator.storage.getDirectory()).getDirectoryHandle('elabora-models')).removeEntry(folder as string, { recursive: true });
    const second = await ask('generateVoice', { screen: screenId, lines: [ids[1]] });
    // Each line's audio is now its take.
    const current = [];
    for (const id of ids as string[]) current.push(((await ask('voiceTakes', { screen: screenId, line: id })).result as { takes: { current: boolean }[] }).takes.some((one) => one.current));
    return { before, installed, set, first, second, current, said, seed: last.seed, ms, progress };
  }, [{ link, confirmed: [...exampleFiles] }, screen, lines.map((line) => line.id), MODELS_ORIGIN, lines[0]!.speaker, `${bundle.id}@${bundle.version}`] as unknown as [object, string, string[], string, string, string]);

  assert.ok(!('failed' in result), JSON.stringify({ installed: result.installed, set: result.set, first: result.first, takes: (result as { takes?: unknown }).takes }).slice(0, 3000));
  const grace = (result.before.result as { id: string; installed: boolean; size: number }[] | undefined)?.find((voice) => voice.id === 'grace');
  assert.ok(grace && !grace.installed && grace.size > 100e6, JSON.stringify(result.before));
  assert.deepEqual(result.installed.result, { language: 'en', installed: true }, JSON.stringify(result.installed.error));
  assert.ok(result.set.ok, JSON.stringify(result.set.error));
  assert.ok(result.first.ok, JSON.stringify(result.first.error));
  assert.deepEqual((result.first.result as { lines: { status: string }[] }).lines.map((line) => line.status), ['generated']);
  assert.ok(result.second.ok, JSON.stringify(result.second.error));
  assert.deepEqual((result.second.result as { lines: { status: string }[] }).lines.map((line) => line.status), ['generated']);
  // Each file asked from its start twice: downloaded, then again once the browser erased it.
  assert.deepEqual(bundle.files.map((file) => asked.filter((one) => one === `${file.url.split('/').pop()} bytes=0-${Math.min(file.size, 16 * 1024 * 1024) - 1}`).length), bundle.files.map(() => 2), asked.join(', '));
  assert.deepEqual(result.current, [true, true], 'each line\'s audio is its take');

  // The take, heard by the desktop's aligner: every word of the line, none swallowed, and its words as
  // sure as those of the desktop's take of the same seed.
  const tools = await findMediaTools();
  const native = await loadWav2Vec2(await loadOrt(), path.join(ALIGNER, 'model.onnx'), path.join(ALIGNER, 'vocab.json'));
  const text = lines[0]!.text!;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-voice-browser-'));
  const heard = async (wav: Uint8Array) => {
    fs.writeFileSync(path.join(temp, 'take.wav'), wav);
    const { stdout } = await run(tools.ffmpeg, ['-v', 'error', '-i', path.join(temp, 'take.wav'), '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
    const samples = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length / 4).slice();
    const { words } = alignEmissions(await wav2vec2Emissions(native, samples), text, 'en', native, { startShift: english.startShift, endShift: english.endShift });
    const scores = words.map((word) => word.score ?? 0);
    return { words, seconds: samples.length / 16000, mean: scores.reduce((sum, score) => sum + score, 0) / scores.length, lowest: Math.min(...scores) };
  };
  try {
    const here = await heard(Uint8Array.from(result.said));
    const model = await PocketModel.load(VOICE);
    const voice = await model.voiceState(readEmbeddings(path.join(VOICES, 'english_2026-04/grace.f16')));
    const desktop = await model.synthesize(withoutDirections(text), voice, { temperature: DEFAULT_TEMPERATURE, seed: result.seed, rules: { replaceCharacters: {}, removeSemicolons: model.meta.remove_semicolons, padWithSpacesForShortInputs: model.meta.pad_with_spaces_for_short_inputs } });
    await model.release();
    const there = await heard(wavBytes(desktop, model.sampleRate));
    assert.equal(here.words.length, spokenWords(text, 'en').length);
    assert.deepEqual(here.words.filter((word) => (word.score ?? 0) < 0.25 && word.text.length > 1).map((word) => word.text), [], 'no word swallowed');
    assert.ok(here.mean >= there.mean - 0.1, `mean score ${here.mean.toFixed(2)}, the desktop's take ${there.mean.toFixed(2)}`);
    t.diagnostic(`${lines[0]!.id}: « ${text} », ${here.seconds.toFixed(2)} s said in ${(result.ms / 1000).toFixed(1)} s (download, model and voice loaded included); ${here.words.length} words heard, mean score ${here.mean.toFixed(2)} (lowest ${here.lowest.toFixed(2)}); the desktop's take of the same seed ${there.seconds.toFixed(2)} s, ${there.mean.toFixed(2)} (lowest ${there.lowest.toFixed(2)})`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  t.diagnostic(`progress: ${[...new Set(result.progress)].join(', ')}`);
});
