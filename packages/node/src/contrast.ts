import { createRequire } from 'node:module';
import type { CDPSession, Page } from 'playwright-core';
import { browserIdentity } from './emulator/browser.ts';

const require = createRequire(import.meta.url);

export interface MeasuredContrast {
  block: string | null;
  text: string;
  ratio: number;
  need: number;
  // Found with animations on, as the page scrolls (scroll presentation): text that a scroll-driven
  // animation leaves too faint where it is read, in the middle of the window.
  scrolled?: true;
}

// In the page: whether an animation that follows the scroll (a scroll or view timeline) is running,
// on an element in this band of the window (any band: null). An element without a box (display:
// contents) counts as everywhere.
export function scrollDrivenIn(band: Band | null): boolean {
  const top = band ? innerHeight * band.top : -Infinity;
  const bottom = band ? innerHeight * band.bottom : Infinity;
  return document.getAnimations().some((animation) => {
    if (!animation.timeline || animation.timeline instanceof DocumentTimeline) return false;
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    if (!target || !band) return true;
    const box = target.getBoundingClientRect();
    if (!box.width && !box.height) return true;
    return box.bottom > top && box.top < bottom && box.right > 0 && box.left < innerWidth;
  });
}

// ── Measured contrast ────────────────────────────────────────────────
// Static checks compare text tokens with the surface token; over a backdrop, an image or a gradient
// the real background is only known in pixels. The text of the window is located, made transparent,
// the window captured, and for every element its colour is compared with the pixels behind its
// lines: 90 % of them must reach WCAG 1.4.3 (4.5:1, 3:1 for large text). Text shadows stay: a
// halo behind the letters is what readers see them against. Transitions stop at once: with
// animations on, a colour transition would still show the text in the capture of its background.
const HIDE_TEXT = '*, *::before, *::after, *::marker { color: transparent !important; -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important; caret-color: transparent !important; transition: none !important; }';
// The window as it is, or (wholePage: a page of scroll presentation) every window down the page,
// each element kept once with its lowest ratio.
// band: the part of the window read (fractions of its height from the top), default all of it.
export interface Band { top: number; bottom: number }
// keep: "worst", the lowest ratio of an element over the windows (what does not move); "best", the
// highest (with animations on: text that a scroll-driven entrance shows as it reaches the middle of
// the window is read then; text never readable there is reported). stride: share of a window.
// With "best", text once readable is not read again, nor text already reported (known): neither can
// be reported any more. scrollDriven: only the windows where a scroll-driven animation applies to
// the band.
interface ContrastOptions { keep?: 'worst' | 'best'; stride?: number; known?: ReadonlySet<string>; scrollDriven?: boolean }
export async function measureContrast(page: Page, wholePage = false, band: Band = { top: 0, bottom: 1 }, { keep = 'worst', stride: share = 0.85, known, scrollDriven = false }: ContrastOptions = {}): Promise<MeasuredContrast[]> {
  const tops: (number | null)[] = wholePage ? await page.evaluate((share) => {
    const end = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const stride = Math.max(160, Math.round(innerHeight * share));
    const out: number[] = [];
    for (let top = 0; top < end; top += stride) out.push(top);
    out.push(end);
    return out;
  }, share) : [null];
  const found = new Map<string, MeasuredContrast>();
  const settled = new Set<string>(known);
  for (const top of tops) {
    if (top !== null) await page.evaluate((y) => { scrollTo(0, y); }, top);
    if (scrollDriven && !(await page.evaluate(scrollDrivenIn, band))) continue;
    for (const measured of await contrastInWindow(page, band, keep === 'best' ? settled : undefined)) {
      const key = `${measured.block}\u0000${measured.text}`;
      const before = found.get(key);
      if (!before || (keep === 'worst' ? measured.ratio < before.ratio : measured.ratio > before.ratio)) found.set(key, measured);
      if (keep === 'best' && measured.ratio >= measured.need) settled.add(key);
    }
  }
  if (wholePage) await page.evaluate(() => { scrollTo(0, 0); });
  return [...found.values()].filter((measured) => measured.ratio < measured.need);
}
// skip: text (block and text) not to read.
async function contrastInWindow(page: Page, band: Band, skip?: ReadonlySet<string>): Promise<MeasuredContrast[]> {
  // With animations on, transitions are settled first: those of a state change (a screen, a step), and
  // the colour transitions that removing HIDE_TEXT starts (.t-btn: color .2s) after the last window,
  // or the text is read still fading in, more or less depending on timing.
  await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation instanceof CSSTransition) animation.finish(); });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const runs = (await page.evaluate(textRuns, band)).filter((run) => !skip?.has(`${run.block}\u0000${run.text}`));
  if (!runs.length) return [];
  const style = await page.addStyleTag({ content: HIDE_TEXT });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pixels = await windowPixels(page);
  await style.evaluate((node) => { node.parentNode?.removeChild(node); });
  return contrastBehind(pixels, runs);
}

