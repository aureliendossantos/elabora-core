// The mouth's envelope of a line (docs/dialogues.md, characters; D61): how open a character's mouth
// is while the line's audio plays, one letter per 1/30 s: c (closed), s (small), o (open), w (wide).
// @elabora/node computes it when it writes a line's audio (the sidecar's mouth) and the build for
// an audio whose sidecar has none; the player reads it (@elabora/player character/ voiceAt).
//
// Measured on a real voice (a Pocket TTS line of the diagnostic-reseau sample):
// - the level of each frame (RMS over 1/30 s), half against the line's 95th percentile, half against
//   the loudest frame within ±0.2 s: syllables read even inside a loud word;
// - thresholds taken from the line's own spoken frames (quantiles 12 %, 42 %, 80 %), so that a loud
//   voice and a whispered one give the same share of each shape;
// - closed outside words when the silence lasts more than 250 ms;
// - closed on m, b, p, placed by the letter's position in its word;
// - a shape holds two frames at least (a closure may last one).
// Pure and deterministic: the same samples and words give the same letters.

import { holdTwoFrames, MOUTH_FPS, SPEECH_GAP } from '@elabora/player/character/voice';

export { MOUTH_FPS } from '@elabora/player/character/voice';

// Below this share of the line's loud level a frame is silence, whatever the quantiles say.
const SILENCE = 0.02;
const LOCAL_FRAMES = 6;
const QUANTILES = [0.12, 0.42, 0.8] as const;

export interface MouthWord {
  text: string;
  start: number;
  end: number;
}

// samples: the line's audio, mono, at rate samples a second; words: when each is said (aligned, or
// estimated along the line).
export function mouthEnvelope(samples: Float32Array, rate: number, words: readonly MouthWord[]): string {
  const frames = Math.ceil((samples.length / rate) * MOUTH_FPS);
  if (!frames) return '';
  const rms = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const from = Math.floor((frame * rate) / MOUTH_FPS);
    const to = Math.min(samples.length, Math.floor(((frame + 1) * rate) / MOUTH_FPS));
    let sum = 0;
    for (let index = from; index < to; index++) sum += samples[index]! * samples[index]!;
    rms[frame] = Math.sqrt(sum / Math.max(1, to - from));
  }
  const sorted = Float64Array.from(rms).sort();
  const top = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  if (!(top > 0)) return 'c'.repeat(frames);
  const global = Array.from(rms, (value) => Math.min(1, value / top));
  const level = global.map((value, frame) => {
    let near = 0;
    for (let other = Math.max(0, frame - LOCAL_FRAMES); other <= Math.min(frames - 1, frame + LOCAL_FRAMES); other++) near = Math.max(near, global[other]!);
    return 0.5 * value + 0.5 * (near > 0 ? value / near : 0);
  });

  const speaking = (frame: number) => inSpeech(words, (frame + 0.5) / MOUTH_FPS);
  const spoken = level.filter((_value, frame) => speaking(frame) && global[frame]! >= SILENCE).sort((a, b) => a - b);
  const quantile = (q: number) => spoken[Math.min(spoken.length - 1, Math.floor(spoken.length * q))] ?? 0;
  const [q1, q2, q3] = QUANTILES.map(quantile) as [number, number, number];
  // A voice as level as a test tone has no syllables to read: the mouth stays open while it sounds.
  const flat = q3 - q1 < 0.05;
  const values = level.map((value, frame) => (!speaking(frame) || global[frame]! < SILENCE ? 'c' : flat ? 'o' : value < q1 ? 'c' : value < q2 ? 's' : value < q3 ? 'o' : 'w'));

  // m, b, p close the lips: each letter of a word placed evenly over the word's time.
  for (const word of words) {
    const letters = [...word.text.toLowerCase()];
    letters.forEach((letter, index) => {
      if (letter !== 'm' && letter !== 'b' && letter !== 'p') return;
      const frame = Math.floor((word.start + ((word.end - word.start) * (index + 0.5)) / letters.length) * MOUTH_FPS);
      if (frame >= 0 && frame < values.length) values[frame] = 'c';
    });
  }
  holdTwoFrames(values);
  return values.join('');
}

function inSpeech(words: readonly MouthWord[], t: number): boolean {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (t >= word.start && t <= word.end) return true;
    const next = words[index + 1];
    if (next && t > word.end && t < next.start && next.start - word.end <= SPEECH_GAP) return true;
  }
  return false;
}

// Whether a sidecar's mouth is an envelope (letters c s o w only).
export const isMouth = (value: unknown): value is string => typeof value === 'string' && /^[csow]*$/.test(value);
