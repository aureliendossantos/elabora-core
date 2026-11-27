// The relay of the web app: what its service worker asks, and what answers it (D118). On the web the
// canvas is a page of an origin of its own, and so are the free objects' frames; the files of the open
// module (the player's pages excepted, which the host serves) are nowhere on those origins. A service
// worker, the relay, asks for each one by a message port that the app's page gave to its own page, and
// the app's engine answers there. The desktop's local server answers the same questions from the
// project's folder (RelaySource), without a service worker.
//
// Three parties and two links:
//
//   engine (a Worker of the app) ──port── relay page ──postMessage── relay (service worker) ── the browser
//   app's page ─────postMessage (a port with it)──▶ relay page
//
// 1. The relay page is a page of the relay's host (the canvas page, or the frames host's hidden page
//    that the app puts in a frame). It registers the service worker, and is the one that holds the port:
//    the service worker gives it each request of a page it controls, the page asks the port.
// 2. The app's page gives each relay page one port per route (`relay/open`, with the port): a route is
//    one view of one module in one tab, named by a random key the app makes. A request is answered by the
//    port of its own route, never by another's. The page takes it from its parent only, at the app's exact
//    origin (self.ELABORA_HOST, written by the host's Worker).
// 3. A request reaches the engine as a RelayRequest and comes back as a RelayAnswer; the relay turns
//    that into a response (status, headers, ranges). Nothing is kept by the relay.
//
// A version of the relay replaces another without reloading the app: the ports live in the pages, not in
// the service worker, which keeps nothing. A new script installs and takes the open pages over; a page
// reports its version (`relay/ready`, again as it changes), and the app, whose build knows the protocol it
// speaks, tells it to look for an update (`relay/update`) when the one it runs is older.
// Types, and the few functions both ends need. No Node, no dependency.

import { isRecord } from './json.ts';

export const RELAY_PROTOCOL = 'elabora-relay/1';

// The path the relayed files are under, on the relay's hosts and on the desktop's local server: the
// module's own paths follow it (/canvas/assets/a.png asks for assets/a.png).
export const RELAY_PREFIX = '/canvas/';

// How long a request waits for the engine's answer, in ms.
export const RELAY_ANSWER_MS = 15000;

export type RelayHost = 'canvas' | 'frames';

// A byte range of a file, as a request asks for it (`end` included): from `start` to `end` or to the
// end of the file, or the last `last` bytes.
export type RelayRange = { start: number; end?: number } | { last: number };

// What the relay asks. `file`: a file of the open module, by its path in the module (assets/a.png,
// theme/theme.css); a range when the browser asks for one. `object-frame`: the page of a free object's
// frame, as the core writes it (objectFrameHtml). `object-code`: the object's code, bundled (D117).
export type RelayRequest =
  | { kind: 'file'; path: string; range?: RelayRange }
  | { kind: 'object-frame'; object: string }
  | { kind: 'object-code'; object: string };

// A file (or a part of it) found.
export interface RelayFile {
  status: 'ok';
  // Its media type, as it is sent.
  type: string;
  // Bytes in the whole file.
  size: number;
  // sha256:… of the whole file, when known: the relay may send it as the entity tag.
  hash?: string;
  // A validator that changes when the file does, when there is no hash (a folder's file: its size and time): the
  // entity tag a local server compares with the browser's. Without either, nothing is validated.
  etag?: string;
  // The bytes, or the text. A Blob is read as it is used: a file kept by the browser goes by reference.
  body: Blob | string;
  // Set when body is only these bytes (end included) of a file of `size`: a medium taken in pieces from
  // the server. A request for a range may be answered with the whole file, or with more than was asked.
  part?: { start: number; end: number };
}

// Not served: no such file of the open module, not allowed, not here yet (a file the engine has not got
// and cannot fetch now), or failed. The relay answers 404, 403, 503, 500.
export interface RelayRefusal {
  status: 'not-found' | 'refused' | 'unavailable' | 'failed';
  message?: string;
}

export type RelayAnswer = RelayFile | RelayRefusal;

