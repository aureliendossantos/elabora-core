// The miniatures' painter's page (D139): the canvas page in `mode=thumb&painter=1`, loaded once, given each render by message, which
// answers `picture` with the pixels of the screen it shows. The host shows them as an image; nothing else crosses the origins (no SVG,
// no markup: an SVG opened as a document would run in the app's origin).
//
// Two ways to draw a page, the first the browser has:
// - `drawElementImage` (HTML drawn in a canvas, on by default in Chrome stable): the page's root is moved into a canvas with
//   `layoutsubtree`, laid out at the window's size there, and drawn as the browser paints it.
// - snapdom (MIT, vendored, 3.8.3), loaded by this page only when it is needed: it copies the page's computed styles into an SVG
//   that a canvas draws inside this origin. Firefox and Safari.

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

let drawer: { kind: 'element'; canvas: ElementCanvas; root: HTMLElement } | { kind: 'snapdom' } | null = null;
let snapdomLoaded: Promise<Snapdom> | null = null;

// Made once, as the painter's page starts: where the browser draws HTML in a canvas, the page's root goes inside one.
export function preparePainter(root: HTMLElement): 'element' | 'snapdom' {
  const canvas = document.createElement('canvas') as ElementCanvas;
  canvas.setAttribute('layoutsubtree', '');
  canvas.setAttribute('content', 'drawable');
  const context = canvas.getContext('2d') as DrawingContext | null;
  if (!context || typeof context.drawElementImage !== 'function') {
    drawer = { kind: 'snapdom' };
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
  drawer = { kind: 'element', canvas, root };
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

// A part of the window (CSS px), drawn `width` px wide: a WebP (a PNG where the browser writes no WebP).
export async function drawPicture(region: LayoutRect, width: number): Promise<Blob> {
  if (!drawer) throw new Error('This page is not a painter');
  const out = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round((width * region.height) / region.width)) };
  let source: CanvasImageSource;
  let crop = region;
  if (drawer.kind === 'element') {
    const { canvas, root } = drawer;
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
    const snapdom = await loadSnapdom();
    // Drawn at the size the part needs, never larger than the window.
    const scale = Math.min(1, out.width / region.width);
    const shot = await snapdom.toCanvas(document.documentElement, { width: Math.round(innerWidth * scale), embedFonts: true, clip: 'viewport' });
    const k = shot.width / innerWidth;
    crop = { x: region.x * k, y: region.y * k, width: region.width * k, height: region.height * k };
    source = shot;
  }
  const bitmap = await createImageBitmap(source, Math.round(crop.x), Math.round(crop.y), Math.max(1, Math.round(crop.width)), Math.max(1, Math.round(crop.height)), { resizeWidth: out.width, resizeHeight: out.height, resizeQuality: 'high' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
}