// The window's pixels, captured at half its size (a CSS pixel in four: the backgrounds text is read
// against are smooth at that scale, and a capture costs a quarter) and decoded here. Chrome encodes
// the PNG for speed (lossless, larger). The capture comes through a DevTools session of its own:
// Chrome's needs the window size Playwright emulates (else it captures the headless window's own);
// Elabora's Electron is not emulated and draws at the screen's pixel ratio, which the scale asked
// for then allows for (device: device pixels per CSS pixel). The ratio is learnt once per page from
// a capture of 100 CSS pixels (its width is in the PNG's header, bytes 16 to 19, and is exact to a
// hundredth), so every window is read at half scale whatever the screen.
const CONTRAST_SCALE = 0.5;
const RATIO_PROBE = 100;
interface Pixels { width: number; height: number; data: Uint8Array; scale: number }
const capturing = new WeakMap<Page, Promise<{ session: CDPSession; device: number }>>();
async function windowPixels(page: Page): Promise<Pixels> {
  const view = await page.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }));
  let capture = capturing.get(page);
  if (!capture) {
    capture = (async () => {
      const session = await page.context().newCDPSession(page);
      const browser = page.context().browser();
      if (!browser || browserIdentity(browser).engine !== 'electron') await session.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: false });
      const { data } = await session.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { x: view.x, y: view.y, width: RATIO_PROBE, height: RATIO_PROBE, scale: 1 } });
      return { session, device: Math.max(1, Buffer.from(data, 'base64').readUInt32BE(16) / RATIO_PROBE) };
    })();
    capturing.set(page, capture);
    // Learnt again next time when it failed.
    capture.catch(() => capturing.delete(page));
  }
  const state = await capture;
  const asked = CONTRAST_SCALE / state.device;
  const { data } = await state.session.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { x: view.x, y: view.y, width: view.width, height: view.height, scale: asked } });
  const image = readPng(Buffer.from(data, 'base64'));
  return { ...image, scale: image.width / view.width };
}

// pngjs: an optional dependency of @elabora/node, installed with the command line and the app.
interface PngModule { PNG: { sync: { read(data: Buffer): { width: number; height: number; data: Buffer } } } }
function readPng(png: Buffer): { width: number; height: number; data: Uint8Array } {
  let pngjs: PngModule;
  try { pngjs = require('pngjs'); } catch { throw new Error('pngjs is not installed: npm install pngjs'); }
  return pngjs.PNG.sync.read(png);
}

type Rgba = [number, number, number, number];
type Rect = [number, number, number, number]; // left, top, right, bottom

// Visible text of an element: colour, size class and line boxes.
interface TextRun {
  block: string | null;
  text: string;
  fg: Rgba;
  large: boolean;
  rects: Rect[];
}

