import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { readProjectFiles } from '@elabora/node/project-reader';
import { launchBrowser } from '@elabora/node/emulator/browser';
import type { EventMessage, RequestMessage, ResponseMessage } from '@elabora/engine/protocol';
import type { WorkerAnswer, WorkerOpen } from '@elabora/engine/browser/worker';
import { bundleForBrowser } from '../browser-bundle.ts';
import { engineConformance, type ConformanceTarget, type Sample } from '../conformance/engine.ts';
import { EXAMPLE, BILINGUAL, NETWORK_SAMPLE } from '../helpers.ts';

// The engine's protocol (test/conformance/engine.ts) played against the browser engine in a Worker of
// Chromium (D103): its copy kept in IndexedDB, one Worker a module, offline, with the canvas alone of its services (D105). And
// what the browser's storage adds: a change kept across a closing, a second tab told the module is
// open elsewhere.

// A secure context: Web Locks and the origin's private file system need one.
const ORIGIN = 'https://engine.elabora.test';
const SAMPLES: Record<Sample, string> = { network: NETWORK_SAMPLE, basic: EXAMPLE, bilingual: BILINGUAL, empty: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-empty-')) };
const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };

type Message = WorkerAnswer | ResponseMessage | EventMessage;

// The media the app ships with an example, by hash: one right, one whose bytes are not its hash's.
const LINE = 'assets/narration/fr/chemin/chemin-depart.m4a';
const WRONG = 'assets/narration/fr/chemin/chemin-reseaux.m4a';
const hashOf = (rel: string) => { const file = readProjectFiles(NETWORK_SAMPLE).files.get(rel); return file?.kind === 'binary' ? file.hash! : ''; };
const SHIPPED = new Map<string, Buffer>([[hashOf(LINE), fs.readFileSync(path.join(NETWORK_SAMPLE, LINE))], [hashOf(WRONG), fs.readFileSync(path.join(NETWORK_SAMPLE, LINE))]]);
const shipped: string[] = [];
let browser: Browser;
let page: Page;
const listeners = new Map<number, (message: Message) => void>();
let workers = 0;

before(async () => {
  const worker = await bundleForBrowser({ file: 'packages/engine/src/browser/worker.ts' });
  // The app's Worker as it gives a compiler of free objects (provideObjects): a stand-in for
  // esbuild-wasm, which says when it is loaded.
  const withObjects = await bundleForBrowser({ source: `import { provideObjects } from './packages/engine/src/browser/worker.ts';
provideObjects(async () => {
  self.postMessage({ kind: 'event', event: { type: 'error', context: 'objects', message: 'loaded' } });
  return { bundler: { build: async () => ({ outputFiles: [{ text: 'compiled here' }] }) }, libraries: {} };
});` });
  // The app's Worker as it gives the media of the examples it ships (provideMedia), by hash.
  const withMedia = await bundleForBrowser({ source: `import { provideMedia } from './packages/engine/src/browser/worker.ts';
provideMedia(async (hash) => { const response = await fetch('/media/' + hash); return response.ok ? response.blob() : null; });` });
  browser = await launchBrowser('chromium');
  page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname;
    const scripts: Record<string, string> = { '/worker.js': worker.code, '/worker-objects.js': withObjects.code, '/worker-media.js': withMedia.code };
    if (scripts[name]) return route.fulfill({ contentType: 'text/javascript', body: scripts[name] });
    if (name.startsWith('/media/')) {
      const hash = name.slice('/media/'.length);
      shipped.push(hash);
      const bytes = SHIPPED.get(hash);
      return bytes ? route.fulfill({ contentType: 'application/octet-stream', body: bytes }) : route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>engine</title>' });
  });
  await page.exposeFunction('deliver', (id: number, message: Message) => listeners.get(id)?.(message));
  page.on('pageerror', (error) => console.error('page:', error.message));
  await page.goto(`${ORIGIN}/`);
});
after(async () => { await browser?.close(); });

