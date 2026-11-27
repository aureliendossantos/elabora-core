// What the canvas page answers when its host asks about what is on screen (canvas-protocol.ts,
// CanvasAsks): the measures a host used to inject into the page as scripts, now messages, so that a host
// in another origin asks them the same way. canvas.ts hands each ask to answerAsk and posts the answer.

import { drawPicture, painterScroller, windowScroller } from './canvas-picture.ts';
import type { Scroller } from './canvas-picture.ts';
import { blockMiniFrame, blockPreviewFrame } from './block-frame.ts';
import { holdStill } from './canvas-still.ts';
import { isRecord } from './json.ts';
import type { AnswerMessage, AskMessage, AskName, BlockPreviewMeasure, CanvasAsks, LayoutRect, PictureResult, ScreenMeasurement } from './canvas-protocol.ts';
import type { LayoutMessage } from './canvas-protocol.ts';

// What an ask needs of the canvas.
export interface AskedCanvas {
  // The id of the last render or view message applied.
  appliedId(): string | number | null;
  // Resolves once the images, fonts and free objects of the screen are ready.
  ready(timeout: number): Promise<unknown>;
  layout(): LayoutMessage;
}

const SHOWN_POLLS = 150;
const SHOWN_EVERY_MS = 20;
const READY_MS = 4000;
const PREVIEW_STYLE = 'elabora-block-preview';
const MARK = 'elabora-drawn';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frames = (count: number) => new Promise<void>((resolve) => { const step = (left: number) => requestAnimationFrame(() => (left <= 1 ? resolve() : step(left - 1))); step(count); });

