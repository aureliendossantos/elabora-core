// bars: a ranking. Labels and values are HTML in a grid (they wrap and translate); a bar's length is
// --w, a fraction of the track, so the chart is right at any width. Under 560 px the labels go above
// their bars (charts.css).

import { esc, attrs, hl } from './frame.ts';
import { formatValue, n } from './format.ts';
import type { ChartType, ChartContext } from './types.ts';
import { recordsOf, num, str, itemsOf } from './values.ts';

export interface Row { id: string; label: string; value: number; note: string }

export function rowsOf(props: Record<string, unknown>): Row[] {
  const rows = recordsOf(props.rows).map((row) => ({ id: str(row.id), label: str(row.label), value: num(row.value), note: str(row.note) }));
  return props.sort === 'none' ? rows : [...rows].sort((a, b) => b.value - a.value);
}

export const bars: ChartType = {
  axis: 'y',
  items: (props) => itemsOf(props.rows, 'rows'),
  body(props, context: ChartContext) {
    const rows = rowsOf(props);
    const format = { unit: str(props.unit) || undefined, decimals: num(props.decimals) };
    const max = num(props.max) > 0 ? num(props.max) : Math.max(...rows.map((row) => row.value), 0) || 1;
    const cells = rows.map((row) => {
      const value = formatValue(row.value, format, context.language);
      const say = `${row.label}: ${value}${row.note ? `, ${row.note}` : ''}`;
      const w = Math.max(0, Math.min(1, row.value / max));
      return `<div class="t-bars-label${hl(props, row.id)}"${attrs({ 'data-t-item': row.id, 'data-t-say': say, 'data-t-tip': row.note || null })}>${esc(row.label)}</div>`
        + `<div class="t-bars-track${hl(props, row.id)}"${attrs({ 'data-t-item': row.id })} style="--w:${n(w)}"><i class="t-bars-bar"></i><span class="t-bars-value" data-t-tip-at${attrs({ 'data-t-num': row.value })}>${esc(value)}</span></div>`;
    });
    return `<div class="t-bars-grid">${cells.join('')}</div>`;
  },
  table(props, context) {
    const format = { unit: str(props.unit) || undefined, decimals: num(props.decimals) };
    const rows = rowsOf(props);
    const notes = rows.some((row) => row.note);
    return { head: [], rows: rows.map((row) => [row.label, formatValue(row.value, format, context.language), ...(notes ? [row.note] : [])]) };
  }
};
