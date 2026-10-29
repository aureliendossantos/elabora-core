// donut (D60): the ring draws itself clockwise, part after part, each legend row arriving with its part,
// while the centre counts up with the share of the ring drawn; then the focus pull gives the
// highlighted part the accent (donut.css).
//
// Pointing at a part (on the ring, by angle, or at its legend row) is soothing and nothing moves: the
// part takes the accent (the highlight gives it up meanwhile), the others step back, and the centre
// cross-fades to the part's face (CSS: faces carry their part's data-t-item). The core's markup is
// described in core charts/donut.ts.

import type { ChartDom, ChartView } from './view.ts';
import { count } from './view.ts';
import { clamp01, easeOut } from './kit.ts';

// Seconds the whole ring takes to draw, the pause between two parts, an item's whole entrance (its
// part's sweep, its legend row's rise), and a legend row's rise.
const SWEEP = 0.8;
const STAGGER = 0.05;
const ITEM = 0.45;
const ROW = 0.4;

interface Part { id: string; from: number; to: number; arc: SVGPathElement | null; sweep: SVGPathElement | null; row: HTMLElement | null }
interface Donut { parts: Map<string, Part>; drawn: Map<string, number>; rest: HTMLElement | null; svg: SVGSVGElement | null }
const donuts = new WeakMap<HTMLElement, Donut>();

function donutOf(dom: ChartDom): Donut {
  const known = donuts.get(dom.root);
  if (known) return known;
  const parts = new Map<string, Part>();
  for (const id of dom.order) {
    const elements = dom.items.elements(id);
    const arc = (elements.find((element) => element.matches('.t-donut-arc')) ?? null) as unknown as SVGPathElement | null;
    const [from, to] = (arc?.dataset.turn ?? '0 0').split(' ').map(Number);
    const mask = arc?.getAttribute('mask')?.match(/url\(#(.+)\)/)?.[1];
    const sweep = mask ? dom.root.querySelector<SVGPathElement>(`[id="${CSS.escape(mask)}"] .t-donut-sweep`) : null;
    parts.set(id, { id, from: from || 0, to: to || 0, arc, sweep, row: elements.find((element) => element.matches('.t-donut-row')) ?? null });
  }
  const donut: Donut = {
    parts, drawn: new Map(),
    rest: dom.root.querySelector<HTMLElement>('.t-donut-face.is-rest'),
    svg: dom.root.querySelector<SVGSVGElement>('.t-donut-svg')
  };
  donuts.set(dom.root, donut);
  return donut;
}

// A part's own drawing, from its item's progress p: a part takes the time of its size, so the ring
// sweeps at about one speed (a small part still takes a moment, a large one at most the item's time).
function drawOf(part: Part, p: number): number {
  const seconds = Math.min(ITEM, Math.max(0.12, (part.to - part.from) * SWEEP));
  return clamp01((p * ITEM) / seconds);
}

export const donutView: ChartView = {
  // slot: when the sweep reaches each part (in staggers), a short pause between parts.
  entrance: { item: ITEM, stagger: STAGGER },
  slot(dom, id, index) {
    const donut = donutOf(dom);
    const part = donut.parts.get(id);
    return part ? (part.from * SWEEP) / STAGGER + index : index;
  },
  reveal(dom, id, p) {
    const donut = donutOf(dom);
    const part = donut.parts.get(id);
    if (!part) return;
    const rest = p >= 1;
    const draw = drawOf(part, p);
    const e = 1 - (1 - draw) ** 2;
    if (part.arc) part.arc.style.opacity = rest || p > 0 ? '' : '0';
    if (part.sweep) {
      part.sweep.style.strokeDasharray = rest ? '' : '1 1';
      part.sweep.style.strokeDashoffset = rest ? '' : String(1 - e);
    }
    if (part.row) {
      const q = easeOut(clamp01((p * ITEM) / ROW));
      part.row.style.opacity = rest ? '' : String(q);
      part.row.style.translate = rest ? '' : `0 ${((1 - q) * 6).toFixed(2)}px`;
    }
    // The centre counts with the share of the ring drawn.
    donut.drawn.set(id, rest ? 1 : e);
    let filled = 0, whole = 0;
    for (const other of donut.parts.values()) {
      const size = other.to - other.from;
      whole += size;
      filled += size * (donut.drawn.get(other.id) ?? 0);
    }
    const done = [...donut.parts.keys()].every((key) => (donut.drawn.get(key) ?? 0) >= 1);
    const share = done ? 1 : whole > 0 ? filled / whole : 0;
    if (donut.rest) {
      // The face's words fade in (its own opacity is the CSS's: hidden while a part is pointed or said).
      for (const child of donut.rest.children) (child as HTMLElement).style.opacity = done ? '' : String(clamp01(share * 5));
      count(donut.rest.querySelector<HTMLElement>('[data-t-num]'), share, dom.format_);
    }
  },
  // Picks a part by its angle on the ring, or by its legend row (the nearest row in the legend's column).
  pick(dom, event) {
    const donut = donutOf(dom);
    const row = (event.target as Element | null)?.closest?.('.t-donut-row');
    if (row instanceof HTMLElement && dom.root.contains(row)) return row.dataset.tItem ?? null;
    const legend = dom.root.querySelector<HTMLElement>('.t-donut-legend');
    const box = legend?.getBoundingClientRect();
    if (box && event.clientX >= box.left - 12 && event.clientX <= box.right + 12 && event.clientY >= box.top - 8 && event.clientY <= box.bottom + 8) {
      let best: string | null = null, distance = Infinity;
      for (const part of donut.parts.values()) {
        const rect = part.row?.getBoundingClientRect();
        if (!rect) continue;
        const d = Math.abs(rect.top + rect.height / 2 - event.clientY);
        if (d < distance) { distance = d; best = part.id; }
      }
      return best;
    }
    const ring = donut.svg?.getBoundingClientRect();
    if (!ring || !ring.width) return null;
    const x = event.clientX - (ring.left + ring.width / 2), y = event.clientY - (ring.top + ring.height / 2);
    const d = Math.hypot(x, y) / (ring.width / 2);
    // The hole says the centre's figure; far outside the ring, nothing.
    if (d < 0.5 || d > 1.2) return null;
    let turn = Math.atan2(x, -y) / (Math.PI * 2);
    if (turn < 0) turn += 1;
    for (const part of donut.parts.values()) if (turn >= part.from && turn < part.to) return part.id;
    return null;
  }
};
