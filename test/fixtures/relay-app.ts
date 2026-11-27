// The web app's page in the relay's tests: it holds the two relay pages (the canvas and the frames host's),
// gives them a port per route, and answers the ports as the engine will: from a module's files served by
// the test (a stand-in for the engine in a Worker). window.app is what the test drives.
import { RELAY_PROTOCOL, serveRelayPort } from '@elabora/player/relay-protocol';
import type { RelayAnswer, RelayRequest, RelaySource } from '@elabora/player/relay-protocol';
import { objectFrameHtml } from '@elabora/core/objects/bundle';
import { createPageCanvasHost } from '@elabora/player/canvas-page-host';
import { forgetHostStorage } from '@elabora/player/relay-forget';
import type { CanvasMessage } from '@elabora/player/canvas-protocol';

// What the test's address says is taken from closed lists and checked shapes, never put in an address as it is.
const params = new URLSearchParams(location.search);
const oneOf = <T extends string>(value: string | null, allowed: readonly T[]): T => {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`Not an allowed value: ${String(value)}`);
  return found;
};
const MODULE = oneOf(params.get('module'), ['a', 'b']);
const CANVAS = oneOf(params.get('canvas'), ['https://canvas.elabora.page']);
const FRAMES = oneOf(params.get('frames'), ['https://frames.elabora.page']);
// A medium answered in pieces, as the engine does while it takes it from the server.
const PARTS = params.get('parts') === '1';
// The engine's own Worker answers the ports (the test starts it with a project's files: app.startEngine), not the stand-in below.
const ENGINE = params.get('engine') === '1';
// The Lecteur's preview (chrome=live) in place of the editor's canvas.
const LIVE = params.get('chrome') === 'live';
let engineSeed!: (worker: Worker) => void;
const engineStarted = new Promise<Worker>((resolve) => { engineSeed = resolve; });
let engineRequests = 0;

const log: unknown[] = [];
// How many times the late page's port was said done (relay/done).
let lateDone = 0;
const requests: RelayRequest[] = [];
const url = (path: string) => `/module/${MODULE}/${path.split('/').map(encodeURIComponent).join('/')}`;

const source: RelaySource = {
  async get(request: RelayRequest): Promise<RelayAnswer> {
    requests.push(request);
    // A file answered 10 s late: a request still waiting when its route closes.
    if (request.kind === 'file' && request.path === 'slow/late.txt') { await new Promise((resolve) => setTimeout(resolve, 10000)); return { status: 'not-found' }; }
    if (request.kind === 'object-frame') {
      const manifest = await fetch(url(`objects/${request.object}/object.manifest.json`));
      if (!manifest.ok) return { status: 'not-found' };
      return { status: 'ok', type: 'text/html; charset=utf-8', size: 0, body: objectFrameHtml(await manifest.json(), { language: 'en' }) };
    }
    if (request.kind === 'object-code') {
      const code = await fetch(`/compiled/${MODULE}/${encodeURIComponent(request.object)}.js`);
      return code.ok ? { status: 'ok', type: 'text/javascript; charset=utf-8', size: 0, body: await code.text() } : { status: 'not-found' };
    }
    const range = request.range;
    const headers: Record<string, string> = {};
    if (PARTS && range && 'start' in range) headers.range = `bytes=${range.start}-${range.end ?? ''}`;
    const response = await fetch(url(request.path), { headers });
    if (response.status === 404) return { status: 'not-found' };
    const type = response.headers.get('content-type') ?? 'application/octet-stream';
    if (response.status === 206) {
      const [, start, end, size] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')!;
      return { status: 'ok', type, size: Number(size), body: await response.blob(), part: { start: Number(start), end: Number(end) } };
    }
    const body = await response.blob();
    return { status: 'ok', type, size: body.size, body };
  }
};

// The window's side, as the web window will have it: the canvas host for a page does the rest (the route, the ports,
// the frames host's relay page); the app gives it the engine's end of each port and the frame of the canvas page.
const ends: Array<() => void> = [];
const messages: CanvasMessage[] = [];
// A view of the module: a canvas host for a page and the frame of its canvas page. A window makes one for each view it shows
// (a layer is another one), and closes the one before it.
type Host = ReturnType<typeof createPageCanvasHost>;
let host!: Host;
let canvas!: HTMLIFrameElement;
let canvasAddress!: URL;
function startView(): void {
  host = createPageCanvasHost({
    canvasOrigin: CANVAS,
    framesOrigin: FRAMES,
    mount: document.body,
    ...(LIVE ? { chrome: 'live' as const } : {}),
    relayPort: async (relayHost, port) => {
      if (!ENGINE) { ends.push(serveRelayPort(port, source, relayHost)); return; }
      const worker = await engineStarted;
      const id = `relay-${relayHost}-${++engineRequests}`;
      const answered = new Promise<void>((resolve, reject) => worker.addEventListener('message', function listen({ data }: MessageEvent<{ kind?: string; id?: string; ok?: boolean; error?: string }>) {
        if (data.kind !== 'response' || data.id !== id) return;
        worker.removeEventListener('message', listen);
        if (data.ok) resolve(); else reject(new Error(data.error ?? 'the engine refused the port'));
      }));
      worker.postMessage({ kind: 'request', id, type: 'relayPort', params: { host: relayHost } }, [port]);
      await answered;
    }
  });
  canvas = document.createElement('iframe');
  canvas.id = 'canvas';
  canvas.allow = 'autoplay';
  canvas.referrerPolicy = 'no-referrer';
  canvas.setAttribute('sandbox', host.info.sandbox);
  canvas.style.cssText = 'width:1280px;height:720px;border:0';
  document.body.append(canvas);
  host.attach(canvas);
  canvasAddress = new URL(host.info.url);
  canvasAddress.searchParams.set('scrollbars', 'none');
  canvasAddress.searchParams.set('placing', 'editor');
  host.onRelay((from, message) => log.push({ from, ...message }));
  host.onMessage((message) => messages.push(message));
  canvas.src = canvasAddress.href;
}

