import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { readProjectFiles } from '@elabora/node/project-reader';
import { launchBrowser } from '@elabora/node/emulator/browser';
import type { EventMessage, RequestMessage, ResponseMessage } from '@elabora/engine/protocol';
import type { WorkerAnswer, WorkerOpen } from '@elabora/engine/browser/worker';
import { bundleForBrowser } from '../browser-bundle.ts';
import { engineConformance, type ConformanceTarget, type Sample } from '../conformance/engine.ts';
import { EXAMPLE, BILINGUAL, NETWORK_SAMPLE } from '../helpers.ts';

// The engine's protocol (test/conformance/engine.ts) played against the browser engine in a Worker of
// Chromium (D103): its copy kept in IndexedDB, one Worker a module, offline, without any service. And
// what the browser's storage adds: a change kept across a closing, a second tab told the module is
// open elsewhere.

// A secure context: Web Locks and the origin's private file system need one.
const ORIGIN = 'https://engine.elabora.test';
const SAMPLES: Record<Sample, string> = { network: NETWORK_SAMPLE, basic: EXAMPLE, bilingual: BILINGUAL };
const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };

type Message = WorkerAnswer | ResponseMessage | EventMessage;
let browser: Browser;
let page: Page;
const listeners = new Map<number, (message: Message) => void>();
let workers = 0;

before(async () => {
  const worker = await bundleForBrowser({ file: 'packages/engine/src/browser/worker.ts' });
  browser = await launchBrowser('chromium');
  page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, (route) => new URL(route.request().url()).pathname === '/worker.js'
    ? route.fulfill({ contentType: 'text/javascript', body: worker.code })
    : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>engine</title>' }));
  await page.exposeFunction('deliver', (id: number, message: Message) => listeners.get(id)?.(message));
  page.on('pageerror', (error) => console.error('page:', error.message));
  await page.goto(`${ORIGIN}/`);
});
after(async () => { await browser?.close(); });

type Page$ = { workers: Map<number, Worker>; deliver(id: number, message: unknown): void };

// A Worker of the engine on a copy; its first answer (opened, held, missing, failed).
async function worker(open: WorkerOpen): Promise<{ id: number; first: WorkerAnswer; send(message: RequestMessage): Promise<void>; receive(listener: (message: ResponseMessage | EventMessage) => void): void; end(): Promise<void> }> {
  const id = ++workers;
  const received: ((message: ResponseMessage | EventMessage) => void)[] = [];
  let first!: (answer: WorkerAnswer) => void;
  const answered = new Promise<WorkerAnswer>((resolve) => { first = resolve; });
  listeners.set(id, (message) => {
    if (message.kind === 'response' || message.kind === 'event') for (const listener of received) listener(message);
    else first(message);
  });
  await page.evaluate(([n, request]) => {
    const scope = window as unknown as Page$;
    scope.workers ??= new Map();
    const w = new Worker('/worker.js', { type: 'module' });
    scope.workers.set(n, w);
    w.onmessage = ({ data }) => scope.deliver(n, data);
    w.onerror = (event) => scope.deliver(n, { kind: 'failed', message: event.message || 'the Worker did not load' });
    w.postMessage(request);
  }, [id, open] as unknown as [number, object]);
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
  services: [],
  async open(sample, { services } = {}) {
    const engine = await worker({ kind: 'open', copy: `conformance-${++copies}`, seed: seedOf(sample), api: 'http://localhost:1', offline: true, ...(services ? { services: [...services] } : {}) });
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
  const copy = 'kept';
  const first = await worker({ kind: 'open', copy, seed: seedOf('basic'), api: 'http://localhost:1', offline: true });
  assert.equal(first.first.kind, 'opened');
  const second = await worker({ kind: 'open', copy, api: 'http://localhost:1', offline: true });
  assert.equal(second.first.kind, 'held');
  await second.end();
  const run = await ask<{ change: { seq: number } }>(first, 'run', { command: 'update_screen', args: { id: 'chemin', title: 'Gardé dans le navigateur' } });
  await ask(first, 'close', {});
  await first.end();

  // Opened again without a seed: what the copy kept, its change and its journal.
  const again = await worker({ kind: 'open', copy, api: 'http://localhost:1', offline: true });
  assert.equal(again.first.kind, 'opened');
  assert.equal((await ask<{ data: { title: string } }>(again, 'readScreen', { screen: 'chemin' })).data.title, 'Gardé dans le navigateur');
  const history = await ask<{ changes: { seq: number; op: string }[] }>(again, 'history', {});
  assert.deepEqual(history.changes.map((change) => [change.seq, change.op]), [[run.change.seq, 'update_screen']]);
  await ask(again, 'close', {});
  await again.end();

  const never = await worker({ kind: 'open', copy: 'never-kept', api: 'http://localhost:1', offline: true });
  assert.equal(never.first.kind, 'missing');
  await never.end();
});
