import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as wasm from 'esbuild-wasm';
import { readProjectFiles } from '@elabora/node/project-reader';
import { objectLibrarySources } from '@elabora/node/bundles';
import type { EnginePortMessage, RelayAnswer, RelayRequest } from '@elabora/player/relay-protocol';
import { mediaFacts } from '@elabora/core/sync/media';
import type { FileContent } from '@elabora/core/ops/types';
import { openCopy } from '@elabora/engine/browser/session';
import { memoryCopy } from '@elabora/engine/browser/store';
import type { RoomSocket } from '@elabora/engine/base/session-cloud';
import type { EngineEvent, EventMessage, ResponseMessage } from '@elabora/engine/protocol';
import { engineConformance, type ConformanceTarget, type Sample } from '../conformance/engine.ts';
import { EXAMPLE, BILINGUAL, NETWORK_SAMPLE } from '../helpers.ts';

// The engine's protocol (test/conformance/engine.ts) played against a browser engine's session
// (D103) under Node: a copy of the sample as the room would give it, kept in memory, offline (its room
// never answers), with the one service it has a provider for, the canvas (D105): every case of another
// service is skipped, and the case of a service not here judges them.

const SAMPLES: Record<Sample, string> = { network: NETWORK_SAMPLE, basic: EXAMPLE, bilingual: BILINGUAL, empty: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-empty-')) };

// A room that never answers: the copy keeps its changes waiting.
const offline = (): RoomSocket => ({ readyState: 0, send() {}, close() {}, addEventListener() {} });

const browser: ConformanceTarget = {
  name: 'browser (memory)',
  services: ['canvas'],
  async open(sample, { services } = {}) {
    const { files } = readProjectFiles(SAMPLES[sample]);
    const store = memoryCopy({ link: { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 }, confirmed: files });
    const session = await openCopy({ id: `cloud:tm_test/prj_test`, store, api: 'http://localhost:1', connect: offline, services: services ?? ['canvas'] });
    const listeners: ((message: ResponseMessage | EventMessage) => void)[] = [];
    session.subscribe((message) => { for (const listener of listeners) listener(structuredClone(message)); });
    return {
      send(message) { void session.handle(structuredClone(message)).then((response) => { for (const listener of listeners) listener(structuredClone(response)); }); },
      receive(listener) { listeners.push(listener); },
      pick: (name) => name,
      saveAs: (name) => name,
      async dispose() { await session.close(); }
    };
  }
};

engineConformance(browser);

// esbuild-wasm starts once per process: the browser's compiler of free objects (D117).
const started = wasm.initialize({});

// ── what the browser engine adds ─────────────────────────────────────

const ask = async <T>(session: Awaited<ReturnType<typeof openCopy>>, type: string, params: unknown, ports: MessagePort[] = []): Promise<T> => {
  const answer = await session.handle({ kind: 'request', id: type, type, params }, ports);
  if (!answer.ok) throw Object.assign(new Error(answer.error.message), answer.error);
  return answer.result as T;
};
const copyOf = async (sample: Sample, options: Partial<Parameters<typeof openCopy>[0]> = {}) => {
  const { files } = readProjectFiles(SAMPLES[sample]);
  const media = new Map<string, Uint8Array>();
  for (const [rel, file] of files) if (file.kind === 'binary' && file.hash) media.set(file.hash, fs.readFileSync(path.join(SAMPLES[sample], rel)));
  const store = memoryCopy({ link: { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 }, confirmed: files, media });
  const session = await openCopy({ id: 'cloud:tm_test.prj_test', store, api: 'http://localhost:1', connect: offline, ...options });
  closing.push(() => session.close());
  return session;
};
const closing: (() => Promise<unknown>)[] = [];
after(async () => { for (const close of closing) await close(); });

test('browser: a service named without a provider is not had: not in the summary, and a command that needs it is not here', async () => {
  const session = await copyOf('basic', { services: ['library', 'media', 'canvas'] });
  assert.deepEqual((await ask<{ services: string[] }>(session, 'summary', {})).services, ['canvas']);
  await assert.rejects(ask(session, 'run', { command: 'add_font', args: { family: 'inter' } }), (error: { kind?: string; code?: string }) => error.kind === 'not-available' && error.code === 'E_NOT_HERE');
});

test('browser canvas: its renders and views go out as events, the page\'s words left to the window; a change sends the screen shown again', async () => {
  const session = await copyOf('network', { services: ['canvas'] });
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => { if (event.type === 'canvasRender' || event.type === 'canvasView') events.push(event); });
  const info = await ask<{ url: string; base: string; token: string }>(session, 'openCanvas', {});
  assert.deepEqual([info.url, info.base, info.token], ['', '', '']);
  const shown = await ask<{ id: string }>(session, 'canvasView', { screen: 'chemin', step: 1 });
  const render = events.shift();
  assert.ok(render?.type === 'canvasRender' && render.id === shown.id && render.render.screen === 'chemin' && render.render.view.step === 1);
  assert.ok(render.render.files?.length && render.render.files.every((file) => Object.keys(file).sort().join() === 'hash,kind,path'), 'files by path, kind and hash');
  const stepped = await ask<{ id: string }>(session, 'canvasView', { step: 2 });
  assert.deepEqual(events.shift(), { type: 'canvasView', id: stepped.id, view: { state: 'initial', step: 2, layer: null } });
  const changed = await ask<{ change: { seq: number } }>(session, 'run', { command: 'update_screen', args: { id: 'chemin', title: 'Le chemin' } });
  const again = events.shift();
  assert.ok(again?.type === 'canvasRender' && again.id === changed.change.seq && again.render.course.screens[0]?.title === 'Le chemin');
  await ask(session, 'run', { command: 'update_screen', args: { id: 'accueil', showTitle: false } });
  assert.deepEqual(events, [], 'another screen\'s change that the bars do not show');
  assert.deepEqual(await ask(session, 'closeCanvas', {}), { closed: true });
});

