// proportion (D60): the icons arrive in a wave from the top left (small pieces: they may overshoot a
// little), then the figure rises (counting when it is the default percentage) and the lit icons take
// the accent in turn, column after column. With a voice, the icons are there from the start and the
// lit ones take the accent at the item's moment.
//
// Pointing at the figure or at the lit icons lifts the lit icons by 2 px, softly (proportion.css).
// The chart has one item, "part": the figure and the lit icons (core charts/proportion.ts).

import type { ChartDom, ChartView } from './view.ts';
import { count } from './view.ts';
import { clamp01, easeOut, formatValue } from './kit.ts';

interface Icon { element: HTMLElement; wave: number; ink: HTMLElement | null; turn: number }
interface Proportion { icons: Icon[]; lit: Icon[]; figure: HTMLElement | null; big: HTMLElement | null }
const charts = new WeakMap<HTMLElement, Proportion>();

function proportionOf(dom: ChartDom): Proportion {
  const known = charts.get(dom.root);
  if (known) return known;
  const icons = [...dom.root.querySelectorAll<HTMLElement>('.t-prop-icon')].map((element) => ({
    element, wave: Number(element.dataset.wave) || 0, ink: element.querySelector<HTMLElement>('.t-prop-ink'), turn: Number(element.dataset.turn) || 0
  }));
  const chart = { icons, lit: icons.filter((icon) => icon.ink), figure: dom.root.querySelector<HTMLElement>('.t-prop-figure'), big: dom.root.querySelector<HTMLElement>('.t-prop-big') };
  charts.set(dom.root, chart);
  return chart;
}

// Ease out with a small overshoot (about 6 %), for icons arriving.
const settle = (t: number) => { const c = 1.2; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };

export const proportionView: ChartView = {
  entrance: { item: 0.85, stagger: 0.09, frame: 0.9 },
  // The wave: each icon in its turn, from the top left to the bottom right.
  frame(dom, p) {
    const rest = p >= 1;
    for (const icon of proportionOf(dom).icons) {
      const q = clamp01((p - icon.wave * 0.55) / 0.45);
      const style = icon.element.style;
      style.opacity = rest ? '' : String(clamp01(q * 2.5));
      style.scale = rest ? '' : String(0.4 + 0.6 * settle(q));
      style.translate = rest ? '' : `0 ${((1 - easeOut(q)) * 5).toFixed(2)}px`;
    }
  },
  // The figure rises (and counts), then the lit icons take the accent in turn.
  reveal(dom, id, p) {
    const chart = proportionOf(dom);
    const rest = p >= 1;
    if (chart.figure) {
      const e = easeOut(clamp01(p / 0.55));
      chart.figure.style.opacity = rest ? '' : String(clamp01(p * 3));
      chart.figure.style.translate = rest ? '' : `0 ${((1 - e) * 8).toFixed(2)}px`;
    }
    if (chart.big?.dataset.tNum) count(chart.big, rest ? 1 : easeOut(clamp01(p / 0.8)), (value) => formatValue(value, { unit: '%' }, dom.language));
    for (const icon of chart.lit) {
      if (!icon.ink) continue;
      const q = clamp01((p - 0.12 - icon.turn * 0.5) / 0.3);
      icon.ink.style.opacity = rest ? '' : String(easeOut(q));
    }
  },
  // The figure and the lit icons answer (within a few pixels of them); the rest of the grid does not.
  pick(dom, event) {
    const chart = proportionOf(dom);
    const near = (rect: DOMRect | undefined, margin: number) => !!rect && rect.width > 0
      && event.clientX >= rect.left - margin && event.clientX <= rect.right + margin && event.clientY >= rect.top - margin && event.clientY <= rect.bottom + margin;
    if (near(chart.figure?.getBoundingClientRect(), 8)) return 'part';
    for (const icon of chart.lit) if (near(icon.element.getBoundingClientRect(), 4)) return 'part';
    return null;
  }
};
