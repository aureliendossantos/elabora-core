// Reading a chart's props without trusting them: the validator reports what is wrong, the renderer
// draws what it can.

import type { Anchor } from '@elabora/format';
import type { ChartItem } from './types.ts';

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const recordsOf = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
export const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
export const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

// The items of a list prop, with their moments (at) and where those are written.
export function itemsOf(list: unknown, prop: string): ChartItem[] {
  return (Array.isArray(list) ? list : []).flatMap((item, index) => (isRecord(item) && typeof item.id === 'string'
    ? [{ id: item.id, ...(isRecord(item.at) ? { at: item.at as Anchor } : {}), path: `/${prop}/${index}/at` }]
    : []));
}
