// What a host takes from a canvas page, as data (D121): the messages of canvas-protocol.ts (CanvasMessage), read
// from what a window posted, field by field. A page of the web is another origin than the app's and its messages
// are not typed by the language: a message of another shape, a number that is not one, a list past its bounds is
// null, or its part is left out. The host checks who sent it (the frame's window, at the canvas's origin) before
// it reads what it says.

import { isRecord } from './json.ts';
import { PLAYER_PREVIEW_PROTOCOL } from './canvas-protocol.ts';
import type { AnswerMessage, AskName, BlockLayout, BlockPreviewMeasure, CanvasAsks, CanvasMessage, FieldLayout, FlowLayout, LayoutMessage, LayoutRect, PlacingLayout, ScreenMeasurement, TermLayout, TextLayout } from './canvas-protocol.ts';
import type { PlayerItemId } from './course-data.ts';

// How many entries of a list a message may carry: the blocks of a screen are tens, its texts hundreds.
const LIMIT = 5000;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, max = 2000): value is string => typeof value === 'string' && value.length <= max;
const orNull = <T>(value: unknown, check: (candidate: unknown) => candidate is T): T | null | undefined => (value === null ? null : check(value) ? value : undefined);
const listOf = <T>(value: unknown, one: (entry: unknown) => T | null): T[] | null => {
  if (!Array.isArray(value) || value.length > LIMIT) return null;
  const out: T[] = [];
  for (const entry of value) { const read = one(entry); if (read === null) return null; out.push(read); }
  return out;
};

export function rectOf(value: unknown): LayoutRect | null {
  return isRecord(value) && finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height) ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
}
const idOf = (value: unknown): string | number | null | undefined => (value === null || text(value, 200) || finite(value) ? (value as string | number | null) : undefined);

function fieldOf(value: unknown): FieldLayout | null {
  const rect = isRecord(value) ? rectOf(value.rect) : null;
  return isRecord(value) && text(value.path, 500) && rect ? { path: value.path, rect } : null;
}

function blockOf(value: unknown): BlockLayout | null {
  if (!isRecord(value) || !text(value.id, 200)) return null;
  const rect = rectOf(value.rect);
  const slot = orNull(value.slot, (candidate): candidate is string => text(candidate, 200));
  const layer = orNull(value.layer, (candidate): candidate is string => text(candidate, 200));
  const parent = orNull(value.parent, (candidate): candidate is string => text(candidate, 200));
  if (!rect || slot === undefined || layer === undefined || parent === undefined || typeof value.hidden !== 'boolean') return null;
  const block: BlockLayout = { id: value.id, rect, slot, layer, parent, hidden: value.hidden };
  const timed = value.timed;
  if (isRecord(timed) && (timed.state === 'before' || timed.state === 'entering' || timed.state === 'shown' || timed.state === 'leaving' || timed.state === 'after')) block.timed = { state: timed.state, ...(finite(timed.progress) ? { progress: timed.progress } : {}) };
  const fields = listOf(value.fields, fieldOf);
  if (fields) block.fields = fields;
  if (value.placed === true) block.placed = true;
  if (value.lifted === true) block.lifted = true;
  if (isRecord(value.anchor) && finite(value.anchor.x) && finite(value.anchor.y) && finite(value.anchor.width)) block.anchor = { x: value.anchor.x, y: value.anchor.y, width: value.anchor.width };
  if (Array.isArray(value.covers) && value.covers.length <= LIMIT && value.covers.every((id) => text(id, 200))) block.covers = value.covers as string[];
  const home = rectOf(value.home);
  if (home) block.home = home;
  return block;
}

function textOf(value: unknown): TextLayout | null {
  if (!isRecord(value) || (value.kind !== 'title' && value.kind !== 'field' && value.kind !== 'image')) return null;
  const rect = rectOf(value.rect);
  const path = orNull(value.path, (candidate): candidate is string => text(candidate, 500));
  const layer = orNull(value.layer, (candidate): candidate is string => text(candidate, 200));
  const before = orNull(value.before, (candidate): candidate is string => text(candidate, 200));
  return rect && path !== undefined && layer !== undefined && before !== undefined && text(value.text, 400) && typeof value.read === 'boolean' ? { kind: value.kind, path, text: value.text, rect, layer, read: value.read, before } : null;
}

