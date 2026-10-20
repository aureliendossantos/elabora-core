import { lineDirections } from '../narration/directions.ts';

// XLIFF 2.0 for translation units: the exchange format of translation agencies and CAT tools, and
// plain enough for agents. One <unit> per string, with notes for translators; the Markdown and
// the ICU placeholders stay as text in <source> and <target>. The one inline element is the word
// anchor of a narration line (docs/decisions.md D28): <mrk id="w-imprimante" type="elabora:anchor">
// around the words a block or an event waits for, which translators place on the words of their
// language that say the same thing. A narration line's stage directions (D29) are wrapped too, as
// <mrk id="d1" type="elabora:direction">[chuchote]</mrk>, their text inside: computed from the text
// on writing, read back as text (the brackets are what Elabora reads), so that a tool that drops the
// marker loses nothing.

// category: location, format, context, max-length, previous-source; null when a note read has none.
export interface XliffNote {
  category: string | null;
  text: string;
}

// A word anchor's marker in a text: its id and where it is (offsets in the plain text, end excluded).
export interface XliffMark {
  id: string;
  start: number;
  end: number;
}

export const ANCHOR_MARK = 'elabora:anchor';
export const DIRECTION_MARK = 'elabora:direction';

// A unit to write. state: initial (to translate or to review), translated, reviewed, final. Marks:
// the word anchors in the source and the target.
export interface XliffUnit {
  id: string;
  source: string;
  sourceMarks?: readonly XliffMark[];
  target?: string | null;
  targetMarks?: readonly XliffMark[];
  state?: string;
  notes?: XliffNote[];
}

// A unit as read: the target is null when the unit has none; texts without their markers, the
// markers apart.
export interface XliffReadUnit {
  id: string;
  source: string;
  target: string | null;
  state: string;
  notes: XliffNote[];
  sourceMarks?: XliffMark[];
  targetMarks?: XliffMark[];
}

export interface XliffDocument {
  srcLang: string | null;
  trgLang: string | null;
  units: Map<string, XliffReadUnit>;
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text: string): string => escapeXml(text).replace(/"/g, '&quot;');
const unescapeXml = (text: string): string => text
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, data: string) => data.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
  .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// srcLang, trgLang: the languages, named as the XLIFF attributes; original: what the units come from.