type Page$ = { workers: Map<number, Worker>; deliver(id: number, message: unknown): void };

// A Worker of the engine on a copy; its first answer (opened, held, missing, failed).
async function worker(open: WorkerOpen, script = '/worker.js'): Promise<{ id: number; first: WorkerAnswer; send(message: RequestMessage): Promise<void>; receive(listener: (message: ResponseMessage | EventMessage) => void): void; end(): Promise<void> }> {
  const id = ++workers;
  const received: ((message: ResponseMessage | EventMessage) => void)[] = [];
  let first!: (answer: WorkerAnswer) => void;
  const answered = new Promise<WorkerAnswer>((resolve) => { first = resolve; });
  listeners.set(id, (message) => {
    if (message.kind === 'response' || message.kind === 'event') for (const listener of received) listener(message);
    else first(message);
  });
  await page.evaluate(([n, request, url]) => {
    const scope = window as unknown as Page$;
    scope.workers ??= new Map();
    const w = new Worker(url as string, { type: 'module' });
    scope.workers.set(n, w);
    w.onmessage = ({ data }) => scope.deliver(n, data);
    w.onerror = (event) => scope.deliver(n, { kind: 'failed', message: event.message || 'the Worker did not load' });
    w.postMessage(request);
  }, [id, open, script] as unknown as [number, object, string]);
  return {
    id, first: await Promise.race([answered, new Promise<WorkerAnswer>((resolve) => setTimeout(() => resolve({ kind: 'failed', message: 'no answer in 30 s' }), 30_000))]),
    send: (message) => page.evaluate(([n, m]) => (window as unknown as Page$).workers.get(n)!.postMessage(m), [id, message] as unknown as [number, object]),
    receive: (listener) => { received.push(listener); },
    end: () => page.evaluate((n) => { const scope = window as unknown as Page$; scope.workers.get(n)?.terminate(); scope.workers.delete(n); }, id)
  };
}

const seedOf = (sample: Sample) => ({ link, confirmed: [...readProjectFiles(SAMPLES[sample]).files] });
let copies = 0;

const chromium: ConformanceTarget = {
  name: 'browser (Chromium, IndexedDB)',
  services: ['canvas'],
  async open(sample, { services } = {}) {
    const engine = await worker({ kind: 'open', team: 'tm_test', project: `conformance-${++copies}`, seed: seedOf(sample), api: 'http://localhost:1', offline: true, services: [...(services ?? ['canvas'])] });
    assert.equal(engine.first.kind, 'opened', JSON.stringify(engine.first));
    return {
      send: (message) => void engine.send(message),
      receive: (listener) => engine.receive(listener),
      pick: (name) => name,
      saveAs: (name) => name,
      dispose: () => engine.end()
    };
  }
};

engineConformance(chromium);

// A request answered, by the Worker of a copy.
async function ask<T>(engine: Awaited<ReturnType<typeof worker>>, type: string, params: unknown): Promise<T> {
  const id = `r${Math.random()}`;
  const answer = new Promise<ResponseMessage>((resolve) => engine.receive((message) => { if (message.kind === 'response' && message.id === id) resolve(message); }));
  await engine.send({ kind: 'request', id, type, params } as RequestMessage);
  const response = await answer;
  if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
  return response.result as T;
}

