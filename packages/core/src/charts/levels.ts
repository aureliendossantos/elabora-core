// levels: a funnel (what remains at each stage, widest at the top) or a pyramid (levels resting on one
// another, widest at the base), drawn as one silhouette. Each row is a trapezoid whose slanted sides
// carry on through the gap into the next row's, so the stack reads as one shape, not as bars.
//
// A row is a grid cell (rows are as tall as their words need, never shorter than ROW) holding an SVG
// stretched to it (preserveAspectRatio none): the trapezoid is filled and stroked with the same paint,
// with round joins and a non-scaling stroke, so its corners stay round at any size; the SVG is inset by
// the stroke's half width so the shape fills the cell exactly. Widths are fractions of the shape's
// column. Words are HTML: the value (or, without values, the label) inside the row when it fits, the
// rest beside it in a note column, and for a funnel the drop between two rows (« −38 % ») in the gap,
// next to the silhouette's edge. The fit is decided here for the two layouts (wide, and narrow under
// 560 px), from estimated text widths at the smallest size the shape takes in each (levels.css).

import { esc, attrs, hl } from './frame.ts';
import { formatValue, n } from './format.ts';
import type { ChartType, ChartContext } from './types.ts';
import { recordsOf, num, str, itemsOf } from './values.ts';

// Sizes in rem, as levels.css draws them: a row's least height, the gap between rows, and the smallest
// width of the shape's column wide and narrow (its clamp() lower bounds).
export const LEVELS = { row: 3.25, gap: 0.5, wide: 19, narrow: 9, note: 10, textSize: 0.8125 } as const;
const MIN_WIDTH = 0.1; // the narrowest row of a funnel (a fraction of the column)
const APEX = 0.04; // a pyramid's tip
const INSIDE_PAD = { wide: 1.5, narrow: 1 }; // rem of breathing room around words inside a row
const INSIDE_SIZE = 0.9375; // rem, the size of the words inside a row

export interface Level {
  id: string;
  label: string;
  text: string;
  value: number | null;
  // Widths of the row at its top and bottom edges (fractions of the column).
  top: number;
  bottom: number;
}

export function levelsGeometry(props: Record<string, unknown>): { shape: 'funnel' | 'pyramid'; levels: Level[]; sized: boolean } {
  const shape = props.shape === 'pyramid' ? 'pyramid' : 'funnel';
  const raw = recordsOf(props.items).map((item) => ({ id: str(item.id), label: str(item.label), text: str(item.text), value: typeof item.value === 'number' && Number.isFinite(item.value) ? Math.max(0, item.value) : null }));
  const count = raw.length;
  const pitch = LEVELS.row + LEVELS.gap;
  const total = count * LEVELS.row + Math.max(0, count - 1) * LEVELS.gap;
  // A funnel whose every stage has a value is sized by them; otherwise the silhouette is regular.
  const sized = shape === 'funnel' && count > 0 && raw.every((item) => item.value !== null);
  let widthAt: (y: number) => number;
  if (sized) {
    const max = Math.max(...raw.map((item) => item.value ?? 0)) || 1;
    const knots = raw.map((item, index) => ({ y: index * pitch, w: Math.max(MIN_WIDTH, (item.value ?? 0) / max) }));
    // The neck: the last stage narrows a little more, as a funnel does.
    knots.push({ y: total, w: Math.max(MIN_WIDTH * 0.7, knots[knots.length - 1].w * 0.78) });
    widthAt = (y) => {
      let k = 0;
      while (k < knots.length - 2 && y > knots[k + 1].y) k++;
      const a = knots[k], b = knots[k + 1];
      return a.w + (b.w - a.w) * Math.max(0, Math.min(1, (y - a.y) / ((b.y - a.y) || 1)));
    };
  } else if (shape === 'funnel') widthAt = (y) => 1 - 0.62 * (y / (total || 1));
  else widthAt = (y) => APEX + (1 - APEX) * (y / (total || 1));
  const levels = raw.map((item, index) => ({ ...item, top: widthAt(index * pitch), bottom: widthAt(index * pitch + LEVELS.row) }));
  return { shape, levels, sized };
}