// A relay's port (D118, D105): what each host's pages may ask, answered from the copy.
async function relay(session: Awaited<ReturnType<typeof openCopy>>, host: 'canvas' | 'frames') {
  const { port1, port2 } = new MessageChannel();
  await ask(session, 'relayPort', { host }, [port1]);
  let next = 0;
  const waiting = new Map<number, (answer: RelayAnswer) => void>();
  port2.onmessage = ({ data }: MessageEvent<EnginePortMessage>) => { if (data.type === 'relay/answer') waiting.get(data.id)?.(data.answer); };
  return {
    get: (request: RelayRequest) => new Promise<RelayAnswer>((resolve) => { const id = ++next; waiting.set(id, resolve); port2.postMessage({ type: 'relay/request', id, request }); }),
    close: () => port2.close()
  };
}
const bytesOf = async (answer: RelayAnswer) => (answer.status === 'ok' ? (typeof answer.body === 'string' ? new TextEncoder().encode(answer.body) : new Uint8Array(await answer.body.arrayBuffer())) : null);

test('browser relay: the canvas gets the module\'s files, texts and media by hash; the frames host an object\'s page, its code and its files, nothing else', { timeout: 120_000 }, async () => {
  const session = await copyOf('network', { objects: async () => { await started; const sources = await objectLibrarySources(); return { bundler: wasm, libraries: { d3: { contents: sources.d3 }, charts: { contents: sources.charts } } }; } });
  const canvas = await relay(session, 'canvas');
  const frames = await relay(session, 'frames');
  try {
    const screen = await canvas.get({ kind: 'file', path: 'screens/chemin.json' });
    assert.ok(screen.status === 'ok' && screen.type === 'application/json' && typeof screen.body === 'string' && JSON.parse(screen.body).id === 'chemin');
    const audio = await canvas.get({ kind: 'file', path: 'assets/narration/fr/chemin/chemin-depart.m4a' });
    assert.ok(audio.status === 'ok' && audio.type === 'audio/mp4' && /^sha256:/.test(audio.hash ?? ''));
    assert.deepEqual(await bytesOf(audio), new Uint8Array(fs.readFileSync(path.join(NETWORK_SAMPLE, 'assets/narration/fr/chemin/chemin-depart.m4a'))));
    assert.equal((await canvas.get({ kind: 'file', path: 'assets/absent.png' })).status, 'not-found');
    assert.equal((await canvas.get({ kind: 'file', path: '../course.json' })).status, 'refused', 'a path that leaves the module');
    assert.equal((await canvas.get({ kind: 'object-code', object: 'diagnostic-reseau' })).status, 'refused', 'an object is the frames host\'s');

    const page = await frames.get({ kind: 'object-frame', object: 'diagnostic-reseau' });
    assert.ok(page.status === 'ok' && typeof page.body === 'string' && page.body.includes('<script src="object.js">'));
    const code = await frames.get({ kind: 'object-code', object: 'diagnostic-reseau' });
    assert.ok(code.status === 'ok' && typeof code.body === 'string' && code.body.includes('__elaboraObject'), JSON.stringify(code).slice(0, 300));
    assert.equal((await frames.get({ kind: 'file', path: 'objects/diagnostic-reseau/object.manifest.json' })).status, 'ok');
    assert.equal((await frames.get({ kind: 'file', path: 'screens/chemin.json' })).status, 'refused', 'a frame never reads the module\'s screens');
    assert.equal((await frames.get({ kind: 'object-frame', object: 'absent' })).status, 'not-found');
  } finally {
    canvas.close();
    frames.close();
  }
});

