// trend: a change over time. The line and its area are SVG in a viewBox stretched to the plot (strokes
// do not scale); everything with words, and every point, is HTML placed in percentages, so the chart is
// right at any width. In predict mode the markup is the whole answer (exports, fit checks, the canvas);
// the player hides the points after predict.from until the learner has drawn them.

import { scaleLinear } from 'd3-scale';
import { line as lineShape, area as areaShape, curveMonotoneX } from 'd3-shape';
import { esc, attrs } from './frame.ts';
import { formatValue, n } from './format.ts';
import type { ChartType } from './types.ts';
import { isRecord, recordsOf, num, str } from './values.ts';

// The plot's drawing space (the SVG's viewBox), stretched to the plot's box.
const W = 1000, H = 360;

export interface Point { id: string; x: number | string; y: number; px: number; py: number }

export function trendGeometry(props: Record<string, unknown>) {
  const raw = recordsOf(props.points).filter((point) => typeof point.y === 'number');
  const numeric = raw.every((point) => typeof point.x === 'number');
  const xs = raw.map((point, index) => (numeric ? Number(point.x) : index));
  const x = scaleLinear().domain([Math.min(...xs), Math.max(...xs)]).range([0, W]);
  const values = raw.map((point) => num(point.y));
  const low = typeof props.yMin === 'number' ? props.yMin : Math.min(0, ...values);
  const high = typeof props.yMax === 'number' ? props.yMax : Math.max(...values) * 1.15 || 1;
  const y = scaleLinear().domain([low, high]).nice(4).range([H, 0]);
  const points: Point[] = raw.map((point, index) => ({ id: `p${index}`, x: numeric ? Number(point.x) : str(point.x), y: num(point.y), px: x(xs[index]), py: y(num(point.y)) }));
  const ticks = y.ticks(4);
  const indexOf = (value: unknown): number => {
    const found = points.findIndex((point) => point.x === value || String(point.x) === String(value));
    return found;
  };
  return { points, x, y, ticks, numeric, indexOf, domain: y.domain() as [number, number] };
}

const path = (points: readonly Point[]) => lineShape<Point>().x((point) => point.px).y((point) => point.py).curve(curveMonotoneX)(points as Point[]) ?? '';