// A text's width in em, roughly (a sans-serif's average advances, leaning wide so a fit is safe).
export function textWidth(text: string, bold = false): number {
  let width = 0;
  for (const char of text) {
    if (/[0-9]/.test(char)) width += 0.6;
    else if (/[\sil.,:;'’!|()[\]ftj  -]/.test(char)) width += 0.32;
    else if (/[A-Z]/.test(char)) width += 0.7;
    else if (/[mwMW@%]/.test(char)) width += 0.86;
    else width += 0.56;
  }
  return width * (bold ? 1.07 : 1);
}

// Whether words fit inside a row whose column is columnRem wide: within the row's narrower edge, near
// its middle where the words sit.
function fits(level: Level, words: string, layout: 'wide' | 'narrow'): boolean {
  const at = (t: number) => level.top + (level.bottom - level.top) * t;
  const narrowest = Math.min(at(0.3), at(0.7));
  return textWidth(words, true) * INSIDE_SIZE + INSIDE_PAD[layout] <= narrowest * LEVELS[layout];
}

// A drop between two stages, as the language writes a percentage, with a true minus sign.
function dropText(from: number, to: number, language: string): string {
  if (!from) return '';
  const ratio = (to - from) / from;
  const text = new Intl.NumberFormat(language || 'en', { style: 'percent', maximumFractionDigits: Math.abs(ratio) < 0.1 ? 1 : 0, signDisplay: 'exceptZero' }).format(ratio);
  return text.replace(/^-/, '−');
}

const formatOf = (props: Record<string, unknown>) => ({ unit: str(props.unit) || undefined, decimals: num(props.decimals) });

export const levels: ChartType = {
  axis: 'y',
  items: (props) => itemsOf(props.items, 'items'),
  body(props, context: ChartContext) {
    const { shape, levels: rows, sized } = levelsGeometry(props);
    const format = formatOf(props);
    const valueOf = (level: Level) => (level.value === null ? '' : formatValue(level.value, format, context.language));
    let bare = true;
    const cells = rows.map((level, index) => {
      const value = valueOf(level);
      // Inside the row: a funnel's value, or the label.
      const primaryIsValue = shape === 'funnel' && level.value !== null;
      const primary = primaryIsValue ? value : level.label;
      const wide = fits(level, primary, 'wide'), narrow = fits(level, primary, 'narrow');
      const fit = `${wide ? ' is-in-wide' : ''}${narrow ? ' is-in-narrow' : ''}`;
      const say = `${level.label}${value ? `: ${value}` : ''}${level.text ? `. ${level.text}` : ''}`;
      const previous = rows[index - 1];
      const drop = sized && previous && previous.value !== null && level.value !== null ? dropText(previous.value, level.value, context.language) : '';
      // Where the silhouette's edge is in the gap above (the drop sits just beyond it).
      const edge = previous ? (previous.bottom + level.top) / 2 : level.top;
      const half = (w: number) => n(50 - w * 50);
      const points = `${half(level.top)},0 ${n(50 + level.top * 50)},0 ${n(50 + level.bottom * 50)},100 ${half(level.bottom)},100`;
      const counted = level.value === null ? {} : { 'data-t-num': level.value };
      const row = `<div class="t-levels-row${hl(props, level.id)}${fit}"${attrs({ 'data-t-item': level.id, 'data-t-say': say })} style="--top:${n(level.top)};--bottom:${n(level.bottom)};--edge:${n(edge)}">`
        + `<svg class="t-levels-svg" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false"><polygon points="${points}"/></svg>`
        + `<span class="t-levels-in"${attrs(primaryIsValue ? counted : {})}>${esc(primary)}</span>`
        + (drop ? `<span class="t-levels-drop">${esc(drop)}</span>` : '')
        + '</div>';
      // Beside it: what is not inside (the label, the value when it does not fit), then the sentence.
      const name = primaryIsValue
        ? `<span class="t-levels-name">${esc(level.label)}</span> <span class="t-levels-num t-levels-dup"${attrs(counted)}>${esc(value)}</span>`
        : `<span class="t-levels-name t-levels-dup">${esc(level.label)}</span>${value ? ` <span class="t-levels-num"${attrs(counted)}>${esc(value)}</span>` : ''}`;
      if (!wide || primaryIsValue || value || level.text) bare = false;
      const note = `<div class="t-levels-note${hl(props, level.id)}${fit}"${attrs({ 'data-t-item': level.id })}>`
        + `<p class="t-levels-head${!primaryIsValue && !value ? ' t-levels-head--dup' : ''}">${name}</p>`
        + (level.text ? `<p class="t-levels-text">${esc(level.text)}</p>` : '')
        + '</div>';
      return row + note;
    });
    // Narrow, sentences longer than two lines beside a row would stretch the silhouette: they all go
    // under it, each after its level's name.
    const under = rows.some((level) => level.text && Math.ceil(textWidth(level.text) * LEVELS.textSize / LEVELS.note) > 2);
    const texts = under ? `<ul class="t-levels-texts">${rows.filter((level) => level.text).map((level) => `<li${attrs({ class: hl(props, level.id).trim() || null, 'data-t-item': level.id })}><b>${esc(level.label)}</b> ${esc(level.text)}</li>`).join('')}</ul>` : '';
    return `<div class="t-levels t-levels--${shape}${sized ? ' is-sized' : ''}${bare ? ' is-bare' : ''}${under ? ' is-texts-under' : ''}" style="--n:${rows.length}">${cells.join('')}</div>${texts}`;
  },
  table(props, context) {
    const { levels: rows } = levelsGeometry(props);
    const format = formatOf(props);
    const values = rows.some((level) => level.value !== null);
    const texts = rows.some((level) => level.text);
    return {
      head: [],
      rows: rows.map((level) => [level.label, ...(values ? [level.value === null ? '' : formatValue(level.value, format, context.language)] : []), ...(texts ? [level.text] : [])])
    };
  }
};
