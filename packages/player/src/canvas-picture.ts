// The miniatures' painter's page (D139): the canvas page in `mode=thumb&painter=1`, loaded once, given each render by message, which
// answers `picture` with the pixels of the screen it shows. The host shows them as an image; nothing else crosses the origins (no SVG,
// no markup: an SVG opened as a document would run in the app's origin).
//
// Two ways to draw a page, the first the browser has:
// - `drawElementImage` (HTML drawn in a canvas, on by default in Chrome stable): the page's root is moved into a canvas with
//   `layoutsubtree`, laid out at the window's size there, and drawn as the browser paints it.
// - snapdom (MIT, vendored, 3.8.3), loaded by this page only when it is needed: it copies the page's computed styles into an SVG
//   that a canvas draws inside this origin. Firefox and Safari; in Chrome too for a screen whose modal layer is open (the browser's
//   top layer is outside the root the canvas draws).

import type { LayoutRect } from './canvas-protocol.ts';

// Where a page scrolls to show a block (« Ajouter un bloc »): the window, or the root a canvas holds.
export interface Scroller {
  to(top: number): void;
  top(): number;
  // How far the page runs past its window, in px.
  overflow(): number;
}
export const windowScroller: Scroller = {
  to: (top) => window.scrollTo(0, top),
  top: () => scrollY,
  overflow: () => document.documentElement.scrollHeight - innerHeight
};

const SNAPDOM_SRC = 'elabora/vendor/snapdom.js';
const PAINT_WAIT_MS = 200;
const QUALITY = 0.85;

interface ElementCanvas extends HTMLCanvasElement {
  onpaint: ((event: Event) => void) | null;
  requestPaint?(): void;
}
interface DrawingContext extends CanvasRenderingContext2D {
  drawElementImage(element: Element, x: number, y: number): void;
}
type Snapdom = { toCanvas(element: Element, options: Record<string, unknown>): Promise<HTMLCanvasElement> };

let drawer: { kind: 'element'; canvas: ElementCanvas; root: HTMLElement; fit(): void } | { kind: 'snapdom'; loads: PerformanceObserver | null } | null = null;
let snapdomLoaded: Promise<Snapdom> | null = null;
// Firefox draws the copy snapdom makes before it has decoded the images inside it (their text shows in their place); Chromium and
// WebKit do not. Read from the user agent, as no feature tells it.
const decodesLate = (): boolean => /Firefox\//.test(navigator.userAgent);
// Whether the page has loaded an image or a font since its last picture (its first: yes).
let freshFiles = true;
// What the page itself loads: not snapdom's own fetches, nor its script.
const PAGE_LOADS = new Set(['img', 'image', 'css', 'link', 'other', 'video']);
const loadedFiles = (entries: PerformanceEntryList): boolean => entries.some((entry) => PAGE_LOADS.has((entry as PerformanceResourceTiming).initiatorType));

// Made once, as the painter's page starts: where the browser draws HTML in a canvas, the page's root goes inside one.
export function preparePainter(root: HTMLElement): 'element' | 'snapdom' {
  const canvas = document.createElement('canvas') as ElementCanvas;
  canvas.setAttribute('layoutsubtree', '');
  canvas.setAttribute('content', 'drawable');
  const context = canvas.getContext('2d') as DrawingContext | null;
  if (!context || typeof context.drawElementImage !== 'function') {
    let loads: PerformanceObserver | null = null;
    if (decodesLate()) try {
      loads = new PerformanceObserver((list) => { if (loadedFiles(list.getEntries())) freshFiles = true; });
      loads.observe({ type: 'resource' });
    } catch { loads = null; }
    drawer = { kind: 'snapdom', loads };
    return 'snapdom';
  }
  canvas.id = 'elabora-painter';
  root.setAttribute('drawable', '');
  root.replaceWith(canvas);
  canvas.append(root);
  const fit = () => {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    canvas.style.cssText = `display:block;width:${innerWidth}px;height:${innerHeight}px`;
    root.style.width = `${innerWidth}px`;
    root.style.height = `${innerHeight}px`;
    root.style.overflow = 'hidden';
  };
  fit();
  addEventListener('resize', fit);
  drawer = { kind: 'element', canvas, root, fit };
  return 'element';
}

// Where this page scrolls: the root, when a canvas holds it (the document itself is the window's size then), else the window.
export function painterScroller(): Scroller {
  if (drawer?.kind !== 'element') return windowScroller;
  const { root } = drawer;
  return { to: (top) => { root.scrollTop = top; }, top: () => root.scrollTop, overflow: () => root.scrollHeight - root.clientHeight };
}

