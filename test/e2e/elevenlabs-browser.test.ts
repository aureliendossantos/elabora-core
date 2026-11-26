import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from 'playwright-core';
import { narrationLines } from '@elabora/core/narration/narration';
import { loadProjectFromDir, readProjectFiles } from '@elabora/node/project-reader';
import { aacEncoderModule } from '@elabora/engine/aac-encoder';
import { bundleForBrowser } from '../browser-bundle.ts';
import { emptyStorage, ISOLATED, pageWithStorage } from '../browser-page.ts';
import { ROOT } from '../helpers.ts';

// ElevenLabs in a browser's session (D136; ELABORA_BROWSER: chromium, firefox or webkit), against an
// imitation of ElevenLabs: the app frames the page of the key (an origin of its own, as
// keys.elabora.studio), the author types the key in its field and the window commits it; the engine's
// Worker, given a port to that page, says a line with the course's ElevenLabs voice and keeps its take.
// The key reaches ElevenLabs, and nothing the window or the engine receives carries it. The page
// refuses a port from another origin, and an operation outside the list.

const BROWSER = process.env.ELABORA_BROWSER ?? 'chromium';
const APP = 'https://app.elabora.test';
const KEYS = 'https://keys.elabora.test';
const KEY = 'sk_' + 'f00dcafe'.repeat(5);
const VOICES = path.join(ROOT, 'packages/node/voices/pocket-tts');
const ORT = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
const EXAMPLE = path.join(ROOT, 'examples/canal-locks');
const exampleFiles = readProjectFiles(EXAMPLE).files;
const exampleMedia = new Map([...exampleFiles].flatMap(([rel, file]) => (file.kind === 'binary' && file.hash ? [[file.hash, fs.readFileSync(path.join(EXAMPLE, rel))] as [string, Buffer]] : [])));

let browser: Awaited<ReturnType<typeof pageWithStorage>> | undefined;
after(async () => { await browser?.close(); });

// ElevenLabs' imitation: a second of a tone for a line, its characters timed evenly.
const heard: { path: string; key: string | undefined; body: string | null }[] = [];
function elevenLabs(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  heard.push({ path: url.pathname + url.search, key: request.headers()['xi-api-key'], body: request.postData() });
  const json = (status: number, body: unknown) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (request.headers()['xi-api-key'] !== KEY) return json(401, { detail: { status: 'invalid_api_key', message: `Invalid API key: ${request.headers()['xi-api-key']}` } });
  if (url.pathname === '/v1/user') return json(200, { subscription: { tier: 'starter', character_count: 1000, character_limit: 30000, next_character_count_reset_unix: 1798761600 } });
  if (url.pathname === '/v1/models') return json(200, [{ model_id: 'eleven_v4', model_rates: { character_cost_multiplier: 1 } }]);
  if (url.pathname.startsWith('/v1/voices/')) return json(200, { voice_id: url.pathname.split('/').pop(), name: 'Beatrice - Mature, Gentle and Engaging', category: 'professional', labels: { language: 'en' } });
  if (url.pathname.startsWith('/v1/text-to-speech/')) {
    const text = (JSON.parse(request.postData() ?? '{}') as { text: string }).text;
    const pcm = Buffer.alloc(24000 * 2);
    for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
    const characters = [...text];
    const step = 0.9 / Math.max(1, characters.length);
    return json(200, { audio_base64: pcm.toString('base64'), alignment: { characters, character_start_times_seconds: characters.map((_, i) => 0.05 + i * step), character_end_times_seconds: characters.map((_, i) => 0.05 + (i + 1) * step) } });
  }
  return json(404, { detail: { status: 'not_found', message: 'no such route' } });
}

