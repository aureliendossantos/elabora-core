import type { CourseGlossary } from '@elabora/format';
import type { Project } from '../project/model.ts';
import { extractUnits, setAt, valueAt } from '../i18n/units.ts';
import { readXliff } from '../i18n/xliff.ts';
import { translateUnits, translationPath } from '../i18n/translate.ts';
import { parseMarkdown } from '../compile/markdown.ts';
import { readText } from '../project/files.ts';
import { loadProject, screenBlocks } from '../project/load.ts';
import type { Screen } from '../project/model.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import type { Draft } from './context.ts';

// « Relier les termes aux écrans » (docs/decisions.md D58): the first time a term of the glossary, or
// one of its variants, is in a screen's texts, it becomes a link to its entry, [mot](glossary:<id>).
// Deterministic: the screens in the course's order, their texts in reading order (the order of the
// translation units), the first occurrence of each term per screen; a screen that already links to
// the term is left as it is. Only the screens' own Markdown texts take links: the plan's locked
// texts and validated questions keep the client's words as they are, and nothing inside a link, code,
// maths, a URL or an HTML tag is touched (protectedRanges). It runs when the option is turned on,
// when a term is added and on demand, never on its own afterwards: a link the author removed stays
// removed.
//
// Matching: every form of every entry at once, the longest first (« réseau privé virtuel » before
// « réseau », whatever their order in the glossary); a word written in capitals, or with a capital
// inside (« SI », « VPN », « iPhone »), matches with its case, any other word in either case
// (« Routeur » and « routeur »).
//
// Translations: a text the links change goes stale in every translation that had it up to date. In
// those translations the same link is placed where the term's own translation (or the term, for an
// entry with translate: false) is in the translated text, and the unit stays up to date; where it is
// not, the unit is left stale and listed, for a translator.
//
// Removing an entry removes its links (unlinkGlossaryTerms): every link to it in the screens' texts,
// placed here or written by hand (it would be broken: E_GLOSSARY_TERM_UNKNOWN), becomes its words,
// inline or by reference, and the same links leave the translations that had those texts up to date.

export interface PlacedLink {
  screen: string;
  term: string;
  // The words linked, as they are in the text.
  text: string;
  // The translation unit of the text.
  unit: string;
}

export interface LinkedTranslation {
  language: string;
  // Units whose translation took the same links (still up to date).
  linked: string[];
  // Units the links made stale: their translation must be redone (the term was not found in it).
  stale: string[];
  // Units whose translation lost the links of entries removed (still up to date).
  unlinked?: string[];
}

// A link removed with its entry: the words it kept, where.
export interface RemovedLink {
  // The screen, and the translation unit of the text (null for a text that is not translated).
  screen: string;
  term: string;
  text: string;
  unit: string | null;
}

export interface UnlinkResult {
  removed: RemovedLink[];
  translations: LinkedTranslation[];
}

export interface LinkResult {
  placed: PlacedLink[];
  translations: LinkedTranslation[];
}

