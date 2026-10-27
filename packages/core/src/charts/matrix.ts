// matrix: items placed on two axes, in four quadrants (D60). The plot is HTML: four tiles with their
// names in the outer corners, a cross through the middle (an SVG stretched to the plot, its strokes not
// scaled), a dot per item placed in percentages, and its label beside it. The axes' names and ends are
// HTML around the plot.
//
// Labels are placed here, when the course is built, so they never cover each other, the dots or the
// quadrants' names: each label tries the sides of its dot (the outer side first) on a plot of the
// smallest wide size, measured with an estimate of its text, and keeps the side that collides least.
// The same is done on a phone's plot: if a label still collides there, the narrow layout numbers the
// dots and moves every label into a numbered legend under the plot (matrix.css).
//
// An item's dot comes first in the markup (it says the item and carries its tip), then its label, then
// its line in the legend.

import { esc, attrs, hl } from './frame.ts';
import { n } from './format.ts';
import type { ChartType } from './types.ts';
import { isRecord, recordsOf, num, str, itemsOf } from './values.ts';

export type Quadrant = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
export const QUADRANTS: readonly Quadrant[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
export type Side = 'r' | 'l' | 't' | 'b' | 'rt' | 'rb' | 'lt' | 'lb';

export interface MatrixItem { id: string; label: string; text: string; x: number; y: number; quadrant: Quadrant }

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function matrixItems(props: Record<string, unknown>): MatrixItem[] {
  return recordsOf(props.items).map((item) => {
    const x = clamp01(num(item.x, 0.5)), y = clamp01(num(item.y, 0.5));
    return { id: str(item.id), label: str(item.label), text: str(item.text), x, y, quadrant: `${y >= 0.5 ? 'top' : 'bottom'}${x >= 0.5 ? 'Right' : 'Left'}` as Quadrant };
  });
}

// A plot to place on (px), the label's type (px: font size, widest line, line height), the dot's
// radius and the gap to its label, and the quadrants' names (font size, inset from the corner).
// The CSS (matrix.css) uses the same sizes: 14 px dots, labels 0.375 rem from them.
export interface PlotSize { w: number; h: number; font: number; maxWidth: number; name: number; inset: number }
export const WIDE_PLOT: PlotSize = { w: 520, h: 390, font: 14, maxWidth: 160, name: 11.5, inset: 12 };
export const NARROW_PLOT: PlotSize = { w: 300, h: 300, font: 13, maxWidth: 112, name: 10.5, inset: 9 };
const DOT = 7, GAP = 6, DIAGONAL = 5;
const LINE = 1.25;

interface Box { x0: number; y0: number; x1: number; y1: number }

// An estimate of a text's lines at a width: words laid greedily, at an average glyph width.
export function measure(text: string, font: number, maxWidth: number, glyph = 0.56): { w: number; h: number } {
  const space = font * glyph * 0.55;
  const width = (word: string) => [...word].length * font * glyph;
  let lines = 0, widest = 0, current = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = width(word);
    if (current > 0 && current + space + w > maxWidth) { widest = Math.max(widest, current); lines++; current = w; }
    else current = current > 0 ? current + space + w : w;
  }
  if (current > 0) { widest = Math.max(widest, current); lines++; }
  return { w: Math.min(maxWidth, widest), h: Math.max(1, lines) * font * LINE };
}

function boxAt(side: Side, px: number, py: number, w: number, h: number): Box {
  const near = DOT + GAP;
  const at = (x0: number, y0: number): Box => ({ x0, y0, x1: x0 + w, y1: y0 + h });
  switch (side) {
    case 'r': return at(px + near, py - h / 2);
    case 'l': return at(px - near - w, py - h / 2);
    case 't': return at(px - w / 2, py - near - h);
    case 'b': return at(px - w / 2, py + near);
    case 'rt': return at(px + DIAGONAL, py - DIAGONAL - h);
    case 'rb': return at(px + DIAGONAL, py + DIAGONAL);
    case 'lt': return at(px - DIAGONAL - w, py - DIAGONAL - h);
    case 'lb': return at(px - DIAGONAL - w, py + DIAGONAL);
  }
}
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const grow = (box: Box, by: number): Box => ({ x0: box.x0 - by, y0: box.y0 - by, x1: box.x1 + by, y1: box.y1 + by });
const outside = (box: Box, w: number, h: number) => (box.x1 - box.x0) * (box.y1 - box.y0) - overlap(box, { x0: 0, y0: 0, x1: w, y1: h });

