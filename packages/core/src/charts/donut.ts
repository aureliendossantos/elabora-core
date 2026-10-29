// donut: a whole in 2 to 5 parts, as a ring. The ring is SVG in a uniform viewBox (it must stay round);
// the centre figure and the legend are HTML, so they wrap and translate.
//
// Each part is a filled arc (rounded corners, a gap between parts) masked by a stroke along its middle:
// the player draws a part clockwise by moving the mask's dash, without touching the arc. The centre
// holds one face at rest (the highlighted part, or the total) and one face per part, hidden: a face
// carries its part's data-t-item, so pointing at a part (or the voice naming it) shows its face in
// the centre by CSS alone. A part's arc, its legend row and its face answer together.
//
// Colours: with a highlight, the other parts take steps of ink and the highlighted one a darker ink
// until the focus pull gives it the accent; without one, the parts take steps of the accent.

import { arc as arcShape, pie as pieShape } from 'd3-shape';
import type { PieArcDatum } from 'd3-shape';
import { esc, attrs, hl } from './frame.ts';
import { formatValue, n } from './format.ts';
import type { ChartType, ChartContext } from './types.ts';
import { recordsOf, num, str, itemsOf } from './values.ts';

// The ring in viewBox units: the drawing space is -100..100 on both axes.
const OUTER = 98, INNER = 64, MIDDLE = (OUTER + INNER) / 2;
const PAD = 0.022; // radians between two parts

export interface Part { id: string; label: string; value: number }

export function partsOf(props: Record<string, unknown>): Part[] {
  return recordsOf(props.parts).map((part) => ({ id: str(part.id), label: str(part.label), value: Math.max(0, num(part.value)) }));
}

const formatOf = (props: Record<string, unknown>) => ({ unit: str(props.unit) || undefined, decimals: num(props.decimals) });

// The point at angle a (radians, 0 at the top, clockwise) on a circle of radius r.
const at = (a: number, r: number) => `${n(Math.sin(a) * r)},${n(-Math.cos(a) * r)}`;

// The middle line of a part, clockwise from a0 to a1 (two halves for a whole turn): what the mask draws.
function middle(a0: number, a1: number): string {
  const sweep = a1 - a0;
  if (sweep <= 0) return '';
  if (sweep >= Math.PI * 2 - 1e-6) {
    const half = a0 + Math.PI;
    return `M${at(a0, MIDDLE)}A${MIDDLE},${MIDDLE} 0 0 1 ${at(half, MIDDLE)}A${MIDDLE},${MIDDLE} 0 0 1 ${at(a0 + Math.PI * 2 - 1e-4, MIDDLE)}`;
  }
  return `M${at(a0, MIDDLE)}A${MIDDLE},${MIDDLE} 0 ${sweep > Math.PI ? 1 : 0} 1 ${at(a1, MIDDLE)}`;
}

// The colour of each part, as a variable of donut.css.
function shades(parts: readonly Part[], highlight: string | null): string[] {
  let step = 0;
  return parts.map((part) => (highlight === null ? `var(--t-donut-a${Math.min(step++, 5)})` : part.id === highlight ? 'var(--t-donut-hl)' : `var(--t-donut-k${Math.min(step++, 4)})`));
}

export function donutGeometry(props: Record<string, unknown>) {
  const parts = partsOf(props);
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const arcs: PieArcDatum<Part>[] = total > 0 ? pieShape<Part>().sort(null).value((part) => part.value)(parts) : parts.map((part, index) => ({ data: part, value: 0, index, startAngle: 0, endAngle: 0, padAngle: 0 }));
  const highlight = typeof props.highlight === 'string' && parts.some((part) => part.id === props.highlight) ? props.highlight : null;
  return { parts, total, arcs, highlight };
}

export const donut: ChartType = {
  axis: 'xy',
  items: (props) => itemsOf(props.parts, 'parts'),
  body(props, context: ChartContext) {
    const { parts, total, arcs, highlight } = donutGeometry(props);
    const format = formatOf(props);
    const value = (v: number) => formatValue(v, format, context.language);
    const colours = shades(parts, highlight);
    const shape = arcShape<PieArcDatum<Part>>().innerRadius(INNER).outerRadius(OUTER).cornerRadius(3.5).padAngle((d) => (d.value > 0 && d.value < total ? PAD : 0)).digits(2);
    const id = (suffix: string) => `${context.id}-donut-${suffix}`;
    const ring = arcs.map((d, index) => {
      const part = d.data;
      // Its colour; its place on the ring as turns (the pointer picks by angle).
      const style = `--c:${colours[index]}`;
      const say = `${part.label}: ${value(part.value)}`;
      const path = shape(d) ?? '';
      return `<mask id="${esc(id(`m${index}`))}" maskUnits="userSpaceOnUse" x="-110" y="-110" width="220" height="220"><path class="t-donut-sweep" d="${middle(d.startAngle, d.endAngle)}" pathLength="1" fill="none" stroke="#fff" stroke-width="44"/></mask>`
        + `<path class="t-donut-arc${hl(props, part.id)}"${attrs({ 'data-t-item': part.id, 'data-t-say': say, 'data-turn': `${n(d.startAngle / (Math.PI * 2))} ${n(d.endAngle / (Math.PI * 2))}`, mask: `url(#${id(`m${index}`)})` })} style="${style}" d="${path}"/>`;
    }).join('');
    const svg = `<svg class="t-donut-svg" viewBox="-100 -100 200 200" focusable="false">${ring}</svg>`;
    // The centre at rest: the highlighted part, else the total (and its label).
    const showsTotal = props.center === 'total' || highlight === null;
    const restPart = showsTotal ? null : parts.find((part) => part.id === highlight)!;
    const restValue = restPart ? restPart.value : total;
    const restLabel = restPart ? restPart.label : str(props.totalLabel);
    const face = (figure: number, label: string, className: string, data: Record<string, string | number | null>, counted: boolean) => `<p class="${className}"${attrs(data)}>`
      + `<span class="t-donut-figure"${counted ? attrs({ 'data-t-num': figure }) : ''}>${esc(value(figure))}</span>`
      + (label ? `<span class="t-donut-name">${esc(label)}</span>` : '')
      + '</p>';
    const faces = face(restValue, restLabel, `t-donut-face is-rest${restPart ? ' is-hl' : ''}`, {}, true)
      + parts.map((part) => face(part.value, part.label, `t-donut-face${hl(props, part.id)}`, { 'data-t-item': part.id }, false)).join('');
    const legend = parts.map((part, index) => `<li class="t-donut-row${hl(props, part.id)}"${attrs({ 'data-t-item': part.id })} style="--c:${colours[index]}">`
      + '<i class="t-donut-swatch"></i>'
      + `<span class="t-donut-label">${esc(part.label)}</span>`
      + `<span class="t-donut-value">${esc(value(part.value))}</span>`
      + '</li>').join('');
    return `<div class="t-donut-layout"><div class="t-donut-ring">${svg}<div class="t-donut-center">${faces}</div></div><ul class="t-donut-legend">${legend}</ul></div>`;
  },
  table(props, context) {
    const format = formatOf(props);
    return { head: [], rows: partsOf(props).map((part) => [part.label, formatValue(part.value, format, context.language)]) };
  }
};
