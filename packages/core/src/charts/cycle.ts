// cycle: a loop of stages around a centre (D60). The stages are HTML placed in percentages of a 3:2
// box (numbers, titles and texts wrap and translate); the arcs between them are one SVG with a uniform
// viewBox of the same proportions, each ending in a small arrowhead that shows the direction. A stage's
// title sits outside the ring, on the side it faces, so the middle stays free for the centre: the loop's
// name at rest, the stage pointed at (or said by the voice) when there is one (the player swaps them;
// every text is in the markup, stacked).
//
// Each arc belongs to the stage it leads into (data-t-item), so pointing at a stage keeps the arc that
// brings it. Under 560 px (cycle.css) the ring becomes a list: numbers down a spine, every text shown,
// and a return line from the last stage back to the first.

import { esc, attrs, hl } from './frame.ts';
import { n } from './format.ts';
import type { ChartType } from './types.ts';
import { isRecord, recordsOf, str, itemsOf } from './values.ts';

// The drawing space (the ring box is 3:2, cut under the ring by heightOf), the ring's centre and radius.
export const VIEW = { w: 300, h: 200, cx: 150, cy: 100, r: 66 } as const;
// Room kept free around a stage's number on its arcs (viewBox units): the number's disc and a breath.
const GAP = 15;
// The arrowhead's length and half width (viewBox units).
const HEAD = 5.2, WING = 3.3;

export interface Stage { id: string; title: string; text: string; angle: number; x: number; y: number; side: 'top' | 'bottom' | 'left' | 'right' }

// Stage i of count: clockwise from the top.
export function stagesOf(props: Record<string, unknown>): Stage[] {
  const items = recordsOf(props.items);
  return items.map((item, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / items.length;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const side = Math.abs(cos) < 0.35 ? (sin < 0 ? 'top' : 'bottom') : cos > 0 ? 'right' : 'left';
    return { id: str(item.id), title: str(item.title), text: str(item.text), angle, x: VIEW.cx + VIEW.r * cos, y: VIEW.cy + VIEW.r * sin, side };
  });
}

const point = (angle: number) => ({ x: VIEW.cx + VIEW.r * Math.cos(angle), y: VIEW.cy + VIEW.r * Math.sin(angle) });

// The arc from stage `from` to the next (clockwise), and its arrowhead at the end.
export function arcOf(from: Stage, count: number): { d: string; head: string } | null {
  if (count < 2) return null;
  const step = (2 * Math.PI) / count;
  const free = GAP / VIEW.r;
  const a0 = from.angle + free;
  const tip = from.angle + step - free;
  const a1 = tip - HEAD / VIEW.r;
  if (a1 <= a0) return null;
  const start = point(a0), end = point(a1), at = point(tip);
  const d = `M${n(start.x)} ${n(start.y)}A${VIEW.r} ${VIEW.r} 0 0 1 ${n(end.x)} ${n(end.y)}`;
  // The head points along the circle at its tip; its base sits across the arc's end.
  const nx = Math.cos(a1), ny = Math.sin(a1);
  const head = `M${n(at.x)} ${n(at.y)}L${n(end.x + nx * WING)} ${n(end.y + ny * WING)}L${n(end.x - nx * WING)} ${n(end.y - ny * WING)}Z`;
  return { d, head };
}

// The ring box's height: the full 3:2 when a stage sits at the bottom (its title goes under it);
// otherwise cut under the lowest arc or stage (with room for its number and its words, centred on it),
// so an odd ring leaves no empty band under it.
export function heightOf(stages: Stage[]): number {
  if (stages.some((stage) => stage.side === 'bottom')) return VIEW.h;
  const lowest = Math.max(...stages.map((stage) => stage.y));
  return Math.min(VIEW.h, Math.max(VIEW.cy + VIEW.r + WING + 2, lowest + 16));
}

const say = (stage: Stage, index: number) => `${index + 1}. ${stage.title}${stage.text ? `: ${stage.text}` : ''}`;

export const cycle: ChartType = {
  axis: 'xy',
  items: (props) => itemsOf(props.items, 'items'),
  body(props) {
    const stages = stagesOf(props);
    if (!stages.length) return '';
    const center = isRecord(props.center) ? props.center : {};
    const pct = (value: number, of: number) => `${n((value / of) * 100)}%`;
    const h = heightOf(stages);
    const words = (title: string, text: string) => `${title ? `<p class="t-cycle-name">${esc(title)}</p>` : ''}${text ? `<p class="t-cycle-about">${esc(text)}</p>` : ''}`;
    // The centre: the loop at rest (when it has one: center is optional, the middle then stays empty
    // until a stage is pointed at), then each stage's words, stacked in one place (the player shows one).
    const rest = words(str(center.title), str(center.text));
    const centre = '<div class="t-cycle-centre">'
      + (rest ? `<div class="t-cycle-rest">${rest}</div>` : '')
      + stages.map((stage) => `<div class="t-cycle-say"${attrs({ 'data-t-for': stage.id })}>${words(stage.title, stage.text)}</div>`).join('')
      + '</div>';
    const nodes = stages.map((stage, index) => `<div class="t-cycle-stage is-${stage.side}${hl(props, stage.id)}"${attrs({ 'data-t-item': stage.id, 'data-t-say': say(stage, index) })} style="--x:${pct(stage.x, VIEW.w)};--y:${pct(stage.y, h)}">`
      + `<span class="t-cycle-num">${index + 1}</span>`
      + `<span class="t-cycle-words"><span class="t-cycle-title">${esc(stage.title)}</span>${stage.text ? `<span class="t-cycle-text">${esc(stage.text)}</span>` : ''}</span>`
      + '</div>').join('');
    // Arc k leads into stage k + 1 (the last one closes the loop into the first).
    const arcs = stages.map((stage, index) => {
      const arc = arcOf(stage, stages.length);
      if (!arc) return '';
      const into = stages[(index + 1) % stages.length];
      return `<g class="t-cycle-arc${hl(props, into.id)}"${attrs({ 'data-t-item': into.id })}><path class="t-cycle-line" d="${arc.d}" pathLength="1"/><path class="t-cycle-head" d="${arc.head}"/></g>`;
    }).join('');
    const svg = arcs ? `<svg class="t-cycle-svg" viewBox="0 0 ${VIEW.w} ${n(h)}" focusable="false">${arcs}</svg>` : '';
    // The ring's stages come before its arcs: a stage is its item's first element.
    return `<div class="t-cycle" style="--n:${stages.length};--h:${n(h)};--cy:${n(VIEW.cy / h)}">${centre}<div class="t-cycle-ring">${nodes}${svg}<i class="t-cycle-back"></i></div></div>`;
  },
  table(props) {
    return { head: [], rows: stagesOf(props).map((stage, index) => [`${index + 1}. ${stage.title}`, stage.text]) };
  }
};