// The sides a label tries, the outer one first (labels on the right half look left, toward the middle).
const ORDER_RIGHT: readonly Side[] = ['r', 'l', 'rt', 'rb', 't', 'b', 'lt', 'lb'];
const ORDER_LEFT: readonly Side[] = ['l', 'r', 'lt', 'lb', 't', 'b', 'rt', 'rb'];

export interface Placement { sides: Side[]; clashes: number[] }

// Each label's side on a plot, and how much it still collides (px², 0 when it fits).
export function placeLabels(items: readonly MatrixItem[], names: readonly string[], size: PlotSize): Placement {
  const dots = items.map((item) => ({ px: item.x * size.w, py: (1 - item.y) * size.h }));
  const boxes = items.map((item) => measure(item.label, size.font, size.maxWidth));
  const nameBoxes = names.map((name, index): Box => {
    const { w, h } = measure(name.toUpperCase(), size.name, size.w * 0.42, 0.74);
    const right = index % 2 === 1, bottom = index >= 2;
    const x0 = right ? size.w - size.inset - w : size.inset, y0 = bottom ? size.h - size.inset - h : size.inset;
    return { x0, y0, x1: x0 + w, y1: y0 + h };
  });
  const dotBoxes = dots.map((dot) => ({ x0: dot.px - DOT - 2, y0: dot.py - DOT - 2, x1: dot.px + DOT + 2, y1: dot.py + DOT + 2 }));
  const cross: Box[] = [{ x0: size.w / 2 - 1, y0: 0, x1: size.w / 2 + 1, y1: size.h }, { x0: 0, y0: size.h / 2 - 1, x1: size.w, y1: size.h / 2 + 1 }];
  const orders = items.map((item) => (item.x > 0.6 ? ORDER_LEFT : ORDER_RIGHT));
  const sides: Side[] = orders.map((order) => order[0]);
  const placed: (Box | null)[] = items.map(() => null);
  const cost = (index: number, side: Side) => {
    const box = boxAt(side, dots[index].px, dots[index].py, boxes[index].w, boxes[index].h);
    let clash = outside(box, size.w, size.h) * 3;
    dotBoxes.forEach((dot, other) => { if (other !== index) clash += overlap(box, dot) * 2; });
    for (const name of nameBoxes) clash += overlap(box, grow(name, 3));
    placed.forEach((label, other) => { if (other !== index && label) clash += overlap(grow(box, 3), label); });
    // Crossing the cross is allowed, but a side that does not is better.
    const soft = (overlap(box, cross[0]) + overlap(box, cross[1])) * 3;
    return { clash, soft };
  };
  const clashes = items.map(() => 0);
  // Greedily in reading order, then each label again knowing all the others.
  for (let pass = 0; pass < 4; pass++) {
    items.forEach((_, index) => {
      let best = sides[index], bestScore = Infinity, bestClash = 0;
      orders[index].forEach((side, rank) => {
        const { clash, soft } = cost(index, side);
        const score = clash + soft + rank * 6;
        if (score < bestScore) { bestScore = score; best = side; bestClash = clash; }
      });
      sides[index] = best;
      clashes[index] = bestClash;
      placed[index] = boxAt(best, dots[index].px, dots[index].py, boxes[index].w, boxes[index].h);
    });
  }
  return { sides, clashes: clashes.map((clash) => Math.round(clash)) };
}