function termOf(value: unknown): TermLayout | null {
  if (!isRecord(value) || !text(value.term, 200) || !text(value.block, 200) || !text(value.words, 500)) return null;
  const rects = listOf(value.rects, rectOf);
  return rects ? { term: value.term, block: value.block, words: value.words, rects } : null;
}

function flowOf(value: unknown): FlowLayout | null {
  if (!isRecord(value)) return null;
  const slot = orNull(value.slot, (candidate): candidate is string => text(candidate, 200));
  const rect = rectOf(value.rect);
  const places = listOf(value.places, (place) => {
    if (!isRecord(place) || !finite(place.y)) return null;
    const after = orNull(place.after, (candidate): candidate is string => text(candidate, 200));
    return after === undefined ? null : { after, y: place.y };
  });
  if (slot === undefined || !rect || !places) return null;
  const flow: FlowLayout = { slot, rect, places };
  if (value.default === true) flow.default = true;
  if (text(value.label, 200)) flow.label = value.label;
  if (Array.isArray(value.refuses) && value.refuses.length <= LIMIT && value.refuses.every((type) => text(type, 100))) flow.refuses = value.refuses as string[];
  return flow;
}

function placingOf(value: unknown): PlacingLayout | undefined {
  if (!isRecord(value)) return undefined;
  const frame = rectOf(value.frame);
  const flows = listOf(value.flows, flowOf);
  const columns = value.columns;
  const widths = isRecord(columns) && finite(columns.half) && finite(columns.full) && finite(columns.wide) && finite(columns.bleed) ? { half: columns.half, full: columns.full, wide: columns.wide, bleed: columns.bleed } : null;
  return frame && flows && (columns === null || widths) ? { frame, flows, columns: widths } : undefined;
}

export function layoutOf(value: unknown): LayoutMessage | null {
  if (!isRecord(value) || value.type !== 'elabora/layout') return null;
  const id = idOf(value.id);
  const screen = orNull(value.screen, (candidate): candidate is string => text(candidate, 200));
  const layer = orNull(value.layer, (candidate): candidate is string => text(candidate, 200));
  const viewport = value.viewport;
  const blocks = listOf(value.blocks, blockOf);
  const screenRect = value.screenRect === null ? null : rectOf(value.screenRect);
  if (id === undefined || screen === undefined || layer === undefined || !blocks || screenRect === undefined) return null;
  if (!finite(value.step) || !Array.isArray(value.steps) || value.steps.length > LIMIT || !value.steps.every(finite)) return null;
  if (value.state !== 'initial' && value.state !== 'answered') return null;
  if (!finite(value.applyMs) || !isRecord(viewport) || !finite(viewport.width) || !finite(viewport.height) || !finite(viewport.scrollX) || !finite(viewport.scrollY)) return null;
  const layout: LayoutMessage = { type: 'elabora/layout', id, screen, step: value.step, steps: value.steps as number[], layer, state: value.state, applyMs: value.applyMs, viewport: { width: viewport.width, height: viewport.height, scrollX: viewport.scrollX, scrollY: viewport.scrollY }, screenRect, blocks };
  const texts = listOf(value.texts, textOf);
  if (texts) layout.texts = texts;
  const terms = listOf(value.terms, termOf);
  if (terms) layout.terms = terms;
  const placing = placingOf(value.placing);
  if (placing) layout.placing = placing;
  const glide = value.glide;
  if (isRecord(glide) && finite(glide.ms) && finite(glide.elapsed) && text(glide.easing, 200) && isRecord(glide.from)) {
    const from: Record<string, LayoutRect> = {};
    for (const [block, rect] of Object.entries(glide.from).slice(0, LIMIT)) { const read = rectOf(rect); if (read) from[block] = read; }
    layout.glide = { ms: glide.ms, elapsed: glide.elapsed, easing: glide.easing, from };
  }
  return layout;
}