// Ranges [start, end) of a Markdown text that hold no linkable word: code blocks, fences and display
// maths as the player's Markdown (markdown-it) reads them, link reference definitions, and, inline:
// code spans, maths, links (inline, reference, with nested brackets) and bracketed text, autolinks and
// HTML tags, bare URLs. Escaped characters are literal.
export function protectedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lineStarts.push(index + 1);
  const lineRange = (from: number, to: number): [number, number] => [lineStarts[from] ?? text.length, lineStarts[to] ?? text.length];
  try {
    for (const token of parseMarkdown(text)) {
      if ((token.type === 'code_block' || token.type === 'fence' || token.type === 'math_block' || token.type === 'html_block') && token.map) ranges.push(lineRange(token.map[0], token.map[1]));
    }
  } catch { /* the inline rules below still hold */ }
  for (const match of text.matchAll(/^ {0,3}\[(?:[^\]\\\n]|\\.){1,999}\]:.*$/gm)) ranges.push([match.index, match.index + match[0].length]);

  // The closing bracket of an opening one, nested brackets and escapes counted; -1 when none.
  const closing = (from: number, open: string, close: string): number => {
    let depth = 0;
    for (let index = from; index < text.length; index++) {
      const char = text[index];
      if (char === '\\') { index++; continue; }
      if (char === '\n' && text[index + 1] === '\n') return -1; // a paragraph ends
      if (char === open) depth++;
      else if (char === close && --depth === 0) return index;
    }
    return -1;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') { index++; continue; }
    if (char === '`') {
      let run = 1;
      while (text[index + run] === '`') run++;
      const fence = '`'.repeat(run);
      let end = text.indexOf(fence, index + run);
      while (end >= 0 && text[end + run] === '`') end = text.indexOf(fence, end + run + 1);
      if (end >= 0) { ranges.push([index, end + run]); index = end + run - 1; } else index += run - 1;
      continue;
    }
    if (char === '$') {
      const display = text[index + 1] === '$';
      const end = display ? text.indexOf('$$', index + 2) : text.indexOf('$', index + 1);
      if (end > index && (display || !text.slice(index + 1, end).includes('\n'))) { ranges.push([index, end + (display ? 2 : 1)]); index = end + (display ? 1 : 0); }
      continue;
    }
    if (char === '<') {
      const tag = /^<[^<>\n]+>/.exec(text.slice(index, index + 2000));
      if (tag) { ranges.push([index, index + tag[0].length]); index += tag[0].length - 1; }
      continue;
    }
    if (char === '[') {
      const end = closing(index, '[', ']');
      if (end < 0) continue;
      let last = end;
      if (text[end + 1] === '(') { const paren = closing(end + 1, '(', ')'); if (paren > 0) last = paren; }
      else if (text[end + 1] === '[') { const reference = closing(end + 1, '[', ']'); if (reference > 0) last = reference; }
      ranges.push([index, last + 1]);
      index = last;
      continue;
    }
    if ((char === 'h' || char === 'H' || char === 'w' || char === 'W' || char === 'f' || char === 'F') && !/[\p{L}\p{N}_]/u.test(text[index - 1] ?? '')) {
      const url = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>]*/i.exec(text.slice(index, index + 4000));
      if (url) { ranges.push([index, index + url[0].length]); index += url[0].length - 1; }
    }
  }
  return ranges;
}

// What a Markdown text links to the glossary, as the player's Markdown reads it: inline links
// ([mot](glossary:id), with a title or the address in <…>), links by reference ([mot][ref], [ref][],
// [ref]) and the definitions they use ([ref]: glossary:id). Nothing in code blocks, fences, display
// maths and HTML blocks (markdown-it's), code spans, inline maths, HTML tags, or after a backslash;
// an image (![…](…)) is not a link.
export interface GlossaryLinkSpan {
  start: number;
  end: number;
  term: string;
  // The link's words (its text as written, Markdown included); '' for a definition.
  words: string;
  definition: boolean;
}

const GLOSSARY_ADDRESS = /^\s*<?glossary:([a-z][a-z0-9-]{0,47})>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const referenceLabel = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

