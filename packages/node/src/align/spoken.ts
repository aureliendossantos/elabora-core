// From the text of a narration line to what a character-level CTC model aligns (docs/decisions.md
// D27): the words of the line as anchors name them (narrationWords in @elabora/core: French elisions
// are words of their own), each turned into what a voice says (numbers, times, ordinals, decimals
// and symbols spelt out), then into the model's characters. A word's time is the time of its
// characters, so every word of narrationWords gets one, in order.

import { narrationWords } from '@elabora/core/narration/words';
import type { TextWord } from '@elabora/core/narration/words';
import { cardinal, digitByDigit, englishOrdinal, frenchOrdinal, sayDigits } from './numbers.ts';
import { STAR } from './ctc.ts';

// The languages whose numbers are spelt out; another language aligns its numbers with a wildcard.
export type NumberLanguage = 'fr' | 'en';

// Symbols a voice says out loud.
const SYMBOLS: Record<NumberLanguage, Record<string, string[]>> = {
  fr: { '%': ['pour', 'cent'], '€': ['euros'], $: ['dollars'], '&': ['et'], '+': ['plus'], '@': ['arobase'], '°': ['degrés'], '=': ['égale'] },
  en: { '%': ['percent'], '€': ['euros'], $: ['dollars'], '&': ['and'], '+': ['plus'], '@': ['at'], '°': ['degrees'], '=': ['equals'] }
};
const SPOKEN_SYMBOLS = /[%€$&+@°=]/gu;