test('browser storage: a change is kept across a closing; a second tab is told the module is open elsewhere; a copy never kept says so', { timeout: 120_000 }, async () => {
  const first = await worker({ kind: 'open', team: 'tm_test', project: 'kept', seed: seedOf('basic'), api: 'http://localhost:1', offline: true });
  assert.equal(first.first.kind, 'opened');
  const second = await worker({ kind: 'open', team: 'tm_test', project: 'kept', api: 'http://localhost:1', offline: true });
  assert.equal(second.first.kind, 'held');
  await second.end();
  const run = await ask<{ change: { seq: number } }>(first, 'run', { command: 'update_screen', args: { id: 'chemin', title: 'Gardé dans le navigateur' } });
  await ask(first, 'close', {});
  await first.end();

  // Opened again without a seed: what the copy kept, its change and its journal.
  const again = await worker({ kind: 'open', team: 'tm_test', project: 'kept', api: 'http://localhost:1', offline: true });
  assert.equal(again.first.kind, 'opened');
  assert.equal((await ask<{ data: { title: string } }>(again, 'readScreen', { screen: 'chemin' })).data.title, 'Gardé dans le navigateur');
  const history = await ask<{ changes: { seq: number; op: string }[] }>(again, 'history', {});
  assert.deepEqual(history.changes.map((change) => [change.seq, change.op]), [[run.change.seq, 'update_screen']]);
  await ask(again, 'close', {});
  await again.end();

  const never = await worker({ kind: 'open', team: 'tm_test', project: 'never-kept', api: 'http://localhost:1', offline: true });
  assert.equal(never.first.kind, 'missing');
  await never.end();
});

test('a copy the browser does not hold is taken from the room\'s project, with the web session\'s cookie', { timeout: 120_000 }, async () => {
  const API = 'https://api.elabora.test';
  const { files } = readProjectFiles(EXAMPLE);
  const snapshot = [...files].map(([rel, file]) => (file.kind === 'text' ? { path: rel, text: file.text } : { path: rel, blob: file.hash, size: file.size }));
  const asked: string[] = [];
  await page.route(`${API}/**`, (route) => {
    const url = new URL(route.request().url());
    asked.push(`${url.pathname} ${route.request().headers().cookie ?? 'no cookie'}`);
    const headers = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Credentials': 'true', 'Content-Type': 'application/json' };
    if (url.pathname === '/v1/account') return route.fulfill({ headers, body: JSON.stringify({ account: { id: 'acc_bea', handle: 'bea', displayName: 'Béa' } }) });
    if (url.pathname === '/v1/teams/tm_test/projects/taken/files') return route.fulfill({ headers, body: JSON.stringify({ head: 7, files: snapshot }) });
    return route.fulfill({ status: 404, headers, body: JSON.stringify({ error: { code: 'not-found', message: 'Not here.' } }) });
  });
  await page.context().addCookies([{ name: '__Host-elabora-web', value: 'session-of-the-test', url: `${API}/`, secure: true, httpOnly: true, sameSite: 'Strict' }]);
  try {
    const engine = await worker({ kind: 'open', team: 'tm_test', project: 'taken', api: API });
    assert.deepEqual(engine.first, { kind: 'opened', taken: true });
    const summary = await ask<{ course: { id: string } | null; journal: { seq: number } }>(engine, 'summary', {});
    assert.equal(summary.course?.id, 'diagnostic-reseau');
    assert.ok(asked.includes('/v1/account __Host-elabora-web=session-of-the-test'), asked.join('\n'));
    await ask(engine, 'close', {});
    await engine.end();
  } finally {
    await page.unroute(`${API}/**`);
  }
});

