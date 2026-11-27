// The relay: the service worker of the web app's canvas host and frames host (/relay.js, one script for
// both; D118, D119). It answers what a page of the host asks for under /canvas/ (the open module's
// files, an object's frame page and code) by asking the app's engine, through the one relay page that
// holds the request's route, and puts the host's policy on every answer it makes. It keeps nothing of a
// module or a person: no module's file, no cookie; what it knows (which page holds which route) is in
// memory, and the pages say it again when it wakes. It keeps the host's own files (the canvas page, the
// player's, the relay page's), public and named in it by their SHA-256, so that the canvas opens without
// the network after a first visit (D131).
//
// The host's Worker writes `self.ELABORA_HOST = Object.freeze({ policy, frameAncestors, appOrigin? })`
// before this script. Without it the relay answers nothing.

import { RELAY_ANSWER_MS, isRoute, isStaticPath, parseRange, parseRelayAnswer, relayMayServe, relayPathOf, relayRequestOf, relayResponse } from '../relay-protocol.ts';
import type { RelayAnswer, RelayFaultStage, RelayRange } from '../relay-protocol.ts';
import { RELAY_PAGES, mayConnectToSelf } from '../relay-link.ts';
import type { RelayHostPolicy, WorkerHello, WorkerToPage } from '../relay-link.ts';
import { isRecord } from '../json.ts';

declare const self: ServiceWorkerGlobalScope & { ELABORA_HOST?: RelayHostPolicy };
// Written by the build: the script's version, which changes with it.
declare const __RELAY_VERSION__: string | undefined;
const VERSION = typeof __RELAY_VERSION__ === 'string' ? __RELAY_VERSION__ : 'development';
// Written by the build: the host's own files, by their path on the host, and the SHA-256 of each (D131).
declare const __RELAY_FILES__: Record<string, string> | undefined;
const HOST_FILES: Readonly<Record<string, string>> = typeof __RELAY_FILES__ === 'object' && __RELAY_FILES__ !== null ? __RELAY_FILES__ : {};
const CACHE_PREFIX = 'elabora-relay-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;

// Route → the client (a page) that holds it, in memory. Claims are made by the relay pages, which are
// asked nothing a route could be read from; a route is a secret of the tab that made it.
const holders = new Map<string, string>();

const pagePath = (url: string): string => new URL(url).pathname;
const isRelayPage = (url: string): boolean => RELAY_PAGES.includes(pagePath(url));