// A result as the question that was asked says it is made (a page that answers another shape answers nothing).
export function askResultOf<Name extends AskName>(name: Name, value: unknown): { ok: true; result: CanvasAsks[Name]['result'] } | { ok: false } {
  const ok = (result: CanvasAsks[AskName]['result']) => ({ ok: true as const, result: result as CanvasAsks[Name]['result'] });
  switch (name) {
    case 'shown':
    case 'block-preview-clear':
      return typeof value === 'boolean' ? ok(value) : { ok: false };
    case 'mark':
      return value === true ? ok(true) : { ok: false };
    case 'block-preview': {
      if (value === null) return ok(null);
      if (!isRecord(value) || typeof value.overflow !== 'boolean') return { ok: false };
      const block = value.block === null ? null : rectOf(value.block);
      return value.block === null || block ? ok({ overflow: value.overflow, block } satisfies BlockPreviewMeasure) : { ok: false };
    }
    case 'measure': {
      if (value === null) return ok(null);
      if (!isRecord(value) || !finite(value.overflow)) return { ok: false };
      const fields = listOf(value.fields, (entry) => (isRecord(entry) && text(entry.block, 200) && text(entry.path, 500) && finite(entry.width) && finite(entry.height) ? { block: entry.block, path: entry.path, width: entry.width, height: entry.height } : null));
      return fields ? ok({ overflow: value.overflow, fields } satisfies ScreenMeasurement) : { ok: false };
    }
    default:
      return { ok: false };
  }
}

const PREVIEW_ITEM_BARS = ['top', 'bottom'] as const;

// A message of a canvas page, or null: not one of the page's, or malformed. An answer is returned as it says
// itself (its result is read by askResultOf, once the host knows which question it answers).
export function parseCanvasMessage(value: unknown): CanvasMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'elabora/ready':
      return value.chrome === 'none' || value.chrome === 'player' || value.chrome === 'live' ? { type: 'elabora/ready', chrome: value.chrome, ...(value.protocol === PLAYER_PREVIEW_PROTOCOL ? { protocol: PLAYER_PREVIEW_PROTOCOL } : {}) } : null;
    case 'elabora/layout':
      return layoutOf(value);
    case 'elabora/navigate': {
      const by = value.by;
      return text(value.screen, 200) && (by === undefined || by === 'previous' || by === 'next' || by === 'outline' || by === 'progress') ? { type: 'elabora/navigate', screen: value.screen, ...(by ? { by } : {}) } : null;
    }
    case 'elabora/error': {
      const id = idOf(value.id);
      return id !== undefined && text(value.message, 1000) ? { type: 'elabora/error', id, message: value.message } : null;
    }
    case 'elabora/item':
      return value.protocol === PLAYER_PREVIEW_PROTOCOL && text(value.id, 200) && (value.bar === PREVIEW_ITEM_BARS[0] || value.bar === PREVIEW_ITEM_BARS[1]) ? { type: 'elabora/item', protocol: PLAYER_PREVIEW_PROTOCOL, id: value.id as PlayerItemId, bar: value.bar } : null;
    case 'elabora/language':
      return value.protocol === PLAYER_PREVIEW_PROTOCOL && text(value.language, 50) ? { type: 'elabora/language', protocol: PLAYER_PREVIEW_PROTOCOL, language: value.language } : null;
    case 'elabora/answer': {
      if (!Number.isSafeInteger(value.request) || (value.request as number) < 0) return null;
      if (typeof value.error === 'string') return { type: 'elabora/answer', request: value.request as number, error: value.error.slice(0, 500) } satisfies AnswerMessage;
      return 'result' in value ? { type: 'elabora/answer', request: value.request as number, result: value.result as CanvasAsks[AskName]['result'] } : null;
    }
    default:
      return null;
  }
}
