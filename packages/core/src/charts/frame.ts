// The frame every chart shares (D60): its takeaway as the title, a line of context, the drawing, the
// source, and a table of the data for screen readers (the drawing is hidden from them).
//
// The markup is the chart at rest, complete without script. The player's chart behaviour reads these
// hooks to move it (packages/player/src/charts/):
//   .t-chart[data-t-chart="<type>"]   the figure; data-t-axis (x, y, xy): how the pointer picks an item
//   data-t-item="<id>"                every element of an item (a bar's label and its track)
//   data-t-say="…"                    on an item's first element: what the live region says of it
//   data-t-tip="…"                    an item's detail, in the bubble over data-t-tip-at (or the item)
//   data-t-num="62"                   a figure the entrance counts up (written with the chart's format);
//                                     on an element that holds only its text (counting replaces it)
//   .is-hl                            the highlighted item's elements; .is-pulled on the figure when
//                                     there is one (the entrance adds it last: the focus pull)
//   data-t-depth                      a diagram node's distance from the roots (its entrance slot);
//                                     its edges carry data-t-from and data-t-to
//   .t-trend-ask                      a prediction's slider, button and feedback (trend.ts)

import { escapeHtml } from '../util/html.ts';
import { contrastRatio } from '../validate/theme.ts';
import type { ChartContext, ChartTable } from './types.ts';

export const esc = escapeHtml;

export function attrs(values: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`))
    .join('');
}

// What reads best on the accent colour: the course's surface, its text, white or black.
export function onAccent(tokens: ChartContext['tokens']): string | null {
  const accent = hex(tokens['color.accent']);
  if (!accent) return null;
  const candidates = [hex(tokens['color.surface']), hex(tokens['color.text']), '#FFFFFF', '#000000'].filter((value): value is string => !!value);
  return candidates.reduce((best, candidate) => (contrastRatio(candidate, accent) > contrastRatio(best, accent) + 0.5 ? candidate : best));
}
function hex(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

export interface FrameInput {
  type: string;
  props: Record<string, unknown>;
  body: string;
  table: ChartTable;
  axis?: 'x' | 'y' | 'xy' | 'none';
  // Classes and attributes of the figure (a layout variant, data for the behaviour).
  className?: string;
  data?: Record<string, string | number | boolean | null | undefined>;
  // Controls after the drawing, which screen readers reach (a prediction's slider and button).
  after?: string;
}

export function frame(context: ChartContext, input: FrameInput): string {
  const { props } = input;
  const titleId = `${context.id}-title`;
  // Something takes the accent once every item stands: a highlighted item, or a part of the drawing
  // marked .is-hl by its type (a matrix's quadrant).
  const pulled = (typeof props.highlight === 'string' && props.highlight !== '') || /class="[^"]*\bis-hl\b/.test(input.body);
  const field = (name: string) => (context.fields ? ` data-t-field="${name}"` : '');
  const text = (value: unknown) => (typeof value === 'string' ? escapeHtml(value) : '');
  const on = onAccent(context.tokens);
  const style = on ? ` style="--t-chart-on-accent:${on}"` : '';
  return `<figure class="t-chart t-chart--${input.type}${pulled ? ' is-pulled' : ''}${input.className ? ` ${input.className}` : ''}"${attrs({ 'data-t-chart': input.type, 'data-t-axis': input.axis ?? 'y', 'aria-labelledby': titleId, ...input.data })}${style}>`
    + `<figcaption class="t-chart-head"><p class="t-chart-title" id="${escapeHtml(titleId)}"${field('takeaway')}>${text(props.takeaway)}</p>`
    + (props.context ? `<p class="t-chart-context"${field('context')}>${text(props.context)}</p>` : '')
    + '</figcaption>'
    + `<div class="t-chart-body" aria-hidden="true">${input.body}</div>`
    + (input.after ?? '')
    + tableHtml(input.table, typeof props.context === 'string' ? props.context : String(props.takeaway ?? ''))
    + (props.source ? `<p class="t-chart-source"${field('source')}>${text(props.source)}</p>` : '')
    + '</figure>';
}

function tableHtml(table: ChartTable, caption: string): string {
  if (!table.rows.length) return '';
  const head = table.head.length ? `<thead><tr>${table.head.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join('')}</tr></thead>` : '';
  const rows = table.rows.map((row) => `<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`)).join('')}</tr>`).join('');
  return `<table class="t-chart-table">${caption ? `<caption>${escapeHtml(caption)}</caption>` : ''}${head}<tbody>${rows}</tbody></table>`;
}

// The highlight's class on an item's elements.
export const hl = (props: Record<string, unknown>, id: string): string => (props.highlight === id ? ' is-hl' : '');
