// Fill-in blanks (D63): reading [[answer|other accepted]] in a fill-in's Markdown, comparing what a
// learner gave with the answers, and grading a blank at a time. Pure: the core parses the blanks when
// it builds a course, the player grades what learners give.

// A blank as the author wrote it: its accepted answers, the first one shown after the last try.
export interface Blank {
  answers: string[];
}

// What a typed blank keeps of what the learner writes: twice its longest answer, between 16 and 60
// characters (the field takes no more; the build counts it in the worst-case saved data).
export function blankMaxLength(blank: Blank): number {
  const longest = Math.max(0, ...blank.answers.map((answer) => answer.length));
  return Math.min(60, Math.max(16, 2 * longest));
}

// [[…]] holding no bracket: a blank. A blank cannot span a paragraph.
const BLANK = /\[\[([^[\]\n]*)\]\]/g;
export const MAX_BLANKS = 12;

// The blanks of a fill-in's Markdown, in reading order. An empty answer ([[ ]], [[a||b]]) is left out;
// a blank without any answer keeps its place with none (the validator reports it).
export function parseBlanks(markdown: unknown): Blank[] {
  const blanks: Blank[] = [];
  for (const match of String(markdown ?? '').matchAll(BLANK)) blanks.push({ answers: match[1].split('|').map((answer) => answer.trim()).filter(Boolean) });
  return blanks;
}

// The Markdown with each blank replaced by what replace returns for it (its index from 0).
export function replaceBlanks(markdown: unknown, replace: (index: number, blank: Blank) => string): string {
  let index = 0;
  return String(markdown ?? '').replace(BLANK, (_, inside: string) => replace(index++, { answers: inside.split('|').map((answer) => answer.trim()).filter(Boolean) }));
}

// What counts when an answer is compared: not the case, the spaces around and between words (and the
// French space before ? ! : ;), the form of quotes and apostrophes, nor (ignoreAccents) the accents.
export function normalizeAnswer(text: unknown, { ignoreAccents = false }: { ignoreAccents?: boolean } = {}): string {
  let value = String(text ?? '').normalize('NFC')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\s\u00a0\u202f\u2009]+/g, ' ')
    .trim()
    .toLocaleLowerCase();
  // Quotes keep no space inside them (« mot » and "mot" read alike).
  value = value.replace(/" /g, '"').replace(/ "/g, '"').replace(/ ([?!:;])/g, '$1');
  if (ignoreAccents) value = value.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
  return value;
}

// Whether a learner's answer is one of a blank's.
export function blankIsRight(blank: Blank, given: unknown, options: { ignoreAccents?: boolean } = {}): boolean {
  const answer = normalizeAnswer(given, options);
  return answer !== '' && blank.answers.some((accepted) => normalizeAnswer(accepted, options) === answer);
}

export interface FillInGrade {
  // One per blank: right or not.
  marks: boolean[];
  // The share of blanks right, 0..1 (0 for a fill-in without blanks).
  score: number;
  correct: boolean;
}

// What a learner's answers are worth (one per blank, '' left empty).
export function gradeFillIn(blanks: readonly Blank[], given: readonly unknown[], options: { ignoreAccents?: boolean } = {}): FillInGrade {
  const marks = blanks.map((blank, index) => blankIsRight(blank, given[index], options));
  const right = marks.filter(Boolean).length;
  return { marks, score: blanks.length ? right / blanks.length : 0, correct: blanks.length > 0 && right === blanks.length };
}

// A shuffle that is the same at every build: a fill-in's menus and bank, a sort's items. The order
// depends on the block's id only (mulberry32 seeded by an FNV-1a hash). When it would leave a list of
// several unchanged, it turns it by one, so that nothing reads as given.
export function stableShuffle<T>(list: readonly T[], seed: string): T[] {
  let hash = 0x811c9dc5;
  for (const char of seed) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 0x01000193) >>> 0; }
  let state = hash;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (out.length > 1 && out.every((item, index) => item === list[index])) out.push(out.shift()!);
  return out;
}
