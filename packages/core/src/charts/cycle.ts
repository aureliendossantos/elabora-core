// cycle: not drawn yet (a list of its items).

import { listed } from './listed.ts';
import type { ChartType } from './types.ts';
import { str } from './values.ts';

export const cycle: ChartType = listed('items', (item) => str(item.title), 'xy');
