// A line's voice as a character reads it (docs/dialogues.md, characters): whether the voice is
// sounding at a time, the mouth's shape and the word being said. Pure, without DOM: the player's
// dialogues call it every frame with the audio's currentTime, the editor's preview without audio.

import type { LineVoiceData } from '../dialogue/types.ts';

export type Mouth = 'closed' | 'small' | 'open' | 'wide';

// The envelope's letters (one per 1/30 s), as @elabora/node writes them in a line's sidecar.
export const MOUTH_FPS = 30;
export const MOUTH_LETTERS: Readonly<Record<string, Mouth>> = { c: 'closed', s: 'small', o: 'open', w: 'wide' };

// A silence between two words shorter than this is still speech: the mouth does not close for it.
export const SPEECH_GAP = 0.25;

// When a line is said at t (seconds from its start):
// - talking: the voice is sounding (in a word, or in a gap of SPEECH_GAP or less between two words);
// - mouth: the envelope's shape at t; without an envelope, open during speech and closed otherwise;
// - word: the index of the last word whose start has passed (null before the first word), what
//   the ink reveal shows as said.
export function voiceAt(voice: LineVoiceData, t: number): { talking: boolean; mouth: Mouth; word: number | null } {
  const words = voice.words;
  let word: number | null = null;
  for (let index = 0; index < words.length && words[index]![1] <= t; index++) word = index;
  const talking = t >= 0 && t < voice.duration && inSpeech(words, t);
  let mouth: Mouth = 'closed';
  if (voice.mouth) {
    const frame = Math.floor(t * MOUTH_FPS);
    mouth = frame >= 0 && frame < voice.mouth.length ? MOUTH_LETTERS[voice.mouth[frame]!] ?? 'closed' : 'closed';
  } else if (talking) mouth = 'open';
  return { talking, mouth, word };
}

function inSpeech(words: LineVoiceData['words'], t: number): boolean {
  for (let index = 0; index < words.length; index++) {
    const [, start, end] = words[index]!;
    if (t >= start && t <= end) return true;
    const next = words[index + 1];
    if (next && t > end && t < next[1] && next[1] - end <= SPEECH_GAP) return true;
  }
  return false;
}

// The words of a text, as @elabora/core narration/words.ts counts them (D27): runs of letters,
// digits and marks joined by an apostrophe or a hyphen, or by . , : / between digits; in French an
// elision is a word of its own (l'imprimante: l', imprimante). The compiled text has no stage
// directions. A test checks that both tokenizers agree.
const WORD = /[\p{L}\p{N}\p{M}]+(?:(?:['’‘‐-]|(?<=\p{N})[.,:/](?=\p{N}))[\p{L}\p{N}\p{M}]+)*/gu;
const ELISION = /^(?:l|d|j|m|n|s|t|c|ç|qu|jusqu|lorsqu|puisqu|quoiqu|presqu|quelqu)['’‘](?=[\p{L}\p{N}])/iu;

export function textWords(text: string, language?: string): { text: string; start: number; end: number }[] {
  const elides = !language || /^fr\b/i.test(language);
  const out: { text: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(WORD)) {
    const start = match.index ?? 0;
    const word = match[0];
    const elision = elides ? ELISION.exec(word) : null;
    if (elision && elision[0].length < word.length) {
      out.push({ text: word.slice(0, elision[0].length), start, end: start + elision[0].length });
      out.push({ text: word.slice(elision[0].length), start: start + elision[0].length, end: start + word.length });
    } else out.push({ text: word, start, end: start + word.length });
  }
  return out;
}

// The core's estimate of a line's length (narration/timing.ts estimatedDuration): 15 characters a
// second, one second at least, to the tenth.
export const CHARACTERS_PER_SECOND = 15;
export const estimatedSeconds = (text: string): number => Math.max(1, Math.round((text.trim().length / CHARACTERS_PER_SECOND) * 10) / 10);

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

// A line's voice without audio (the editor's preview before compiling, a line whose audio is
// missing): the words placed in proportion to the text along the line, as the core estimates them
// (narration/words.ts lineWordTimes), and a mouth drawn from the letters: a, à, â open wide; o, é,
// è, ê, œ open; e, i, u, y and the other letters open a little; m, b, p close; the gaps between
// words close it, so pauses follow the punctuation. A shape holds two frames at least.
export function textVoice(text: string, duration?: number, language?: string): LineVoiceData {
  const length = Math.max(1, text.trimEnd().length);
  const seconds = duration !== undefined && duration > 0 ? duration : estimatedSeconds(text);
  const words = textWords(text, language).map((word): [string, number, number] => [word.text, round(seconds * word.start / length), round(seconds * word.end / length)]);
  return { src: null, duration: seconds, words, mouth: textMouth(words, seconds), estimated: true };
}

const shapeOf = (letter: string): string => (/[aàâ]/i.test(letter) ? 'w' : /[oôéèêœ]/i.test(letter) ? 'o' : /[mbp]/i.test(letter) ? 'c' : 's');

export function textMouth(words: LineVoiceData['words'], duration: number): string {
  const out: string[] = [];
  const frames = Math.ceil(duration * MOUTH_FPS);
  for (let frame = 0, current = 0; frame < frames; frame++) {
    const t = (frame + 0.5) / MOUTH_FPS;
    while (current < words.length && words[current]![2] < t) current++;
    const word = words[current];
    if (!word || t < word[1]) { out.push('c'); continue; }
    const letters = [...word[0].replace(/[^\p{L}]/gu, '')];
    if (!letters.length) { out.push('s'); continue; }
    const span = word[2] - word[1] || 1;
    const index = Math.min(letters.length - 1, Math.floor(((t - word[1]) / span) * letters.length));
    out.push(shapeOf(letters[index]!));
  }
  holdTwoFrames(out);
  return out.join('');
}

// A shape that lasts a single frame takes its neighbour's, so the mouth does not flicker; a closure
// may last one frame (m, b, p).
export function holdTwoFrames(values: string[]): void {
  for (let frame = 1; frame < values.length - 1; frame++) {
    if (values[frame] !== 'c' && values[frame - 1] !== values[frame] && values[frame + 1] !== values[frame]) values[frame] = values[frame - 1] === 'c' ? values[frame + 1]! : values[frame - 1]!;
  }
}
