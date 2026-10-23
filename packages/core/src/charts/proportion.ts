// proportion: "1 in 10" as an icon array. The figure and its label beside a grid of `of` icons, `part`
// of them lit. Icons are HTML in a grid of `columns` (they keep their shape at any width); lit icons
// fill column after column from the top left, so they read as one block (grouped icons are read
// better than scattered ones).
//
// The chart has one item, "part": the figure and the lit icons. Each lit icon holds its accent as a
// layer (.t-prop-ink) over its quiet shape, so the player lights them in turn with opacity alone.

import { esc, attrs } from './frame.ts';
import { formatValue, n } from './format.ts';
import type { ChartType, ChartContext } from './types.ts';
import { isRecord, num, str } from './values.ts';

export const PROPORTION_ITEM = 'part';
const ICONS = ['person', 'circle', 'square'] as const;

export function proportionGeometry(props: Record<string, unknown>) {
  const of = Math.max(1, Math.min(200, Math.round(num(props.of, 100))));
  const part = Math.max(0, Math.min(of, Math.round(num(props.part))));
  const columns = Math.max(1, Math.min(of, typeof props.columns === 'number' && props.columns >= 1 ? Math.round(props.columns) : of >= 100 ? 20 : 10));
  const rows = Math.ceil(of / columns);
  // The lit cells: column after column from the top left (cells of a short last row are skipped).
  const lit = new Set<number>();
  for (let column = 0; column < columns && lit.size < part; column++) {
    for (let row = 0; row < rows && lit.size < part; row++) {
      const index = row * columns + column;
      if (index < of) lit.add(index);
    }
  }
  // Each lit cell's turn when the icons light up, in that order.
  const turn = new Map([...lit].map((index, k) => [index, k]));
  return { of, part, columns, rows, lit, turn };
}

// The figure: the author's words, else the share as a percentage.
function figureOf(props: Record<string, unknown>, part: number, of: number, language: string): { text: string; share: number | null } {
  const written = str(props.figure);
  if (written) return { text: written, share: null };
  const share = (part / of) * 100;
  return { text: formatValue(share, { unit: '%' }, language), share: Math.round(share) };
}

export const proportion: ChartType = {
  axis: 'none',
  items: (props) => [{ id: PROPORTION_ITEM, ...(isRecord(props.at) ? { at: props.at as never } : {}), path: '/at' }],
  body(props, context: ChartContext) {
    const { of, part, columns, rows, lit, turn } = proportionGeometry(props);
    const icon = ICONS.includes(props.icon as never) ? String(props.icon) : 'person';
    const figure = figureOf(props, part, of, context.language);
    const label = str(props.label);
    const say = [figure.text, label].filter(Boolean).join(' ');
    const cells = Array.from({ length: of }, (_, index) => {
      const row = Math.floor(index / columns), column = index % columns;
      // Its place in the entrance's wave (0 at the top left, 1 at the bottom right).
      const wave = n((row + column) / Math.max(1, rows - 1 + columns - 1));
      return lit.has(index)
        ? `<i class="t-prop-icon is-lit"${attrs({ 'data-t-item': PROPORTION_ITEM, 'data-wave': wave, 'data-turn': n(turn.get(index)! / Math.max(1, part)) })}><b class="t-prop-ink"></b></i>`
        : `<i class="t-prop-icon"${attrs({ 'data-wave': wave })}></i>`;
    }).join('');
    return `<div class="t-prop-layout t-prop--${icon}">`
      + `<div class="t-prop-figure"${attrs({ 'data-t-item': PROPORTION_ITEM, 'data-t-say': say })}>`
      + `<p class="t-prop-big"${figure.share !== null ? attrs({ 'data-t-num': figure.share }) : ''}>${esc(figure.text)}</p>`
      + (label ? `<p class="t-prop-label">${esc(label)}</p>` : '')
      + '</div>'
      + `<div class="t-prop-grid" style="--cols:${columns}">${cells}</div>`
      + '</div>';
  },
  table(props, context) {
    const { of, part } = proportionGeometry(props);
    const figure = figureOf(props, part, of, context.language);
    const count = (value: number) => formatValue(value, {}, context.language);
    return { head: [], rows: [[figure.text, str(props.label), `${count(part)} / ${count(of)}`]] };
  }
};