// What a host that serves the module's files implements: the engine of the browser over its storage, the
// desktop's local server over the project's folder. `signal` ends when the browser no longer waits.
export interface RelaySource {
  get(request: RelayRequest, signal?: AbortSignal): Promise<RelayAnswer>;
}

// ── The app's page and a relay page ────────────────────────────────────────────────────────────
// Every message carries `protocol`: one of another protocol is refused.

// App → relay page, posted at the relay host's origin. `relay/open` carries the port, to which the
// relay page then sends RelayPortMessages and from which it takes EnginePortMessages. An open of a
// route that is open replaces its port.
export type AppToRelay =
  | { type: 'relay/open'; protocol: string; route: string }
  | { type: 'relay/close'; protocol: string; route: string }
  | { type: 'relay/update'; protocol: string };

// Relay page → app (its parent), posted at the app's origin.
export type RelayToApp =
  // The service worker is active and controls the page: `version` is the script's, opaque, and changes
  // with it (said again when a new script takes over).
  | { type: 'relay/ready'; protocol: string; version: string; host: RelayHost }
  | { type: 'relay/opened'; protocol: string; route: string }
  | { type: 'relay/closed'; protocol: string; route: string }
  // A message not taken: another protocol, a route that is not one, no port, from a window that is not
  // the page's parent or not at the app's origin (that one is not answered at all).
  | { type: 'relay/refused'; protocol: string; reason: 'protocol' | 'route' | 'port'; route?: string }
  // The update asked for was looked for: the version now running (the same when there is none).
  | { type: 'relay/updated'; protocol: string; version: string }
  // The service worker could not be registered, or does not control the page.
  | { type: 'relay/error'; protocol: string; message: string }
  // A request of the module's files the service worker answered 503 (or another refusal it made itself), and why: the
  // file's path, where it failed, and what was caught. For the app to show or log, never for a module's frame.
  | { type: 'relay/fault'; protocol: string; path: string; stage: RelayFaultStage; message: string };

// Where a request failed: no page held its route, the page could not be asked, the answer was refused or could not be
// made into a response.
export type RelayFaultStage = 'holder' | 'ask' | 'answer';
export const RELAY_FAULT_STAGES: readonly RelayFaultStage[] = ['holder', 'ask', 'answer'];

// ── A route's port: the relay page and the engine ──────────────────────────────────────────────────
export type RelayPortMessage =
  | { type: 'relay/request'; id: number; request: RelayRequest }
  // The browser stopped waiting (a medium seeked away from): the engine may stop reading.
  | { type: 'relay/cancel'; id: number }
  // The page closed the route (relay/close, or another port for it): the engine forgets this port.
  | { type: 'relay/done' };

export type EnginePortMessage =
  | { type: 'relay/answer'; id: number; answer: RelayAnswer }
  // The module closed: nothing more is answered on this port.
  | { type: 'relay/bye' };

// ── What both ends need ──────────────────────────────────────────────────────────────────────────

// A route: what the app makes at random for a view of a module (128 bits or more, base64url).
export const isRoute = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(value);

// The Range header of a request as a range the relay asks for; null when it asks for none we serve
// (several ranges: the whole file is sent, as RFC 9110 allows).
export function parseRange(header: string | null | undefined): RelayRange | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) return { last: Number(match[2]) };
  const start = Number(match[1]);
  if (!match[2]) return { start };
  return { start, end: Number(match[2]) };
}

// The bytes (end included) of a file of `size` that a range asks for, or 'unsatisfiable'.
export function resolveRange(range: RelayRange, size: number): { start: number; end: number } | 'unsatisfiable' {
  let start: number;
  let end: number;
  if ('last' in range) {
    if (!range.last) return 'unsatisfiable';
    start = Math.max(0, size - range.last);
    end = size - 1;
  } else {
    start = range.start;
    end = range.end === undefined ? size - 1 : Math.min(range.end, size - 1);
  }
  return start >= size || start > end ? 'unsatisfiable' : { start, end };
}

// The module path a URL of a relay host asks for: what follows the prefix, decoded once; null for
// anything that is not under it, or not a path of a module (a segment of `..`, a backslash, a NUL,
// nothing). `elabora/…` and the canvas page are the host's own static files, not the module's: the
// relay lets them go to the network, the desktop's server serves them itself (`isStaticPath`).
export function relayPathOf(pathname: string): string | null {
  if (!pathname.startsWith(RELAY_PREFIX)) return null;
  let path: string;
  try { path = decodeURIComponent(pathname.slice(RELAY_PREFIX.length)); } catch { return null; }
  return isModulePath(path) ? path : null;
}

