import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as wasm from 'esbuild-wasm';
import { readProjectFiles } from '@elabora/node/project-reader';
import { objectLibrarySources } from '@elabora/node/bundles';
import type { EnginePortMessage, RelayAnswer, RelayRequest } from '@elabora/player/relay-protocol';
import { openCopy } from '@elabora/engine/browser/session';
import { memoryCopy } from '@elabora/engine/browser/store';
import type { RoomSocket } from '@elabora/engine/base/session-cloud';
import type { EventMessage, ResponseMessage } from '@elabora/engine/protocol';
import { engineConformance, type ConformanceTarget, type Sample } from '../conformance/engine.ts';
import { EXAMPLE, BILINGUAL, NETWORK_SAMPLE } from '../helpers.ts';

// The engine's protocol (test/conformance/engine.ts) played against a browser engine's session
// (D103) under Node: a copy of the sample as the room would give it, kept in memory, offline (its room
// never answers), without any service: every case of a service is skipped, and the case of a
// service not here judges them.

const SAMPLES: Record<Sample, string> = { network: NETWORK_SAMPLE, basic: EXAMPLE, bilingual: BILINGUAL };

// A room that never answers: the copy keeps its changes waiting.
const offline = (): RoomSocket => ({ readyState: 0, send() {}, close() {}, addEventListener() {} });

const browser: ConformanceTarget = {
  name: 'browser (memory)',
  services: [],
  async open(sample, { services } = {}) {
    const { files } = readProjectFiles(SAMPLES[sample]);
    const store = memoryCopy({ link: { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 }, confirmed: files });
    const session = await openCopy({ id: `cloud:tm_test/prj_test`, store, api: 'http://localhost:1', connect: offline, ...(services ? { services } : {}) });
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
  const session = await copyOf('basic', { services: ['library', 'media'] });
  assert.deepEqual((await ask<{ services: string[] }>(session, 'summary', {})).services, []);
  await assert.rejects(ask(session, 'run', { command: 'add_font', args: { family: 'inter' } }), (error: { kind?: string; code?: string }) => error.kind === 'not-available' && error.code === 'E_NOT_HERE');
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
