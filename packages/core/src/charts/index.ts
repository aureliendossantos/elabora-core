// Charts and diagrams (D60): built-in blocks drawn by the core as HTML and SVG when the course is
// built, and moved by the player's chart behaviour. Each type is a module of this folder.

import { frame } from './frame.ts';
import { bars } from './bars.ts';
import { trend } from './trend.ts';
import { keyFigures } from './key-figures.ts';
import { diagram } from './diagram.ts';
import { donut } from './donut.ts';
import { proportion } from './proportion.ts';
import { beforeAfter } from './before-after.ts';
import { levels } from './levels.ts';
import { process } from './process.ts';
import { cycle } from './cycle.ts';
import { matrix } from './matrix.ts';
import { milestones } from './milestones.ts';
import type { ChartContext, ChartItem, ChartTable, ChartType } from './types.ts';
import { isRecord, str } from './values.ts';

export type { ChartContext, ChartItem, ChartTable, ChartType } from './types.ts';

export const CHART_TYPES: Readonly<Record<string, ChartType>> = {
  'key-figures': keyFigures,
  bars,
  donut,
  trend,
  proportion,
  'before-after': beforeAfter,
  levels,
  process,
  cycle,
  matrix,
  milestones,
  diagram
};

export const isChartType = (type: string | null | undefined): boolean => !!type && Object.hasOwn(CHART_TYPES, type);

// The chart at rest, in its frame, and what the player needs beyond the markup.
export function renderChart(type: string, props: Record<string, unknown>, context: ChartContext): { html: string; data: Record<string, unknown> | undefined } {
  const chart = CHART_TYPES[type];
  const figure = chart.figure?.(props, context) ?? {};
  const html = frame(context, { type, props, body: chart.body(props, context), table: chart.table(props, context), axis: chart.axis, ...figure });
  // Values the player counts are written with the chart's unit and decimals.
  const format = typeof props.unit === 'string' || typeof props.decimals === 'number' ? { format: { unit: str(props.unit) || undefined, decimals: typeof props.decimals === 'number' ? props.decimals : 0 } } : {};
  const data = { ...format, ...chart.data?.(props, context) };
  return { html, data: Object.keys(data).length ? data : undefined };
}

export function chartItems(type: string, props: Record<string, unknown>): ChartItem[] {
  return CHART_TYPES[type]?.items(props) ?? [];
}

// The data as a table, for exports and fallbacks (the takeaway, then a Markdown table).
export function chartTable(type: string, props: Record<string, unknown>, context: ChartContext): ChartTable {
  return CHART_TYPES[type]?.table(props, context) ?? { head: [], rows: [] };
}

export function chartMarkdown(type: string, props: Record<string, unknown>, context: ChartContext): string {
  const table = chartTable(type, props, context);
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const width = Math.max(1, ...table.rows.map((row) => row.length));
  const head = table.head.length ? table.head : Array.from({ length: width }, () => '');
  const lines = table.rows.length ? [`| ${head.map(cell).join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...table.rows.map((row) => `| ${row.map(cell).join(' | ')} |`)] : [];
  const parts = [`**${str(props.takeaway)}**`, str(props.context), lines.join('\n'), str(props.source) ? `*${str(props.source)}*` : ''];
  return parts.filter(Boolean).join('\n\n');
}

export const isChartProps = isRecord;
