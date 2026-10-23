// matrix: not drawn yet (a list of its items).

import { listed } from './listed.ts';
import type { ChartType } from './types.ts';
import { str } from './values.ts';

export const matrix: ChartType = listed('items', (item) => str(item.label), 'xy');