// What a host's policy says of the app: its origin, the sole ancestor of its pages when it names no other.
function appOriginOf(host: RelayHostPolicy): string | null {
  if (host.appOrigin) return host.appOrigin;
  const tokens = /^\s*frame-ancestors\s+(.+?)\s*;?\s*$/i.exec(host.frameAncestors)?.[1]?.split(/\s+/) ?? [];
  return tokens.length === 1 && /^https?:\/\/[^/*'\s]+$/.test(tokens[0]!) ? tokens[0]! : null;
}

self.addEventListener('install', (event) => {
  void self.skipWaiting();
  if (keeps()) event.waitUntil(keepHostFiles());
});
self.addEventListener('activate', (event) => { event.waitUntil(Promise.all([self.clients.claim().then(awake), dropOtherVersions()])); });
void awake();

// The relay pages hold what the worker lost: they say it again.
async function awake(): Promise<void> {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    if (isRelayPage(client.url)) client.postMessage({ type: 'relay/awake' } satisfies WorkerToPage);
  }
}

self.addEventListener('message', (event) => {
  const host = self.ELABORA_HOST;
  const source = event.source;
  const data: unknown = event.data;
  if (!host || !source || !('url' in source) || !isRecord(data) || !isRelayPage(source.url)) return;
  // A newer script that was held back (the browser stopped the running one for it, and an event of a page brought that one
  // back: the browser does not try again until it is idle for its own time): asked again, it takes over.
  if (data.type === 'relay/skip') { void self.skipWaiting(); return; }
  if (data.type === 'relay/hello') {
    event.ports[0]?.postMessage({ version: VERSION, appOrigin: appOriginOf(host) } satisfies WorkerHello);
    return;
  }
  if (data.type !== 'relay/hold' || !Array.isArray(data.routes)) return;
  event.waitUntil(hold(source.id, data.routes.filter(isRoute)));
});

// Records the routes a page holds. A route that another page holds stays with it while that page lives.
async function hold(client: string, routes: string[]): Promise<void> {
  for (const [route, holder] of holders) if (holder === client && !routes.includes(route)) holders.delete(route);
  for (const route of routes) {
    const holder = holders.get(route);
    if (holder === undefined || holder === client || !(await self.clients.get(holder))) holders.set(route, client);
  }
}

self.addEventListener('fetch', (event) => {
  const host = self.ELABORA_HOST;
  if (!host) return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // The host's own files, kept (D131); those it does not name are the host's to serve.
  if (Object.hasOwn(HOST_FILES, url.pathname) && (event.request.method === 'GET' || event.request.method === 'HEAD') && keeps()) { event.respondWith(hostFile(url.pathname)); return; }
  const path = relayPathOf(url.pathname);
  if (path === null || isStaticPath(path)) return;
  event.respondWith(serve(event, path, host));
});

// The headers of every answer the relay makes: the host's policy (frame-ancestors with it, so that a
// page that has not the app above it never shows what the relay serves), the isolation the app's page
// needs to frame it, and no referrer, which would carry a route.
//
// `inert`: an answer built from a module's file (everything but the frame page of an object) also carries `sandbox`, without
// a word after it: if a browser ever loads it as a page all the same, the page has no script and an origin of its own.
function headers(host: RelayHostPolicy, extra: Record<string, string> = {}, inert = false): Headers {
  return new Headers({
    'content-security-policy': inert ? `${host.policy}; sandbox` : host.policy,
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'cross-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...extra
  });
}

const refusal = (host: RelayHostPolicy, status: number): Response => new Response(status === 404 ? 'not found' : status === 403 ? 'forbidden' : status === 405 ? 'method not allowed' : status === 416 ? 'range not satisfiable' : 'unavailable', { status, headers: headers(host, { 'content-type': 'text/plain; charset=utf-8' }) });

async function serve(event: FetchEvent, path: string, host: RelayHostPolicy): Promise<Response> {
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return refusal(host, 405);
  // A page of the relay's host framed by the app (the frame of an object), or a file it asks for: never a page at the top, and
  // never an author's file as a page or a script (relayMayServe).
  const navigate = request.mode === 'navigate';
  if (navigate && request.destination !== 'iframe' && request.destination !== 'frame') return refusal(host, 404);
  const wanted = relayRequestOf(path);
  if (!relayMayServe(wanted, request.destination, navigate)) return refusal(host, 403);
  let route: string | null = null;
  let holder: Client | null = null;
  let stage: RelayFaultStage = 'holder';
  try {
    route = await routeOf(event);
    if (route === null) return refusal(host, 404);
    holder = await holderOf(route);
    if (!holder) { await fault(event, null, path, stage, 'no page holds the route'); return refusal(host, 503); }
    const range = parseRange(request.headers.get('range'));
    stage = 'ask';
    const answer = await ask(holder, route, relayRequestOf(path, range));
    stage = 'answer';
    const response = respond(answer, range, request.method === 'HEAD', host, wanted.kind !== 'object-frame');
    if (response.status >= 500) await fault(event, holder, path, stage, answer.status === 'ok' ? `a ${answer.part ? 'part' : 'whole file'} for a request ${range ? 'with' : 'without'} a range, ${answer.size} bytes` : `${answer.status}${answer.message ? `: ${answer.message}` : ''}`);
    return response;
  } catch (error) {
    await fault(event, holder, path, stage, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return refusal(host, 503);
  }
}

// Says to the relay page that holds the route (else the canvas page that asked), as data, what a request that is answered
// 503 or 500 caught: its path, where it failed, the error. The page tells the app. Never to a module's frame.
async function fault(event: FetchEvent, holder: Client | null, path: string, stage: RelayFaultStage, message: string): Promise<void> {
  try {
    let page: Client | null | undefined = holder;
    if (!page && event.clientId) { const asker = await self.clients.get(event.clientId); if (asker && isRelayPage(asker.url)) page = asker; }
    page?.postMessage({ type: 'relay/fault', path, stage, message: message.slice(0, 400) } satisfies WorkerToPage);
  } catch { /* nobody to tell */ }
}

// The route a request belongs to: the one in the address of a frame's page (a navigation), else the one
// in the address of the page that asks (the canvas page, or a frame's document).
async function routeOf(event: FetchEvent): Promise<string | null> {
  const fromAddress = (address: string): string | null => { const route = new URL(address).searchParams.get('route'); return isRoute(route) ? route : null; };
  if (event.request.mode === 'navigate') {
    const own = fromAddress(event.request.url);
    if (own) return own;
  }
  const client = event.clientId ? await self.clients.get(event.clientId) : undefined;
  return client ? fromAddress(client.url) : null;
}

