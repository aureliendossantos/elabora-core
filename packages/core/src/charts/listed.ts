// A type not drawn yet shows its items as a list (its renderer comes in its own module).

import { esc, attrs } from './frame.ts';
import type { ChartType } from './types.ts';
import { recordsOf, str, itemsOf } from './values.ts';

export function listed(list: string, text: (item: Record<string, unknown>) => string, axis: ChartType['axis'] = 'y'): ChartType {
  return {
    axis,
    items: (props) => itemsOf(props[list], list),
    body: (props) => `<ul class="t-chart-list">${recordsOf(props[list]).map((item) => `<li${attrs({ 'data-t-item': str(item.id), 'data-t-say': text(item) })}>${esc(text(item))}</li>`).join('')}</ul>`,
    table: (props) => ({ head: [], rows: recordsOf(props[list]).map((item) => [text(item)]) })
  };
}

