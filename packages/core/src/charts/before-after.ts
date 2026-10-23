// before-after: a slope chart, who moved and who moved least. Two columns (the two moments) and a
// line per item between its two values. The plot has a height in rem chosen here (from SLOPE.plot, taller
// when labels crowd: --h, --hn), so values are placed in fractions of it; the columns' x are CSS variables (--x0, --x1), wide and
// narrow. Each line is its own SVG spanning the two columns (stretched, its stroke not scaling), so the
// player can draw it by clipping its box. Dots are HTML (round at any size); labels are HTML, pushed
// apart here so they never overlap: once for the wide layout (--y: the name and the value on both
// sides) and once for the narrow one (--yn: the value alone on the left, the value and the name on
// the right), from their estimated number of lines.

import { esc, attrs, hl } from './frame.ts';
import { formatValue, n } from './format.ts';
import { textWidth } from './levels.ts';
import type { ChartType, ChartContext } from './types.ts';
import { recordsOf, num, str, itemsOf } from './values.ts';

// rem, as before-after.css draws them: the plot's height, a label's line, the least room between two
// labels, the label size, and the room a label has beside its column (at the smallest width of each
// layout: the plot is 34 rem wide or more when wide, 20 rem or more when narrow).
export const SLOPE = {
  plot: 18, most: 26, line: 1.25, space: 0.25, size: 0.9375,
  wide: { x0: 0.34, x1: 0.66, width: 34 },
  narrow: { x0: 0.2, x1: 0.6, width: 20, size: 0.875 }
} as const;
const DOT_ROOM = 0.875; // rem between a column and its labels

export interface SlopeItem { id: string; label: string; before: number; after: number; y0: number; y1: number }

export function slopeGeometry(props: Record<string, unknown>): SlopeItem[] {
  const raw = recordsOf(props.items).map((item) => ({ id: str(item.id), label: str(item.label), before: num(item.before), after: num(item.after) }));
  const values = raw.flatMap((item) => [item.before, item.after]);
  let low = Math.min(...values), high = Math.max(...values);
  if (!Number.isFinite(low)) { low = 0; high = 1; }
  if (high === low) { low -= 1; high += 1; }
  // A slope chart compares changes: its scale spans the values, not zero to the top.
  const y = (value: number) => 0.03 + 0.94 * (1 - (value - low) / (high - low));
  return raw.map((item) => ({ ...item, y0: y(item.before), y1: y(item.after) }));
}

// Label centres pushed apart (each needs its own height, plus space), keeping their order; then the
// group is kept within the plot when it can be. Positions and sizes in the same unit.
export function dodgeSized(centres: readonly number[], sizes: readonly number[], space: number, bounds?: [number, number]): number[] {
  const order = centres.map((c, i) => ({ c, s: sizes[i], i })).sort((a, b) => a.c - b.c || a.i - b.i);
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let k = 1; k < order.length; k++) {
      const need = (order[k - 1].s + order[k].s) / 2 + space;
      const d = order[k].c - order[k - 1].c;
      if (d < need - 1e-9) { const push = (need - d) / 2; order[k].c += push; order[k - 1].c -= push; moved = true; }
    }
    if (bounds && order.length) {
      const top = order[0].c - order[0].s / 2, bottom = order[order.length - 1].c + order[order.length - 1].s / 2;
      const shift = top < bounds[0] ? bounds[0] - top : bottom > bounds[1] ? Math.max(bounds[1] - bottom, bounds[0] - top) : 0;
      if (shift) { for (const entry of order) entry.c += shift; moved = true; }
    }
    if (!moved) break;
  }
  const out: number[] = [];
  for (const entry of order) out[entry.i] = entry.c;
  return out;
}

// Lines a label takes in room rem wide (at least one).
const linesOf = (words: string, size: number, room: number, extra = 0) => Math.max(1, Math.ceil((textWidth(words) * size + extra) / Math.max(1, room)));

