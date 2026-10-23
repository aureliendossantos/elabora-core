// before-after (D60): the columns' headings come first; then, item by item, the dot on the left pops
// in with its label, the line draws itself to the right, and the right dot and label arrive as it
// lands, the value counting from the one before. The pointer picks the line nearest to it at its x
// (between the columns, a line is where it crosses), or the label it is on; the others step back
// (charts.css).

import type { ChartView } from './view.ts';
import { count } from './view.ts';
import { clamp01, easeInOut, easeOut } from './kit.ts';

// A small overshoot for the dots (small pieces that arrive), as a pure function of t.
const backOut = (t: number) => { const c = 1.2; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
const centre = (element: Element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; };

export const beforeAfterView: ChartView = {
  entrance: { item: 0.9, stagger: 0.07, frame: 0.3 },
  // Many items are staggered tighter, so the whole stays near a second.
  slot(dom, _id, index) {
    const last = dom.order.length - 1;
    return index * (last > 4 ? 4 / last : 1);
  },
  frame(dom, p) {
    for (const head of dom.root.querySelectorAll<HTMLElement>('.t-slope-head')) head.style.opacity = p >= 1 ? '' : String(easeOut(p));
  },
  reveal(dom, id, p) {
    const done = p >= 1;
    const elements = dom.items.elements(id);
    const leftLabel = elements.find((element) => element.matches('.t-slope-label.is-before'));
    const rightLabel = elements.find((element) => element.matches('.t-slope-label.is-after'));
    const leftDot = elements.find((element) => element.matches('.t-slope-dot.is-before'));
    const rightDot = elements.find((element) => element.matches('.t-slope-dot.is-after'));
    const line = elements.find((element) => element.matches('.t-slope-line'));
    // The left dot pops, its label fades in.
    const a = clamp01(p / 0.3);
    if (leftDot) { leftDot.style.opacity = done ? '' : String(clamp01(a * 3)); leftDot.style.scale = done ? '' : String(Math.max(0, backOut(a))); }
    if (leftLabel) leftLabel.style.opacity = done ? '' : String(a);
    // The line draws from left to right (its box spans the two columns).
    const d = easeInOut(clamp01((p - 0.18) / 0.6));
    if (line) {
      line.style.opacity = done ? '' : d > 0 ? '1' : '0';
      line.style.clipPath = done ? '' : `inset(-2rem ${Math.round((1 - d) * 10000) / 100}% -2rem -1rem)`;
    }
    // The right dot lands, its label arrives with the value counting from the one before.
    const b = clamp01((p - 0.74) / 0.26);
    if (rightDot) { rightDot.style.opacity = done ? '' : String(clamp01(b * 3)); rightDot.style.scale = done ? '' : String(Math.max(0, backOut(b))); }
    if (rightLabel) {
      rightLabel.style.opacity = done ? '' : String(b);
      rightLabel.style.translate = done ? '' : `${-(1 - easeOut(b)) * 0.5}rem 0`;
      const before = Number(leftLabel?.querySelector<HTMLElement>('[data-t-num]')?.dataset.tNum);
      count(rightLabel.querySelector<HTMLElement>('[data-t-num]'), done ? 1 : easeOut(b), dom.format_, Number.isFinite(before) ? before : 0);
    }
  },
  // The label under the pointer, else the line nearest to it where it is between the columns.
  pick(dom, event) {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.t-slope-label[data-t-item]') : null;
    if (target) return target.dataset.tItem ?? null;
    const plot = dom.root.querySelector('.t-slope-plot')?.getBoundingClientRect();
    if (!plot || event.clientY < plot.top - 24 || event.clientY > plot.bottom + 24) return null;
    let best: string | null = null, distance = Infinity;
    for (const id of dom.order) {
      const elements = dom.items.elements(id);
      const left = elements.find((element) => element.matches('.t-slope-dot.is-before'));
      const right = elements.find((element) => element.matches('.t-slope-dot.is-after'));
      if (!left || !right) continue;
      const l = centre(left), r = centre(right);
      const t = clamp01((event.clientX - l.x) / ((r.x - l.x) || 1));
      const gap = Math.abs(l.y + (r.y - l.y) * t - event.clientY);
      if (gap < distance) { distance = gap; best = id; }
    }
    return best;
  }
};
