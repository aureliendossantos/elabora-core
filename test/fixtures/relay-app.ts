// The web app's page in the relay's tests: it holds the two relay pages (the canvas and the frames host's),
// gives them a port per route, and answers the ports as the engine will: from a module's files served by
// the test (a stand-in for the engine in a Worker). window.app is what the test drives.
import { RELAY_PROTOCOL, isRoute, serveRelayPort } from '@elabora/player/relay-protocol';
import type { RelayAnswer, RelayRequest, RelaySource } from '@elabora/player/relay-protocol';
import { objectFrameHtml } from '@elabora/core/objects/bundle';

// What the test's address says is taken from closed lists and checked shapes, never put in an address as it is.
const params = new URLSearchParams(location.search);
const oneOf = <T extends string>(value: string | null, allowed: readonly T[]): T => {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`Not an allowed value: ${String(value)}`);
  return found;
};
const MODULE = oneOf(params.get('module'), ['a', 'b']);
const ROUTE = params.get('route') ?? '';
if (!isRoute(ROUTE)) throw new Error('Not a route');
const CANVAS = oneOf(params.get('canvas'), ['https://canvas.elabora.page']);
const FRAMES = oneOf(params.get('frames'), ['https://frames.elabora.page']);
const TOKEN = oneOf(params.get('token') ?? 'test-token', ['test-token']);
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

const canvas = document.createElement('iframe');
canvas.id = 'canvas';
canvas.allow = 'autoplay';
canvas.style.cssText = 'width:1280px;height:720px;border:0';
const relay = document.createElement('iframe');
relay.id = 'relay';
relay.style.display = 'none';
document.body.append(canvas, relay);

const pages: Record<string, { frame: HTMLIFrameElement; origin: string; version?: string; ready?: boolean }> = { canvas: { frame: canvas, origin: CANVAS }, frames: { frame: relay, origin: FRAMES } };
const ends: Array<() => void> = [];
addEventListener('message', (event) => {
  const data = event.data as { type?: string; host?: string; version?: string } | null;
  if (!data || typeof data.type !== 'string') return;
  log.push({ from: event.origin, ...data });
  if (!data.type.startsWith('relay/')) return;
  const host = Object.entries(pages).find(([, page]) => page.origin === event.origin && page.frame.contentWindow === event.source)?.[0];
  if (!host) return;
  const page = pages[host]!;
  if (data.type === 'relay/ready') { page.version = data.version; if (!page.ready) { page.ready = true; open(host); } }
  if (data.type === 'relay/updated') page.version = data.version;
});

function open(host: string): void {
  const page = pages[host]!;
  const channel = new MessageChannel();
  ends.push(serveRelayPort(channel.port1, source, host as 'canvas' | 'frames'));
  page.frame.contentWindow!.postMessage({ type: 'relay/open', protocol: RELAY_PROTOCOL, route: ROUTE }, page.origin, [channel.port2]);
}

let renderId = 0;
const api = {
  log, requests, pages,
  versions: () => ({ canvas: pages.canvas!.version, frames: pages.frames!.version }),
  // Said to a relay page, as the app would.
  say(host: string, message: object, ports: Transferable[] = []) { pages[host]!.frame.contentWindow!.postMessage(message, pages[host]!.origin, ports); },
  update() { for (const host of ['canvas', 'frames']) api.say(host, { type: 'relay/update', protocol: RELAY_PROTOCOL }); },
  async show(screen: string) {
    const render = await (await fetch(`/render/${MODULE}/${encodeURIComponent(screen)}.json`)).json();
    canvas.contentWindow!.postMessage({ type: 'elabora/render', id: ++renderId, token: TOKEN, render }, CANVAS);
    return renderId;
  },
  close() { for (const end of ends.splice(0)) end(); }
};
(window as unknown as { app: typeof api }).app = api;

const canvasAddress = new URL('/canvas/index.html', CANVAS);
for (const [name, value] of [['token', TOKEN], ['route', ROUTE], ['frames', FRAMES], ['scrollbars', 'none'], ['placing', 'editor']] as const) canvasAddress.searchParams.set(name, value);
canvas.src = canvasAddress.href;
relay.src = new URL('/relay.html', FRAMES).href;
