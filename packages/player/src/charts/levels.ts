// levels (D60): the silhouette builds itself. A funnel's stages arrive top to bottom, each sliding
// out of the one above and narrowing from its width to its own while its value counts down from the
// stage before; the drop appears as it lands. A pyramid builds up from its base, each level settling
// from just above. Notes beside fade in with their level. Pointing at a level is the shared soothing
// answer (the others step back to 40 %, charts.css).

import type { ChartView } from './view.ts';
import { count } from './view.ts';
import { clamp01, easeOut } from './kit.ts';

const isPyramid = (root: HTMLElement) => root.querySelector('.t-levels--pyramid') !== null;
// The width of a level's top edge, as the core wrote it (a fraction of the shape's column).
const topOf = (row: HTMLElement | undefined) => Number(row?.style.getPropertyValue('--top')) || 1;

export const levelsView: ChartView = {
  entrance: { item: 0.7, stagger: 0.085 },
  // A pyramid is built from its base; long stacks are staggered tighter so the whole stays near a second.
  slot(dom, _id, index) {
    const last = dom.order.length - 1;
    const step = last > 4 ? 4 / last : 1;
    return (isPyramid(dom.root) ? last - index : index) * step;
  },
  reveal(dom, id, p) {
    // Its row, its note, and its sentence under the shape when narrow.
    const [row, note, ...under] = dom.items.elements(id);
    if (!row) return;
    const done = p >= 1;
    const e = easeOut(p);
    const svg = row.querySelector<SVGElement>('.t-levels-svg');
    const inside = row.querySelector<HTMLElement>('.t-levels-in');
    const drop = row.querySelector<HTMLElement>('.t-levels-drop');
    if (isPyramid(dom.root)) {
      // Settles from just above, without bounce (a large shape).
      row.style.opacity = done ? '' : String(clamp01(p * 2.5));
      row.style.translate = done ? '' : `0 ${-(1 - e) * 0.9}rem`;
    } else {
      // Slides out of the stage above, narrowing from its width to its own.
      const index = dom.order.indexOf(id);
      const above = index > 0 ? dom.items.first(dom.order[index - 1]) : undefined;
      const from = above ? topOf(above) / topOf(row) : 0.9;
      row.style.opacity = done ? '' : String(clamp01(p * 3));
      row.style.translate = done ? '' : `0 ${-(1 - e) * (index > 0 ? 1.1 : 0.5)}rem`;
      if (svg) svg.style.scale = done ? '' : `${from + (1 - from) * e} 1`;
      // The value counts down from the stage above (or up from nothing for the first).
      const before = Number(above?.querySelector<HTMLElement>('[data-t-num]')?.dataset.tNum);
      for (const figure of [inside, ...(note ? [...note.querySelectorAll<HTMLElement>('[data-t-num]')] : [])]) {
        if (figure?.dataset.tNum !== undefined) count(figure, done ? 1 : e, dom.format_, Number.isFinite(before) ? before : 0);
      }
    }
    if (inside) inside.style.opacity = done ? '' : String(clamp01((p - 0.25) / 0.45));
    if (drop) drop.style.opacity = done ? '' : String(clamp01((p - 0.6) / 0.4));
    if (note) {
      note.style.opacity = done ? '' : String(clamp01((p - 0.15) / 0.55));
      note.style.translate = done ? '' : `${-(1 - e) * 0.5}rem 0`;
    }
    for (const element of under) element.style.opacity = done ? '' : String(clamp01((p - 0.15) / 0.55));
  }
};
