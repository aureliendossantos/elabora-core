import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';
import { findMediaTools } from '@elabora/node/media/index';
import { spokenWords } from '@elabora/core/align/spoken';
import { ALIGNER_MODELS } from '@elabora/core/align/models';
import { bundleFor } from '@elabora/core/voice/pocket/models';
import { narrationLines } from '@elabora/core/narration/narration';
import { loadProjectFromDir, readProjectFiles } from '@elabora/node/project-reader';
import { bundleForBrowser } from '../browser-bundle.ts';
import { emptyStorage, ISOLATED, pageWithStorage, watchMemory } from '../browser-page.ts';
import { desktopAlignment, desktopTake } from '../native-models.ts';
import { aacEncoderModule } from '@elabora/engine/aac-encoder';
import { ROOT } from '../helpers.ts';

// A local voice in a browser's session (D25, D114; ELABORA_BROWSER: chromium, firefox or webkit, the page isolated as the app's host serves it, C105): Pocket TTS's English model downloaded from the
// models' origin into the origin's private file system, a speaker's voice set, a line said in the
// models Worker by onnxruntime-web, its take kept and its audio written; the take judged by the
// desktop's word aligner (every word said, none swallowed, as the native voice's takes score); the
// model erased by the browser, then downloaded again as the next line is said, without an error.
// ELABORA_MODELS_LANGUAGE says the language (en by default, fr); ELABORA_VOICE_TEST_MODELS names a
// folder holding that language's voice model (English 126 MB, French 338 MB) and
// ELABORA_ALIGNER_TEST_MODELS its aligner's (95 MB, 339 MB), both from the models' mirror (D57);
// without them, the test is skipped. It says what the browser grants the origin and the browser's
// memory at its peak.

const run = promisify(execFile);
const VOICE = process.env.ELABORA_VOICE_TEST_MODELS;
const ALIGNER = process.env.ELABORA_ALIGNER_TEST_MODELS;
const ORIGIN = 'https://app.elabora.test';
const MODELS_ORIGIN = 'https://models.elabora.test';
const ORT = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
const VOICES = path.join(ROOT, 'packages/node/voices/pocket-tts');
const EXAMPLE = path.join(ROOT, 'examples/canal-locks');
const LANGUAGE = process.env.ELABORA_MODELS_LANGUAGE ?? 'en';
const bundle = bundleFor(LANGUAGE)!;
const aligner = ALIGNER_MODELS.find((model) => model.language === LANGUAGE)!;
// The language's first voice of the catalogue (packages/node/voices/pocket-tts/voices.json).
const voice = (JSON.parse(fs.readFileSync(path.join(VOICES, 'voices.json'), 'utf8')) as { voices: { id: string; language: string; file: string }[] }).voices.find((one) => one.language === LANGUAGE)!;
const exampleFiles = readProjectFiles(EXAMPLE).files;
const exampleMedia = new Map([...exampleFiles].flatMap(([rel, file]) => (file.kind === 'binary' && file.hash ? [[file.hash, fs.readFileSync(path.join(EXAMPLE, rel))] as [string, Buffer]] : [])));

const BROWSER = process.env.ELABORA_BROWSER ?? 'chromium';
let browser: Awaited<ReturnType<typeof pageWithStorage>> | undefined;
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
  browser = await pageWithStorage(BROWSER);
  ({ page } = browser);
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
    if (scripts[name]) return route.fulfill({ headers: ISOLATED, contentType: 'text/javascript', body: scripts[name] });
    if (name.startsWith('/voices/')) {
      const file = path.join(VOICES, name.slice('/voices/'.length));
      return fs.existsSync(file) ? route.fulfill({ headers: ISOLATED, contentType: 'application/octet-stream', body: fs.readFileSync(file) }) : route.fulfill({ status: 404, body: '' });
    }
    if (name.startsWith('/example-media/')) {
      const bytes = exampleMedia.get(name.slice('/example-media/'.length));
      return bytes ? route.fulfill({ headers: ISOLATED, contentType: 'application/octet-stream', body: bytes }) : route.fulfill({ status: 404, body: '' });
    }
    if (name.startsWith('/ort/')) return route.fulfill({ headers: ISOLATED, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: fs.readFileSync(path.join(ORT, path.basename(name))) });
    return route.fulfill({ headers: ISOLATED, contentType: 'text/html', body: '<!doctype html><title>voices</title>' });
  });
  page.on('pageerror', (error) => console.error('page:', error.message));
  await page.goto(`${ORIGIN}/`);
  await emptyStorage(page);
});

after(async () => { await browser?.close(); });

