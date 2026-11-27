// The editor's miniatures in a browser as images (D139): one painter (canvas-painter.ts) draws the scenes in the view that have no image
// for their render's version yet, one at a time, in the order of thumbs-order.ts; each image is kept by its version (D133), so that a
// retouch draws again only the miniature of the screen it changed, and a row seen again shows its image at once. An element shows its
// image in an <img>: pixels only, a WebP or a PNG, never markup.
//
// The live frames of D130 (canvas-thumbs.ts, `createLiveThumbs`) stay the fallback: where the browser cannot make images, and for every
// scene once the painter has failed twice in a row (said in the log). The measurer stays a live frame.

import { createPainter } from './canvas-painter.ts';
import type { Painter, PictureAsk } from './canvas-painter.ts';
import type { Thumbs, ThumbsOptions } from './canvas-thumbs.ts';
import { THUMB_SETTLE_MS } from './thumbs-protocol.ts';
import type { Scene, SceneRender, ThumbShown } from './thumbs-protocol.ts';
import { firstOf, requestOf } from './thumbs-order.ts';
import type { BlockRender } from './thumbs-order.ts';

// How long a painter rests before it goes, where it is not kept (Chromium, Firefox): long enough that the retouches of a working session
// do not pay a new painter each (0.26 to 0.38 s), short enough that a list at rest gives its memory back.
export const PAINTER_IDLE_MS = 30000;
// The image's width for a scene, in px: a screen as the desktop keeps it (640), a block alone in the list's small box.
const SCREEN_WIDTH = 640;
const MINI_WIDTH = 96;
// The images kept in memory, at most, in bytes (about 15 to 100 KB each).
const KEPT_BYTES = 48 * 1024 * 1024;
// Failures in a row after which every scene goes to the live frames.
const FAILURES = 2;
const FADE_MS = 120;

interface Kept {
  image: Blob;
  url: string;
  overflow: boolean;
  used: number;
  // Elements that show it now.
  showing: number;
}

interface Entry {
  element: HTMLElement;
  scene: Scene;
  visible: boolean;
  settled: boolean;
  settle: ReturnType<typeof setTimeout> | null;
  released: boolean;
  // The version and image key it shows (null: none yet), and whether its scene may have changed since.
  key: string | null;
  wanted: boolean;
  holder: HTMLElement | null;
  live: ThumbShown | null;
  finish(drawn: boolean): void;
  tellOverflow: ((overflow: boolean) => void) | null;
}

// Whether this browser makes the painter's images and shows them: the page needs OffscreenCanvas and createImageBitmap (every
// browser Elabora runs in has them); a test or a host may also ask for the live frames.
export const imagesHere = (): boolean => typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function' && typeof IntersectionObserver === 'function';

// WebKit keeps memory for each document a frame loads: its painter lives as long as the miniatures. Read from the user agent, as no
// feature tells it.
export const keepsPainter = (): boolean => typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/(Chrome|Chromium|CriOS|Edg|Firefox|FxiOS)\//.test(navigator.userAgent);