// Labels placed beside their dots in a plot height rem high (fractions of it), pushed apart.
function placed(items: SlopeItem[], heights: number[], side: 'y0' | 'y1', height: number): number[] {
  const centres = items.map((item) => item[side] * height);
  return dodgeSized(centres, heights, SLOPE.space, [-0.5, height + 0.5]).map((value) => value / height);
}
// The least plot height (from SLOPE.plot up to SLOPE.most) at which no label is pushed more than a
// line away from its dot, on either side; the labels placed at that height.
function layout(items: SlopeItem[], left: number[], right: number[]): { height: number; left: number[]; right: number[] } {
  let best: { height: number; left: number[]; right: number[] } = { height: SLOPE.most, left: [], right: [] };
  for (let height = SLOPE.plot; height <= SLOPE.most; height += 1) {
    const l = placed(items, left, 'y0', height), r = placed(items, right, 'y1', height);
    const off = Math.max(0, ...items.map((item, index) => Math.max(Math.abs(l[index] - item.y0), Math.abs(r[index] - item.y1)) * height));
    best = { height, left: l, right: r };
    if (off <= SLOPE.line) break;
  }
  return best;
}

const formatOf = (props: Record<string, unknown>) => ({ unit: str(props.unit) || undefined, decimals: num(props.decimals) });

export const beforeAfter: ChartType = {
  axis: 'y',
  items: (props) => itemsOf(props.items, 'items'),
  body(props, context: ChartContext) {
    const items = slopeGeometry(props);
    const format = formatOf(props);
    const value = (v: number) => formatValue(v, format, context.language);
    // Wide: name and value on both sides, beside their column; narrow: the value alone on the left.
    const wideRoom = (x: number) => x * SLOPE.wide.width - DOT_ROOM;
    const narrowRoom = (1 - SLOPE.narrow.x1) * SLOPE.narrow.width - DOT_ROOM;
    const lineHeight = (lines: number) => lines * SLOPE.line;
    const lines = (words: string, size: number, room: number) => lineHeight(linesOf(words, size, room));
    const wide = layout(items,
      items.map((item) => lines(`${item.label} ${value(item.before)}`, SLOPE.size, wideRoom(SLOPE.wide.x0))),
      items.map((item) => lines(`${value(item.after)} ${item.label}`, SLOPE.size, wideRoom(1 - SLOPE.wide.x1))));
    const narrow = layout(items, items.map(() => lineHeight(1)), items.map((item) => lines(`${value(item.after)} ${item.label}`, SLOPE.narrow.size, narrowRoom)));
    const [wideLeft, wideRight, narrowLeft, narrowRight] = [wide.left, wide.right, narrow.left, narrow.right];
    const marks = items.map((item, index) => {
      const say = `${item.label}: ${value(item.before)} → ${value(item.after)}`;
      const h = hl(props, item.id);
      const y = (fraction: number) => n(fraction);
      return `<p class="t-slope-label is-before${h}"${attrs({ 'data-t-item': item.id, 'data-t-say': say })} style="--y:${y(wideLeft[index])};--yn:${y(narrowLeft[index])}"><span class="t-slope-name">${esc(item.label)}</span> <b class="t-slope-num"${attrs({ 'data-t-num': item.before })}>${esc(value(item.before))}</b></p>`
        + `<svg class="t-slope-line${h}"${attrs({ 'data-t-item': item.id })} viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false"><line x1="0" y1="${n(item.y0 * 100)}" x2="100" y2="${n(item.y1 * 100)}"/></svg>`
        + `<i class="t-slope-dot is-before${h}"${attrs({ 'data-t-item': item.id })} style="--y:${y(item.y0)}"></i>`
        + `<i class="t-slope-dot is-after${h}"${attrs({ 'data-t-item': item.id })} style="--y:${y(item.y1)}"></i>`
        + `<p class="t-slope-label is-after${h}"${attrs({ 'data-t-item': item.id })} style="--y:${y(wideRight[index])};--yn:${y(narrowRight[index])}"><b class="t-slope-num"${attrs({ 'data-t-num': item.after })}>${esc(value(item.after))}</b> <span class="t-slope-name">${esc(item.label)}</span></p>`;
    });
    const heads = `<p class="t-slope-head is-before">${esc(str(props.beforeLabel))}</p><p class="t-slope-head is-after">${esc(str(props.afterLabel))}</p>`;
    return `<div class="t-slope"><div class="t-slope-plot" style="--h:${wide.height};--hn:${narrow.height}">${heads}${marks.join('')}</div></div>`;
  },
  table(props, context) {
    const format = formatOf(props);
    return {
      head: ['', str(props.beforeLabel), str(props.afterLabel)],
      rows: slopeGeometry(props).map((item) => [item.label, formatValue(item.before, format, context.language), formatValue(item.after, format, context.language)])
    };
  }
};
