// The editor's miniatures in a browser (D130): what the desktop's captures are to the app's window, for a page that cannot capture a
// page. A miniature is a frame of the canvas page (`mode=thumb`: still, quiet, no free object, no medium loaded), at the course's
// reference size and scaled to the element it is shown in, given a frozen render by message. Each live frame is a canvas page host
// (canvas-page-host.ts) of its own: its own route and port for the module's files, no frames host, no hidden relay page, so no route
// of the frames and nothing for an object's code to reach.
//
//   window ── createThumbs ──┬── an element, a frame inside it (at most `limit` live frames; the others keep what the window shows)
//                            └── a measurer: one frame at the course's reference size, kept in the view and clipped to a pixel
//
// What it asks of the window: an element of its size when `show` is called, `release()` when it goes (thumbs-protocol.ts). It watches
// what is in the view itself: it makes a frame for an element 120 ms after the element is in the view, nearest to the view first (the
// editor's own screen before any), and keeps the frame when the element leaves the view while a place is free, so a row that comes
// back is already drawn; when an element in the view needs a place and none is free, the frame farthest from the view goes (a browser
// draws no frame that is out of the view, and a frame is about 20 MB). A frame moved to another parent loads again, so a frame is never
// given to another element; `release()` destroys it.

import { createPageCanvasHost } from './canvas-page-host.ts';
import type { PageCanvasHost } from './canvas-page-host.ts';
import type { BlockPreviewMeasure, LayoutRect, ScreenMeasurement } from './canvas-protocol.ts';
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
  // In the view now (what the observer last said), and seen there for the wait: a frame is wanted.
  visible: boolean;
  settled: boolean;
  // A refresh asked for while out of the view: drawn when it comes back (a frame out of the view does not draw).
  stale: boolean;
  // Counts the frames made for it: a frame made, then taken for another element, ends what it was doing.
  turn: number;
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
  // What of the page the element shows (a block's preview: around the block, or the block alone); null: the whole page.
  crop: LayoutRect | null;
  // A block's preview: whether the slide runs past the window, said once, at its first drawing.
  tellOverflow: ((overflow: boolean) => void) | null;
  // A refresh was asked for while one was being drawn: it follows, after the wait.
  again: boolean;
  redrawing: boolean;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  resize: ResizeObserver | null;
  finish(drawn: boolean): void;
  drawn: Promise<boolean>;
  release(): void;
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
// A preview the author is choosing from (« Ajouter un bloc », the Charte): it opens over the miniatures of the window, which the view still counts.
const previewing = (scene: Scene): boolean => scene.kind === 'block' || scene.kind === 'charter';

// « Ajouter un bloc » (Lin 34), as the desktop's capture frames it: the block with a narrow margin around it, at the window's
// proportions, centred on it (its top when even the whole window is shorter), as large as it can be read; a small block keeps some of
// what surrounds it (`PREVIEW_LEAST` of the window's width). `mini`: the block alone, a very long block its start (three times as wide
// as it is tall at most); null when it is too small to show, and the preview is shown instead.
const PREVIEW_MARGIN = 0.035;
const PREVIEW_LEAST = 0.42;
const within = (start: number, size: number, room: number): number => Math.round(Math.max(0, Math.min(start, room - size)));
export function blockPreviewFrame(block: LayoutRect, page: { width: number; height: number }): LayoutRect {
  const ratio = page.height / page.width;
  const margin = page.width * PREVIEW_MARGIN;
  const width = Math.round(Math.min(page.width, Math.max(page.width * PREVIEW_LEAST, block.width + margin * 2, (block.height + margin * 2) / ratio)));
  const height = Math.round(width * ratio);
  const top = block.height + margin * 2 <= height ? block.y + block.height / 2 - height / 2 : block.y - margin;
  return { x: within(block.x + block.width / 2 - width / 2, width, page.width), y: within(top, height, page.height), width, height };
}
export function blockMiniFrame(block: LayoutRect, page: { width: number; height: number }): LayoutRect | null {
  const x = Math.max(0, Math.round(block.x));
  const y = Math.max(0, Math.round(block.y));
  const height = Math.min(Math.round(block.height), page.height - y);
  const width = Math.min(Math.round(block.width), page.width - x, height * 3);
  return width > 4 && height > 4 ? { x, y, width, height } : null;
}

