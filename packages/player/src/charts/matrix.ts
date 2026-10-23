// matrix (D60): the cross draws from the centre outward and the quadrants open from it, their names
// fade in, then the dots drop in one after another (a small overshoot: small pieces arriving), each
// label following its dot. The pointer is magnetic: the nearest dot answers, its reason in the tip.
// On a phone with a numbered legend, pointing at a line of the legend picks its item.
//
// Labels were placed by the core (charts/matrix.ts) so they never collide; the view moves nothing
// of the layout. Positions are transforms and margins; the entrance writes translate and scale.

import type { ChartDom, ChartView } from './view.ts';
import { clamp01, easeOut } from './kit.ts';

// A small overshoot for what arrives (about 10 %), settling at 1.
const backOut = (t: number) => { const c = 1.7; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

const kindOf = (dom: ChartDom, id: string, className: string) => dom.items.elements(id).find((element) => element.classList.contains(className));
// Tiles open from the centre: each grows from its inner corner.
const ORIGINS: Record<string, string> = { 'is-tl': '100% 100%', 'is-tr': '0 100%', 'is-bl': '100% 0', 'is-br': '0 0' };

export const matrixView: ChartView = {
  entrance: { item: 0.6, stagger: 0.075, frame: 0.6 },
  frame(dom, p) {
    const rest = p >= 1;
    const draw = easeOut(clamp01(p / 0.75));
    for (const line of dom.root.querySelectorAll<SVGLineElement>('.t-matrix-cross-x')) line.style.scale = rest ? '' : `${draw} 1`;
    for (const line of dom.root.querySelectorAll<SVGLineElement>('.t-matrix-cross-y')) line.style.scale = rest ? '' : `1 ${draw}`;
    const open = easeOut(clamp01((p - 0.1) / 0.8));
    for (const tile of dom.root.querySelectorAll<HTMLElement>('.t-matrix-q')) {
      const origin = Object.entries(ORIGINS).find(([name]) => tile.classList.contains(name))?.[1] ?? '50% 50%';
      tile.style.opacity = rest ? '' : String(clamp01(open * 1.4));
      tile.style.transformOrigin = rest ? '' : origin;
      tile.style.scale = rest ? '' : String(0.94 + 0.06 * open);
      const name = tile.querySelector<HTMLElement>('.t-matrix-q-name');
      if (name) name.style.opacity = rest ? '' : String(clamp01((p - 0.45) / 0.55));
    }
    for (const axis of dom.root.querySelectorAll<HTMLElement>('.t-matrix-axis')) axis.style.opacity = rest ? '' : String(clamp01((p - 0.2) / 0.6));
  },
  reveal(dom, id, p) {
    const rest = p >= 1;
    const drop = clamp01(p / 0.62);
    const dot = kindOf(dom, id, 't-matrix-dot');
    if (dot) {
      dot.style.opacity = rest ? '' : String(clamp01(drop * 3));
      dot.style.translate = rest ? '' : `0 ${Math.round(-(1 - backOut(drop)) * 140) / 10}px`;
      dot.style.scale = rest ? '' : String(0.6 + 0.4 * backOut(drop));
    }
    const follow = clamp01((p - 0.38) / 0.62);
    const label = kindOf(dom, id, 't-matrix-label');
    if (label) {
      label.style.opacity = rest ? '' : String(follow);
      label.style.translate = rest ? '' : `0 ${Math.round((1 - easeOut(follow)) * 40) / 10}px`;
    }
    const key = kindOf(dom, id, 't-matrix-key');
    if (key) {
      key.style.opacity = rest ? '' : String(follow);
      key.style.translate = rest ? '' : `0 ${Math.round((1 - easeOut(follow)) * 60) / 10}px`;
    }
  },
  // The nearest dot; over the legend (a phone), the line under the pointer or the nearest one.
  pick(dom, event) {
    const legend = dom.root.querySelector<HTMLElement>('.t-matrix-legend');
    const box = legend?.getBoundingClientRect();
    const inLegend = !!box && box.height > 0 && event.clientY >= box.top - 4 && event.clientY <= box.bottom + 4 && event.clientX >= box.left && event.clientX <= box.right;
    let best: string | null = null, distance = Infinity;
    for (const id of dom.order) {
      const element = kindOf(dom, id, inLegend ? 't-matrix-key' : 't-matrix-dot');
      const rect = element?.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) continue;
      const d = inLegend
        ? Math.max(0, Math.abs(rect.top + rect.height / 2 - event.clientY) - rect.height / 2)
        : Math.hypot(rect.left + rect.width / 2 - event.clientX, rect.top + rect.height / 2 - event.clientY);
      if (d < distance) { distance = d; best = id; }
    }
    return best;
  }
};