test('a local voice in a browser\'s session: its model downloaded and kept, a line said and written, the take saying every word; erased, downloaded again', { timeout: 900_000 }, async (t) => {
  if (!VOICE || !ALIGNER) return t.skip('ELABORA_VOICE_TEST_MODELS and ELABORA_ALIGNER_TEST_MODELS name no folders of the English voice\'s and aligner\'s files');
  const project = loadProjectFromDir(EXAMPLE);
  const screen = [...project.screens.keys()].find((id) => (narrationLines(project, id, LANGUAGE)?.filter((line) => line.text).length ?? 0) >= 2)!;
  const lines = narrationLines(project, screen, LANGUAGE)!.filter((line) => line.text).slice(0, 2);
  const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };
  const memory = watchMemory();
  await page.exposeFunction('memoryPhase', (name: string) => memory.mark(name));
  const result = await page.evaluate(async ([seed, screenId, ids, base, speaker, folder, language, voiceId]) => {
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
    const before = await ask('voices', { language });
    const phase = (name: string) => (globalThis as unknown as { memoryPhase(name: string): Promise<void> }).memoryPhase(name);
    await phase('download');
    const installed = await ask('installVoices', { language });
    const granted = await navigator.storage.estimate();
    const set = await ask('setSpeakerVoice', { speaker, voice: voiceId, provider: 'pocket-tts', language });
    await phase('first line');
    const started = performance.now();
    const first = await ask('generateVoice', { screen: screenId, lines: [ids[0]], language });
    const ms = performance.now() - started;
    const takes = await ask('voiceTakes', { screen: screenId, line: ids[0], language });
    const last = (takes.result as { takes: { file: string; seed: number }[] } | undefined)?.takes.at(-1);
    if (!last) return { before, installed, set, first, takes, failed: true };
    const said = await take(last.file);
    // The browser erases the model: the next line downloads it again first.
    await (await (await navigator.storage.getDirectory()).getDirectoryHandle('elabora-models')).removeEntry(folder as string, { recursive: true });
    await phase('erased, second line');
    const again = performance.now();
    const second = await ask('generateVoice', { screen: screenId, lines: [ids[1]], language });
    const nextMs = performance.now() - again;
    // Each line's audio is now its take.
    const current = [];
    for (const id of ids as string[]) current.push(((await ask('voiceTakes', { screen: screenId, line: id, language })).result as { takes: { current: boolean }[] }).takes.some((one) => one.current));
    // The second line's take, heard like the first.
    const next = ((await ask('voiceTakes', { screen: screenId, line: ids[1], language })).result as { takes: { file: string; seed: number }[] }).takes.at(-1)!;
    const said2 = await take(next.file);
    // What the browser keeps once the lines are said: the model stays loaded for the next one.
    await phase('thirty seconds after');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    // A minute without a line: the models Worker is stopped, its memory given back (MODELS_IDLE_MS).
    await phase('stopped after a minute');
    await new Promise((resolve) => setTimeout(resolve, 45_000));
    // The next line starts it again: the runtime and the model loaded once more.
    await phase('a line once stopped');
    const restarted = performance.now();
    const third = await ask('generateVoice', { screen: screenId, lines: [ids[0]], language });
    const afterStopMs = performance.now() - restarted;
    // And the one after it, the model loaded: what the restart cost is told against.
    const warm = performance.now();
    await ask('generateVoice', { screen: screenId, lines: [ids[1]], language });
    const warmMs = performance.now() - warm;
    const threads = crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1;
    return { third, afterStopMs, warmMs, before, installed, set, first, second, current, said: [said, said2], seeds: [last.seed, next.seed], ms, nextMs, threads, progress, granted: { usage: granted.usage ?? 0, quota: granted.quota ?? 0, persisted: await navigator.storage.persisted() } };
  }, [{ link, confirmed: [...exampleFiles] }, screen, lines.map((line) => line.id), MODELS_ORIGIN, lines[0]!.speaker, `${bundle.id}@${bundle.version}`, LANGUAGE, voice.id] as unknown as [object, string, string[], string, string, string, string, string]);
  const peak = memory.stop();
  assert.deepEqual(((result as { third: { result?: { lines: { status: string }[] } } }).third.result)?.lines.map((line) => line.status), ['generated'], 'a line said once the models Worker stopped');
  const timed = result as { afterStopMs: number; warmMs: number };
  t.diagnostic(`a line once the models Worker stopped: ${(timed.afterStopMs / 1000).toFixed(1)} s, the runtime and the model loaded again; the next, the model loaded: ${(timed.warmMs / 1000).toFixed(1)} s`);
  t.diagnostic(`memory by phase (peak, median, end): ${memory.phases().map((one) => `${one.name} ${one.peak}, ${one.median}, ${one.end} MB`).join('; ')}`);

  assert.ok(!('failed' in result), JSON.stringify({ installed: result.installed, set: result.set, first: result.first, takes: (result as { takes?: unknown }).takes }).slice(0, 3000));
  const listed = (result.before.result as { id: string; installed: boolean; size: number }[] | undefined)?.find((one) => one.id === voice.id);
  assert.ok(listed && !listed.installed && listed.size > 100e6, JSON.stringify(result.before));
  assert.deepEqual(result.installed.result, { language: LANGUAGE, installed: true }, JSON.stringify(result.installed.error));
  t.diagnostic(`${LANGUAGE}, ${voice.id}: the origin uses ${(result.granted.usage / 1e6).toFixed(0)} MB of the ${(result.granted.quota / 1e9).toFixed(1)} GB the browser grants it (kept for good: ${result.granted.persisted}); the browser's memory at its peak ${peak} MB (its processes' RSS)`);
  assert.ok(result.set.ok, JSON.stringify(result.set.error));
  assert.ok(result.first.ok, JSON.stringify(result.first.error));
  assert.deepEqual((result.first.result as { lines: { status: string }[] }).lines.map((line) => line.status), ['generated']);
  assert.ok(result.second.ok, JSON.stringify(result.second.error));
  assert.deepEqual((result.second.result as { lines: { status: string }[] }).lines.map((line) => line.status), ['generated']);
  // Each file asked from its start twice: downloaded, then again once the browser erased it.
  assert.deepEqual(bundle.files.map((file) => asked.filter((one) => one === `${file.url.split('/').pop()} bytes=0-${Math.min(file.size, 16 * 1024 * 1024) - 1}`).length), bundle.files.map(() => 2), asked.join(', '));
  assert.deepEqual(result.current, [true, true], 'each line\'s audio is its take');

  // The take, heard by the desktop's aligner: every word of the line, none swallowed, and its words
  // heard surely.
  const tools = await findMediaTools();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-voice-browser-'));
  const heard = async (wav: Uint8Array, text: string) => {
    fs.writeFileSync(path.join(temp, 'take.wav'), wav);
    const { stdout } = await run(tools.ffmpeg, ['-v', 'error', '-i', path.join(temp, 'take.wav'), '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
    const samples = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length / 4).slice();
    const { words } = (await desktopAlignment(ALIGNER, samples, text, LANGUAGE, aligner)).alignment;
    const scores = words.map((word) => word.score ?? 0);
    return { words, seconds: samples.length / 16000, mean: scores.reduce((sum, score) => sum + score, 0) / scores.length, lowest: Math.min(...scores) };
  };
  try {
    for (const [i, line] of lines.entries()) {
      const text = line.text!;
      const here = await heard(Uint8Array.from(result.said[i]!), text);
      const desktop = await desktopTake(VOICE, path.join(VOICES, voice.file), text, result.seeds[i]!);
      const there = await heard(desktop.wav, text);
      const said = i === 0 ? `said in ${(result.ms / 1000).toFixed(1)} s on ${result.threads} thread(s) (download, model and voice loaded included)` : `said in ${(result.nextMs / 1000).toFixed(1)} s (the model downloaded again included)`;
      t.diagnostic(`${line.id}: « ${text} », ${here.seconds.toFixed(2)} s ${said}; ${here.words.length} words heard, mean score ${here.mean.toFixed(2)} (lowest ${here.lowest.toFixed(2)}); the desktop's take of the same seed ${there.seconds.toFixed(2)} s in ${(desktop.ms / 1000).toFixed(1)} s (its model loaded before), ${there.mean.toFixed(2)} (lowest ${there.lowest.toFixed(2)})`);
      t.diagnostic(`words: ${here.words.map((word) => `${word.text} ${(word.score ?? 0).toFixed(2)}`).join(', ')}; the desktop's: ${there.words.map((word) => `${word.text} ${(word.score ?? 0).toFixed(2)}`).join(', ')}`);
      assert.equal(here.words.length, spokenWords(text, LANGUAGE).length);
      // A word of one letter, and an elided one bound to the next (French « c’ », « l’ »), are left out: the
      // aligner hears them badly in any take (« c’est » at the desktop: c’ 0.01).
      assert.deepEqual(here.words.filter((word) => (word.score ?? 0) < 0.25 && word.text.length > 1 && !/['’]$/.test(word.text)).map((word) => word.text), [], `${line.id}: no word swallowed`);
      // As sure as a take a listener follows. Not the desktop's take of the same seed: onnxruntime-web and
      // the native runtime compute apart, and their takes of one seed may part. Under macOS, nell2's are
      // nearly one (0.98 here, 0.99 at the desktop, the same length); nell1's part (0.79 in the three
      // browsers, on one thread as on four; 0.90 at the desktop, where the study's takes scored 0.88 to 0.96).
      // The French aligner scores lower on any take (nell1: 0.60 here, 0.63 at the desktop): a take below
      // 0.7 passes when it is within 0.1 of the desktop's, and never below 0.5.
      assert.ok(here.mean >= Math.max(0.5, Math.min(0.7, there.mean - 0.1)), `${line.id}: mean score ${here.mean.toFixed(2)}, the desktop's take of the same seed ${there.mean.toFixed(2)}`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  t.diagnostic(`progress: ${[...new Set(result.progress)].join(', ')}`);
});