export function createImageThumbs(options: ThumbsOptions, live: Thumbs): Thumbs {
  const { canvasOrigin, relayPort, source, current, mount, settleMs = THUMB_SETTLE_MS, drawTimeoutMs = 20000 } = options;
  const log = options.log ?? ((message: string) => console.warn(`[elabora] ${message}`));
  const painter: Painter = createPainter({ canvasOrigin, relayPort, ...(mount ? { mount } : {}), keep: options.keepPainter ?? keepsPainter(), idleMs: options.painterIdleMs ?? PAINTER_IDLE_MS, timeoutMs: drawTimeoutMs });
  const entries = new Set<Entry>();
  const byElement = new Map<Element, Entry>();
  const handles = new Map<Element, ThumbShown>();
  const kept = new Map<string, Kept>();
  let keptBytes = 0;
  let failures = 0;
  let broken = false;
  let busy = false;
  let closed = false;

  // Made as the miniatures are (the module opening): its page loads, and a new profile's slow first frames pass, before the list shows.
  painter.warm();
  const hidden = (): boolean => document.visibilityState === 'hidden';
  const fetchRender = (scene: Scene): Promise<SceneRender> => {
    const { name, params } = requestOf(scene);
    return source.render(name, params as never) as Promise<SceneRender>;
  };
  const askOf = (scene: Scene, made: SceneRender): PictureAsk => {
    if (scene.kind !== 'block') return { width: SCREEN_WIDTH };
    const { block, slides } = made as BlockRender;
    return { width: scene.mini ? MINI_WIDTH : SCREEN_WIDTH, block, slides, ...(scene.mini ? { mini: true } : {}) };
  };
  // The image of a render as an element asks for it: its version, and what of the page it shows.
  const keyOf = (made: SceneRender, ask: PictureAsk): string => `${made.version}|${ask.width}|${ask.block ?? ''}|${ask.mini ? 'mini' : ''}`;

  // ── What is in the view ───────────────────────────────────────────────────────────────────────
  const observer = new IntersectionObserver((changes) => {
    for (const change of changes) {
      const entry = byElement.get(change.target);
      if (entry) seenNow(entry, change.isIntersecting);
    }
  });
  function seenNow(entry: Entry, visible: boolean): void {
    if (entry.released || entry.live || entry.visible === visible) return;
    entry.visible = visible;
    if (visible) {
      if (!entry.settled && !entry.settle) entry.settle = setTimeout(() => { entry.settle = null; if (entry.visible) { entry.settled = true; pumpSoon(); } }, settleMs);
      return;
    }
    if (entry.settle) { clearTimeout(entry.settle); entry.settle = null; }
    entry.settled = false;
  }
  const seenAgain = (): void => { if (!hidden()) pumpSoon(); };
  document.addEventListener('visibilitychange', seenAgain);

  // ── The images kept ───────────────────────────────────────────────────────────────────────────
  function keep(key: string, image: Blob, overflow: boolean): Kept {
    const known = kept.get(key);
    if (known) return known;
    const made: Kept = { image, url: URL.createObjectURL(image), overflow, used: performance.now(), showing: 0 };
    kept.set(key, made);
    keptBytes += image.size;
    // The least used first, among those no element shows.
    for (const [other, held] of [...kept].sort((a, b) => a[1].used - b[1].used)) {
      if (keptBytes <= KEPT_BYTES) break;
      if (held.showing || other === key) continue;
      URL.revokeObjectURL(held.url);
      kept.delete(other);
      keptBytes -= held.image.size;
    }
    return made;
  }
  function show(entry: Entry, key: string, made: Kept): void {
    made.used = performance.now();
    if (entry.key === key) return;
    const before = entry.key ? kept.get(entry.key) : null;
    if (before) before.showing--;
    made.showing++;
    entry.key = key;
    const image = document.createElement('img');
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    image.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover';
    image.src = made.url;
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = `position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:${entry.holder ? 1 : 0};transition:opacity ${FADE_MS}ms ease`;
    holder.append(image);
    const previous = entry.holder;
    void image.decode().catch(() => {}).then(() => {
      if (entry.released || entry.key !== key) { holder.remove(); return; }
      if (getComputedStyle(entry.element).position === 'static') entry.element.style.position = 'relative';
      entry.element.append(holder);
      previous?.remove();
      requestAnimationFrame(() => { holder.style.opacity = '1'; });
      entry.tellOverflow?.(made.overflow);
      entry.tellOverflow = null;
      entry.finish(true);
    });
    entry.holder = holder;
  }

  // ── The painter's work, one scene at a time ───────────────────────────────────────────────────
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;
  function pumpSoon(): void {
    if (pumpTimer || closed) return;
    pumpTimer = setTimeout(() => { pumpTimer = null; void pump(); }, 30);
  }
  async function pump(): Promise<void> {
    if (busy || closed || hidden()) return;
    const waiting = [...entries].filter((entry) => entry.visible && entry.settled && entry.wanted && !entry.released && !entry.live && entry.element.isConnected);
    if (!waiting.length) return;
    const entry = firstOf(waiting, current?.() ?? null);
    busy = true;
    entry.wanted = false;
    try {
      const made = await fetchRender(entry.scene);
      const ask = askOf(entry.scene, made);
      const key = keyOf(made, ask);
      let held = kept.get(key);
      if (!held && !entry.released) {
        const painted = await painter.paint(made, ask);
        failures = 0;
        held = keep(key, painted.image, painted.overflow);
      }
      if (held && !entry.released && !closed) show(entry, key, held);
    } catch (error) {
      if (!closed && !entry.released) failed(entry, error);
    } finally {
      busy = false;
      if (!closed) pumpSoon();
    }
  }
  function failed(entry: Entry, error: unknown): void {
    // A tab hidden meanwhile serves the painter no animation frame: not the painter's failure; drawn again when the tab is seen.
    if (hidden()) { entry.wanted = true; return; }
    failures++;
    const why = error instanceof Error ? error.message : String(error);
    if (failures < FAILURES && !broken) {
      log(`A miniature's image could not be made (${why}); tried again.`);
      entry.wanted = true;
      return;
    }
    if (!broken) {
      broken = true;
      log(`The miniatures' painter failed ${failures} times in a row (${why}): live frames show the miniatures from now on.`);
      painter.close();
    }
    for (const each of entries) toLive(each);
  }
  // The scene in a live frame (D130), the image it showed kept until the frame is drawn.
  function toLive(entry: Entry): void {
    if (entry.live || entry.released) return;
    entry.live = live.show(entry.element, entry.scene);
    if (entry.tellOverflow) { const tell = entry.tellOverflow; entry.tellOverflow = null; void (entry.live.overflow ?? Promise.resolve(false)).then(tell); }
    void entry.live.drawn.then((drawn) => { if (drawn) { entry.holder?.remove(); entry.holder = null; } entry.finish(drawn); });
    observer.unobserve(entry.element);
  }

  return {
    show(element, scene): ThumbShown {
      let finish!: (drawn: boolean) => void;
      let done = false;
      const drawn = new Promise<boolean>((resolve) => { finish = resolve; });
      let tellOverflow: ((overflow: boolean) => void) | null = null;
      const overflow = scene.kind === 'block' ? new Promise<boolean>((resolve) => { tellOverflow = resolve; }) : undefined;
      const entry: Entry = {
        element, scene, visible: false, settled: false, settle: null, released: false, key: null, wanted: true, holder: null, live: null, tellOverflow,
        finish: (drawnNow) => { if (done) return; done = true; finish(drawnNow); if (!drawnNow) { entry.tellOverflow?.(false); entry.tellOverflow = null; } }
      };
      const handle: ThumbShown = {
        drawn,
        ...(overflow ? { overflow } : {}),
        release() {
          if (entry.released) return;
          entry.released = true;
          if (entry.settle) clearTimeout(entry.settle);
          entries.delete(entry);
          if (byElement.get(element) === entry) { byElement.delete(element); handles.delete(element); observer.unobserve(element); }
          const held = entry.key ? kept.get(entry.key) : undefined;
          if (held) held.showing--;
          entry.holder?.remove();
          entry.holder = null;
          entry.live?.release();
          entry.finish(false);
        },
        // Drawn again when its render's version changes: now if it is in the view, else when it comes back.
        refresh() {
          if (entry.released) return;
          if (entry.live) { entry.live.refresh(); return; }
          entry.wanted = true;
          if (entry.visible && entry.settled) pumpSoon();
        }
      };
      // An element shown again is shown once: what it showed before is released.
      handles.get(element)?.release();
      entries.add(entry);
      byElement.set(element, entry);
      handles.set(element, handle);
      if (broken) toLive(entry); else observer.observe(element);
      return handle;
    },
    measure: (screen, language) => live.measure(screen, language),
    get live() { return (painter.alive ? 1 : 0) + live.live; },
    close() {
      closed = true;
      if (pumpTimer) clearTimeout(pumpTimer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', seenAgain);
      for (const entry of entries) { entry.released = true; if (entry.settle) clearTimeout(entry.settle); entry.live?.release(); entry.holder?.remove(); entry.finish(false); }
      entries.clear();
      byElement.clear();
      handles.clear();
      painter.close();
      for (const held of kept.values()) URL.revokeObjectURL(held.url);
      kept.clear();
      live.close();
    }
  };
}
