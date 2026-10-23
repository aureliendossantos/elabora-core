// milestones (D60): the line draws itself (across, or down when narrow), each event's dot drops onto
// it as the line passes (a small overshoot: a dot is a small piece), and its date and title fade in
// just after. With a voice, the line is there from the start and each event comes when it is named.
// The pointer picks the event under it, else the nearest dot along the line; pointing is soothing
// (milestones.css), and the tip gives the event's text when the layout had no room to write it.

import type { ChartDom, ChartView } from './view.ts';
import { clamp01, easeOut } from './kit.ts';

const LINE = 0.95;     // the line's draw, the entrance's frame (seconds)
const EARLY = 0.05;    // a dot starts to drop just before the line reaches it
const DROP = 0.42;
const WORDS = 0.45, WORDS_AFTER = 0.1;
const ITEM = Math.max(DROP, WORDS_AFTER + WORDS);
const STAGGER = 0.1;

const backOut = (t: number): number => { const c = 1.4; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

interface Rail { line: HTMLElement | null; down: boolean; dots: Map<string, HTMLElement> }
function railOf(dom: ChartDom): Rail {
  const line = dom.root.querySelector<HTMLElement>('.t-ms-line');
  const dots = new Map<string, HTMLElement>();
  for (const id of dom.order) {
    const dot = dom.items.elements(id).find((element) => element.classList.contains('t-ms-dot'));
    if (dot) dots.set(id, dot);
  }
  // Read each time: the container may have crossed 560 px since.
  return { line, down: !!line && line.offsetHeight > line.offsetWidth, dots };
}

// Where a dot sits along the line, from 0 (its start) to 1 (its end): from the layout (offsets in
// .t-ms), so the line's scale and the dot's drop, both transforms, do not move it.
function along(rail: Rail, id: string): number {
  const dot = rail.dots.get(id);
  const line = rail.line;
  if (!line || !dot) return 0;
  const length = rail.down ? line.offsetHeight : line.offsetWidth;
  if (!length) return 0;
  const centre = rail.down ? dot.offsetTop + dot.offsetHeight / 2 - line.offsetTop : dot.offsetLeft + dot.offsetWidth / 2 - line.offsetLeft;
  return clamp01(centre / length);
}

function set(element: Element | null | undefined, values: Record<string, string>): void {
  if (!element) return;
  const style = (element as HTMLElement).style;
  for (const [name, value] of Object.entries(values)) style.setProperty(name, value);
}

export const milestonesView: ChartView = {
  entrance: { item: ITEM, stagger: STAGGER, frame: LINE },
  // Each event when the line reaches its dot (the behaviour starts items at half the frame: earlier
  // events have negative slots).
  slot(dom, id) {
    const at = along(railOf(dom), id) * LINE - EARLY;
    return (Math.max(0, at) - LINE * 0.5) / STAGGER;
  },
  frame(dom, p) {
    const rail = railOf(dom);
    const w = p >= 1 ? '' : String(p);
    set(rail.line, { scale: w === '' ? '' : rail.down ? `1 ${w}` : `${w} 1` });
  },
  reveal(dom, id, p) {
    const rest = p >= 1;
    const t = p * ITEM;
    const drop = clamp01(t / DROP);
    const words = easeOut(clamp01((t - WORDS_AFTER) / WORDS));
    for (const element of dom.items.elements(id)) {
      if (element.classList.contains('t-ms-dot')) {
        set(element, rest ? { opacity: '', translate: '', scale: '' } : {
          opacity: String(clamp01(drop * 4)),
          translate: `0 ${((1 - backOut(drop)) * -0.625).toFixed(3)}rem`,
          scale: String(0.5 + 0.5 * clamp01(drop * 2))
        });
      } else {
        const above = element.classList.contains('is-above') || element.classList.contains('t-ms-date') && !element.classList.contains('is-below');
        set(element, rest ? { opacity: '', translate: '' } : { opacity: String(words), translate: `0 ${((1 - words) * (above ? -0.3125 : 0.3125)).toFixed(3)}rem` });
      }
    }
  },
  // The event under the pointer, else the one whose dot is nearest along the line.
  pick(dom, event) {
    const hit = (event.target as Element | null)?.closest?.<HTMLElement>('[data-t-item]');
    if (hit && dom.root.contains(hit)) return hit.dataset.tItem ?? null;
    const rail = railOf(dom);
    let best: string | null = null, distance = Infinity;
    for (const [id, dot] of rail.dots) {
      const box = dot.getBoundingClientRect();
      const d = rail.down ? Math.abs(box.top + box.height / 2 - event.clientY) : Math.abs(box.left + box.width / 2 - event.clientX);
      if (d < distance) { distance = d; best = id; }
    }
    return best;
  }
};
