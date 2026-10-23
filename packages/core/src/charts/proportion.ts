// proportion: not drawn yet (a list of its items).

import { esc } from './frame.ts';
import type { ChartType } from './types.ts';
import { str } from './values.ts';

export const proportion: ChartType = { axis: 'none', items: () => [], body: (props) => `<p>${esc(str(props.figure))} ${esc(str(props.label))}</p>`, table: (props) => ({ head: [], rows: [[str(props.figure), str(props.label)]] }) };
