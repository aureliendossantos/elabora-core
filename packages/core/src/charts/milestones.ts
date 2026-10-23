// milestones: dated events on a line. The events stand evenly in reading order, in a grid of equal
// columns: each column's dot sits on the line, its date and title wrap in HTML within the column.
// When a title would not fit its column (decided here, at build time, from a measure of the words),
// the events alternate above and below the line, and each gets two columns: its neighbours are on
// the other side, so long titles never collide (and a last column is added for the last one's); their
// texts then go into the tip. Under 560 px the
// line runs down, dates on its left, titles and texts on its right (milestones.css).

import { esc, attrs, hl } from './frame.ts';
import type { ChartType } from './types.ts';
import { recordsOf, str, itemsOf } from './values.ts';

export interface Milestone { id: string; date: string; title: string; text: string }

export function milestonesOf(props: Record<string, unknown>): Milestone[] {
  return recordsOf(props.items).map((item) => ({ id: str(item.id), date: str(item.date), title: str(item.title), text: str(item.text) }));
}

// The measure: a chart as wide as a page's reading column (760 px, also about a slide's at
// 1280 × 720), titles at 16 px in a semi-bold face, whose letters average about 0.56 em, a column's
// padding taken off. A title fits when it takes at most three lines and its longest word fits.
const REFERENCE_WIDTH = 760;
const EM = 16;
const AVERAGE = 0.56;
const WIDE = /[MWmw@%]/g;
const NARROW = /[iljtf.,:;'’!|() ]/g;
const PADDING = 20;
const MAX_LINES = 3;

// The words' width in pixels, from their letters (wide and narrow ones counted apart).
export function wordsWidth(text: string, size = EM): number {
  const wide = text.match(WIDE)?.length ?? 0;
  const narrow = text.match(NARROW)?.length ?? 0;
  return (text.length * AVERAGE + wide * 0.3 - narrow * 0.28) * size;
}

// The lines a text takes in a column (greedy wrap), Infinity when a word does not fit.
export function linesIn(text: string, width: number, size = EM): number {
  const space = wordsWidth(' ', size);
  let lines = 1, line = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = wordsWidth(word, size);
    if (w > width) return Infinity;
    if (line && line + space + w > width) { lines++; line = w; } else line += (line ? space : 0) + w;
  }
  return lines;
}

// Events alternate above and below when a title or a date would not fit one column.
export function alternates(events: readonly Milestone[]): boolean {
  if (events.length < 3) return false;
  const column = REFERENCE_WIDTH / events.length - PADDING;
  return events.some((event) => linesIn(event.title, column) > MAX_LINES || linesIn(event.date, column, EM * 1.0625) > 1);
}

const said = (event: Milestone) => `${event.date}: ${event.title}${event.text ? `. ${event.text}` : ''}`;

export const milestones: ChartType = {
  axis: 'x',
  items: (props) => itemsOf(props.items, 'items'),
  body(props) {
    const events = milestonesOf(props);
    const alternate = alternates(events);
    const cells = events.map((event, index) => {
      const mark = hl(props, event.id);
      const item = { 'data-t-item': event.id };
      // Above or below the line (alternating), and how many columns its words may take.
      const side = !alternate ? '' : index % 2 === 0 ? ' is-above' : ' is-below';
      const span = alternate ? 2 : 1;
      const place = ` style="--c:${index + 1};--span:${span}"`;
      // The tip shows the text only when it is not written under the title: over the title above
      // the line, over the dot below it (the event's own words stay clear).
      const tip = alternate && event.text ? event.text : null;
      return `<p class="t-ms-date${side}${mark}"${attrs({ ...item, 'data-t-say': said(event), 'data-t-tip': tip })}${place}>${esc(event.date)}</p>`
        + `<i class="t-ms-dot${mark}"${attrs({ ...item, 'data-t-tip-at': tip !== null && side === ' is-below' })}${place}></i>`
        + `<div class="t-ms-label${side}${mark}"${attrs(item)}${place}>`
        + `<p class="t-ms-title"><span${attrs({ 'data-t-tip-at': tip !== null && side === ' is-above' })}>${esc(event.title)}</span></p>`
        + (event.text ? `<p class="t-ms-text">${esc(event.text)}</p>` : '')
        + '</div>';
    });
    // Alternating, a last column is left after the last dot, for its words.
    return `<div class="t-ms${alternate ? ' is-alternate' : ''}" style="--n:${events.length};--columns:${events.length + (alternate ? 1 : 0)}"><i class="t-ms-line"></i>${cells.join('')}</div>`;
  },
  table(props) {
    const events = milestonesOf(props);
    const texts = events.some((event) => event.text);
    return { head: [], rows: events.map((event) => [event.date, event.title, ...(texts ? [event.text] : [])]) };
  }
};
