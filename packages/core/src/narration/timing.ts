// The timeline of a narrated screen (docs/decisions.md D24): its lines laid end to end with their
// pauses, each step a segment, and the captions cut from the lines. Pure: the build gives the
// durations it measured from the decoded audio, the canvas and the validator those of the files'
// sidecars, or estimates while a line has no audio yet.

import { withoutDirections } from './directions.ts';

// Silence before a line that does not say: none before the first line, 0.4 s before the others.
export const DEFAULT_PAUSE = 0.4;
// A step's first line starts at least this long after the previous segment ends, so that stopping
// playback at the end of a segment never lets the next sound through.
export const STEP_GAP = 0.3;
// The pace of an estimated line: about 150 words a minute in French or English.
export const CHARACTERS_PER_SECOND = 15;
// A caption holds two lines of text at most.
export const CAPTION_CHARACTERS = 84;

export interface TimedLineInput {
  id: string;
  step: number;
  text: string;
  pauseBefore?: number;
  // Seconds of audio; null: no audio yet (estimated from the text).
  duration: number | null;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface TimedLine {
  id: string;
  step: number;
  // When the voice starts (after the pause) and ends, in seconds from the start of the track.
  start: number;
  end: number;
  pause: number;
  duration: number;
  estimated: boolean;
  cues: CaptionCue[];
}

export interface Segment {
  step: number;
  start: number;
  end: number;
}

export interface NarrationTiming {
  lines: TimedLine[];
  segments: Segment[];
  duration: number;
  // Some line has no audio: its time is estimated.
  estimated: boolean;
}

// Times are kept to the millisecond: the same inputs always give the same course data.
const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000;

export const estimatedDuration = (text: string): number => ms(Math.max(1, Math.round((withoutDirections(text).trim().length / CHARACTERS_PER_SECOND) * 10) / 10));

// The pause before a line: its own, else the default; a step's first line keeps the step gap.
export function pauseOf(line: { pauseBefore?: number; step: number }, index: number, previous: { step: number } | undefined): number {
  const pause = typeof line.pauseBefore === 'number' ? line.pauseBefore : index === 0 ? 0 : DEFAULT_PAUSE;
  return previous && previous.step !== line.step ? Math.max(pause, STEP_GAP) : pause;
}

// steps: every step of the screen (its blocks' and its lines'), so that a step without lines has its
// (empty) segment too.
export function narrationTiming(lines: readonly TimedLineInput[], steps: readonly number[] = []): NarrationTiming {
  const timed: TimedLine[] = [];
  let t = 0;
  lines.forEach((line, index) => {
    const pause = pauseOf(line, index, lines[index - 1]);
    const estimated = line.duration == null;
    const duration = ms(estimated ? estimatedDuration(line.text) : line.duration ?? 0);
    const start = ms(t + pause);
    const end = ms(start + duration);
    timed.push({ id: line.id, step: line.step, start, end, pause: ms(pause), duration, estimated, cues: captionCues(line.text, start, end) });
    t = end;
  });
  const allSteps = [...new Set([...steps, ...lines.map((line) => line.step)])].sort((a, b) => a - b);
  const segments: Segment[] = [];
  let from = 0;
  for (const step of allSteps) {
    const own = timed.filter((line) => line.step === step);
    const end = own.length ? own[own.length - 1].end : from;
    segments.push({ step, start: from, end });
    from = end;
  }
  return { lines: timed, segments, duration: ms(t), estimated: timed.some((line) => line.estimated) };
}

// The captions of a line: its sentences, cut again where one is longer than two caption lines, each
// shown for a share of the line's time in proportion to its length (word timings will place them).
export function captionCues(text: string, start: number, end: number): CaptionCue[] {
  const chunks = captionChunks(text);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) || 1;
  const cues: CaptionCue[] = [];
  let at = start;
  chunks.forEach((chunk, index) => {
    const next = index === chunks.length - 1 ? end : ms(at + ((end - start) * chunk.length) / total);
    cues.push({ start: ms(at), end: next, text: chunk });
    at = next;
  });
  return cues;
}

export function captionChunks(text: string, limit = CAPTION_CHARACTERS): string[] {
  // Stage directions are never shown (D29).
  const clean = withoutDirections(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["»”’)]*\s*|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [clean];
  // Short sentences share a caption.
  const merged: string[] = [];
  for (const sentence of sentences) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length + 1 + sentence.length <= limit) merged[merged.length - 1] = `${last} ${sentence}`;
    else merged.push(sentence);
  }
  return merged.flatMap((sentence) => split(sentence, limit));
}

// A sentence too long for a caption, cut at a comma or a word near its middle, again and again.
function split(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  const middle = sentence.length / 2;
  const cuts: number[] = [];
  for (const match of sentence.matchAll(/[,;:—–] /g)) cuts.push((match.index ?? 0) + match[0].length - 1);
  const words: number[] = [];
  for (const match of sentence.matchAll(/ /g)) words.push(match.index ?? 0);
  const nearest = (positions: number[]) => positions.reduce<number | null>((best, at) => (best === null || Math.abs(at - middle) < Math.abs(best - middle) ? at : best), null);
  const punctuation = nearest(cuts.filter((at) => Math.abs(at - middle) < sentence.length / 4));
  const cut = punctuation ?? nearest(words);
  if (cut === null || cut <= 0 || cut >= sentence.length - 1) return [sentence];
  return [...split(sentence.slice(0, cut).trim(), limit), ...split(sentence.slice(cut).trim(), limit)];
}

// WebVTT of a screen's narration: one cue per caption, the speaker as a voice span.
export function narrationVtt(lines: readonly (TimedLine & { speaker: string | null })[]): string {
  const out = ['WEBVTT', ''];
  let n = 0;
  for (const line of lines) {
    for (const cue of line.cues) {
      n++;
      const text = escapeVtt(cue.text);
      out.push(String(n), `${vttTime(cue.start)} --> ${vttTime(cue.end)}`, line.speaker ? `<v ${escapeVtt(line.speaker)}>${text}` : text, '');
    }
  }
  return out.join('\n');
}

const escapeVtt = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function vttTime(seconds: number): string {
  const total = Math.round(seconds * 1000);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const rest = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rest).padStart(3, '0')}`;
}

// 0:12, 1:04: times as learners and agents read them.
export function clockTime(seconds: number, { tenths = false }: { tenths?: boolean } = {}): string {
  const whole = tenths ? Math.round(seconds * 10) / 10 : Math.floor(seconds + 1e-6);
  const m = Math.floor(whole / 60);
  const s = whole - m * 60;
  return `${m}:${tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0')}`;
}