export function glossaryLinkSpans(text: string): GlossaryLinkSpan[] {
  const spans: GlossaryLinkSpan[] = [];
  const skipped: [number, number][] = [];
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lineStarts.push(index + 1);
  try {
    for (const token of parseMarkdown(text)) {
      if ((token.type === 'code_block' || token.type === 'fence' || token.type === 'math_block' || token.type === 'html_block') && token.map) skipped.push([lineStarts[token.map[0]] ?? text.length, lineStarts[token.map[1]] ?? text.length]);
    }
  } catch { /* the inline rules below still hold */ }
  // Reference definitions: those to the glossary go (their line with it), every one is kept out of
  // the inline scan.
  const references = new Map<string, string>();
  for (const match of text.matchAll(/^ {0,3}\[((?:[^\]\\\n]|\\.){1,999})\]:([^\n]*)(?:\n|$)/gm)) {
    if (skipped.some(([from, to]) => match.index >= from && match.index < to)) continue;
    skipped.push([match.index, match.index + match[0].length]);
    const address = GLOSSARY_ADDRESS.exec(match[2]);
    if (!address) continue;
    const label = referenceLabel(match[1]);
    if (!references.has(label)) references.set(label, address[1]);
    spans.push({ start: match.index, end: match.index + match[0].length, term: address[1], words: '', definition: true });
  }
  const closing = (from: number, open: string, close: string): number => {
    let depth = 0;
    for (let index = from; index < text.length; index++) {
      const char = text[index];
      if (char === '\\') { index++; continue; }
      if (char === '\n' && text[index + 1] === '\n') return -1;
      if (char === open) depth++;
      else if (char === close && --depth === 0) return index;
    }
    return -1;
  };
  for (let index = 0; index < text.length; index++) {
    const skip = skipped.find(([from, to]) => index >= from && index < to);
    if (skip) { index = skip[1] - 1; continue; }
    const char = text[index];
    if (char === '\\') { index++; continue; }
    if (char === '`') {
      let run = 1;
      while (text[index + run] === '`') run++;
      const fence = '`'.repeat(run);
      let end = text.indexOf(fence, index + run);
      while (end >= 0 && text[end + run] === '`') end = text.indexOf(fence, end + run + 1);
      index = end >= 0 ? end + run - 1 : index + run - 1;
      continue;
    }
    if (char === '$') {
      const display = text[index + 1] === '$';
      const end = display ? text.indexOf('$$', index + 2) : text.indexOf('$', index + 1);
      if (end > index && (display || !text.slice(index + 1, end).includes('\n'))) index = end + (display ? 1 : 0);
      continue;
    }
    if (char === '<') {
      const tag = /^<[^<>\n]+>/.exec(text.slice(index, index + 2000));
      if (tag) index += tag[0].length - 1;
      continue;
    }
    if (char !== '[') continue;
    const image = text[index - 1] === '!';
    const end = closing(index, '[', ']');
    if (end < 0) continue;
    const words = text.slice(index + 1, end);
    if (text[end + 1] === '(') {
      const paren = closing(end + 1, '(', ')');
      if (paren < 0) continue;
      const address = GLOSSARY_ADDRESS.exec(text.slice(end + 2, paren));
      if (address && !image) spans.push({ start: index, end: paren + 1, term: address[1], words, definition: false });
      index = paren;
      continue;
    }
    if (text[end + 1] === '[') {
      const reference = closing(end + 1, '[', ']');
      if (reference > 0) {
        const term = references.get(referenceLabel(text.slice(end + 2, reference) || words));
        if (term && !image) spans.push({ start: index, end: reference + 1, term, words, definition: false });
        index = reference;
        continue;
      }
    }
    const term = references.get(referenceLabel(words));
    if (term && !image) { spans.push({ start: index, end: end + 1, term, words, definition: false }); index = end; }
    // Brackets that are not a link: what they hold is read on.
  }
  return spans.sort((a, b) => a.start - b.start);
}

