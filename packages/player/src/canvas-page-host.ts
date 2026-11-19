// The host of the editor canvas for a page of the web (D121): what the desktop's local server is to the app's window
// (node/canvas/host.ts: it pushes renders to the canvas page, asks it what it shows, passes its messages on), for a
// window that shows the canvas page of another origin in a frame and has no server. Same names (push, view, ask), over
// postMessage, and it holds what links the page to the module's files: the route and the ports of the relay (D118,
// D119), the relay page of the frames host that it puts in the window, and what must be said again when a page is
// loaded anew. No Node; a window and an engine to give it the relay's ports are all it takes.
//
//   window ── createPageCanvasHost ──┬── the canvas frame (the window's): renders, views, gestures, questions
//                                     └── a hidden frame of the frames host: its relay page
//   both relay pages hold the route's port, one each; the engine answers each (serveRelayPort, the host named)
//
// What a message from a frame is worth is read here and never by the window: it must come from that frame's window,
// at its exact origin, and is read as data (parseCanvasMessage, parseRelayToApp). Every message the host posts is
// to one exact origin, never to `*`.

import { RELAY_PROTOCOL, parseRelayToApp } from './relay-protocol.ts';
import type { AppToRelay, RelayHost, RelayToApp } from './relay-protocol.ts';
import { askResultOf, parseCanvasMessage } from './canvas-parse.ts';
import { framesOrigin as originOf } from './frames.ts';
import type { AskName, CanvasAsks, CanvasMessage, HostMessage, RenderView, ScreenRender } from './canvas-protocol.ts';

export interface PageCanvasOptions {
  // The canvas host's origin and the frames host's, exact: https, or http on this computer.
  canvasOrigin: string;
  framesOrigin: string;
  // Gives the engine its end of a route's port: the window's engine client calls `relayPort { host }` with it.
  relayPort(host: RelayHost, port: MessagePort): Promise<void>;
  // Where the frames host's relay page goes: an element of the window's page (the page is hidden).
  mount: HTMLElement;
  // How long a question waits for its answer, in ms (30 s: the page's own waits are timers a busy page delays).
  askTimeoutMs?: number;
}

// What a relay page of a host last said of itself.
export interface RelayState {
  // The relay's script is active and controls the page (relay/ready).
  ready: boolean;
  // The route's port is with the page (relay/opened).
  opened: boolean;
  // The script's version, opaque.
  version: string | null;
  // The last error it reported, if any.
  error: string | null;
}

export interface PageCanvasHost {
  // The canvas page's address, its origin and its token, as the desktop's host gives (CanvasInfo): the window frames
  // `url` (and adds its own options: scrollbars=none, placing=editor) and gives the frame to `attach`.
  readonly info: { url: string; base: string; token: string };
  // The window's frame of the canvas page (null: it is gone). A page loaded again is given the last render again.
  attach(frame: HTMLIFrameElement | null): void;
  // Shows a render, or updates the one shown (the id comes back in the page's layout message).
  push(render: ScreenRender, options?: { id?: string | number }): void;
  // Changes what the page shows of the screen (step, layer, state, moment) without new data.
  view(view: Partial<RenderView>, options?: { id?: string | number }): void;
  // A message to the page (a gesture of the author: scroll, focus, lift, motion; the player's preview), with the token.
  post(message: WithoutToken<HostMessage>): void;
  // Asks the page what it shows (canvas-protocol.ts, CanvasAsks). Rejects after the timeout, and when the host closes.
  ask<Name extends AskName>(ask: Name, params: CanvasAsks[Name]['params']): Promise<CanvasAsks[Name]['result']>;
  // What the page says, read as data; its answers to questions are the questions'.
  onMessage(listener: (message: CanvasMessage) => void): () => void;
  // What the relay pages say (ready, opened, closed, refused, updated, error), read as data.
  onRelay(listener: (host: RelayHost, message: RelayToApp) => void): () => void;
  relays(): Record<RelayHost, RelayState>;
  // Asks both relay pages to look for a newer script: each answers `relay/updated` with the one it runs.
  update(): void;
  // Both relay pages hold their port: files may be asked.
  readonly opened: Promise<void>;
  // Closes the routes and removes the frames host's page; nothing is answered after.
  close(): void;
}

