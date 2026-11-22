// The editor's miniatures in a browser (D130): what the desktop's captures are to the app's window, for a page that cannot capture a
// page. A miniature is a frame of the canvas page (`mode=thumb`: still, quiet, no free object, no medium loaded), at the course's
// reference size and scaled to the element it is shown in, given a frozen render by message. Each live frame is a canvas page host
// (canvas-page-host.ts) of its own: its own route and port for the module's files, no frames host, no hidden relay page, so no route
// of the frames and nothing for an object's code to reach.
//
//   window ── createThumbs ──┬── an element, a frame inside it (at most `limit` live frames; the others keep what the window shows)
//                            └── a measurer: one frame at the course's reference size, kept in the view and clipped to a pixel
//
// What it asks of the window: an element of its size when `show` is called, mounted only while it is seen (a browser draws no frame
// that is out of the view, and a frame is about 20 MB), `release()` when it goes (thumbs-protocol.ts). It makes a frame for an element
// 120 ms after it asks, nearest to the view first (the editor's own screen before any), and destroys it with `release()`: a frame moved
// to another parent loads again, so a frame is never given to another element.

import { createPageCanvasHost } from './canvas-page-host.ts';
import type { PageCanvasHost } from './canvas-page-host.ts';
import type { ScreenMeasurement } from './canvas-protocol.ts';
import type { RelayHost } from './relay-protocol.ts';
import { THUMB_LIMIT, THUMB_REFRESH_MS, THUMB_REFRESH_PARALLEL, THUMB_SETTLE_MS } from './thumbs-protocol.ts';
import type { Scene, SceneRender, ThumbRequestName, ThumbRequests, ThumbShown, ThumbSource } from './thumbs-protocol.ts';

export interface ThumbsOptions {
  canvasOrigin: string;
  // Gives the engine its end of a frame's route port (the same call as createPageCanvasHost's).
  relayPort(host: RelayHost, port: MessagePort): Promise<void>;
  source: ThumbSource;
  // Live frames at most (THUMB_LIMIT), and the waits of the contract (the defaults are its constants; tests shorten them).
  limit?: number;
  settleMs?: number;
  refreshMs?: number;
  refreshParallel?: number;
  // The screen of the editor's canvas: its miniature is drawn first.
  current?: () => string | null;
  // Where the measurer goes (the window's page: the body).
  mount?: HTMLElement;
  // How long a frame's `shown` is waited for, in ms (a frame the browser does not draw never answers).
  drawTimeoutMs?: number;
}

export interface Thumbs {
  show(element: HTMLElement, scene: Scene): ThumbShown;
  // The screen measured as learners see it (« Déborde à l'écran »), by a frame at the course's reference size; null when it could not be.
  measure(screen: string, language: string | null): Promise<ScreenMeasurement | null>;
  // Live frames now, those making and those drawn.
  readonly live: number;
  close(): void;
}

const MEASURER_IDLE_MS = 15000;
const FADE_MS = 120;

interface Entry {
  element: HTMLElement;
  scene: Scene;
  settled: boolean;
  released: boolean;
  // Holds one of the `limit` places (a render asked for, a frame made).
  slot: boolean;
  failed: boolean;
  settle: ReturnType<typeof setTimeout> | null;
  wrapper: HTMLElement | null;
  frame: HTMLIFrameElement | null;
  host: PageCanvasHost | null;
  size: { width: number; height: number } | null;
  version: string | null;
  renders: number;
  drawnAt: number;
  // A refresh was asked for while one was being drawn: it follows, after the wait.
  again: boolean;
  redrawing: boolean;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  resize: ResizeObserver | null;
  finish(drawn: boolean): void;
  drawn: Promise<boolean>;
}

function requestOf(scene: Scene): { name: ThumbRequestName; params: ThumbRequests[ThumbRequestName]['params'] } {
  switch (scene.kind) {
    case 'screen': return { name: 'thumbRender', params: { screen: scene.screen, ...(scene.language !== undefined ? { language: scene.language } : {}) } };
    case 'moment': return { name: 'momentRender', params: { screen: scene.screen, at: scene.at } };
    case 'block': return { name: 'blockPreviewRender', params: { args: scene.args } };
    case 'charter': {
      const args = scene.args;
      return { name: 'blockPreviewRender', params: { args: 'layout' in args ? { screen: args.screen, layout: { layout: args.layout } } : 'style' in args ? { screen: args.screen, screenStyle: args.style } : { screen: args.screen, backdrop: args.backdrop } } };
    }
  }
}
const screenOf = (scene: Scene): string | null => (scene.kind === 'block' || scene.kind === 'charter' ? scene.args.screen : scene.screen);