// A text without its links to the entries named: each link becomes its words, a definition goes.
export function unlinkText(text: string, terms: ReadonlySet<string>): { text: string; removed: { term: string; words: string }[] } {
  const spans = glossaryLinkSpans(text).filter((span) => terms.has(span.term));
  let unlinked = text;
  for (const span of [...spans].reverse()) {
    let before = unlinked.slice(0, span.start);
    let after = unlinked.slice(span.end);
    // A definition goes with the blank line beside it: the one before when it ended the text, else
    // the one after.
    if (span.definition && !after.trim()) { before = before.replace(/\n[ \t]*\n\s*$/, '\n').replace(/\n$/, ''); after = ''; }
    else if (span.definition && /\n[ \t]*\n$/.test(before)) after = after.replace(/^[ \t]*\n/, '');
    unlinked = `${before}${span.words}${after}`;
  }
  return { text: unlinked, removed: spans.filter((span) => !span.definition).map(({ term, words }) => ({ term, words })) };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isUpper = (char: string) => char !== char.toLowerCase() && char === char.toUpperCase();
const isLetter = (char: string) => /\p{L}/u.test(char);
// A word written in capitals or with a capital inside matches with its case.
function caseSensitive(word: string): boolean {
  const letters = [...word].filter(isLetter);
  return letters.slice(1).some(isUpper) || (letters.length === 1 && isUpper(letters[0]));
}
function wordPattern(word: string): string {
  if (caseSensitive(word)) return escape(word);
  return [...word].map((char) => {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    return lower !== upper && [...lower].length === 1 && [...upper].length === 1 ? `[${escape(lower)}${escape(upper)}]` : escape(char);
  }).join('');
}
const formPattern = (form: string): string => form.trim().split(/(\s+)/).map((part) => (/^\s+$/.test(part) ? '\\s+' : wordPattern(part))).join('');

interface Form { entry: string; pattern: string; exact: RegExp; length: number }
interface Matcher { any: RegExp; entryOf(words: string): string | null }

// Every form of the entries (term and variants), the longest first, as one pattern.
function matcherOf(entries: readonly { id: string; forms: readonly string[] }[]): Matcher | null {
  const forms: Form[] = [];
  for (const entry of entries) {
    for (const form of entry.forms) {
      if (!form.trim()) continue;
      const pattern = formPattern(form);
      forms.push({ entry: entry.id, pattern, exact: new RegExp(`^(?:${pattern})$`, 'u'), length: form.trim().length });
    }
  }
  if (!forms.length) return null;
  forms.sort((a, b) => b.length - a.length);
  const any = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[...new Set(forms.map((form) => form.pattern))].join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return { any, entryOf: (words) => forms.find((form) => form.exact.test(words))?.entry ?? null };
}

// Links placed in one text: the first occurrence of each entry wanted that this text (and the screen,
// through taken) does not link yet. Entries not wanted still take their words (a longer term's).
function linkText(text: string, matcher: Matcher, wanted: ReadonlySet<string>, taken: Set<string>): { text: string; placed: { term: string; words: string }[] } {
  const blocked = protectedRanges(text);
  const replacements: { start: number; end: number; term: string; words: string }[] = [];
  for (const match of text.matchAll(matcher.any)) {
    const start = match.index;
    const end = start + match[0].length;
    if (blocked.some(([from, to]) => start < to && end > from)) continue;
    const term = matcher.entryOf(match[0]);
    if (!term || !wanted.has(term) || taken.has(term)) continue;
    taken.add(term);
    replacements.push({ start, end, term, words: match[0] });
  }
  let linked = text;
  for (const { start, end, term, words } of [...replacements].reverse()) linked = `${linked.slice(0, start)}[${words}](glossary:${term})${linked.slice(end)}`;
  return { text: linked, placed: replacements.map(({ term, words }) => ({ term, words })) };
}

const linkedTerms = (text: string): string[] => [...text.matchAll(/\]\(glossary:([a-z][a-z0-9-]{0,47})\)/g)].map((match) => match[1]);