const APOSTROPHES = /[’‘ʼ`´]/gu;
const isDigits = (s: string): boolean => /^\d+$/u.test(s);
export const hasNumber = (word: string): boolean => /\d/u.test(word);

// One written word as said, given its neighbours (the "h" of "9 h 30" is "heures").
function sayWord(words: readonly TextWord[], i: number, language: NumberLanguage | null): string[] | null {
  const previous = words[i - 1]?.text;
  const next = words[i + 1]?.text;
  const w = words[i].text.replace(APOSTROPHES, "'");
  const lower = w.toLowerCase();
  if (language === 'fr') {
    if (lower === 'h' && previous && isDigits(previous) && (!next || isDigits(next))) return [Number(previous) <= 1 ? 'heure' : 'heures'];
    // The minutes of "8 h 05": cinq.
    if (isDigits(w) && previous?.toLowerCase() === 'h' && words[i - 2] && isDigits(words[i - 2].text)) return cardinal(Number(w), 'fr');
    const time = /^(\d{1,2})h(\d{2})?$/iu.exec(w);
    if (time) return [...cardinal(Number(time[1]), 'fr'), Number(time[1]) <= 1 ? 'heure' : 'heures', ...(time[2] ? sayDigits(time[2].replace(/^0/u, ''), 'fr') : [])];
    if (/^1(er|re|ère)$/iu.test(w)) return [/^1er$/iu.test(w) ? 'premier' : 'première'];
    const ordinal = /^(\d+)(e|ème|eme|ième|è)$/iu.exec(w);
    if (ordinal) return frenchOrdinal(Number(ordinal[1]));
    const decimal = /^(\d+),(\d+)$/u.exec(w);
    if (decimal) return [...sayDigits(decimal[1], 'fr'), 'virgule', ...sayDigits(decimal[2], 'fr')];
  } else if (language === 'en') {
    const time = /^(\d{1,2}):(\d{2})$/u.exec(w);
    if (time) {
      const minutes = Number(time[2]);
      return [...cardinal(Number(time[1]), 'en'), ...(minutes === 0 ? [] : minutes < 10 ? ['oh', ...cardinal(minutes, 'en')] : cardinal(minutes, 'en'))];
    }
    const ordinal = /^(\d+)(st|nd|rd|th)$/iu.exec(w);
    if (ordinal) return englishOrdinal(Number(ordinal[1]));
    const decimal = /^(\d+)\.(\d+)$/u.exec(w);
    if (decimal) return [...sayDigits(decimal[1], 'en'), 'point', ...digitByDigit(decimal[2], 'en')];
    if (/^\d{1,3}(,\d{3})+$/u.test(w)) return cardinal(Number(w.replaceAll(',', '')), 'en');
  } else if (hasNumber(w)) {
    return null; // a wildcard says it
  }
  // An elided word keeps its apostrophe (« l' » of « l'imprimante »: one word for the model).
  if (/'$/u.test(lower) && next !== undefined && words[i + 1].start === words[i].end) return [lower];
  // Anything else: parts between hyphens and slashes, each a run of letters or of digits.
  const out: string[] = [];
  for (const part of lower.split(/[-‐–—/]+/u)) {
    for (const piece of part.match(/[\p{L}\p{M}']+|\d+/gu) ?? []) {
      if (isDigits(piece)) out.push(...(language ? sayDigits(piece, language) : []));
      else out.push(piece.replace(/^'+|'+$/gu, ''));
    }
  }
  return out.filter(Boolean);
}

export interface SpokenWord extends TextWord {
  // What the voice says for it, in pieces between which it may pause; null: a wildcard absorbs it.
  spoken: string[] | null;
  // Said right after the previous word, with nothing between them (« l' » and « imprimante »).
  joined: boolean;
}

// What each word of a line is said as. A symbol between two words (« 3,5 % », « R&D ») is said with
// the word before it (with the next one at the start of a line).
export function spokenWords(text: string, language: string): SpokenWord[] {
  const primary = language.toLowerCase().split('-')[0];
  const numbers: NumberLanguage | null = primary === 'fr' || primary === 'en' ? primary : null;
  const words = narrationWords(text, language);
  const out: SpokenWord[] = words.map((word, i) => ({ ...word, spoken: sayWord(words, i, numbers), joined: i > 0 && words[i - 1].end === word.start }));
  const symbolsOf = (from: number, to: number): string[] => [...text.slice(from, to).matchAll(SPOKEN_SYMBOLS)].flatMap((match) => (numbers ? SYMBOLS[numbers][match[0]] : []));
  for (let i = 0; i < out.length; i++) {
    const after = symbolsOf(out[i].end, out[i + 1]?.start ?? text.length);
    if (after.length && out[i].spoken) out[i].spoken!.push(...after);
  }
  const before = out.length ? symbolsOf(0, out[0].start) : [];
  if (before.length && out[0].spoken) out[0].spoken.unshift(...before);
  return out;
}

const LIGATURES: Record<string, string> = { œ: 'oe', æ: 'ae', ß: 'ss', ﬁ: 'fi', ﬂ: 'fl' };

// The characters of a spoken word as ids of the model's vocabulary: letters in the vocabulary's case,
// accents removed when the vocabulary lacks the accented letter, ligatures split, anything else dropped.
export function vocabularyTokens(spoken: string, vocab: Readonly<Record<string, number>>): number[] {
  const upper = !('a' in vocab) && 'A' in vocab;
  const text = upper ? spoken.toUpperCase() : spoken.toLowerCase();
  const ids: number[] = [];
  for (const char of text) {
    const direct = vocab[char];
    if (direct !== undefined) { ids.push(direct); continue; }
    const lower = char.toLowerCase();
    const ligature = LIGATURES[lower];
    const fallback = ligature ?? lower.normalize('NFD').replace(/\p{M}/gu, '');
    for (const c of upper ? fallback.toUpperCase() : fallback) {
      const id = vocab[c];
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

export interface Target {
  token: number;   // a vocabulary id, or STAR
  word: number;    // the word it belongs to, -1 for a delimiter between words
}

// The targets of a line: the characters of its words, the model's word delimiter between two words
// said apart (and between the pieces of one word), none inside a word that runs on (an elision).
export function targetsOf(words: readonly SpokenWord[], vocab: Readonly<Record<string, number>>, delimiter: number | null): { targets: Target[]; said: string[] } {
  const targets: Target[] = [];
  const said: string[] = [];
  words.forEach((word, w) => {
    const pieces = (word.spoken ?? []).map((piece) => vocabularyTokens(piece, vocab)).filter((ids) => ids.length > 0);
    const groups = pieces.length ? pieces : [[STAR]];
    said.push(pieces.length ? word.spoken!.join(' ') : '*');
    groups.forEach((ids, g) => {
      if (targets.length && delimiter !== null && (g > 0 || !word.joined)) targets.push({ token: delimiter, word: -1 });
      for (const token of ids) targets.push({ token, word: w });
    });
  });
  return { targets, said };
}