export function createThumbs({ canvasOrigin, relayPort, source, limit = THUMB_LIMIT, settleMs = THUMB_SETTLE_MS, refreshMs = THUMB_REFRESH_MS, refreshParallel = THUMB_REFRESH_PARALLEL, current, mount, drawTimeoutMs = 20000 }: ThumbsOptions): Thumbs {
  const entries = new Set<Entry>();
  let slots = 0;
  let refreshing = 0;
  let closed = false;
  const refreshQueue: Entry[] = [];

  const fetchRender = (scene: Scene): Promise<SceneRender> => {
    const { name, params } = requestOf(scene);
    return source.render(name, params as never) as Promise<SceneRender>;
  };
  const distance = (entry: Entry): number => {
    const box = entry.element.getBoundingClientRect();
    const dy = Math.max(0, box.top - innerHeight, -box.bottom);
    const dx = Math.max(0, box.left - innerWidth, -box.right);
    return Math.hypot(dx, dy) * 1000 + Math.abs(box.top + box.height / 2 - innerHeight / 2) + Math.abs(box.left + box.width / 2 - innerWidth / 2) / 1000;
  };
  const firstOf = (waiting: Entry[]): Entry => {
    const now = current?.() ?? null;
    return waiting.reduce((best, entry) => {
      const mine = now !== null && screenOf(entry.scene) === now;
      const theirs = now !== null && screenOf(best.scene) === now;
      if (mine !== theirs) return mine ? entry : best;
      return distance(entry) < distance(best) ? entry : best;
    });
  };

  // Rows that ask together are chosen among together: places are given a moment after the first row settles, not to the first alone.
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;
  function pumpSoon(): void {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, 30);
  }

  // The frames wanted, in the order they are asked for, while a place is free.
  function pump(): void {
    if (closed) return;
    while (slots < limit) {
      const waiting = [...entries].filter((entry) => entry.settled && !entry.slot && !entry.released && !entry.failed && !entry.frame && entry.element.isConnected);
      if (!waiting.length) return;
      void start(firstOf(waiting));
    }
  }

  function place(entry: Entry): void {
    if (!entry.wrapper || !entry.frame || !entry.size) return;
    const width = entry.element.clientWidth;
    if (!width) return;
    entry.frame.style.transform = `scale(${width / entry.size.width})`;
  }

  async function start(entry: Entry): Promise<void> {
    entry.slot = true;
    slots++;
    try {
      const made = await fetchRender(entry.scene);
      if (entry.released || closed) return;
      const host = createPageCanvasHost({ canvasOrigin, frames: false, relayPort, mount: entry.element, askTimeoutMs: drawTimeoutMs });
      const wrapper = document.createElement('div');
      wrapper.setAttribute('aria-hidden', 'true');
      wrapper.style.cssText = `position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:0;transition:opacity ${FADE_MS}ms ease`;
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', host.info.sandbox);
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('inert', '');
      frame.tabIndex = -1;
      frame.title = '';
      frame.referrerPolicy = 'no-referrer';
      frame.style.cssText = `position:absolute;left:0;top:0;width:${made.width}px;height:${made.height}px;border:0;transform-origin:0 0;pointer-events:none`;
      wrapper.append(frame);
      if (getComputedStyle(entry.element).position === 'static') entry.element.style.position = 'relative';
      entry.element.append(wrapper);
      entry.wrapper = wrapper;
      entry.frame = frame;
      entry.host = host;
      entry.size = { width: made.width, height: made.height };
      host.attach(frame);
      const address = new URL(host.info.url);
      address.searchParams.set('mode', 'thumb');
      address.searchParams.set('placing', 'editor');
      address.searchParams.set('scrollbars', 'none');
      frame.src = address.href;
      place(entry);
      if (typeof ResizeObserver === 'function') { entry.resize = new ResizeObserver(() => place(entry)); entry.resize.observe(entry.element); }
      host.push(made.render, { id: ++entry.renders });
      const shown = await host.ask('shown', { id: entry.renders }).catch(() => false);
      if (entry.released) return;
      entry.version = made.version;
      entry.drawnAt = performance.now();
      if (shown) wrapper.style.opacity = '1';
      entry.finish(shown);
    } catch {
      entry.failed = true;
      freeFrame(entry);
      entry.finish(false);
    }
  }

  function freeFrame(entry: Entry): void {
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
    entry.refreshTimer = null;
    entry.resize?.disconnect();
    entry.resize = null;
    entry.host?.close();
    entry.host = null;
    entry.wrapper?.remove();
    entry.wrapper = null;
    entry.frame = null;
    if (entry.slot) { entry.slot = false; slots--; }
    const queued = refreshQueue.indexOf(entry);
    if (queued >= 0) refreshQueue.splice(queued, 1);
    pump();
  }

  // A live frame given a new render by message when its screen may have changed: at most once every `refreshMs`, `refreshParallel` at a time,
  // the editor's screen first, and only when the render's version is not the one drawn.
  function refresh(entry: Entry): void {
    if (entry.released || !entry.host || !entry.slot || !entry.version) return;
    if (entry.redrawing) { entry.again = true; return; }
    if (entry.refreshTimer || refreshQueue.includes(entry)) return;
    const wait = refreshMs - (performance.now() - entry.drawnAt);
    if (wait > 0) { entry.refreshTimer = setTimeout(() => { entry.refreshTimer = null; refresh(entry); }, wait); return; }
    refreshQueue.push(entry);
    drain();
  }
  function drain(): void {
    while (refreshing < refreshParallel && refreshQueue.length) {
      const entry = firstOf(refreshQueue);
      refreshQueue.splice(refreshQueue.indexOf(entry), 1);
      void redraw(entry);
    }
  }
  async function redraw(entry: Entry): Promise<void> {
    refreshing++;
    entry.redrawing = true;
    try {
      const made = await fetchRender(entry.scene);
      if (entry.released || !entry.host) return;
      if (made.version !== entry.version) {
        if (entry.size && (entry.size.width !== made.width || entry.size.height !== made.height) && entry.frame) {
          entry.size = { width: made.width, height: made.height };
          entry.frame.style.width = `${made.width}px`;
          entry.frame.style.height = `${made.height}px`;
          place(entry);
        }
        entry.host.push(made.render, { id: ++entry.renders });
        await entry.host.ask('shown', { id: entry.renders }).catch(() => false);
        entry.version = made.version;
      }
    } catch { /* the thumbnail stays as it is drawn */ } finally {
      // The wait runs from the end of a redraw: a change that came during it is drawn after it, not at once.
      entry.drawnAt = performance.now();
      entry.redrawing = false;
      refreshing--;
      if (entry.again) { entry.again = false; refresh(entry); }
      drain();
    }
  }

  // ── The measurer ────────────────────────────────────────────────────────────────────────────
  let measurer: { host: PageCanvasHost; frame: HTMLIFrameElement; holder: HTMLElement; ready: boolean } | null = null;
  let measurerIdle: ReturnType<typeof setTimeout> | null = null;
  let measures: Promise<unknown> = Promise.resolve();
  let measureIds = 0;
  function dropMeasurer(): void {
    if (!measurer) return;
    measurer.host.close();
    measurer.holder.remove();
    measurer = null;
  }
  function measurerFor(size: { width: number; height: number }): PageCanvasHost {
    if (!measurer) {
      const host = createPageCanvasHost({ canvasOrigin, frames: false, relayPort, mount: mount ?? document.body, askTimeoutMs: drawTimeoutMs });
      // In the view and clipped to a pixel: a browser does not draw a frame of another site that is out of the view (Chromium and WebKit never answer).
      const holder = document.createElement('div');
      holder.setAttribute('aria-hidden', 'true');
      holder.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', host.info.sandbox);
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('inert', '');
      frame.tabIndex = -1;
      frame.title = '';
      frame.referrerPolicy = 'no-referrer';
      frame.style.cssText = 'border:0;';
      holder.append(frame);
      (mount ?? document.body).append(holder);
      host.attach(frame);
      const address = new URL(host.info.url);
      address.searchParams.set('mode', 'thumb');
      address.searchParams.set('placing', 'editor');
      address.searchParams.set('scrollbars', 'none');
      frame.src = address.href;
      measurer = { host, frame, holder, ready: true };
    }
    measurer.frame.style.width = `${size.width}px`;
    measurer.frame.style.height = `${size.height}px`;
    return measurer.host;
  }
  async function measureNow(screen: string, language: string | null): Promise<ScreenMeasurement | null> {
    if (closed) return null;
    if (measurerIdle) clearTimeout(measurerIdle);
    try {
      const made = await source.render('measureRender', { screen, language });
      const host = measurerFor(made);
      const id = `m${++measureIds}`;
      host.push(made.render, { id });
      if (!(await host.ask('shown', { id }))) return null;
      return await host.ask('measure', { id });
    } catch {
      return null;
    } finally {
      measurerIdle = setTimeout(dropMeasurer, MEASURER_IDLE_MS);
    }
  }

  return {
    show(element, scene): ThumbShown {
      let finish!: (drawn: boolean) => void;
      const drawn = new Promise<boolean>((resolve) => { finish = resolve; });
      const entry: Entry = {
        element, scene, settled: false, released: false, slot: false, failed: false, settle: null, wrapper: null, frame: null, host: null, size: null, version: null, renders: 0, drawnAt: 0, again: false, redrawing: false,
        refreshTimer: null, resize: null, finish, drawn
      };
      entries.add(entry);
      entry.settle = setTimeout(() => { entry.settle = null; entry.settled = true; pumpSoon(); }, settleMs);
      return {
        drawn,
        release() {
          if (entry.released) return;
          entry.released = true;
          if (entry.settle) clearTimeout(entry.settle);
          entries.delete(entry);
          freeFrame(entry);
          entry.finish(false);
        },
        refresh() { refresh(entry); }
      };
    },
    measure(screen, language) {
      const run = measures.then(() => measureNow(screen, language));
      measures = run.catch(() => null);
      return run;
    },
    get live() { return slots; },
    close() {
      closed = true;
      if (pumpTimer) clearTimeout(pumpTimer);
      for (const entry of [...entries]) { entry.released = true; if (entry.settle) clearTimeout(entry.settle); freeFrame(entry); entry.finish(false); }
      entries.clear();
      if (measurerIdle) clearTimeout(measurerIdle);
      dropMeasurer();
    }
  };
}
