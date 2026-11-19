// The relay: the service worker of the web app's canvas host and frames host (/relay.js, one script for
// both; D118, D119). It answers what a page of the host asks for under /canvas/ (the open module's
// files, an object's frame page and code) by asking the app's engine, through the one relay page that
// holds the request's route, and puts the host's policy on every answer it makes. It keeps nothing: no
// file, no cookie, no storage; what it knows (which page holds which route) is in memory, and the pages
// say it again when it wakes.
//
// The host's Worker writes `self.ELABORA_HOST = Object.freeze({ policy, frameAncestors, appOrigin? })`
// before this script. Without it the relay answers nothing.

import { RELAY_ANSWER_MS, isRoute, isStaticPath, parseRange, parseRelayAnswer, relayPathOf, relayRequestOf, relayResponse } from '../relay-protocol.ts';
import type { RelayAnswer, RelayRange } from '../relay-protocol.ts';
import { RELAY_PAGES } from '../relay-link.ts';
import type { RelayHostPolicy, WorkerHello, WorkerToPage } from '../relay-link.ts';
import { isRecord } from '../json.ts';

declare const self: ServiceWorkerGlobalScope & { ELABORA_HOST?: RelayHostPolicy };
// Written by the build: the script's version, which changes with it.
declare const __RELAY_VERSION__: string | undefined;
const VERSION = typeof __RELAY_VERSION__ === 'string' ? __RELAY_VERSION__ : 'development';

// Route → the client (a page) that holds it, in memory. Claims are made by the relay pages, which are
// asked nothing a route could be read from; a route is a secret of the tab that made it.
const holders = new Map<string, string>();
const startedAt = Date.now();

const pagePath = (url: string): string => new URL(url).pathname;
const isRelayPage = (url: string): boolean => RELAY_PAGES.includes(pagePath(url));

// What a host's policy says of the app: its origin, the sole ancestor of its pages when it names no other.
function appOriginOf(host: RelayHostPolicy): string | null {
  if (host.appOrigin) return host.appOrigin;
  const tokens = /^\s*frame-ancestors\s+(.+?)\s*;?\s*$/i.exec(host.frameAncestors)?.[1]?.split(/\s+/) ?? [];
  return tokens.length === 1 && /^https?:\/\/[^/*'\s]+$/.test(tokens[0]!) ? tokens[0]! : null;
}

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim().then(awake)); });
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
  const path = relayPathOf(url.pathname);
  // The host's own files (the canvas page, the player's) are the host's to serve.
  if (path === null || isStaticPath(path)) return;
  event.respondWith(serve(event, path, host));
});

// The headers of every answer the relay makes: the host's policy (frame-ancestors with it, so that a
// page that has not the app above it never shows what the relay serves), the isolation the app's page
// needs to frame it, and no referrer, which would carry a route.
function headers(host: RelayHostPolicy, extra: Record<string, string> = {}): Headers {
  return new Headers({
    'content-security-policy': host.policy,
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'cross-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...extra
  });
}

const refusal = (host: RelayHostPolicy, status: number): Response => new Response(status === 404 ? 'not found' : status === 405 ? 'method not allowed' : status === 416 ? 'range not satisfiable' : 'unavailable', { status, headers: headers(host, { 'content-type': 'text/plain; charset=utf-8' }) });

async function serve(event: FetchEvent, path: string, host: RelayHostPolicy): Promise<Response> {
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return refusal(host, 405);
  // A page of the relay's host framed by the app, or a file it asks for: never a page at the top.
  if (request.mode === 'navigate' && request.destination !== 'iframe' && request.destination !== 'frame') return refusal(host, 404);
  try {
    const route = await routeOf(event);
    if (route === null) return refusal(host, 404);
    const holder = await holderOf(route);
    if (!holder) return refusal(host, 503);
    const range = parseRange(request.headers.get('range'));
    const answer = await ask(holder, route, relayRequestOf(path, range));
    return respond(answer, range, request.method === 'HEAD', host);
  } catch {
    return refusal(host, 503);
  }
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
  const patience = Date.now() - startedAt < 3000 ? 2000 : 300;
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
    const timer = setTimeout(() => { port1.postMessage('cancel'); done({ status: 'unavailable' }); }, RELAY_ANSWER_MS + 2000);
    port1.onmessage = (event: MessageEvent<unknown>) => done(parseRelayAnswer(event.data) ?? { status: 'failed' });
    holder.postMessage({ type: 'relay/fetch', route, request } satisfies WorkerToPage, [port2]);
  });
}

// The answer a request gets (relayResponse: 200, or 206 with a Range, never 206 or 416 without one), with the host's policy.
function respond(answer: RelayAnswer, range: RelayRange | null, head: boolean, host: RelayHostPolicy): Response {
  const http = relayResponse(answer, range, head);
  if (http.status >= 400 && http.status !== 416) return refusal(host, http.status);
  return new Response(http.body, { status: http.status, headers: headers(host, http.status === 416 ? { ...http.headers, 'content-type': 'text/plain; charset=utf-8' } : http.headers) });
}