// In the page: visible text of the band of the window, grouped by element.
function textRuns(band: Band = { top: 0, bottom: 1 }): TextRun[] {
  const out = new Map<Element, TextRun>();
  // Any CSS colour (rgb(), color(srgb …) from color-mix(), …) to 0–255 RGBA, through a canvas.
  const pen = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!pen) return [];
  const rgba = (css: string): Rgba => { pen.clearRect(0, 0, 1, 1); pen.fillStyle = css; pen.fillRect(0, 0, 1, 1); const pixel = pen.getImageData(0, 0, 1, 1).data; return [pixel[0], pixel[1], pixel[2], pixel[3] / 255]; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  // Opacity of an element and its ancestors (a block faded by an animation), once per element.
  const opacities = new Map<Element, number>();
  const opacityOf = (element: Element | null): number => {
    if (!element || element === document.documentElement) return 1;
    const known = opacities.get(element);
    if (known !== undefined) return known;
    const value = (parseFloat(getComputedStyle(element).opacity) || 0) * opacityOf(element.parentElement);
    opacities.set(element, value);
    return value;
  };
  // Text that has scrolled under a bar that stays in the window (the player's bars, D58) is hidden by
  // it: only what is between them is read.
  const stuck = (selector: string) => { const bar = document.querySelector<HTMLElement>(selector); return bar && !bar.hidden && getComputedStyle(bar).position === 'sticky' ? bar : null; };
  const footer = stuck('.t-bar--bottom') ?? stuck('.t-bar--controls');
  const header = stuck('.t-bar--top');
  // A few pixels off their edges: the capture at half scale blends the line of pixels along a bar
  // with the bar, which is not behind the text cut there (it is read whole in another window).
  const EDGE = 4;
  const fold = footer ? footer.getBoundingClientRect().top - EDGE : innerHeight;
  const ceiling = header ? header.getBoundingClientRect().bottom + EDGE : 0;
  // Text a box of 1 px clips away is read by screen readers only (the visually hidden pattern: a
  // chart's table, a live region): it is not read against the pixels where it would be.
  const clipped = new Map<Element, boolean>();
  const clippedAway = (element: Element | null): boolean => {
    if (!element || element === document.body) return false;
    const known = clipped.get(element);
    if (known !== undefined) return known;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const hides = style.clipPath === 'inset(50%)' || /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(style.clip) || (style.overflow !== 'visible' && box.width <= 1 && box.height <= 1);
    const value = hides || clippedAway(element.parentElement);
    clipped.set(element, value);
    return value;
  };
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = node.textContent ?? '';
    if (!data.trim()) continue;
    const element = node.parentElement;
    if (!element) continue;
    // Where the text is first (layout is done): text outside the band is not looked at further.
    range.selectNodeContents(node);
    const inBar = !!element.closest('.t-bar');
    const top = Math.max(innerHeight * band.top, inBar ? 0 : ceiling);
    const bottom = Math.min(inBar ? innerHeight : fold, innerHeight * band.bottom);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 2 && rect.height > 2 && rect.bottom > top && rect.top < bottom && rect.right > 0 && rect.left < innerWidth)
      .map((rect): Rect => [Math.max(0, rect.left), Math.max(top, rect.top), Math.min(innerWidth, rect.right), Math.min(bottom, rect.bottom)]);
    if (!rects.length) continue;
    if (element.closest('.t-backdrop, .t-sr-only, [aria-hidden="true"], [inert], [aria-disabled="true"], :disabled, script, style') || clippedAway(element)) continue;
    // Not rendered: closed disclosures (content-visibility), hidden or fully transparent elements.
    if (element.checkVisibility && !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || parseFloat(style.opacity) === 0) continue;
    let run = out.get(element);
    if (!run) {
      const size = parseFloat(style.fontSize);
      const weight = parseInt(style.fontWeight, 10) || 400;
      // The text's own alpha times the opacity of its ancestors (a block faded by an animation).
      const fg = rgba(style.color);
      fg[3] *= opacityOf(element);
      run = { block: element.closest<HTMLElement>('[data-block]')?.dataset.block || element.closest('header, footer')?.localName || null, text: '', fg, large: size >= 24 || (size >= 18.66 && weight >= 700), rects: [] };
      out.set(element, run);
    }
    run.text += data;
    run.rects.push(...rects);
  }
  return [...out.values()].map((run) => ({ ...run, text: run.text.replace(/\s+/g, ' ').trim().slice(0, 48) }));
}

// Contrast of every run against the captured pixels behind it (text made transparent), sampled every
// 2 CSS px.
const LINEAR = Float64Array.from({ length: 256 }, (_, value) => { const x = value / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
function contrastBehind({ width, height, data, scale }: Pixels, runs: TextRun[]): MeasuredContrast[] {
  const linear = (value: number) => { const x = value / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const step = Math.max(1, Math.round(2 * scale));
  const out: MeasuredContrast[] = [];
  for (const run of runs) {
    const behind: number[] = [];
    for (const [x0, y0, x1, y1] of run.rects) {
      for (let y = Math.floor(y0 * scale); y < Math.min(height, y1 * scale); y += step) {
        for (let x = Math.floor(x0 * scale); x < Math.min(width, x1 * scale); x += step) behind.push((y * width + x) * 4);
      }
    }
    if (!behind.length) continue;
    const [red, green, blue, alpha] = run.fg;
    const ratios = new Float64Array(behind.length);
    for (const [n, i] of behind.entries()) {
      const backRed = data[i], backGreen = data[i + 1], backBlue = data[i + 2];
      const l2 = 0.2126 * LINEAR[backRed] + 0.7152 * LINEAR[backGreen] + 0.0722 * LINEAR[backBlue];
      // Semi-transparent text: its colour over this pixel.
      const l1 = alpha === 1 ? 0.2126 * LINEAR[red] + 0.7152 * LINEAR[green] + 0.0722 * LINEAR[blue]
        : 0.2126 * linear(red * alpha + backRed * (1 - alpha)) + 0.7152 * linear(green * alpha + backGreen * (1 - alpha)) + 0.0722 * linear(blue * alpha + backBlue * (1 - alpha));
      ratios[n] = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
    ratios.sort();
    const ratio = ratios[Math.floor(ratios.length * 0.1)];
    out.push({ block: run.block, text: run.text, ratio: Math.round(ratio * 100) / 100, need: run.large ? 3 : 4.5 });
  }
  return out;
}