// A path of the module as the relay asks for it: segments that name something, none of `.` or `..`, no
// backslash, no NUL.
export const isModulePath = (path: string): boolean => path !== '' && !path.includes('\\') && !path.includes('\0') && !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');

// The player's own files, which the host gives: the canvas page and everything under elabora/.
export const isStaticPath = (path: string): boolean => path === 'index.html' || path.startsWith('elabora/');

// The question a module path is: the frame page and the code of an object (objects/<id>/frame.html and
// object.js), else a file. The same for the relay and the desktop's server.
export function relayRequestOf(path: string, range: RelayRange | null = null): RelayRequest {
  const object = /^objects\/([^/]+)\/(frame\.html|object\.js)$/.exec(path);
  if (object) return { kind: object[2] === 'frame.html' ? 'object-frame' : 'object-code', object: object[1]! };
  return { kind: 'file', path, ...(range ? { range } : {}) };
}

// What a request of a relay host may be, by what the browser says it is for (the request's destination, and whether it is a
// navigation): an author's file is never given as a page or as a script of the canvas host. A module's file is given to what
// shows it or reads it: an image, a font, a style, a sound, a video, a track, a plain fetch (the empty destination); never a
// document, a frame, an embed, an object, a script, a worker or its kin, which would run it on the host's origin. Only the
// frame page of an object is a navigation (the frame of an object, on the frames host), and only the code of an object is a
// script. The relay and the desktop's server decide the same way (the desktop's, from the header `Sec-Fetch-Dest`).
// If the canvas ever needs an author's page or script (a PDF shown in a frame, a component's code), it is a decision of its
// own, with its own destination and its own bound: it is not opened here.
export const FILE_DESTINATIONS: ReadonlySet<string> = new Set(['', 'image', 'font', 'style', 'audio', 'video', 'track']);
export function relayMayServe(request: RelayRequest, destination: string, navigate: boolean): boolean {
  if (request.kind === 'object-frame') return navigate && (destination === 'iframe' || destination === 'frame');
  if (navigate) return false;
  if (request.kind === 'object-code') return destination === 'script';
  return FILE_DESTINATIONS.has(destination);
}

// The HTTP status of a refusal.
export const REFUSAL_STATUS: Readonly<Record<RelayRefusal['status'], number>> = { 'not-found': 404, refused: 403, unavailable: 503, failed: 500 };

// The HTTP answer to a request, from the engine's answer: what the relay and a local server both send, written
// once. Headers are the file's own (type, length, range, entity tag); the host adds its policy and its cache
// rules. A request with a Range gets 206 with it (416 past the end of the file), whatever the source returned (the
// whole file, or only the part it had); one without never gets 206 or 416; several ranges, or a malformed one,
// get the whole file. A refusal is its status with no body (404, 403, 503, 500): the host says it in its words.
export interface RelayHttp {
  status: number;
  headers: Record<string, string>;
  body: Blob | null;
}

// A media type as a source gives it, or the one that is read as nothing.
export const safeMediaType = (type: string): string => (/^[\w.+-]+\/[\w.+-]+(?:; ?[\w-]+=[\w.-]+)*$/.test(type) ? type : 'application/octet-stream');