// The page that holds the route, waiting a moment for the pages to say it again after the worker woke.
async function holderOf(route: string): Promise<Client | null> {
  // A request of the module's files that comes before its route is open (a page asks for an image in its first task; a worker
  // that has just woken, whose pages have not said again what they hold) waits for it, as long as an answer of the engine does,
  // then is answered 503: it is never left to the network, which has none of the module's files.
  const patience = RELAY_ANSWER_MS;
  for (let waited = 0; waited <= patience; waited += 100) {
    const id = holders.get(route);
    const client = id ? await self.clients.get(id) : undefined;
    if (client) return client;
    if (id) holders.delete(route);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

// Asks the page that holds the route: it asks the app's engine by the route's port.
async function ask(holder: Client, route: string, request: ReturnType<typeof relayRequestOf>): Promise<RelayAnswer> {
  const { port1, port2 } = new MessageChannel();
  return new Promise<RelayAnswer>((resolve) => {
    const done = (answer: RelayAnswer) => { clearTimeout(timer); port1.close(); resolve(answer); };
    const timer = setTimeout(() => { port1.postMessage('cancel'); done({ status: 'unavailable', message: 'the relay page gave no answer in time' }); }, RELAY_ANSWER_MS + 2000);
    port1.onmessage = (event: MessageEvent<unknown>) => done(parseRelayAnswer(event.data) ?? { status: 'failed', message: 'the page\'s answer is not one' });
    holder.postMessage({ type: 'relay/fetch', route, request } satisfies WorkerToPage, [port2]);
  });
}

// The answer a request gets (relayResponse: 200, or 206 with a Range, never 206 or 416 without one), with the host's policy.
function respond(answer: RelayAnswer, range: RelayRange | null, head: boolean, host: RelayHostPolicy, inert: boolean): Response {
  const http = relayResponse(answer, range, head);
  if (http.status >= 400 && http.status !== 416) return refusal(host, http.status);
  return new Response(http.body, { status: http.status, headers: headers(host, http.status === 416 ? { ...http.headers, 'content-type': 'text/plain; charset=utf-8' } : http.headers, inert) });
}

// ── The host's own files (D131) ───────────────────────────────────────────────────────────────
// Kept as the script installs, in a cache of its version. Any script of the host's origin can write in its cache (an object's code
// runs on the frames host, S5): a file is served from the cache only once its bytes are the ones the script names, and is then held
// in memory until the worker sleeps; its headers are the relay's own (the host's policy and isolation, the type its name says), never
// those the cache gives, which anyone could have written with the right bytes. One that does not match, or that is not kept, is
// asked of the network, and kept if its bytes match.
// It keeps them only when the policy it runs under lets it fetch its own origin; otherwise they are the host's to serve, as before.
const keeps = (): boolean => { const host = self.ELABORA_HOST; return !!host && mayConnectToSelf(host.workerPolicy ?? host.policy); };
interface HeldFile { body: ArrayBuffer }
// The type of a host's file, by its name (the files the relay names: pages, scripts, a style sheet, licences).
const TYPES: Readonly<Record<string, string>> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', txt: 'text/plain; charset=utf-8' };
const typeOf = (path: string): string => TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
const held = new Map<string, Promise<HeldFile | null>>();

const hex = (digest: ArrayBuffer): string => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
async function fileOf(response: Response | undefined, path: string): Promise<HeldFile | null> {
  if (!response || response.status !== 200) return null;
  const body = await response.arrayBuffer();
  if (hex(await crypto.subtle.digest('SHA-256', body)) !== HOST_FILES[path]) return null;
  return { body };
}
const fromNetwork = (path: string): Promise<Response> => fetch(path, { cache: 'no-cache', credentials: 'omit' });

async function keepHostFiles(): Promise<void> {
  try {
    const cache = await caches.open(CACHE);
    await Promise.all(Object.keys(HOST_FILES).map(async (path) => {
      if (await fileOf(await cache.match(path), path)) return;
      const response = await fromNetwork(path);
      if (await fileOf(response.clone(), path)) await cache.put(path, response);
    }));
  } catch { /* what is not kept now is kept when it is first served */ }
}

async function dropOtherVersions(): Promise<void> {
  for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
}

function keptFile(path: string): Promise<HeldFile | null> {
  let file = held.get(path);
  if (!file) {
    file = caches.open(CACHE).then((cache) => cache.match(path)).then((response) => fileOf(response, path)).catch(() => null);
    held.set(path, file);
  }
  return file;
}

async function hostFile(path: string): Promise<Response> {
  const kept = await keptFile(path);
  if (kept) return new Response(kept.body, { status: 200, headers: headers(self.ELABORA_HOST!, { 'content-type': typeOf(path) }) });
  held.delete(path);
  // Not kept, or not the bytes it names: the network's, kept if they are the ones.
  const response = await fromNetwork(path);
  const file = await fileOf(response.clone(), path);
  if (file) {
    held.set(path, Promise.resolve(file));
    try { await (await caches.open(CACHE)).put(path, response.clone()); } catch { /* kept in memory still */ }
  }
  return response;
}