test('browser relay: a port transferred to the Worker answers the canvas from the copy; a medium not kept, offline, is not here yet', { timeout: 120_000 }, async () => {
  const engine = await worker({ kind: 'open', team: 'tm_test', project: 'relayed', seed: seedOf('network'), api: 'http://localhost:1', offline: true });
  assert.equal(engine.first.kind, 'opened');
  const answers = await relayAsks(engine.id, 'canvas', [{ kind: 'file', path: 'screens/chemin.json' }, { kind: 'file', path: 'assets/narration/fr/chemin/chemin-depart.m4a' }]);
  assert.equal(answers.ok, true);
  const [screen, audio] = answers.answers;
  assert.deepEqual([screen.status, screen.type], ['ok', 'application/json']);
  assert.match(screen.text ?? "", /^\{\n  "\$schema"/);
  assert.equal(audio.status, 'unavailable');
  await ask(engine, 'close', {});
  await engine.end();
});

test('the app\'s Worker gives a compiler of free objects: loaded at the first object a page asks for, once', { timeout: 120_000 }, async () => {
  const engine = await worker({ kind: 'open', team: 'tm_test', project: 'objects', seed: seedOf('network'), api: 'http://localhost:1', offline: true }, '/worker-objects.js');
  assert.equal(engine.first.kind, 'opened');
  let loads = 0;
  engine.receive((message) => { if (message.kind === 'event' && message.event.type === 'error' && message.event.context === 'objects') loads++; });
  await ask(engine, 'summary', {});
  assert.equal(loads, 0, 'nothing loaded while no page asks for an object');
  const answers = await relayAsks(engine.id, 'frames', [{ kind: 'object-code', object: 'diagnostic-reseau' }, { kind: 'object-frame', object: 'diagnostic-reseau' }, { kind: 'object-code', object: 'diagnostic-reseau' }]);
  assert.deepEqual(answers.answers.map((answer) => answer.status), ['ok', 'ok', 'ok']);
  assert.equal(answers.answers[0].text, 'compiled here');
  assert.equal(loads, 1);
  await ask(engine, 'close', {});
  await engine.end();
});

test('the app\'s Worker gives the media it ships: a copy opened offline takes a medium from it, checked against its hash, then kept', { timeout: 120_000 }, async () => {
  const engine = await worker({ kind: 'open', team: 'tm_test', project: 'shipped', seed: seedOf('network'), api: 'http://localhost:1', offline: true }, '/worker-media.js');
  assert.equal(engine.first.kind, 'opened');
  const answers = await relayAsks(engine.id, 'canvas', [{ kind: 'file', path: LINE }, { kind: 'file', path: LINE }, { kind: 'file', path: WRONG }, { kind: 'file', path: 'assets/narration/fr/chemin/chemin-diagnostic.m4a' }]);
  assert.deepEqual(answers.answers.map((answer) => answer.status), ['ok', 'ok', 'failed', 'unavailable']);
  assert.equal(shipped.filter((hash) => hash === hashOf(LINE)).length, 1, 'taken once, then kept');
  await ask(engine, 'close', {});
  await engine.end();
});

// Questions of a relay host's pages, through a port transferred to the Worker (relayPort).
function relayAsks(n: number, host: 'canvas' | 'frames', requests: unknown[]) {
  return page.evaluate(async ([n, host, requests]) => {
    const w = (window as unknown as Page$).workers.get(n as number)!;
    const { port1, port2 } = new MessageChannel();
    const opened = new Promise((resolve) => w.addEventListener('message', function listen({ data }) { if (data.kind === 'response' && data.id === 'relay') { w.removeEventListener('message', listen); resolve(data.ok); } }));
    w.postMessage({ kind: 'request', id: 'relay', type: 'relayPort', params: { host } }, [port1]);
    const ok = await opened;
    const ask = (id: number, request: unknown) => new Promise<{ status: string; type?: string; text?: string }>((resolve) => {
      port2.addEventListener('message', async function listen({ data }) {
        if (data.type !== 'relay/answer' || data.id !== id) return;
        port2.removeEventListener('message', listen);
        const answer = data.answer;
        resolve({ status: answer.status, ...(answer.type ? { type: answer.type } : {}), ...(answer.body !== undefined ? { text: typeof answer.body === 'string' ? answer.body.slice(0, 40) : await (answer.body as Blob).text().then((t) => t.slice(0, 4)) } : {}) });
      });
      port2.start();
      port2.postMessage({ type: 'relay/request', id, request });
    });
    const answers = [];
    for (const [i, request] of (requests as unknown[]).entries()) answers.push(await ask(i + 1, request));
    return { ok, answers };
  }, [n, host, requests] as unknown as [number, string, unknown[]]);
}