export function relayResponse(answer: RelayAnswer, range: RelayRange | null, head = false): RelayHttp {
  if (answer.status !== 'ok') return { status: REFUSAL_STATUS[answer.status], headers: {}, body: null };
  const blob = typeof answer.body === 'string' ? new Blob([answer.body]) : answer.body;
  const total = answer.part ? answer.size : blob.size;
  const offset = answer.part?.start ?? 0;
  const tag = answer.etag ?? answer.hash;
  const common: Record<string, string> = { 'content-type': safeMediaType(answer.type), 'accept-ranges': 'bytes', ...(tag ? { etag: `"${tag.replace(/[^\w:.+/=-]/g, '')}"` } : {}) };
  if (range === null) {
    if (answer.part) return { status: 503, headers: {}, body: null };
    return { status: 200, headers: { ...common, 'content-length': String(total) }, body: head ? null : blob };
  }
  const wanted = resolveRange(range, total);
  if (wanted === 'unsatisfiable') return { status: 416, headers: { 'content-range': `bytes */${total}` }, body: null };
  const end = answer.part ? Math.min(wanted.end, answer.part.end) : wanted.end;
  if (wanted.start < offset || wanted.start > end) return { status: 503, headers: {}, body: null };
  return { status: 206, headers: { ...common, 'content-range': `bytes ${wanted.start}-${end}/${total}`, 'content-length': String(end - wanted.start + 1) }, body: head ? null : blob.slice(wanted.start - offset, end - offset + 1) };
}

// ── Messages from another window or another thread are data: checked before they are used ────────────

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isRange(value: unknown): value is RelayRange {
  return isRecord(value) && (isCount(value.last) || (isCount(value.start) && (value.end === undefined || isCount(value.end))));
}

export function parseRelayRequest(value: unknown): RelayRequest | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'file' && typeof value.path === 'string' && isModulePath(value.path)) {
    if (value.range === undefined) return { kind: 'file', path: value.path };
    return isRange(value.range) ? { kind: 'file', path: value.path, range: value.range } : null;
  }
  if ((value.kind === 'object-frame' || value.kind === 'object-code') && typeof value.object === 'string' && /^[^/\\\0]+$/.test(value.object) && value.object !== '.' && value.object !== '..') return { kind: value.kind, object: value.object };
  return null;
}

export function parseRelayAnswer(value: unknown): RelayAnswer | null {
  if (!isRecord(value)) return null;
  if (value.status === 'ok') {
    const { type, size, hash, etag, body, part } = value;
    if (typeof type !== 'string' || !isCount(size) || !(typeof body === 'string' || body instanceof Blob)) return null;
    if (hash !== undefined && typeof hash !== 'string') return null;
    if (etag !== undefined && typeof etag !== 'string') return null;
    if (part !== undefined && !(isRecord(part) && isCount(part.start) && isCount(part.end) && part.start <= part.end && part.end < size)) return null;
    return { status: 'ok', type, size, body, ...(hash !== undefined ? { hash } : {}), ...(etag !== undefined ? { etag } : {}), ...(part !== undefined ? { part: { start: (part as { start: number }).start, end: (part as { end: number }).end } } : {}) };
  }
  if (value.status === 'not-found' || value.status === 'refused' || value.status === 'unavailable' || value.status === 'failed') return { status: value.status, ...(typeof value.message === 'string' ? { message: value.message.slice(0, 500) } : {}) };
  return null;
}

// What the relay page of a relay host takes from the app's page.
export function parseAppToRelay(value: unknown): AppToRelay | 'protocol' | 'route' | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !value.type.startsWith('relay/')) return null;
  if (value.type !== 'relay/open' && value.type !== 'relay/close' && value.type !== 'relay/update') return null;
  if (value.protocol !== RELAY_PROTOCOL) return 'protocol';
  if (value.type === 'relay/update') return { type: 'relay/update', protocol: RELAY_PROTOCOL };
  if (!isRoute(value.route)) return 'route';
  return { type: value.type, protocol: RELAY_PROTOCOL, route: value.route };
}

