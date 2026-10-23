// What a chart's view is given and gives (D60). A view shows an item at a progress p between 0 (not
// there yet) and 1 (there), as a pure function of p: the behaviour drives p from a clock or from the
// screen's timeline. It changes only opacity, transforms, dash offsets, clip paths and the text of
// counted figures: never the layout, which the core drew.

import type { ChartBlock, PredictBlock } from '../course-data.ts';
import type { Labels } from '../labels.ts';
import type { ChartsContext } from './behavior.ts';
import type { NumberFormat, Tip } from './kit.ts';
import { easeOut } from './kit.ts';

export interface ChartDom {
  root: HTMLElement;
  body: HTMLElement;
  block: ChartBlock | PredictBlock;
  // Item ids in reading order, and their elements.
  order: string[];
  items: { ids: readonly string[]; elements(id: string): readonly HTMLElement[]; first(id: string): HTMLElement | undefined };
  live: HTMLElement;
  tip: Tip;
  language: string;
  format: NumberFormat;
  format_: (value: number) => string;
  labels: Labels;
  context: ChartsContext;
  spoken: string | null;
}

export interface ChartView {
  // Seconds: an item's own entrance, between two items, and the frame's (axes, rails, a line) before them.
  entrance?: { item: number; stagger: number; frame?: number };
  // When an item starts, in staggers (default: its index in reading order; a diagram: its depth).
  slot?(dom: ChartDom, id: string, index: number): number;
  before?(dom: ChartDom): void;
  frame?(dom: ChartDom, p: number): void;
  reveal(dom: ChartDom, id: string, p: number): void;
  after?(dom: ChartDom): void;
  // Narrated: anything beyond items (the trend's line drawn up to the voice).
  beat?(dom: ChartDom, time: number, beats: Readonly<Record<string, number>>, ends: number): void;
  // The spotlight moved (the voice talks about id, or about nothing in the chart).
  spot?(dom: ChartDom, id: string | null): void;
  focus?(dom: ChartDom, id: string | null): void;
  // Items the pointer and the keys may reach now (a trend's guessed years are not yet).
  enabled?(dom: ChartDom, id: string): boolean;
  pick?(dom: ChartDom, event: PointerEvent): string | null | undefined;
  setup?(dom: ChartDom): (() => void) | void;
  // Slides reserve the room of the chart answered (predict): each outcome renders one.
  outcomes?(dom: ChartDom): (() => void)[];
}

// ── counted figures ──
// A figure counts from 0 (or from its count's from) to its value, then shows the text the core
// wrote, so a counted figure always lands on the same characters.
const written = new WeakMap<HTMLElement, string>();
export function count(element: HTMLElement | null | undefined, p: number, text: (value: number) => string, from = 0): void {
  if (!element) return;
  if (!written.has(element)) written.set(element, element.textContent ?? '');
  const to = Number(element.dataset.tNum);
  if (p >= 1 || !Number.isFinite(to)) { element.textContent = written.get(element)!; return; }
  element.textContent = text(from + (to - from) * p);
}
// The text the core wrote (before any count changed it).
export function writtenText(element: HTMLElement): string {
  if (!written.has(element)) written.set(element, element.textContent ?? '');
  return written.get(element)!;
}

export const setVar = (element: Element | null | undefined, property: string, value: string): void => { if (element) (element as HTMLElement).style.setProperty(property, value); };

// Items that have no motion of their own rise and fade in, in reading order.
export const defaultView: ChartView = {
  entrance: { item: 0.55, stagger: 0.09 },
  reveal(dom, id, p) {
    const e = easeOut(p);
    for (const element of dom.items.elements(id)) {
      element.style.opacity = p >= 1 ? '' : String(e);
      element.style.translate = p >= 1 ? '' : `0 ${(1 - e) * 0.6}rem`;
    }
  }
};
