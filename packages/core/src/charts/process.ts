// process: a short procedure. The steps stand in a row of equal columns, each a numbered circle with
// its title and text under it (HTML: words wrap and translate); a link runs from each circle to the
// next behind them. An item's elements are its circle, title and text (the step itself is not an
// item, so its link never dims). Under 560 px the steps become a list and the links run down the
// left (process.css).

import { esc, attrs, hl } from './frame.ts';
import type { ChartType } from './types.ts';
import { recordsOf, str, itemsOf } from './values.ts';

export interface Step { id: string; title: string; text: string }

export function stepsOf(props: Record<string, unknown>): Step[] {
  return recordsOf(props.items).map((item) => ({ id: str(item.id), title: str(item.title), text: str(item.text) }));
}

// What the arrow keys announce: « 2. Press Report: the button sends it… ».
const said = (step: Step, index: number) => `${index + 1}. ${step.title}${step.text ? `: ${step.text}` : ''}`;

export const process: ChartType = {
  axis: 'xy',
  items: (props) => itemsOf(props.items, 'items'),
  body(props) {
    const steps = stepsOf(props);
    const cells = steps.map((step, index) => {
      const mark = hl(props, step.id);
      const item = { 'data-t-item': step.id };
      return `<div class="t-process-step${mark}">`
        + (index < steps.length - 1 ? '<i class="t-process-link"></i>' : '')
        + `<span class="t-process-n${mark}"${attrs({ ...item, 'data-t-say': said(step, index) })}>${index + 1}</span>`
        + `<p class="t-process-title${mark}"${attrs(item)}>${esc(step.title)}</p>`
        + (step.text ? `<p class="t-process-text${mark}"${attrs(item)}>${esc(step.text)}</p>` : '')
        + '</div>';
    });
    return `<div class="t-process" style="--n:${steps.length}">${cells.join('')}</div>`;
  },
  table(props) {
    const steps = stepsOf(props);
    const texts = steps.some((step) => step.text);
    return { head: [], rows: steps.map((step, index) => [String(index + 1), step.title, ...(texts ? [step.text] : [])]) };
  }
};