let renderId = 0;
const engineEvents: string[] = [];
const api = {
  log, requests, messages,
  get host() { return host; },
  get info() { return host.info; },
  versions: () => ({ canvas: host.relays().canvas.version ?? undefined, frames: host.relays().frames.version ?? undefined }),
  update: () => host.update(),
  async show(screen: string) {
    const render = await (await fetch(`/render/${MODULE}/${encodeURIComponent(screen)}.json`)).json();
    host.push(render, { id: ++renderId });
    return renderId;
  },
  // The next view: the host and the frame of the one before are closed, a new host and a new frame come (a window does it for a layer).
  newView() { host.close(); canvas.remove(); startView(); },
  // The frame of the canvas page loaded anew, as a window that shows the view again does.
  reload() { canvas.src = 'about:blank'; setTimeout(() => { canvas.src = canvasAddress.href; }, 100); },
  // A canvas page of its own, whose route is opened after it has asked for files: a page that asks for an image in its first task.
  lateCanvas() {
    const route = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const late = document.createElement('iframe');
    late.id = 'late';
    const address = new URL('/canvas/index.html', CANVAS);
    address.searchParams.set('token', 'late');
    address.searchParams.set('route', route);
    late.src = address.href;
    document.body.append(late);
    return route;
  },
  openLate(route: string) {
    const late = document.getElementById('late') as HTMLIFrameElement;
    const channel = new MessageChannel();
    ends.push(serveRelayPort(channel.port1, source, 'canvas', () => { lateDone++; }));
    late.contentWindow!.postMessage({ type: 'relay/open', protocol: RELAY_PROTOCOL, route }, CANVAS, [channel.port2]);
  },
  // The late page's route closed by the window: its page says relay/done on the port, which the engine's end reads.
  closeLate(route: string) {
    const late = document.getElementById('late') as HTMLIFrameElement;
    late.contentWindow!.postMessage({ type: 'relay/close', protocol: RELAY_PROTOCOL, route }, CANVAS);
  },
  lateDone: () => lateDone,
  // What the player keeps on both hosts, emptied as at a sign-out.
  forget: () => forgetHostStorage({ origins: [CANVAS, FRAMES] }),
  // The engine's Worker, opened on a project's files (the seed), offline; services: those it is given (the canvas: its renders
  // go to the view's host as the window gives them).
  async startEngine(seed: unknown, services?: string[], mediaWorker?: string) {
    const worker = new Worker('/engine-worker.js', { type: 'module' });
    await new Promise((resolve) => { worker.onmessage = ({ data }) => resolve(data); worker.postMessage({ kind: 'open', team: 'tm_test', project: 'relay-engine', seed: { ...(seed as { link: object }), link: { ...(seed as { link: object }).link, project: 'relay-engine' } }, api: 'http://localhost:1', offline: true, services: ['canvas'], ...(services ? { services } : {}), ...(mediaWorker ? { mediaWorker } : {}) }); });
    worker.onmessage = null;
    worker.addEventListener('message', ({ data }: MessageEvent<{ kind?: string; event?: { type: string; id: string | number; render?: unknown; view?: unknown } }>) => {
      if (data.kind !== 'event' || !data.event) return;
      engineEvents.push(data.event.type);
      if (data.event.type === 'canvasRender') host.push(data.event.render as Parameters<Host['push']>[0], { id: data.event.id });
      if (data.event.type === 'canvasView') host.view(data.event.view as Parameters<Host['view']>[0], { id: data.event.id });
    });
    engineSeed(worker);
  },
  engineEvents,
  // A request of the protocol to the engine's Worker: its answer, or null when none came within ms.
  async engine(type: string, params: unknown, ms = 15000): Promise<{ ok: boolean; result?: unknown; error?: unknown } | null> {
    const worker = await engineStarted;
    const id = `test-${type}-${++engineRequests}`;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { worker.removeEventListener('message', listen); resolve(null); }, ms);
      function listen({ data }: MessageEvent<{ kind?: string; id?: string; ok?: boolean; result?: unknown; error?: unknown }>) {
        if (data.kind !== 'response' || data.id !== id) return;
        clearTimeout(timer);
        worker.removeEventListener('message', listen);
        resolve({ ok: !!data.ok, result: data.result, error: data.error });
      }
      worker.addEventListener('message', listen);
      worker.postMessage({ kind: 'request', id, type, params });
    });
  },
  // A request to the engine's Worker (after startEngine): what the renders of a screen name is declared to the relay's source by it.
  async engineCall(type: string, params: unknown): Promise<{ ok: boolean; result?: unknown }> {
    const worker = await engineStarted;
    const id = `call-${++engineRequests}`;
    return new Promise((resolve) => {
      worker.addEventListener('message', function listen({ data }: MessageEvent<{ kind?: string; id?: string; ok?: boolean; result?: unknown }>) {
        if (data.kind !== 'response' || data.id !== id) return;
        worker.removeEventListener('message', listen);
        resolve({ ok: !!data.ok, result: data.result, error: (data as { error?: unknown }).error } as { ok: boolean; result?: unknown });
      });
      worker.postMessage({ kind: 'request', id, type, params });
    });
  },
  close() { host.close(); for (const end of ends.splice(0)) end(); }
};
(window as unknown as { app: typeof api }).app = api;

startView();