export const trend: ChartType = {
  axis: 'x',
  items: (props) => (Array.isArray(props.points) ? props.points : []).flatMap((point, index) => (isRecord(point) && isRecord(point.at) ? [{ id: `p${index}`, at: point.at as never, path: `/points/${index}/at` }] : [])),
  figure(props, context) {
    if (props.mode !== 'predict' || !isRecord(props.predict)) return {};
    const { points, domain, indexOf } = trendGeometry(props);
    const from = indexOf(props.predict.from);
    if (from < 0 || from >= points.length - 1) return {};
    // The slider sets the guess for the last year (keys, screen readers); the player gives it its
    // label and fills the button when the author left its words to the player.
    const step = (domain[1] - domain[0]) / 200;
    const after = '<div class="t-trend-ask">'
      + `<input class="t-trend-range t-sr-only" type="range"${attrs({ min: n(domain[0]), max: n(domain[1]), step: n(step), value: n(points[from].y) })}>`
      + `<button type="button" class="t-btn t-btn--primary t-trend-reveal" disabled>${esc(str(props.predict.button))}</button>`
      + '<p class="t-trend-feedback"></p>'
      + '</div>';
    return { className: 'is-predict', after };
  },
  body(props, context) {
    const { points, ticks, y, indexOf } = trendGeometry(props);
    if (points.length < 2) return '';
    const format = { unit: str(props.unit) || undefined, decimals: num(props.decimals) };
    const value = (v: number) => formatValue(v, format, context.language);
    const pct = (v: number, of: number) => `${n((v / of) * 100)}%`;
    const first = points[0], last = points[points.length - 1];
    const area = areaShape<Point>().x((point) => point.px).y0(y(Math.max(y.domain()[0], 0))).y1((point) => point.py).curve(curveMonotoneX)(points) ?? '';
    const grid = ticks.map((tick) => `<line x1="0" x2="${W}" y1="${n(y(tick))}" y2="${n(y(tick))}"/>`).join('');
    const svg = `<svg class="t-trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" focusable="false">`
      + `<g class="t-trend-grid">${grid}</g>`
      + `<path class="t-trend-area" d="${area}"/>`
      + `<path class="t-trend-line" d="${path(points)}" pathLength="1"/>`
      + (props.mode === 'predict' ? '<path class="t-trend-guess" d=""/>' : '')
      + '</svg>';
    const yTicks = ticks.filter((tick) => tick !== y.domain()[0]).map((tick) => `<span class="t-trend-ytick" style="top:${pct(y(tick), H)}">${esc(value(tick))}</span>`).join('');
    const xTicks = points.map((point, index) => `<span class="t-trend-xtick${index % 2 && index !== points.length - 1 ? ' is-minor' : ''}" style="left:${pct(point.px, W)}">${esc(String(point.x))}</span>`).join('');
    const marks = points.map((point) => {
      const said = `${point.x}: ${value(point.y)}`;
      return `<i class="t-trend-point"${attrs({ 'data-t-item': point.id, 'data-t-say': said, 'data-t-tip': said, 'data-t-num': point.y })} style="left:${pct(point.px, W)};top:${pct(point.py, H)}"></i>`;
    }).join('');
    const note = isRecord(props.note) && indexOf(props.note.x) >= 0 ? (() => {
      const at = points[indexOf((props.note as Record<string, unknown>).x)];
      return `<div class="t-trend-note${at.px > W * 0.55 ? ' is-left' : ''}" style="left:${pct(at.px, W)}"${attrs({ 'data-t-at': at.id })}><span>${esc(str((props.note as Record<string, unknown>).text))}</span></div>`;
    })() : '';
    const ends = `<span class="t-trend-start" style="left:${pct(first.px, W)};top:${pct(first.py, H)}">${esc(value(first.y))}</span>`
      + `<i class="t-trend-dot" style="left:${pct(last.px, W)};top:${pct(last.py, H)}"></i>`
      + `<span class="t-trend-end" style="left:${pct(last.px, W)};top:${pct(last.py, H)}"${attrs({ 'data-t-num': last.y })}>${esc(value(last.y))}</span>`;
    const predict = props.mode === 'predict' && isRecord(props.predict) ? (() => {
      const from = indexOf(props.predict.from);
      if (from < 0 || from >= points.length - 1) return '';
      return `<div class="t-trend-zone" style="left:${pct(points[from].px, W)}"${attrs({ 'data-t-from': from })}><span class="t-trend-hint">${esc(str(props.predict.hint))}</span></div><span class="t-trend-guess-label" hidden></span>`;
    })() : '';
    return `<div class="t-trend-plot"><div class="t-trend-area-box">${svg}${yTicks}${xTicks}${note}${marks}${ends}${predict}</div></div>`;
  },
  table(props, context) {
    const { points } = trendGeometry(props);
    const format = { unit: str(props.unit) || undefined, decimals: num(props.decimals) };
    return { head: [], rows: points.map((point) => [String(point.x), formatValue(point.y, format, context.language)]) };
  },
  data(props) {
    const { points, domain, indexOf } = trendGeometry(props);
    const base = { points: points.map((point) => ({ x: point.x, y: point.y, px: point.px / W, py: point.py / H })), domain, format: { unit: str(props.unit) || undefined, decimals: num(props.decimals) } };
    if (props.mode !== 'predict' || !isRecord(props.predict)) return base;
    const p = props.predict;
    const range = domain[1] - domain[0];
    return {
      ...base,
      predict: {
        from: indexOf(p.from),
        hint: str(p.hint) || undefined, button: str(p.button) || undefined, close: str(p.close) || undefined, far: str(p.far) || undefined,
        tolerance: typeof p.tolerance === 'number' ? p.tolerance : range / 10,
        scored: p.scored === true, weight: typeof p.weight === 'number' ? p.weight : 1, ...(typeof p.objective === 'string' ? { objective: p.objective } : {})
      }
    };
  }
};
