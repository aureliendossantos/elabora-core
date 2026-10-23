import type { Anchor } from '@elabora/format';

// What a chart's renderer is given (D60).
export interface ChartContext {
  // The block's id: element ids of the chart start with it.
  id: string;
  // Numbers and words are written in this language.
  language: string;
  // The course's theme tokens (the accent and what reads on it).
  tokens: Readonly<Record<string, string | number>>;
  // The app's canvas marks the elements that show a text prop (data-t-field).
  fields?: boolean;
}

// The data of a chart as a table: for screen readers, exports and fallbacks.
export interface ChartTable {
  head: string[];
  rows: string[][];
}

// An item of a chart that the voice may bring (its at anchor), by id.
export interface ChartItem {
  id: string;
  at?: Anchor;
  path: string; // JSON pointer of its at, under the block's props
}

export interface ChartType {
  // The axis the pointer moves along to pick an item.
  axis: 'x' | 'y' | 'xy' | 'none';
  // The drawing at rest (inside the frame), and the table of its data.
  body(props: Record<string, unknown>, context: ChartContext): string;
  table(props: Record<string, unknown>, context: ChartContext): ChartTable;
  // The items in reading order, with their moments.
  items(props: Record<string, unknown>): ChartItem[];
  // Extra classes and data of the figure, and controls after the drawing (read by screen readers).
  figure?(props: Record<string, unknown>, context: ChartContext): { className?: string; data?: Record<string, string | number | boolean | null | undefined>; after?: string };
  // What the player needs beyond the markup (predict mode…).
  data?(props: Record<string, unknown>, context: ChartContext): Record<string, unknown> | undefined;
}
