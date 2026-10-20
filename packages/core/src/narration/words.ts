// The words of a narration line (docs/decisions.md D27): what a word anchor names, what forced
// alignment times and what a sidecar's words list holds, in the order of the text. One tokenizer for
// all of them, so that an anchor, the aligner and the editor count words the same way.
//
// A word is a run of letters, digits and combining marks, joined by an apostrophe or a hyphen
// (aujourd'hui, P-12, porte-avions), or by . , : / between digits (3,5, 9:30, 1/2). In French an
// elision is a word of its own (l'imprimante: l', imprimante), so that « imprimante » can be anchored
// and timed. Punctuation is not a word, nor is a stage direction ([chuchote], docs/decisions.md D29).

import { lineDirections, maskDirections } from './directions.ts';

export interface TextWord {
  text: string;
  // Offsets of the word in the text (UTF-16 code units), end excluded.
  start: number;
  end: number;
}

// A word and when it is said, in seconds (from the start of the line's audio, or of the timeline).
export interface TimedWord {
  text: string;
  start: number;
  end: number;
  // Not timed by alignment: placed in proportion to the text (no word times, or a word the audio
  // does not say yet).
  estimated?: boolean;
  score?: number;
}

const WORD = /[\p{L}\p{N}\p{M}]+(?:(?:['’‘‐-]|(?<=\p{N})[.,:/](?=\p{N}))[\p{L}\p{N}\p{M}]+)*/gu;
// French elisions: the particle and its apostrophe are a word (l', d', qu', jusqu'…).
const ELISION = /^(?:l|d|j|m|n|s|t|c|ç|qu|jusqu|lorsqu|puisqu|quoiqu|presqu|quelqu)['’‘](?=[\p{L}\p{N}])/iu;

const elides = (language: string | undefined): boolean => !language || /^fr\b/i.test(language);

export function narrationWords(text: string, language?: string): TextWord[] {
  const out: TextWord[] = [];
  // Stage directions are not words (D29): read from the text with them blanked, offsets kept.
  for (const match of maskDirections(text).matchAll(WORD)) {
    const start = match.index ?? 0;
    const word = match[0];
    const elision = elides(language) ? ELISION.exec(word) : null;
    if (elision && elision[0].length < word.length) {
      out.push({ text: word.slice(0, elision[0].length), start, end: start + elision[0].length });
      out.push({ text: word.slice(elision[0].length), start: start + elision[0].length, end: start + word.length });
    } else out.push({ text: word, start, end: start + word.length });
  }
  return out;
}

// A word as anchors compare it: Unicode NFC, lower case, one kind of apostrophe and hyphen.
export const normalizeWord = (word: string): string => word.normalize('NFC').toLowerCase().replace(/[’‘]/g, "'").replace(/‐/g, '-');

// Where a word or phrase is in a line's words: the index of its first word and how many words it
// covers, the occurrence-th time it appears (1: the first). null when the line does not say it.
export function findPhrase(words: readonly Pick<TextWord, 'text'>[], phrase: string, { occurrence = 1, language }: { occurrence?: number; language?: string } = {}): { index: number; count: number } | null {
  const wanted = narrationWords(phrase, language).map((word) => normalizeWord(word.text));
  if (!wanted.length) return null;
  const said = words.map((word) => normalizeWord(word.text));
  // Exactly, then a word that carries the anchor with a possessive or an elision the tokenizer kept
  // whole (printer's, l'imprimante in a language without elisions).
  const loose = (word: string, target: string) => word === target || word === `${target}'s` || word === `${target}'` || word.endsWith(`'${target}`);
  for (const same of [(a: string, b: string) => a === b, loose]) {
    let seen = 0;
    for (let index = 0; index + wanted.length <= said.length; index++) {
      if (!wanted.every((target, offset) => same(said[index + offset], target))) continue;
      if (++seen === Math.max(1, occurrence)) return { index, count: wanted.length };
    }
  }
  return null;
}

// How many times a phrase is in a line (anchors on a word said twice name which one).
export function phraseCount(words: readonly Pick<TextWord, 'text'>[], phrase: string, language?: string): number {
  let count = 0;
  while (findPhrase(words, phrase, { occurrence: count + 1, language })) count++;
  return count;
}

// The longest common subsequence of two word lists (normalized): pairs [index in a, index in b].
export function matchWords(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (table[i + 1][j] >= table[i][j + 1]) i++; else j++;
  }
  return pairs;
}

// When each word of a line's text is said, from the times an alignment gave (of the same text, or of
// the text the audio was made from: a line out of date keeps the times of the words it still says),
// in seconds from the start of the line's audio. Words without a time are placed between their
// neighbours in proportion to their length; without times at all, along the whole line in proportion
// to the text said (its stage directions take no time, D29). duration: seconds of the line.
export function lineWordTimes(text: string, duration: number, given: readonly TimedWord[] | null | undefined, language?: string): TimedWord[] {
  // A sidecar edited by hand may hold anything: only well-formed words count.
  const timed = given?.filter((word) => word && typeof word.text === 'string' && Number.isFinite(word.start) && Number.isFinite(word.end));
  const words = narrationWords(text, language);
  if (!words.length) return [];
  const said = saidOffsets(text);
  const length = Math.max(1, said(text.trimEnd().length));
  const proportional = (word: TextWord): TimedWord => ({ text: word.text, start: round(duration * said(word.start) / length), end: round(duration * said(word.end) / length), estimated: true });
  if (!timed?.length) return words.map(proportional);
  const pairs = matchWords(words.map((word) => normalizeWord(word.text)), timed.map((word) => normalizeWord(word.text)));
  const out: (TimedWord | null)[] = words.map(() => null);
  for (const [index, source] of pairs) {
    const from = timed[source];
    out[index] = { text: words[index].text, start: from.start, end: Math.max(from.start, from.end), ...(typeof from.score === 'number' ? { score: from.score } : {}) };
  }
  // Runs of words without a time share the gap between the timed words around them.
  for (let index = 0; index < words.length;) {
    if (out[index]) { index++; continue; }
    let last = index;
    while (last + 1 < words.length && !out[last + 1]) last++;
    const before = index > 0 ? out[index - 1]!.end : 0;
    const after = last + 1 < words.length ? out[last + 1]!.start : duration;
    const span = Math.max(0, after - before);
    const run = words.slice(index, last + 1);
    const chars = run.reduce((sum, word) => sum + (word.end - word.start), 0) || 1;
    let at = before;
    for (const [offset, word] of run.entries()) {
      const share = span * (word.end - word.start) / chars;
      out[index + offset] = { text: word.text, start: round(at), end: round(at + share), estimated: true };
      at += share;
    }
    index = last + 1;
  }
  return out as TimedWord[];
}

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

// An offset of a line's text, counted without its stage directions and the space before each (what
// the voice says): « [agacé] Ça fait » puts « Ça » at 0, not at 8.
function saidOffsets(text: string): (offset: number) => number {
  let last = 0;
  const cuts = lineDirections(text).map((direction) => {
    let start = direction.start;
    while (start > last && /\s/.test(text[start - 1]!)) start--;
    // Directions that open the line take the space after them too.
    let end = direction.end;
    if (!maskDirections(text.slice(0, start)).trim()) while (end < text.length && /\s/.test(text[end]!)) end++;
    last = end;
    return { start, end };
  });
  if (!cuts.length) return (offset) => offset;
  return (offset) => cuts.reduce((at, cut) => at - Math.max(0, Math.min(offset, cut.end) - cut.start), offset);
}

// Words a voice may have swallowed (docs/decisions.md D27): two letters or more that the alignment
// scores under SWALLOWED_SCORE. Measured on Pocket TTS voices with a word cut out of their audio: it
// catches 84 % (fr) and 100 % (en) of the cut words, and a badly pronounced word scores above it.
export const SWALLOWED_SCORE = 0.25;

// index: the word's place in the line's words (those of narrationWords).
export function doubtfulWords(words: readonly { text: string; score?: number }[]): { word: string; score: number; index: number }[] {
  return words
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => typeof word.score === 'number' && word.score < SWALLOWED_SCORE && [...word.text.matchAll(/\p{L}/gu)].length >= 2)
    .map(({ word, index }) => ({ word: word.text, score: word.score!, index }));
}

// The key of a word the voice may have swallowed (W_NARRATION_WORD_SWALLOWED), which the author may
// ignore (docs/decisions.md D31): the line, the word, and the take's audio. Another take of the line
// (another audio) has another key: the alert comes back, as the voice may now swallow it for real.
//   « client-mecontent/l2/fr/9:de@051bd18597521d7e »
export const swallowedKey = (screen: string, line: string, language: string, word: { index: number; word: string }, audioHash: string): string =>
  `${screen}/${line}/${language}/${word.index}:${word.word}@${audioHash.replace(/^sha256:/, '').slice(0, 16)}`;