const quadrantNames = (props: Record<string, unknown>): string[] => {
  const quadrants = isRecord(props.quadrants) ? props.quadrants : {};
  return QUADRANTS.map((quadrant) => str(quadrants[quadrant]));
};
const highlightedQuadrant = (props: Record<string, unknown>): Quadrant | null => (QUADRANTS.includes(props.highlightQuadrant as Quadrant) ? props.highlightQuadrant as Quadrant : null);
const quadrantClass: Record<Quadrant, string> = { topLeft: 'is-tl', topRight: 'is-tr', bottomLeft: 'is-bl', bottomRight: 'is-br' };

export function matrixLayout(props: Record<string, unknown>) {
  const items = matrixItems(props);
  const names = quadrantNames(props);
  const wide = placeLabels(items, names, WIDE_PLOT);
  const narrow = placeLabels(items, names, NARROW_PLOT);
  return { items, names, wide, narrow, legend: narrow.clashes.some((clash) => clash > 0) };
}

const say = (item: MatrixItem, names: readonly string[]) => {
  const quadrant = names[QUADRANTS.indexOf(item.quadrant)];
  return `${item.label}${quadrant ? `, ${quadrant}` : ''}${item.text ? `: ${item.text}` : ''}`;
};

function axis(spec: unknown, className: string): string {
  const value = isRecord(spec) ? spec : {};
  const low = str(value.low), high = str(value.high);
  return `<div class="t-matrix-axis ${className}">`
    + `<span class="t-matrix-low">${esc(low)}</span>`
    + `<b class="t-matrix-axis-name">${esc(str(value.label))}</b>`
    + `<span class="t-matrix-high">${esc(high)}</span>`
    + '</div>';
}

export const matrix: ChartType = {
  axis: 'xy',
  items: (props) => itemsOf(props.items, 'items'),
  body(props) {
    const { items, names, wide, narrow, legend } = matrixLayout(props);
    const lit = highlightedQuadrant(props);
    const pct = (value: number) => `${n(value * 100)}%`;
    const quads = QUADRANTS.map((quadrant, index) => `<div class="t-matrix-q ${quadrantClass[quadrant]}${lit === quadrant ? ' is-hl' : ''}"><span class="t-matrix-q-name">${esc(names[index])}</span></div>`).join('');
    const cross = '<svg class="t-matrix-cross" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">'
      + '<line class="t-matrix-cross-x" x1="0" y1="50" x2="100" y2="50"/><line class="t-matrix-cross-y" x1="50" y1="0" x2="50" y2="100"/></svg>';
    const position = (item: MatrixItem) => `left:${pct(item.x)};top:${pct(1 - item.y)}`;
    const dots = items.map((item, index) => `<i class="t-matrix-dot${hl(props, item.id)}"${attrs({ 'data-t-item': item.id, 'data-t-say': say(item, names), 'data-t-tip': item.text || null, 'data-t-tip-at': true })} style="${position(item)}"><span>${index + 1}</span></i>`).join('');
    const labels = items.map((item, index) => `<span class="t-matrix-label${hl(props, item.id)}"${attrs({ 'data-t-item': item.id, 'data-side': wide.sides[index], 'data-nside': narrow.sides[index] })} style="${position(item)}">${esc(item.label)}</span>`).join('');
    const list = items.length ? `<ol class="t-matrix-legend">${items.map((item, index) => `<li class="t-matrix-key${hl(props, item.id)}"${attrs({ 'data-t-item': item.id })}><b>${index + 1}</b><span>${esc(item.label)}${item.text ? `<small>${esc(item.text)}</small>` : ''}</span></li>`).join('')}</ol>` : '';
    return `<div class="t-matrix${legend ? ' t-matrix--legend' : ''}">`
      + axis(props.y, 't-matrix-y')
      + `<div class="t-matrix-plot"><div class="t-matrix-quads">${quads}</div>${cross}${dots}${labels}</div>`
      + axis(props.x, 't-matrix-x')
      + `</div>${list}`;
  },
  table(props) {
    const items = matrixItems(props);
    const names = quadrantNames(props);
    return { head: [], rows: items.map((item) => [item.label, names[QUADRANTS.indexOf(item.quadrant)], item.text]) };
  }
};