async function serve(page: Page): Promise<void> {
  const keyPage = await bundleForBrowser({ file: 'packages/engine/src/browser/keys/page.ts' });
  const models = await bundleForBrowser({ file: 'packages/engine/src/browser/models/worker.ts' });
  const media = await bundleForBrowser({ file: 'packages/engine/src/browser/media/worker.ts' });
  const engine = await bundleForBrowser({ source: `import { provideMedia } from './packages/engine/src/browser/worker.ts';
provideMedia(async (hash) => { const response = await fetch('/example-media/' + hash); return response.ok ? response.blob() : null; });` });
  const aac = await aacEncoderModule();
  const html = fs.readFileSync(path.join(ROOT, 'packages/engine/src/browser/keys/index.html'), 'utf8').replace('__ELABORA_KEYS_APP_ORIGINS__', APP).replace('page.ts', 'page.js');
  // The key's page as its host serves it: its policy, framed by the app alone, isolated with it.
  const policy = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://api.elevenlabs.io https://storage.googleapis.com/eleven-public-prod/; form-action 'none'; base-uri 'none'; frame-ancestors ${APP}`;
  const keyHeaders = { 'content-security-policy': policy, 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'cross-origin', 'cross-origin-opener-policy': 'same-origin' };
  await page.route(`${KEYS}/**`, (route) => {
    const name = new URL(route.request().url()).pathname;
    if (name.endsWith('/page.js')) return route.fulfill({ headers: keyHeaders, contentType: 'text/javascript', body: keyPage.code });
    if (name.endsWith('/key.css')) return route.fulfill({ headers: keyHeaders, contentType: 'text/css', body: 'input { width: 100%; }' });
    // /stranger/: the page as a host would serve it for another app, which this one is not.
    if (name.startsWith('/stranger/')) return route.fulfill({ headers: keyHeaders, contentType: 'text/html', body: html.replace(`content="${APP}"`, 'content="https://elsewhere.test"') });
    return route.fulfill({ headers: keyHeaders, contentType: 'text/html', body: html });
  });
  await page.route('https://api.elevenlabs.io/**', elevenLabs);
  await page.route(`${APP}/**`, (route) => {
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
    return route.fulfill({ headers: ISOLATED, contentType: 'text/html', body: '<!doctype html><title>app</title>' });
  });
  page.on('pageerror', (error) => console.error('page:', error.message));
  await page.goto(`${APP}/`);
  await emptyStorage(page);
}