// What the app's page takes from a relay page. A relay page may be taken over by the code of a free object
// of the frames host (same origin), so nothing in it is trusted for more than it says: a version, a state
// of a route, a refusal. Anything else is null.
export function parseRelayToApp(value: unknown): RelayToApp | null {
  if (!isRecord(value) || value.protocol !== RELAY_PROTOCOL) return null;
  const { type } = value;
  if (type === 'relay/ready' && typeof value.version === 'string' && value.version.length <= 100 && (value.host === 'canvas' || value.host === 'frames')) return { type, protocol: RELAY_PROTOCOL, version: value.version, host: value.host };
  if ((type === 'relay/opened' || type === 'relay/closed') && isRoute(value.route)) return { type, protocol: RELAY_PROTOCOL, route: value.route };
  if (type === 'relay/refused' && (value.reason === 'protocol' || value.reason === 'route' || value.reason === 'port')) return { type, protocol: RELAY_PROTOCOL, reason: value.reason, ...(isRoute(value.route) ? { route: value.route } : {}) };
  if (type === 'relay/updated' && typeof value.version === 'string' && value.version.length <= 100) return { type, protocol: RELAY_PROTOCOL, version: value.version };
  if (type === 'relay/error' && typeof value.message === 'string') return { type, protocol: RELAY_PROTOCOL, message: value.message.slice(0, 500) };
  if (type === 'relay/fault' && typeof value.path === 'string' && typeof value.message === 'string' && RELAY_FAULT_STAGES.some((stage) => stage === value.stage)) return { type, protocol: RELAY_PROTOCOL, path: value.path.slice(0, 300), stage: value.stage as RelayFaultStage, message: value.message.slice(0, 500) };
  return null;
}

// What a port of a relay host may ask, each its own: the canvas host's page asks the module's files; the frames
// host's page, which the code of a free object can take over (D119), what an object's frame asks of the relay
// (the frame's page, its code, the files of objects/, its own folder: the course's files an object reads, by
// ctx.host.asset, the canvas page fetches and gives it, and its policy lets it fetch nothing), not the module's
// other files. One source answers both, a port each.
export function hostMayAsk(host: RelayHost, request: RelayRequest): boolean {
  return host === 'canvas' ? request.kind === 'file' : request.kind !== 'file' || request.path.startsWith('objects/');
}

// ── The engine's end of a route's port ──────────────────────────────────────────────────────────────

// Answers a route's port from a source: each request is checked, asked of the source (cancelled when the
// relay says the browser stopped waiting), and answered; a request that is not one, or that the port's host
// may not ask (hostMayAsk), is answered `refused`. `host`: the relay page the port was given to; the app makes
// one port per page, so the frames host's gets the narrower answers. Returns what ends it: it says
// `relay/bye` and closes the port. `relay/done` from the page ends it too, with no bye, and calls `done`: the
// engine keeps no port of a route that is closed.
// A message port as far as it is used here (a browser's MessagePort, or Node's).
export interface RelayPort {
  // (Declared so that both a browser's port and Node's are taken: their handlers take their own event types.)
  onmessage: null | { bivarianceHack(event: { data: unknown }): void }['bivarianceHack'];
  postMessage(message: unknown): void;
  close(): void;
}

export function serveRelayPort(port: RelayPort, source: RelaySource, host: RelayHost = 'canvas', done?: () => void): () => void {
  const running = new Map<number, AbortController>();
  let ended = false;
  const stop = () => {
    ended = true;
    for (const control of running.values()) control.abort();
    running.clear();
    port.onmessage = null;
  };
  port.onmessage = (event) => {
    const message = event.data;
    if (isRecord(message) && message.type === 'relay/done') { stop(); port.close(); done?.(); return; }
    if (!isRecord(message) || !isCount(message.id)) return;
    const id = message.id;
    if (message.type === 'relay/cancel') { running.get(id)?.abort(); running.delete(id); return; }
    if (message.type !== 'relay/request') return;
    const answer = (result: RelayAnswer) => { if (running.delete(id)) port.postMessage({ type: 'relay/answer', id, answer: result } satisfies EnginePortMessage); };
    const request = parseRelayRequest(message.request);
    if (running.has(id)) return;
    if (!request || !hostMayAsk(host, request)) { port.postMessage({ type: 'relay/answer', id, answer: { status: 'refused', message: 'Not a request of the relay' } } satisfies EnginePortMessage); return; }
    const control = new AbortController();
    running.set(id, control);
    source.get(request, control.signal).then(
      (result) => { if (!control.signal.aborted) answer(parseRelayAnswer(result) ?? { status: 'failed', message: 'Not an answer of the relay' }); },
      (error: unknown) => { if (!control.signal.aborted) answer({ status: 'failed', message: error instanceof Error ? error.message : String(error) }); }
    );
  };
  return () => {
    if (ended) return;
    stop();
    port.postMessage({ type: 'relay/bye' } satisfies EnginePortMessage);
    port.close();
  };
}