const ASK_TIMEOUT_MS = 30000;

type WithoutToken<T> = T extends unknown ? Omit<T, 'token'> : never;

// 128 random bits, base64url: a route, or a token.
function random(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

interface Entry {
  host: RelayHost;
  origin: string;
  frame: HTMLIFrameElement | null;
  state: RelayState;
}

export function createPageCanvasHost({ canvasOrigin, framesOrigin, relayPort, mount, askTimeoutMs = ASK_TIMEOUT_MS }: PageCanvasOptions): PageCanvasHost {
  const canvasBase = originOf(canvasOrigin);
  const framesBase = originOf(framesOrigin);
  if (!canvasBase || !framesBase || canvasBase === framesBase) throw new Error('The canvas and the frames are two origins, each https (or http on this computer)');
  const route = random();
  const token = random();
  const info = (() => {
    const url = new URL('/canvas/index.html', canvasBase);
    url.searchParams.set('token', token);
    url.searchParams.set('route', route);
    url.searchParams.set('frames', framesBase);
    return { url: url.href, base: canvasBase, token };
  })();

  const fresh = (): RelayState => ({ ready: false, opened: false, version: null, error: null });
  const entries: Record<RelayHost, Entry> = {
    canvas: { host: 'canvas', origin: canvasBase, frame: null, state: fresh() },
    frames: { host: 'frames', origin: framesBase, frame: null, state: fresh() }
  };
  const messageListeners = new Set<(message: CanvasMessage) => void>();
  const relayListeners = new Set<(host: RelayHost, message: RelayToApp) => void>();
  const asked = new Map<number, { name: AskName; resolve: (result: never) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; sent: boolean }>();
  let requests = 0;
  let closed = false;
  // What the page shows: the last render with the view as it is now, and what the current page holds.
  let last: { id?: string | number; render: ScreenRender } | null = null;
  let pageReady = false;
  let stylesHash = '';
  let resolveOpened!: () => void;
  const opened = new Promise<void>((resolve) => { resolveOpened = resolve; });

  // The hidden page of the frames host: its relay holds the frames' route.
  const hidden = document.createElement('iframe');
  hidden.setAttribute('aria-hidden', 'true');
  hidden.tabIndex = -1;
  hidden.title = 'relay';
  hidden.referrerPolicy = 'no-referrer';
  hidden.style.cssText = 'display:none;width:0;height:0;border:0';
  hidden.src = new URL('/relay.html', framesBase).href;
  entries.frames.frame = hidden;
  mount.append(hidden);

  const toPage = (message: object) => {
    const frame = entries.canvas.frame?.contentWindow;
    if (frame) frame.postMessage({ ...message, token }, canvasBase);
  };
  const toRelay = (entry: Entry, message: AppToRelay, transfer: Transferable[] = []) => entry.frame?.contentWindow?.postMessage(message, entry.origin, transfer);

  // The route's port to a relay page, and the other end to the engine.
  async function open(entry: Entry): Promise<void> {
    const channel = new MessageChannel();
    await relayPort(entry.host, channel.port1);
    if (closed) return;
    toRelay(entry, { type: 'relay/open', protocol: RELAY_PROTOCOL, route }, [channel.port2]);
  }
  function checkOpened(): void {
    if (entries.canvas.state.opened && entries.frames.state.opened) resolveOpened();
  }

  function sendLast(): void {
    if (!last) return;
    const known = !!last.render.styles && last.render.styles.hash === stylesHash;
    if (last.render.styles) stylesHash = last.render.styles.hash;
    // The page has the styles (their hash) already: they are left out, as the desktop's host does.
    const render = known ? { ...last.render, styles: undefined } : last.render;
    toPage({ type: 'elabora/render', ...(last.id !== undefined ? { id: last.id } : {}), render });
  }
  function sendPending(): void {
    for (const [request, entry] of asked) {
      if (entry.sent) continue;
      entry.sent = true;
      toPage({ type: 'elabora/ask', request, ask: entry.name, params: pendingParams.get(request) });
    }
  }
  const pendingParams = new Map<number, unknown>();

  function onWindowMessage(event: MessageEvent): void {
    if (closed) return;
    const entry = (['canvas', 'frames'] as const).map((host) => entries[host]).find((candidate) => candidate.origin === event.origin && candidate.frame?.contentWindow !== null && candidate.frame?.contentWindow === event.source);
    if (!entry) return;
    const data: unknown = event.data;
    const relayMessage = parseRelayToApp(data);
    if (relayMessage) {
      const state = entry.state;
      if (relayMessage.type === 'relay/ready') {
        state.ready = true;
        state.opened = false;
        state.version = relayMessage.version;
        // A script that took the page over, or a page loaded again, says ready again: the route is opened again.
        void open(entry).catch((error: unknown) => { state.error = error instanceof Error ? error.message : String(error); });
      } else if (relayMessage.type === 'relay/opened') { state.opened = true; checkOpened(); }
      else if (relayMessage.type === 'relay/closed') state.opened = false;
      else if (relayMessage.type === 'relay/updated') state.version = relayMessage.version;
      else if (relayMessage.type === 'relay/error') state.error = relayMessage.message;
      for (const listener of [...relayListeners]) listener(entry.host, relayMessage);
      return;
    }
    if (entry.host !== 'canvas') return;
    const message = parseCanvasMessage(data);
    if (!message) return;
    if (message.type === 'elabora/answer') {
      const waiting = asked.get(message.request);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      asked.delete(message.request);
      pendingParams.delete(message.request);
      if ('error' in message) { waiting.reject(new Error(message.error)); return; }
      const result = askResultOf(waiting.name, message.result);
      if (result.ok) waiting.resolve(result.result as never); else waiting.reject(new Error(`The canvas answered "${waiting.name}" with something that is not an answer`));
      return;
    }
    if (message.type === 'elabora/ready') {
      // The page listens (a page loaded again, or the first): what it holds is nothing; it is given what it shows.
      pageReady = true;
      stylesHash = '';
      sendLast();
      sendPending();
    }
    for (const listener of [...messageListeners]) listener(message);
  }
  window.addEventListener('message', onWindowMessage);

  return {
    info,
    attach(frame) {
      const entry = entries.canvas;
      if (entry.frame === frame) return;
      entry.frame = frame;
      entry.state = fresh();
      pageReady = false;
      stylesHash = '';
      for (const waiting of asked.values()) waiting.sent = false;
    },
    push(render, { id } = {}) {
      last = { ...(id !== undefined ? { id } : {}), render };
      if (!pageReady) return;
      sendLast();
    },
    view(view, { id } = {}) {
      if (last) last = { ...last, render: { ...last.render, view: { ...last.render.view, ...view } } };
      if (!pageReady) return;
      toPage({ type: 'elabora/view', ...(id !== undefined ? { id } : {}), view });
    },
    post(message) {
      toPage(message);
    },
    ask(name, params) {
      return new Promise((resolve, reject) => {
        if (closed) { reject(new Error('The canvas host is closed')); return; }
        const request = ++requests;
        const timer = setTimeout(() => { asked.delete(request); pendingParams.delete(request); reject(new Error(`The canvas did not answer "${name}" in ${askTimeoutMs} ms`)); }, askTimeoutMs);
        asked.set(request, { name, resolve: resolve as (result: never) => void, reject, timer, sent: false });
        pendingParams.set(request, params);
        if (pageReady) sendPending();
      });
    },
    onMessage(listener) { messageListeners.add(listener); return () => { messageListeners.delete(listener); }; },
    onRelay(listener) { relayListeners.add(listener); return () => { relayListeners.delete(listener); }; },
    relays: () => ({ canvas: { ...entries.canvas.state }, frames: { ...entries.frames.state } }),
    update() {
      for (const entry of [entries.canvas, entries.frames]) toRelay(entry, { type: 'relay/update', protocol: RELAY_PROTOCOL });
    },
    opened,
    close() {
      if (closed) return;
      for (const entry of [entries.canvas, entries.frames]) toRelay(entry, { type: 'relay/close', protocol: RELAY_PROTOCOL, route });
      closed = true;
      window.removeEventListener('message', onWindowMessage);
      for (const [request, waiting] of asked) { clearTimeout(waiting.timer); waiting.reject(new Error('The canvas host is closed')); asked.delete(request); }
      pendingParams.clear();
      messageListeners.clear();
      relayListeners.clear();
      hidden.remove();
      entries.canvas.frame = null;
    }
  };
}
