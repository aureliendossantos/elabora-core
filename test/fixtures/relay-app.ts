// The web app's page in the relay's tests: it holds the two relay pages (the canvas and the frames host's),
// gives them a port per route, and answers the ports as the engine will: from a module's files served by
// the test (a stand-in for the engine in a Worker). window.app is what the test drives.
import { serveRelayPort } from '@elabora/player/relay-protocol';
import type { RelayAnswer, RelayRequest, RelaySource } from '@elabora/player/relay-protocol';
import { objectFrameHtml } from '@elabora/core/objects/bundle';
import { createPageCanvasHost } from '@elabora/player/canvas-page-host';
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

const log: unknown[] = [];
const requests: RelayRequest[] = [];
const url = (path: string) => `/module/${MODULE}/${path.split('/').map(encodeURIComponent).join('/')}`;

const source: RelaySource = {
  async get(request: RelayRequest): Promise<RelayAnswer> {
    requests.push(request);
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
const host = createPageCanvasHost({
  canvasOrigin: CANVAS,
  framesOrigin: FRAMES,
  mount: document.body,
  relayPort: async (relayHost, port) => { ends.push(serveRelayPort(port, source, relayHost)); }
});
const canvas = document.createElement('iframe');
canvas.id = 'canvas';
canvas.allow = 'autoplay';
canvas.referrerPolicy = 'no-referrer';
canvas.style.cssText = 'width:1280px;height:720px;border:0';
document.body.append(canvas);
host.attach(canvas);
const canvasAddress = new URL(host.info.url);
canvasAddress.searchParams.set('scrollbars', 'none');
canvasAddress.searchParams.set('placing', 'editor');
host.onRelay((from, message) => log.push({ from, ...message }));
host.onMessage((message) => messages.push(message));

let renderId = 0;
const api = {
  log, requests, messages, host,
  info: host.info,
  versions: () => ({ canvas: host.relays().canvas.version ?? undefined, frames: host.relays().frames.version ?? undefined }),
  update: () => host.update(),
  async show(screen: string) {
    const render = await (await fetch(`/render/${MODULE}/${encodeURIComponent(screen)}.json`)).json();
    host.push(render, { id: ++renderId });
    return renderId;
  },
  // The frame of the canvas page loaded anew, as a window that shows the view again does.
  reload() { canvas.src = 'about:blank'; setTimeout(() => { canvas.src = canvasAddress.href; }, 100); },
  close() { host.close(); for (const end of ends.splice(0)) end(); }
};
(window as unknown as { app: typeof api }).app = api;

canvas.src = canvasAddress.href;
