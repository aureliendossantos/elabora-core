// How each chart moves (D60): the views of the types, by type (view.ts says what a view is).

import type { ChartView } from './view.ts';
import { count, setVar, writtenText } from './view.ts';
import { easeOut, clamp01, formatValue, formatMinutes } from './kit.ts';
import { trendView } from './trend.ts';
import { diagramView } from './diagram.ts';
import { donutView } from './donut.ts';
import { proportionView } from './proportion.ts';
import { beforeAfterView } from './before-after.ts';
import { levelsView } from './levels.ts';
import { processView } from './process.ts';
import { cycleView } from './cycle.ts';
import { matrixView } from './matrix.ts';
import { milestonesView } from './milestones.ts';

export type { ChartDom, ChartView } from './view.ts';
export { defaultView } from './view.ts';


// bars: every bar grows from the axis in reading order and counts its value; then the one that
// carries the idea takes the colour (the focus pull).
const barsView: ChartView = {
  entrance: { item: 0.9, stagger: 0.07 },
  reveal(dom, id, p) {
    const e = easeOut(p);
    const [label, track] = dom.items.elements(id);
    if (label) { label.style.opacity = p >= 1 ? '' : String(clamp01(p * 3)); }
    const bar = track?.querySelector<HTMLElement>('.t-bars-bar');
    if (bar) bar.style.scale = p >= 1 ? '' : `${e} 1`;
    const value = track?.querySelector<HTMLElement>('.t-bars-value');
    if (value) {
      value.style.opacity = p >= 1 ? '' : String(clamp01((p - 0.1) * 4));
      // The value rides at the end of its bar while it grows.
      value.style.translate = p >= 1 || !bar ? '' : `${Math.round(-(1 - e) * bar.offsetWidth)}px 0`;
      count(value, e, dom.format_);
    }
  }
};

// key-figures: the cards rise in turn, their figures count (a duration counts down from its old value).
const keyFiguresView: ChartView = {
  entrance: { item: 1.2, stagger: 0.14 },
  reveal(dom, id, p) {
    const card = dom.items.first(id);
    if (!card) return;
    const e = easeOut(p);
    card.style.opacity = p >= 1 ? '' : String(clamp01(p * 2.5));
    card.style.translate = p >= 1 ? '' : `0 ${(1 - e) * 0.9}rem`;
    setVar(card, '--t-progress', p >= 1 ? '1' : String(e));
    const figure = card.querySelector<HTMLElement>('[data-t-count]');
    if (!figure) return;
    const text = writtenText(figure);
    if (p >= 1) { figure.textContent = text; return; }
    try {
      const spec = JSON.parse(figure.dataset.tCount ?? '{}') as { from?: number; to: number; format?: string; decimals?: number };
      const value = (spec.from ?? 0) + (spec.to - (spec.from ?? 0)) * e;
      figure.textContent = spec.format === 'minutes' ? formatMinutes(value, dom.language) : formatValue(value, { unit: spec.format === 'percent' ? '%' : undefined, decimals: spec.decimals }, dom.language);
    } catch { figure.textContent = text; }
  }
};

export const VIEWS: Readonly<Record<string, ChartView>> = {
  bars: barsView,
  'key-figures': keyFiguresView,
  trend: trendView,
  diagram: diagramView,
  donut: donutView,
  proportion: proportionView,
  'before-after': beforeAfterView,
  levels: levelsView,
  process: processView,
  cycle: cycleView,
  matrix: matrixView,
  milestones: milestonesView
};