test('browser: a medium never taken has its size and the facts the room gave (D125), read and validated as a probed one; one without facts has its size and waits', async () => {
  const { files } = readProjectFiles(NETWORK_SAMPLE);
  const line = 'assets/narration/fr/chemin/chemin-depart.m4a';
  const located = 'assets/narration/fr/chemin/chemin-diagnostic.m4a';
  const unknown = 'assets/narration/fr/chemin/chemin-reseaux.m4a';
  const confirmed = new Map<string, FileContent>();
  const media: Record<string, { size: number; facts?: ReturnType<typeof mediaFacts> }> = {};
  for (const [rel, file] of files) {
    if (file.kind !== 'binary' || !file.hash) { confirmed.set(rel, file); continue; }
    // As the room gives a medium: its hash and size, no bytes, no probe.
    confirmed.set(rel, { kind: 'binary', hash: file.hash, size: file.size });
    if (rel === unknown || !file.media) { media[file.hash] = { size: file.size }; continue; }
    const facts = mediaFacts(file.media);
    // Facts that only the room could have given: the line said for 42 s; another with a GPS position in it.
    media[file.hash] = { size: file.size, facts: rel === line ? { ...facts, duration: 42 } : rel === located ? { ...facts, location: true } : facts };
  }
  const store = memoryCopy({ link: { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0, media }, confirmed });
  const session = await openCopy({ id: 'cloud:tm_test.prj_test', store, api: 'http://localhost:1', connect: offline });
  closing.push(() => session.close());

  const lines = (await ask<{ lines: { id: string; duration: number | null }[] }>(session, 'narration', { screen: 'chemin' })).lines;
  assert.equal(lines.find((one) => one.id === 'chemin-depart')?.duration, 42, 'the duration the room gave');
  const diagnostics = await ask<{ project: { code: string; file?: string }[]; screens: Record<string, { code: string; file?: string }[]> }>(session, 'diagnostics', {});
  const all = [...diagnostics.project, ...Object.values(diagnostics.screens).flat()];
  assert.ok(all.some((finding) => finding.code === 'W_MEDIA_NOT_OPTIMIZED' && finding.file === located), 'the verdict computed from the facts');
  assert.ok(!all.some((finding) => finding.file === unknown), 'a medium without facts: no finding');
  const listed = await ask<{ path: string; size: number }[]>(session, 'listFiles', { dir: 'assets/narration/fr/chemin' });
  assert.equal(listed.find((file) => file.path === unknown)?.size, files.get(unknown)?.kind === 'binary' ? (files.get(unknown) as { size: number }).size : -1);
});
