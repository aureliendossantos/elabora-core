import type { Project, Screen } from '../project/model.ts';
import { extractUnits, setAt, valueAt } from '../i18n/units.ts';
import { parseMarkdown } from './markdown.ts';
import { objectsIn } from '../util/values.ts';
import { findItem, playerConfig } from '../player/config.ts';

// The links of a screen's texts to the glossary (docs/decisions.md D58, revised on 7 Nov 2026).
// They are computed when a screen is compiled (the package, the editor's canvas, the Aperçu), in the
// language compiled, and never written into the texts: the first time a term of the glossary, or one
// of its variants, is in a screen's texts becomes a link to its entry, [mot](glossary:<id>). The
// screens' own Markdown texts in reading order (the order of the translation units); the plan's
// locked texts and validated questions keep the client's words as they are, and nothing inside a
// link, code, maths, a URL or an HTML tag is touched (protectedRanges). A link written by hand wins:
// a screen that has one to a term takes no other to it. An entry's `unlinked` lists the screens where
// the author removed its link (« Retirer ce lien »); the glossary option linkTerms false links nothing
// (the links written by hand stay).
//
// Matching: every form of every entry at once, the longest first (« réseau privé virtuel » before
// « réseau », whatever their order in the glossary); a word written in capitals, or with a capital
// inside (« SI », « VPN », « iPhone »), matches with its case, any other word in either case
// (« Routeur » and « routeur »). In a translation the forms are the entry's translated term and
// variants (its own, for an entry with translate: false).
//
// Removing an entry removes the links written by hand to it (commands/glossary-links.ts).

// ── What must not take a link ─────────────────────────────────────────
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

// ── Links to the glossary ─────────────────────────────────────────────
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

// ── Forms of the terms ────────────────────────────────────────────────
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

// The entries a text links to, written by hand (inline or by reference).
const linkedTerms = (text: string): string[] => glossaryLinkSpans(text).filter((span) => !span.definition).map((span) => span.term);

// The screens' Markdown texts by screen file, in reading order (their JSON pointers), for a project.
const markdownPointers = new WeakMap<Project, Map<string, string[]>>();
function pointersOf(project: Project, file: string): string[] {
  let byFile = markdownPointers.get(project);
  if (!byFile) {
    byFile = new Map();
    for (const unit of extractUnits(project)) {
      if (unit.format !== 'markdown' || !unit.file.startsWith('screens/')) continue;
      const pointers = byFile.get(unit.file) ?? [];
      pointers.push(unit.pointer);
      byFile.set(unit.file, pointers);
    }
    markdownPointers.set(project, byFile);
  }
  return byFile.get(file) ?? [];
}

// The glossary option « Relier les termes aux écrans » (on unless the course says false), as the player
// reads its items.
const linking = (project: Project): boolean => {
  const found = findItem(playerConfig(project.course), 'glossary')?.item;
  return found?.id !== 'glossary' || found.options.linkTerms;
};

// The forms of the project's glossary as one matcher (the same for every screen of a project).
const matchers = new WeakMap<Project, Matcher | null>();
function projectMatcher(project: Project, entries: readonly { id: string; term: string; variants?: unknown }[]): Matcher | null {
  if (!matchers.has(project)) matchers.set(project, matcherOf(entries.map((entry) => ({ id: entry.id, forms: [entry.term, ...(Array.isArray(entry.variants) ? entry.variants.filter((form): form is string => typeof form === 'string') : [])] }))));
  return matchers.get(project) ?? null;
}

// A screen with its links to the glossary computed, for the compiler: the same screen when nothing is
// linked, else a copy whose texts have them. The project is the course in the language compiled (its
// glossary and screens translated).
export function linkedScreen(project: Project, screenId: string, screen: Screen): Screen {
  const entries = objectsIn(project.course?.glossary).filter((entry) => typeof entry.id === 'string' && typeof entry.term === 'string');
  if (!entries.length || !linking(project)) return screen;
  const file = project.screens.get(screenId)?.file;
  const pointers = typeof file === 'string' ? pointersOf(project, file) : [];
  if (!pointers.length) return screen;
  const wanted = new Set(entries.filter((entry) => !(Array.isArray(entry.unlinked) && entry.unlinked.includes(screenId))).map((entry) => entry.id));
  if (!wanted.size) return screen;
  const matcher = projectMatcher(project, entries);
  if (!matcher) return screen;
  const texts = pointers.map((pointer) => valueAt(screen, pointer)).filter((text): text is string => typeof text === 'string');
  // A link written by hand wins: the screen takes no other to that entry.
  const taken = new Set(texts.flatMap(linkedTerms));
  let copy: Screen | null = null;
  for (const pointer of pointers) {
    const text = valueAt(copy ?? screen, pointer);
    if (typeof text !== 'string') continue;
    const result = linkText(text, matcher, wanted, taken);
    if (!result.placed.length) continue;
    copy ??= structuredClone(screen);
    setAt(copy, pointer, result.text);
  }
  return copy ?? screen;
}