// The message as the host posted it, if it is a question this canvas knows (what the page receives from
// another window is checked; a host in the same process hands over typed messages).
export function askOf(data: Record<string, unknown>): AskMessage | null {
  const { request, ask, params } = data;
  if (typeof request !== 'number' || !Number.isFinite(request) || !isRecord(params)) return null;
  const id = typeof params.id === 'string' || typeof params.id === 'number';
  if (ask === 'shown' && id) return { type: 'elabora/ask', request, ask, params: { id: params.id as string | number } };
  if (ask === 'measure' && id) return { type: 'elabora/ask', request, ask, params: { id: params.id as string | number } };
  if (ask === 'block-preview-clear' && id) return { type: 'elabora/ask', request, ask, params: { id: params.id as string | number } };
  if (ask === 'block-preview' && id && typeof params.block === 'string' && typeof params.slides === 'boolean') return { type: 'elabora/ask', request, ask, params: { id: params.id as string | number, block: params.block, slides: params.slides } };
  if (ask === 'picture' && id && Number.isInteger(params.width) && (params.width as number) >= 16 && (params.width as number) <= 4096
    && (params.block === undefined || typeof params.block === 'string') && (params.mini === undefined || typeof params.mini === 'boolean') && (params.slides === undefined || typeof params.slides === 'boolean')) {
    return { type: 'elabora/ask', request, ask, params: { id: params.id as string | number, width: params.width as number, ...(typeof params.block === 'string' ? { block: params.block } : {}), ...(params.mini ? { mini: true } : {}), ...(params.slides ? { slides: true } : {}) } };
  }
  if (ask === 'mark') {
    const rgb = params.rgb;
    if (rgb === null) return { type: 'elabora/ask', request, ask, params: { rgb: null } };
    if (Array.isArray(rgb) && rgb.length === 3 && rgb.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return { type: 'elabora/ask', request, ask, params: { rgb: rgb as [number, number, number] } };
  }
  return null;
}

// The screen of a render is the one shown and ready (false: it was not within 3 s). A miniature's page then holds it still.
async function shown(canvas: AskedCanvas, id: string | number): Promise<boolean> {
  for (let i = 0; i < SHOWN_POLLS; i++) {
    if (canvas.appliedId() === id) {
      await canvas.ready(READY_MS);
      if (document.documentElement.hasAttribute('data-thumb')) holdStill();
      return true;
    }
    await sleep(SHOWN_EVERY_MS);
  }
  return false;
}

async function blockPreview(canvas: AskedCanvas, { id, block, slides }: CanvasAsks['block-preview']['params']): Promise<BlockPreviewMeasure | null> {
  if (!await shown(canvas, id)) return null;
  return around(block, slides, windowScroller);
}

// The block's neighbours faded and the page scrolled to it (a scrolling course: around it; a slide it runs past: down to it): where it
// is, and whether a slide runs past its window.
async function around(block: string, slides: boolean, scroller: Scroller): Promise<BlockPreviewMeasure> {
  const own = `[data-block="${CSS.escape(block)}"]`;
  let style = document.getElementById(PREVIEW_STYLE);
  if (!style) { style = document.createElement('style'); style.id = PREVIEW_STYLE; document.head.append(style); }
  // The blocks beside it fade, once each (not again inside a faded one).
  style.textContent = `.t-block[data-block]:not(${own}):not(:has(${own})):not(${own} .t-block):not(.t-block[data-block]:not(:has(${own})) .t-block){opacity:.32!important;transition:none!important;animation:none!important}`;
  const node = document.querySelector(`dialog.t-layer[open] ${own}, #t-main ${own}`);
  // A scrolling course around the block; a slide it runs past, down to it.
  if (node) {
    const box = node.getBoundingClientRect();
    const top = scroller.top();
    if (!slides) scroller.to(Math.max(0, box.height < innerHeight * 0.7 ? box.top + top - (innerHeight - box.height) / 2 : box.top + top - 32));
    else scroller.to(Math.max(0, box.bottom + top + 24 - innerHeight));
  }
  await frames(2);
  const box = node ? node.getBoundingClientRect() : null;
  return { overflow: slides && scroller.overflow() > 4, block: box && box.width > 0 ? { x: box.x, y: box.y, width: box.width, height: box.height } : null };
}
function cleared(scroller: Scroller): void {
  document.getElementById(PREVIEW_STYLE)?.remove();
  scroller.to(0);
}

// The painter's image of the screen shown (D139): the whole window, or the part around a block; the page left as a thumbnail shows it.
async function picture(canvas: AskedCanvas, { id, width, block, mini, slides }: CanvasAsks['picture']['params']): Promise<PictureResult | null> {
  if (!await shown(canvas, id)) return null;
  const scroller = painterScroller();
  const page = { width: innerWidth, height: innerHeight };
  let region: LayoutRect = { x: 0, y: 0, ...page };
  let overflow = false;
  try {
    if (block !== undefined) {
      const seen = await around(block, slides ?? false, scroller);
      overflow = seen.overflow;
      if (seen.block) region = (mini ? blockMiniFrame(seen.block, page) : null) ?? blockPreviewFrame(seen.block, page);
    }
    return { image: await drawPicture(region, width), overflow };
  } finally {
    if (block !== undefined) cleared(scroller);
  }
}

async function blockPreviewClear(canvas: AskedCanvas, id: string | number): Promise<boolean> {
  if (!await shown(canvas, id)) return false;
  cleared(windowScroller);
  await frames(2);
  return true;
}

async function measure(canvas: AskedCanvas, id: string | number): Promise<ScreenMeasurement | null> {
  if (!await shown(canvas, id)) return null;
  await frames(2);
  const fields = canvas.layout().blocks.flatMap((block) => (block.fields ?? []).map((field) => ({ block: block.id, path: field.path, width: field.rect.width, height: field.rect.height })));
  return { overflow: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)), fields };
}

function mark(rgb: [number, number, number] | null): true {
  document.getElementById(MARK)?.remove();
  if (rgb) {
    const square = document.createElement('div');
    square.id = MARK;
    square.style.cssText = `position:fixed;left:0;top:0;width:4px;height:4px;background:rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]});z-index:2147483647;pointer-events:none`;
    document.documentElement.append(square);
  }
  return true;
}

export async function answerAsk(canvas: AskedCanvas, message: AskMessage): Promise<AnswerMessage> {
  const { request } = message;
  try {
    let result: CanvasAsks[AskName]['result'];
    switch (message.ask) {
      case 'shown': result = await shown(canvas, message.params.id); break;
      case 'mark': result = mark(message.params.rgb); break;
      case 'block-preview': result = await blockPreview(canvas, message.params); break;
      case 'block-preview-clear': result = await blockPreviewClear(canvas, message.params.id); break;
      case 'measure': result = await measure(canvas, message.params.id); break;
      case 'picture': result = await picture(canvas, message.params); break;
    }
    return { type: 'elabora/answer', request, result };
  } catch (error) {
    return { type: 'elabora/answer', request, error: error instanceof Error ? error.message : String(error) };
  }
}