test(`ElevenLabs in ${BROWSER}: the key typed in its own page, a line said by the course's ElevenLabs voice, the key in no answer`, { timeout: 300_000 }, async () => {
  browser = await pageWithStorage(BROWSER);
  const { page } = browser;
  await serve(page);
  // The page's ready, then the window's port to it.
  await page.evaluate((keys) => new Promise<void>((resolve) => {
    // Framed as the dialogue frames it, the page's ready awaited before it is sent anything.
    const frame = document.createElement('iframe');
    frame.id = 'keys';
    frame.src = `${keys}/?lang=fr&theme=light`;
    const w = window as unknown as { keys: MessagePort; seen: unknown[] };
    w.seen = [];
    addEventListener('message', function ready({ data, source }) {
      if (source !== frame.contentWindow || data?.kind !== 'ready') return;
      removeEventListener('message', ready);
      const { port1, port2 } = new MessageChannel();
      w.keys = port1;
      port1.onmessage = ({ data: message }) => { w.seen.push(message); };
      frame.contentWindow!.postMessage({ v: 1, kind: 'connect' }, 'https://keys.elabora.test', [port2]);
      resolve();
    });
    document.body.append(frame);
  }), KEYS);
  const ask = (op: string, params: unknown = {}) => page.evaluate(([o, p]) => new Promise<Record<string, unknown>>((resolve) => {
    const w = window as unknown as { keys: MessagePort; next?: number };
    const id = (w.next = (w.next ?? 0) + 1);
    const listen = ({ data }: MessageEvent) => { if (data.id === id) { w.keys.removeEventListener('message', listen); resolve(data); } };
    w.keys.addEventListener('message', listen);
    w.keys.postMessage({ v: 1, id, op: o, params: p });
  }), [op, params] as const);

  // The author types a wrong key: refused, nothing held; then the right one, ticked to be kept.
  const frame = page.frameLocator('#keys');
  await frame.locator('input').fill('sk_' + 'bad0'.repeat(10));
  assert.equal((await ask('commit')).code, 'E_VOICE_KEY_INVALID');
  await frame.locator('input').fill(KEY);
  await ask('setKeep', { keep: true });
  const committed = await ask('commit');
  assert.deepEqual(committed.key, { present: true, masked: 'sk_…cafe', kept: true }, JSON.stringify(committed));
  assert.equal(await frame.locator('input').inputValue(), '', 'the field emptied once the key is held');
  assert.equal((await ask('history')).code, 'E_KEY_REQUEST', 'an operation outside the list is refused');

  // The engine's Worker, given its own port to the page: the account, then a line said.
  const project = loadProjectFromDir(EXAMPLE);
  const screen = [...project.screens.keys()].find((id) => (narrationLines(project, id, 'en')?.filter((line) => line.text).length ?? 0) >= 1)!;
  const line = narrationLines(project, screen, 'en')!.find((one) => one.text)!;
  const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };
  const result = await page.evaluate(async ([seed, screenId, lineId]) => {
    const blob = async (url: string, type = 'text/javascript') => URL.createObjectURL(new Blob([await (await fetch(url)).arrayBuffer()], { type }));
    const open = {
      kind: 'open', team: 'tm_test', project: 'eleven', seed, api: 'http://localhost:1', offline: true, services: ['media', 'voices'],
      mediaWorker: await blob('/media.js'), aacEncoder: await blob('/aac.js'), modelsWorker: await blob('/models.js'), ort: await blob('/ort/ort.wasm.min.mjs'),
      ortWasm: { mjs: await blob('/ort/ort-wasm-simd-threaded.mjs'), wasm: await blob('/ort/ort-wasm-simd-threaded.wasm', 'application/wasm') }, models: 'https://models.elabora.test', voices: '/voices/'
    };
    const w = new Worker('/engine.js', { type: 'module' });
    const received: unknown[] = [];
    const answers = new Map<string, (data: { ok: boolean; result?: unknown; error?: { message: string; code?: string } }) => void>();
    w.onmessage = ({ data }) => { received.push(data); if (data.kind === 'response') answers.get(data.id)?.(data); };
    const ask = (type: string, params: unknown, transfer: Transferable[] = []) => new Promise<{ ok: boolean; result?: unknown; error?: { message: string; code?: string } }>((resolve) => { const id = `${type}${Math.random()}`; answers.set(id, resolve); w.postMessage({ kind: 'request', id, type, params }, transfer); });
    await new Promise((resolve) => { const first = (event: MessageEvent) => { if (event.data.kind === 'opened' || event.data.kind === 'failed') { w.removeEventListener('message', first); resolve(event.data); } }; w.addEventListener('message', first); w.postMessage(open); });
    const before = await ask('voiceAccount', { provider: 'elevenlabs' });
    const { port1, port2 } = new MessageChannel();
    const frame = document.getElementById('keys') as HTMLIFrameElement;
    frame.contentWindow!.postMessage({ v: 1, kind: 'connect' }, 'https://keys.elabora.test', [port1]);
    const connected = await ask('voiceKeyPort', {}, [port2]);
    // The page's state reaches the engine as its port opens.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const account = await ask('voiceAccount', { provider: 'elevenlabs' });
    const given = await ask('setVoiceKey', { provider: 'elevenlabs', key: 'sk_0123456789abcdef0123456789abcdef' });
    const said = await ask('generateVoice', { screen: screenId, lines: [lineId], language: 'en' });
    const takes = await ask('voiceTakes', { screen: screenId, line: lineId, language: 'en' });
    return { before, connected, account, given, said, takes, received: JSON.stringify(received) };
  }, [{ link, confirmed: [...exampleFiles] }, screen, line.id] as unknown as [object, string, string]);

  assert.equal(result.before.error?.code, 'E_VOICE_KEY_MISSING', 'without the page\'s port, no key');
  assert.ok(result.connected.ok, JSON.stringify(result.connected.error));
  assert.ok(result.account.ok, JSON.stringify(result.account.error));
  assert.deepEqual([(result.account.result as { plan: string; key: string }).plan, (result.account.result as { key: string }).key], ['starter', 'sk_…cafe']);
  assert.equal(result.given.ok, false, 'a key given to the session is refused');
  assert.ok(result.said.ok, JSON.stringify(result.said.error));
  assert.deepEqual((result.said.result as { lines: { status: string }[] }).lines.map((one) => one.status), ['generated'], JSON.stringify(result.said.result));
  assert.ok(((result.takes.result as { takes: unknown[] }).takes).length >= 1, 'its take kept');

  // ElevenLabs had the key; nothing the window or the engine received carries it.
  assert.ok(heard.some((asked) => asked.path.startsWith('/v1/text-to-speech/') && asked.key === KEY), JSON.stringify(heard.map((asked) => asked.path)));
  const toWindow = JSON.stringify(await page.evaluate(() => (window as unknown as { seen: unknown[] }).seen));
  assert.ok(!toWindow.includes(KEY) && !result.received.includes(KEY), 'the key in no message');
  assert.ok(!result.received.includes(KEY.slice(3, 23)), 'nor a part of it');

  // The page takes no port from an origin its host did not list: framed for another app, it is ready
  // but answers nothing to this one.
  const stranger = await page.evaluate((keys) => new Promise<string>((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = `${keys}/stranger/`;
    addEventListener('message', function ready({ data, source }) {
      if (source !== frame.contentWindow || data?.kind !== 'ready') return;
      removeEventListener('message', ready);
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => resolve('answered');
      frame.contentWindow!.postMessage({ v: 1, kind: 'connect' }, keys, [port2]);
      port1.postMessage({ v: 1, id: 1, op: 'keyState' });
      setTimeout(() => resolve('silent'), 1000);
    });
    document.body.append(frame);
  }), KEYS);
  assert.equal(stranger, 'silent');

  // Forgotten, the key is gone from the page's storage (WebKit keeps an origin's storage between runs).
  assert.deepEqual((await ask('forgetKey')).key, { present: false, masked: null, kept: false });
});
