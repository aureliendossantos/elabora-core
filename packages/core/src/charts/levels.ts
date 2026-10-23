// levels: not drawn yet (a list of its items).

import { listed } from './listed.ts';
import type { ChartType } from './types.ts';
import { str } from './values.ts';

export const levels: ChartType = listed('items', (item) => [str(item.label), str(item.value)].filter(Boolean).join(': '));
