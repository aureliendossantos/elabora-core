// donut: not drawn yet (a list of its items).

import { listed } from './listed.ts';
import type { ChartType } from './types.ts';
import { str } from './values.ts';

export const donut: ChartType = listed('parts', (part) => `${str(part.label)}: ${str(part.value)}`);