export function toXliff({ srcLang, trgLang, original, units }: { srcLang: string; trgLang: string; original: string; units: readonly XliffUnit[] }): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="${escapeAttribute(srcLang)}" trgLang="${escapeAttribute(trgLang)}">`, `  <file id="f1" original="${escapeAttribute(original)}" xml:space="preserve">`];
  for (const unit of units) {
    lines.push(`    <unit id="${escapeAttribute(unit.id)}">`);
    if (unit.notes?.length) {
      lines.push('      <notes>');
      for (const note of unit.notes) lines.push(`        <note category="${escapeAttribute(String(note.category))}">${escapeXml(note.text)}</note>`);
      lines.push('      </notes>');
    }
    lines.push(`      <segment state="${unit.state || 'initial'}">`);
    const narration = NARRATION_UNIT.test(unit.id);
    lines.push(`        <source>${withMarks(unit.source, unit.sourceMarks, narration)}</source>`);
    if (unit.target !== undefined && unit.target !== null) lines.push(`        <target>${withMarks(unit.target, unit.targetMarks, narration)}</target>`);
    lines.push('      </segment>', '    </unit>');
  }
  lines.push('  </file>', '</xliff>', '');
  return lines.join('\n');
}

// A text with its word anchors' markers (in order; one that overlaps another is left out) and its
// stage directions' markers.
// Only a narration line has directions (elsewhere brackets are Markdown's).
const NARRATION_UNIT = /^screen\.[^.]+\.narration\.[^.]+\.text$/;

function withMarks(text: string, marks: readonly XliffMark[] | undefined, narration = false): string {
  const directions = (narration ? lineDirections(text) : []).map((direction, index) => ({ id: `d${index + 1}`, start: direction.start, end: direction.end, type: DIRECTION_MARK }));
  if (!marks?.length && !directions.length) return escapeXml(text);
  let out = '';
  let at = 0;
  for (const mark of [...(marks ?? []).map((mark) => ({ ...mark, type: ANCHOR_MARK })), ...directions].sort((a, b) => a.start - b.start)) {
    if (mark.start < at || mark.end <= mark.start || mark.end > text.length) continue;
    out += `${escapeXml(text.slice(at, mark.start))}<mrk id="${escapeAttribute(mark.id)}" type="${mark.type}">${escapeXml(text.slice(mark.start, mark.end))}</mrk>`;
    at = mark.end;
  }
  return out + escapeXml(text.slice(at));
}

// The text of inline XML and its word anchors' markers: other inline codes (a CAT tool's) are
// reduced to their text. A marker that lost its type (some tools drop it) is known by its id.
export function readMarked(inner: string): { text: string; marks: XliffMark[] } {
  let text = '';
  const marks: XliffMark[] = [];
  const open: { name: string; id: string | null; anchor: boolean; start: number }[] = [];
  const attribute = (attributes: string, name: string): string | null => { const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes); return match ? unescapeXml(match[1]) : null; };
  for (const match of inner.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    if (match[1] !== undefined) { text += match[1]; continue; }
    if (match[6] !== undefined) { text += unescapeXml(match[6]); continue; }
    const [, , closing, name, attributes, empty] = match;
    if (empty === '/') continue;
    if (closing !== '/') {
      const id = attribute(attributes, 'id');
      const type = attribute(attributes, 'type');
      open.push({ name, id, anchor: name === 'mrk' && !!id && type !== DIRECTION_MARK && (type === ANCHOR_MARK || /^w-/.test(id)), start: text.length });
      continue;
    }
    for (let index = open.length - 1; index >= 0; index--) {
      if (open[index].name !== name) continue;
      const [element] = open.splice(index, 1);
      if (element.anchor && element.id && text.length > element.start) marks.push({ id: element.id, start: element.start, end: text.length });
      break;
    }
  }
  return { text, marks: marks.sort((a, b) => a.start - b.start) };
}

// Tolerant reader: units by id, with source, target, state and notes. Inline codes added by a CAT
// tool are reduced to their text; word anchors' markers are kept apart.
export function readXliff(xml: string): XliffDocument {
  const head = /<xliff\b([^>]*)>/.exec(xml)?.[1] || '';
  const attribute = (attributes: string, name: string): string | null => { const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes); return match ? unescapeXml(match[1]) : null; };
  const textOf = (inner: string): string => unescapeXml(inner.replace(/<(?!!\[CDATA\[)[^>]+>/g, ''));
  const units = new Map<string, XliffReadUnit>();
  for (const match of xml.matchAll(/<unit\b([^>]*)>([\s\S]*?)<\/unit>/g)) {
    const id = attribute(match[1], 'id');
    if (!id) continue;
    const body = match[2];
    const segment = /<segment\b([^>]*)>/.exec(body);
    const source = /<source\b[^>]*>([\s\S]*?)<\/source>/.exec(body);
    // An empty <target/> is an empty translation; no <target> at all, none.
    const target = /<target\b[^>]*\/>/.test(body) ? '' : (/<target\b[^>]*>([\s\S]*?)<\/target>/.exec(body)?.[1] ?? null);
    const notes = [...body.matchAll(/<note\b([^>]*)>([\s\S]*?)<\/note>/g)].map((note) => ({ category: attribute(note[1], 'category'), text: textOf(note[2]) }));
    const sourceRead = source ? readMarked(source[1]) : { text: '', marks: [] };
    const targetRead = target === null ? null : readMarked(target);
    units.set(id, {
      id, source: sourceRead.text, target: targetRead ? targetRead.text : null, state: (segment && attribute(segment[1], 'state')) || 'initial', notes,
      ...(sourceRead.marks.length ? { sourceMarks: sourceRead.marks } : {}), ...(targetRead?.marks.length ? { targetMarks: targetRead.marks } : {})
    });
  }
  return { srcLang: attribute(head, 'srcLang'), trgLang: attribute(head, 'trgLang'), units };
}
