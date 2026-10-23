// before-after: not drawn yet (a list of its items).

import { listed } from './listed.ts';
import type { ChartType } from './types.ts';
import { str } from './values.ts';

export const beforeAfter: ChartType = listed('items', (item) => `${str(item.label)}: ${str(item.before)} → ${str(item.after)}`);