export function createThumbs({ canvasOrigin, relayPort, source, limit = THUMB_LIMIT, settleMs = THUMB_SETTLE_MS, refreshMs = THUMB_REFRESH_MS, refreshParallel = THUMB_REFRESH_PARALLEL, current, mount, drawTimeoutMs = 20000 }: ThumbsOptions): Thumbs {
  const entries = new Set<Entry>();
  const byElement = new Map<Element, Entry>();
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
      if (previewing(entry.scene) !== previewing(best.scene)) return previewing(entry.scene) ? entry : best;
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

  // The frames wanted, in the order they are asked for, while a place is free; when none is, a frame out of the view gives its place,
  // the farthest from the view first. A preview the author chooses from comes before the miniatures under it: when every place is
  // held in the view, the miniature farthest from the middle of the view gives it its place, and takes it back once the preview goes.
  function pump(): void {
    if (closed) return;
    for (;;) {
      const waiting = [...entries].filter((entry) => entry.visible && entry.settled && !entry.slot && !entry.released && !entry.failed && entry.element.isConnected);
      if (!waiting.length) return;
      if (slots >= limit) {
        const kept = [...entries].filter((entry) => entry.slot && (!entry.visible || !entry.element.isConnected));
        const under = waiting.some((entry) => previewing(entry.scene)) ? [...entries].filter((entry) => entry.slot && !previewing(entry.scene)) : [];
        const given = kept.length ? kept : under;
        if (!given.length) return;
        const away = (entry: Entry): number => (entry.element.isConnected ? distance(entry) : Infinity);
        drop(given.reduce((far, entry) => (away(entry) > away(far) ? entry : far)));
        continue;
      }
      void start(firstOf(waiting));
    }
  }

  // What is in the view. Without an observer (an old engine of a test), everything shown is.
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((changes) => {
    for (const change of changes) {
      const entry = byElement.get(change.target);
      if (entry) seenNow(entry, change.isIntersecting);
    }
  }) : null;
  function seenNow(entry: Entry, visible: boolean): void {
    if (entry.released || entry.visible === visible) return;
    entry.visible = visible;
    if (visible) {
      if (entry.slot) {
        if (entry.stale) { entry.stale = false; refresh(entry); }
        return;
      }
      if (!entry.settled && !entry.settle) entry.settle = setTimeout(() => { entry.settle = null; if (entry.visible) { entry.settled = true; pumpSoon(); } }, settleMs);
      return;
    }
    // Gone before it was waited for, or before a place was free: it waits again when it comes back (a flick of the wheel asks for none).
    if (entry.settle) { clearTimeout(entry.settle); entry.settle = null; }
    if (!entry.slot) entry.settled = false;
    pumpSoon();
  }

  // The page at its size, scaled to the element; a part of it (a block's preview) fills the element, centred, as an image would with
  // `object-fit: cover`.
  function place(entry: Entry): void {
    if (!entry.wrapper || !entry.frame || !entry.size) return;
    const width = entry.element.clientWidth;
    if (!width) return;
    const crop = entry.crop;
    if (!crop) { entry.frame.style.transform = `scale(${width / entry.size.width})`; return; }
    const height = entry.element.clientHeight || width * (crop.height / crop.width);
    const scale = Math.max(width / crop.width, height / crop.height);
    const x = (width - crop.width * scale) / 2 - crop.x * scale;
    const y = (height - crop.height * scale) / 2 - crop.y * scale;
    entry.frame.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }
  // A block's preview, once its screen is drawn: the page fades the block's neighbours and scrolls to it (the canvas's `block-preview`),
  // says where the block is and whether the slide runs past the window, and the element shows the part around it.
  async function framed(entry: Entry, made: SceneRender): Promise<void> {
    if (entry.scene.kind !== 'block' || !entry.host || !entry.size) return;
    const { block, slides } = made as SceneRender & { block: string; slides: boolean };
    const seen: BlockPreviewMeasure | null = await entry.host.ask('block-preview', { id: entry.renders, block, slides }).catch(() => null);
    if (!seen) return;
    entry.crop = seen.block ? (entry.scene.mini ? blockMiniFrame(seen.block, entry.size) : null) ?? blockPreviewFrame(seen.block, entry.size) : null;
    place(entry);
    entry.tellOverflow?.(seen.overflow);
    entry.tellOverflow = null;
  }

  async function start(entry: Entry): Promise<void> {
    entry.slot = true;
    slots++;
    const turn = ++entry.turn;
    const ended = (): boolean => entry.released || closed || entry.turn !== turn;
    try {
      const made = await fetchRender(entry.scene);
      if (ended()) return;
      // Out of the view by now: no frame (it would not draw), and it waits again when it comes back.
      if (!entry.visible) { entry.settled = false; drop(entry); pumpSoon(); return; }
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
      if (shown) await framed(entry, made);
      if (ended()) return;
      // It left the view before it was drawn: the frame goes, and it is asked for again when the row comes back.
      if (!shown && !entry.visible) { entry.settled = false; drop(entry); pumpSoon(); return; }
      entry.version = made.version;
      entry.drawnAt = performance.now();
      if (shown) wrapper.style.opacity = '1';
      entry.finish(shown);
    } catch {
      if (ended()) return;
      entry.failed = true;
      freeFrame(entry);
      entry.finish(false);
    }
  }

  function freeFrame(entry: Entry): void {
    drop(entry);
    pump();
  }
  // The frame goes; the element keeps its place among those shown (it is drawn again when it is in the view and a place is free).
  function drop(entry: Entry): void {
    entry.turn++;
    entry.version = null;
    entry.crop = null;
    entry.stale = false;
    entry.again = false;
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
  }

  // A live frame given a new render by message when its screen may have changed: at most once every `refreshMs`, `refreshParallel` at a time,
  // the editor's screen first, and only when the render's version is not the one drawn.
  function refresh(entry: Entry): void {
    if (entry.released || !entry.host || !entry.slot || !entry.version) return;
    if (!entry.visible) { entry.stale = true; return; }
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
      if (!entry.visible) { entry.stale = true; continue; }
      void redraw(entry);
    }
  }
  async function redraw(entry: Entry): Promise<void> {
    refreshing++;
    entry.redrawing = true;
    const turn = entry.turn;
    try {
      const made = await fetchRender(entry.scene);
      if (entry.released || !entry.host || entry.turn !== turn) return;
      if (made.version !== entry.version) {
        if (entry.size && (entry.size.width !== made.width || entry.size.height !== made.height) && entry.frame) {
          entry.size = { width: made.width, height: made.height };
          entry.frame.style.width = `${made.width}px`;
          entry.frame.style.height = `${made.height}px`;
          place(entry);
        }
        entry.host.push(made.render, { id: ++entry.renders });
        const shown = await entry.host.ask('shown', { id: entry.renders }).catch(() => false);
        if (shown && entry.turn === turn) await framed(entry, made);
        if (entry.turn !== turn) return;
        if (shown) entry.version = made.version; else entry.stale = true;
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
      let tellOverflow: ((overflow: boolean) => void) | null = null;
      const overflow = scene.kind === 'block' ? new Promise<boolean>((resolve) => { tellOverflow = resolve; }) : undefined;
      const entry: Entry = {
        element, scene, visible: !observer, settled: false, stale: false, turn: 0, released: false, slot: false, failed: false, settle: null, wrapper: null, frame: null, host: null, size: null, version: null, renders: 0, drawnAt: 0,
        crop: null, tellOverflow, again: false, redrawing: false, refreshTimer: null, resize: null, finish: (done) => { finish(done); entry.tellOverflow?.(false); entry.tellOverflow = null; }, drawn, release: () => undefined
      };
      const handle: ThumbShown = {
        drawn,
        ...(overflow ? { overflow } : {}),
        release() {
          if (entry.released) return;
          entry.released = true;
          if (entry.settle) clearTimeout(entry.settle);
          entries.delete(entry);
          if (byElement.get(element) === entry) { byElement.delete(element); observer?.unobserve(element); }
          freeFrame(entry);
          entry.finish(false);
        },
        refresh() { refresh(entry); }
      };
      entry.release = handle.release;
      // An element shown again is shown once: what it showed before is released.
      byElement.get(element)?.release();
      entries.add(entry);
      if (observer) { byElement.set(element, entry); observer.observe(element); } else entry.settle = setTimeout(() => { entry.settle = null; entry.settled = true; pumpSoon(); }, settleMs);
      return handle;
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
      observer?.disconnect();
      byElement.clear();
      for (const entry of [...entries]) { entry.released = true; if (entry.settle) clearTimeout(entry.settle); drop(entry); entry.finish(false); }
      entries.clear();
      if (measurerIdle) clearTimeout(measurerIdle);
      dropMeasurer();
    }
  };
}
