// process (D60): the link draws from one step to the next, and each step's circle arrives as the
// link reaches it (a small overshoot: a circle is a small piece), its words fading in just after.
// The link into a step belongs to that step's entrance, so with a voice the line runs to each step
// as the voice names it. Pointing at a step is soothing (process.css): the others step back.

import type { ChartDom, ChartView } from './view.ts';
import { clamp01, easeOut } from './kit.ts';

// Seconds, in a step's own time: the link into it draws, then its circle arrives, then its words.
const LINK = 0.13;      // the link from the previous circle (none before the first step)
const OVERLAP = 0.03;   // the next link leaves while a circle is still arriving
const CIRCLE = 0.42;
const WORDS = 0.45, WORDS_AFTER = 0.1;
const ITEM = LINK + Math.max(CIRCLE, WORDS_AFTER + WORDS);
const STAGGER = 0.1;    // the unit of slots (the behaviour's)

// A small overshoot (about 6 %) for the circles that arrive.
const backOut = (t: number): number => { const c = 1.2; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

const stepOf = (dom: ChartDom, id: string) => dom.items.first(id)?.closest<HTMLElement>('.t-process-step') ?? null;

function set(element: Element | null | undefined, values: Record<string, string>): void {
  if (!element) return;
  const style = (element as HTMLElement).style;
  for (const [name, value] of Object.entries(values)) style.setProperty(name, value);
}

export const processView: ChartView = {
  entrance: { item: ITEM, stagger: STAGGER },
  // The first step at once; each next one when the circle before it has started to arrive.
  slot(_dom, _id, index) {
    return index === 0 ? 0 : ((index - 1) * (LINK + OVERLAP) + OVERLAP) / STAGGER;
  },
  reveal(dom, id, p) {
    const index = dom.order.indexOf(id);
    const rest = p >= 1;
    const t = p * ITEM;
    // The first circle arrives at once; the others just before their link reaches them.
    const arrives = index === 0 ? 0 : LINK - OVERLAP;
    // The link from the previous step, drawn toward this one (across, or down when narrow).
    const link = index > 0 ? stepOf(dom, dom.order[index - 1])?.querySelector<HTMLElement>('.t-process-link') : null;
    if (link) {
      const w = clamp01(t / LINK);
      const down = link.offsetHeight > link.offsetWidth;
      set(link, { scale: rest ? '' : down ? `1 ${w}` : `${w} 1` });
    }
    const circle = clamp01((t - arrives) / CIRCLE);
    const words = easeOut(clamp01((t - arrives - WORDS_AFTER) / WORDS));
    for (const element of dom.items.elements(id)) {
      if (element.classList.contains('t-process-n')) {
        set(element, rest ? { opacity: '', scale: '' } : { opacity: String(clamp01(circle * 4)), scale: String(0.35 + 0.65 * backOut(circle)) });
      } else {
        set(element, rest ? { opacity: '', translate: '' } : { opacity: String(words), translate: `0 ${((1 - words) * 0.375).toFixed(3)}rem` });
      }
    }
  }
};