// Links the terms (all of them, or those named) in the draft's screens, then in the translations that
// had those texts up to date.
export function linkGlossaryTerms(project: Project, draft: Draft, glossary: readonly CourseGlossary[], only?: readonly string[]): LinkResult {
  const entries = objectsIn(glossary).filter((entry) => typeof entry.id === 'string' && typeof entry.term === 'string');
  const wanted = new Set(entries.filter((entry) => !only || only.includes(entry.id)).map((entry) => entry.id));
  const matcher = matcherOf(entries.map((entry) => ({ id: entry.id, forms: [entry.term, ...(entry.variants ?? [])] })));
  if (!matcher || !wanted.size) return { placed: [], translations: [] };
  // The screens' Markdown texts, by screen file, in reading order.
  const byFile = new Map<string, { pointer: string; id: string }[]>();
  for (const unit of extractUnits(project)) {
    if (unit.format !== 'markdown' || !unit.file.startsWith('screens/')) continue;
    const units = byFile.get(unit.file) ?? [];
    units.push({ pointer: unit.pointer, id: unit.id });
    byFile.set(unit.file, units);
  }
  const placed: PlacedLink[] = [];
  const changed = new Map<string, { before: string; terms: string[] }>();
  for (const [file, units] of byFile) {
    const screen = draft.json<Record<string, unknown>>(file);
    const id = typeof screen.id === 'string' ? screen.id : file;
    const texts = units.map(({ pointer }) => valueAt(screen, pointer)).filter((text): text is string => typeof text === 'string');
    const taken = new Set(texts.flatMap(linkedTerms));
    let edited = false;
    for (const unit of units) {
      const text = valueAt(screen, unit.pointer);
      if (typeof text !== 'string') continue;
      const result = linkText(text, matcher, wanted, taken);
      if (!result.placed.length) continue;
      setAt(screen, unit.pointer, result.text);
      changed.set(unit.id, { before: text, terms: result.placed.map((link) => link.term) });
      for (const link of result.placed) placed.push({ screen: id, term: link.term, text: link.words, unit: unit.id });
      edited = true;
    }
    if (edited) draft.writeJson(file, screen);
  }
  return { placed, translations: changed.size ? linkTranslations(project, draft, entries, changed) : [] };
}

// Removes the links to the entries named from the draft's screens (every string of their blocks'
// properties, where E_GLOSSARY_TERM_UNKNOWN looks), then from the translations that had those texts
// up to date.
export function unlinkGlossaryTerms(project: Project, draft: Draft, terms: readonly string[]): UnlinkResult {
  const removedTerms = new Set(terms);
  if (!removedTerms.size) return { removed: [], translations: [] };
  const units = new Map(extractUnits(project).map((unit) => [`${unit.file}#${unit.pointer}`, unit.id]));
  const removed: RemovedLink[] = [];
  const changed = new Map<string, string>();
  for (const file of [...project.screens.values()].map((entry) => entry.file).filter((name): name is string => typeof name === 'string').sort()) {
    if (!draft.exists(file)) continue;
    const screen = draft.json<Screen>(file);
    const id = typeof screen.id === 'string' ? screen.id : file;
    let edited = false;
    for (const { block, path } of [...screenBlocks(screen)]) {
      for (const [pointer, text] of [...glossaryStrings(block.props, `${path}/props`)]) {
        const result = unlinkText(text, removedTerms);
        if (result.text === text) continue;
        setAt(screen, pointer, result.text);
        const unit = units.get(`${file}#${pointer}`) ?? null;
        if (unit) changed.set(unit, text);
        for (const link of result.removed) removed.push({ screen: id, term: link.term, text: link.words, unit });
        edited = true;
      }
    }
    if (edited) draft.writeJson(file, screen);
  }
  if (!changed.size) return { removed, translations: [] };
  const after = loadProject(draft.files(), { root: project.root });
  const translations: LinkedTranslation[] = [];
  for (const language of [...project.translations.keys()].sort()) {
    const source = readText(draft.files(), translationPath(language));
    if (source === null) continue;
    let doc: ReturnType<typeof readXliff>;
    try { doc = readXliff(source); } catch { continue; }
    const candidates: Candidate[] = [];
    const stale: string[] = [];
    for (const [id, before] of changed) {
      const unit = doc.units.get(id);
      if (!unit?.target || unit.source !== before || unit.state === 'initial') continue;
      if (unit.targetMarks?.length) { stale.push(id); continue; }
      candidates.push({ unit: id, target: unlinkText(unit.target, removedTerms).text, state: unit.state === 'reviewed' || unit.state === 'final' ? unit.state : 'translated' });
    }
    const accepted = writeTranslations(after, draft, language, candidates, stale);
    if (accepted.length || stale.length) translations.push({ language, linked: [], stale: stale.sort(), unlinked: accepted });
  }
  return { removed, translations };
}