function loadSnapdom(): Promise<Snapdom> {
  snapdomLoaded ??= new Promise<Snapdom>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SNAPDOM_SRC;
    script.onload = () => {
      const snapdom = (window as unknown as { snapdom?: Snapdom }).snapdom;
      if (snapdom) resolve(snapdom); else reject(new Error('snapdom did not load'));
    };
    script.onerror = () => reject(new Error('snapdom could not be loaded'));
    document.head.append(script);
  });
  return snapdomLoaded;
}

// The page's background, under what is transparent in it.
const background = (): string => [document.body, document.documentElement].map((node) => getComputedStyle(node).backgroundColor).find((colour) => colour && colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') ?? '#fff';

// The page copied by snapdom at the size a part of the window needs (never larger than the page), and that part in the copy. The
// whole page, not the window: snapdom's clip to the window (`clip`) leaves out blocks that are in it in some layouts (a charter's
// statement screen drew its paper alone); a slide is the window's size anyway, and a scrolling page is cropped at its scroll.
async function snapshot(region: LayoutRect, width: number, loads: PerformanceObserver | null): Promise<{ source: CanvasImageSource; crop: LayoutRect }> {
  const snapdom = await loadSnapdom();
  const page = document.documentElement;
  const scale = Math.min(1, width / region.width);
  const options = { width: Math.round(page.scrollWidth * scale), embedFonts: true };
  // In Firefox, when the page has loaded files since its last picture, a first copy is made and set aside: its images are decoded
  // for the second (7 to 30 ms each there).
  if (loads) {
    if (loadedFiles(loads.takeRecords())) freshFiles = true;
    if (freshFiles) await snapdom.toCanvas(page, options);
    freshFiles = false;
  }
  const shot = await snapdom.toCanvas(page, options);
  const kx = shot.width / page.scrollWidth;
  const ky = shot.height / page.scrollHeight;
  return { source: shot, crop: { x: (region.x + scrollX) * kx, y: (region.y + scrollY) * ky, width: region.width * kx, height: region.height * ky } };
}

// A part of the window (CSS px), drawn `width` px wide: a WebP (a PNG where the browser writes no WebP).
export async function drawPicture(region: LayoutRect, width: number): Promise<Blob> {
  if (!drawer) throw new Error('This page is not a painter');
  const out = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round((width * region.height) / region.width)) };
  let source: CanvasImageSource;
  let crop = region;
  const held = drawer.kind === 'element' ? drawer.root : null;
  if (drawer.kind === 'element' && [...document.querySelectorAll('dialog')].some((dialog) => dialog.open && !held!.contains(dialog))) {
    // A modal layer is in the browser's top layer, outside the root the canvas draws: snapdom copies this screen, the root out of the
    // canvas meanwhile (its scroll kept).
    const { canvas, root } = drawer;
    const top = root.scrollTop;
    canvas.replaceWith(root);
    root.scrollTop = top;
    try {
      ({ source, crop } = await snapshot(region, out.width, null));
    } finally {
      root.replaceWith(canvas);
      canvas.append(root);
      root.scrollTop = top;
    }
  } else if (drawer.kind === 'element') {
    const { canvas, root } = drawer;
    // A page that started before its frame was laid out read a window of no size: the canvas takes the window's size now.
    if (canvas.width !== innerWidth || canvas.height !== innerHeight) drawer.fit();
    if (!innerWidth || !innerHeight) throw new Error('The painter\'s page has no size');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PAINT_WAIT_MS);
      canvas.onpaint = () => { clearTimeout(timer); resolve(); };
      canvas.requestPaint?.();
    });
    canvas.onpaint = null;
    const context = canvas.getContext('2d') as DrawingContext;
    context.fillStyle = background();
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawElementImage(root, 0, 0);
    source = canvas;
  } else {
    ({ source, crop } = await snapshot(region, out.width, drawer.loads));
  }
  // Drawn at the size asked by the canvas itself, whatever createImageBitmap's resize does in this browser.
  const bitmap = await createImageBitmap(source, Math.round(crop.x), Math.round(crop.y), Math.max(1, Math.round(crop.width)), Math.max(1, Math.round(crop.height)));
  const canvas = new OffscreenCanvas(out.width, out.height);
  const context = canvas.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, out.width, out.height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
}
