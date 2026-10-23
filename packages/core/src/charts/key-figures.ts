// key-figures: 2 to 4 figures to remember, side by side. A figure with count is counted up (or down)
// by the player, then shows its own text.

import { esc, attrs, hl } from './frame.ts';
import { n } from './format.ts';
import type { ChartType } from './types.ts';
import { isRecord, recordsOf, num, str, itemsOf } from './values.ts';

export const keyFigures: ChartType = {
  axis: 'x',
  items: (props) => itemsOf(props.items, 'items'),
  body(props) {
    const cards = recordsOf(props.items).map((item) => {
      const id = str(item.id);
      const count = isRecord(item.count) && typeof item.count.to === 'number'
        ? JSON.stringify({ from: num(item.count.from), to: item.count.to, format: str(item.count.format) || 'number', decimals: num(item.count.decimals) })
        : null;
      const meter = typeof item.meter === 'number' ? Math.max(0, Math.min(1, item.meter)) : null;
      return `<div class="t-figures-card${hl(props, id)}"${attrs({ 'data-t-item': id, 'data-t-say': `${str(item.figure)} ${str(item.label)}${item.was ? `. ${str(item.was)}` : ''}` })}${meter !== null ? ` style="--p:${n(meter)}"` : ''}>`
        + `<p class="t-figures-figure"${attrs({ 'data-t-count': count })}>${esc(str(item.figure))}</p>`
        + `<p class="t-figures-label">${esc(str(item.label))}</p>`
        + (item.was ? `<p class="t-figures-was">${esc(str(item.was))}</p>` : '')
        + (meter !== null ? '<i class="t-figures-meter"></i>' : '')
        + '</div>';
    });
    return `<div class="t-figures-grid" style="--n:${cards.length}">${cards.join('')}</div>`;
  },
  table(props) {
    return { head: [], rows: recordsOf(props.items).map((item) => [str(item.figure), [str(item.label), str(item.was)].filter(Boolean).join('. ')]) };
  }
};
