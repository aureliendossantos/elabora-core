// cycle (D60): the loop draws itself clockwise. The first stage arrives with the centre, then each arc
// draws toward the next stage, which arrives as the arc lands (its number with a slight overshoot: a
// small piece arriving); the last arc closes the loop. Pointing at a stage (or the voice naming it)
// keeps it and the arc that brings it, and the centre says that stage, crossfading softly.
//
// Every text is in the core's markup (charts/cycle.ts): the view only shows one of the centre's.
// Under 560 px the ring is a list (cycle.css): the arcs are hidden, the return line closes the loop.

import type { ChartDom, ChartView } from './view.ts';
import { clamp01, easeInOut, easeOut } from './kit.ts';

// An item's own time (seconds), the first arc's start, and an arc's time for count stages.
const ITEM = 0.72;
const FIRST = 0.2;
const arcSeconds = (count: number) => Math.min(0.28, Math.max(0.11, 0.9 / count));
// When stage i starts, in seconds: its arc starts as the previous stage is arriving.
function startOf(index: number, count: number): number {
  if (index <= 0) return 0;
  return FIRST + (index - 1) * (arcSeconds(count) * 0.75 + 0.05);
}
const STAGGER = 0.05;

// A small overshoot for what arrives (about 8 %), settling at 1.
const backOut = (t: number) => { const c = 1.3; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

interface Cycle { centre: HTMLElement | null; rest: HTMLElement | null; says: HTMLElement[]; back: HTMLElement | null; last: string | null }
const cycles = new WeakMap<HTMLElement, Cycle>();
function cycleOf(dom: ChartDom): Cycle {
  const known = cycles.get(dom.root);
  if (known) return known;
  const cycle: Cycle = {
    centre: dom.root.querySelector('.t-cycle-centre'),
    rest: dom.root.querySelector('.t-cycle-rest'),
    says: [...dom.root.querySelectorAll<HTMLElement>('.t-cycle-say')],
    back: dom.root.querySelector('.t-cycle-back'),
    last: null
  };
  cycles.set(dom.root, cycle);
  return cycle;
}

const stageOf = (dom: ChartDom, id: string) => dom.items.elements(id).find((element) => element.classList.contains('t-cycle-stage'));
const arcOf = (dom: ChartDom, id: string) => dom.items.elements(id).find((element) => element.classList.contains('t-cycle-arc')) as unknown as SVGGElement | undefined;

// An arc drawn to a fraction (its line has pathLength 1), its head shown as it lands.
function drawArc(arc: SVGGElement | undefined, draw: number, rest: boolean): void {
  if (!arc) return;
  const line = arc.querySelector<SVGPathElement>('.t-cycle-line');
  const head = arc.querySelector<SVGPathElement>('.t-cycle-head');
  if (line) {
    line.style.strokeDasharray = rest ? '' : '1 1';
    line.style.strokeDashoffset = rest ? '' : String(1 - easeInOut(draw));
  }
  if (head) head.style.opacity = rest ? '' : String(clamp01((draw - 0.82) / 0.18));
}

// A stage arriving (a from 0 to 1): its number grows in with a little overshoot, its words follow.
function arrive(stage: HTMLElement | undefined, a: number, rest: boolean): void {
  if (!stage) return;
  const num = stage.querySelector<HTMLElement>('.t-cycle-num');
  const words = stage.querySelector<HTMLElement>('.t-cycle-words');
  if (num) {
    num.style.opacity = rest ? '' : String(clamp01(a * 3));
    num.style.scale = rest ? '' : String(0.55 + 0.45 * backOut(clamp01(a / 0.75)));
  }
  if (words) {
    const w = clamp01((a - 0.3) / 0.7);
    words.style.opacity = rest ? '' : String(w);
    words.style.translate = rest ? '' : `0 ${Math.round((1 - easeOut(w)) * 5)}px`;
  }
}

// The centre says a stage's words, or the loop's at rest (null).
function say(dom: ChartDom, id: string | null): void {
  const cycle = cycleOf(dom);
  cycle.rest?.classList.toggle('is-away', id !== null);
  for (const element of cycle.says) element.classList.toggle('is-shown', element.dataset.tFor === id);
}

export const cycleView: ChartView = {
  entrance: { item: ITEM, stagger: STAGGER },
  slot: (dom, _id, index) => startOf(index, dom.order.length) / STAGGER,
  reveal(dom, id, p) {
    const count = dom.order.length;
    const index = dom.order.indexOf(id);
    const rest = p >= 1;
    const t = p * ITEM;
    const arc = arcSeconds(count);
    if (index === 0) {
      arrive(stageOf(dom, id), clamp01(t / 0.38), rest);
      const centre = cycleOf(dom).centre;
      if (centre) centre.style.opacity = rest ? '' : String(clamp01((t - 0.05) / 0.45));
    } else {
      // The arc from the previous stage draws, then this stage arrives as it lands.
      drawArc(arcOf(dom, id), clamp01(t / arc), rest);
      arrive(stageOf(dom, id), clamp01((t - arc * 0.75) / 0.38), rest);
    }
    if (index === count - 1 && count > 1) {
      // The last stage closes the loop: the arc back into the first, and on a phone the return line.
      const close = clamp01((t - arc * 0.75 - 0.2) / arc);
      drawArc(arcOf(dom, dom.order[0]), close, rest);
      const back = cycleOf(dom).back;
      if (back) back.style.opacity = rest ? '' : String(easeOut(close));
    }
  },
  // The stage nearest the pointer, by its number (on a phone, by its row). Over the middle of the
  // ring the centre is being read: the stage it says stays.
  pick(dom, event) {
    const cycle = cycleOf(dom);
    let best: string | null = null, distance = Infinity;
    const svg = dom.root.querySelector<SVGSVGElement>('.t-cycle-svg');
    const ring = svg?.getBoundingClientRect();
    const wide = !!ring && ring.width > 0;
    if (wide && ring && cycle.last !== null) {
      const cx = ring.left + ring.width / 2, cy = ring.top + ring.height / 2;
      if (Math.hypot(event.clientX - cx, event.clientY - cy) < ring.height * 0.2) return cycle.last;
    }
    for (const id of dom.order) {
      const stage = stageOf(dom, id);
      const at = wide ? stage?.querySelector('.t-cycle-num') : stage;
      const box = at?.getBoundingClientRect();
      if (!box || (!box.width && !box.height)) continue;
      const d = wide ? Math.hypot(box.left + box.width / 2 - event.clientX, box.top + box.height / 2 - event.clientY) : Math.max(0, Math.abs(box.top + box.height / 2 - event.clientY) - box.height / 2);
      if (d < distance) { distance = d; best = id; }
    }
    cycle.last = best;
    return best;
  },
  focus(dom, id) {
    cycleOf(dom).last = id;
    say(dom, id ?? dom.spoken);
  },
  spot(dom, id) {
    if (!dom.root.classList.contains('is-focused')) say(dom, id);
  }
};