// The strings of a value that may hold a link to the glossary, with their JSON pointers.
function* glossaryStrings(value: unknown, pointer: string): Generator<[string, string]> {
  if (typeof value === 'string') { if (value.includes('glossary:')) yield [pointer, value]; return; }
  if (Array.isArray(value)) { for (const [index, item] of value.entries()) yield* glossaryStrings(item, `${pointer}/${index}`); return; }
  if (isRecord(value)) for (const [key, item] of Object.entries(value)) yield* glossaryStrings(item, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
}

type Candidate = { unit: string; target: string; state: 'translated' | 'reviewed' | 'final' };

// Translated texts written as translate_text writes them, so their units stay up to date; a text the
// rules of translations refuse (one checked at a time only when the whole set is refused) is added to
// stale. Returns the units written.
function writeTranslations(after: Project, draft: Draft, language: string, candidates: readonly Candidate[], stale: string[]): string[] {
  let accepted = [...candidates];
  if (candidates.length) {
    try { translateUnits(after, { language, texts: candidates }); } catch {
      accepted = candidates.filter((candidate) => {
        try { translateUnits(after, { language, texts: [candidate] }); return true; } catch { stale.push(candidate.unit); return false; }
      });
    }
  }
  if (accepted.length) {
    const { file, text } = translateUnits(after, { language, texts: accepted });
    draft.writeText(file, text);
  }
  return accepted.map((candidate) => candidate.unit);
}

// The translations that had the changed texts up to date: the same links where the term's
// translation is, else the unit listed as stale.
function linkTranslations(project: Project, draft: Draft, entries: readonly CourseGlossary[], changed: ReadonlyMap<string, { before: string; terms: string[] }>): LinkedTranslation[] {
  const after = loadProject(draft.files(), { root: project.root });
  const out: LinkedTranslation[] = [];
  for (const language of [...project.translations.keys()].sort()) {
    const source = readText(draft.files(), translationPath(language));
    if (source === null) continue;
    let doc: ReturnType<typeof readXliff>;
    try { doc = readXliff(source); } catch { continue; }
    const target = (id: string) => { const unit = doc.units.get(id); return unit?.target?.trim() ? unit.target : null; };
    const candidates: Candidate[] = [];
    const stale: string[] = [];
    for (const [id, { before, terms }] of changed) {
      const unit = doc.units.get(id);
      // Not up to date before: not the links' doing.
      if (!unit?.target || unit.source !== before || unit.state === 'initial') continue;
      if (unit.targetMarks?.length) { stale.push(id); continue; }
      const translated = terms.map((term) => {
        const entry = entries.find((candidate) => candidate.id === term);
        const forms = !entry ? [] : entry.translate === false ? [entry.term, ...(entry.variants ?? [])]
          : [target(`course.glossary.${term}.term`), ...(entry.variants ?? []).map((_, index) => target(`course.glossary.${term}.variant.${index + 1}`))].filter((form): form is string => !!form);
        return { id: term, forms };
      });
      const matcher = matcherOf(translated);
      const result = matcher ? linkText(unit.target, matcher, new Set(terms), new Set(linkedTerms(unit.target))) : null;
      if (result && result.placed.length === terms.length) candidates.push({ unit: id, target: result.text, state: unit.state === 'reviewed' || unit.state === 'final' ? unit.state : 'translated' });
      else stale.push(id);
    }
    const linked = writeTranslations(after, draft, language, candidates, stale);
    if (linked.length || stale.length) out.push({ language, linked, stale: stale.sort() });
  }
  return out;
}
