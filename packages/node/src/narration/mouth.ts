import { mouthEnvelope } from '@elabora/core/narration/mouth';
import type { MouthWord } from '@elabora/core/narration/mouth';
import { lineWordTimes } from '@elabora/core/narration/words';
import type { MediaTools } from '../media/tools.ts';
import { decodeSamples } from './tracks.ts';

// The mouth's envelope of a line's audio (@elabora/core narration/mouth.ts, D61): the audio decoded
// by ffmpeg, mono at 16 kHz, its words timed by alignment or placed along the line from its text.
// Written in the line's sidecar when its audio is (setNarrationAudio) or its words timed again
// (alignNarration), and by the build for a sidecar without one.

export const MOUTH_RATE = 16000;

export async function lineMouth(tools: MediaTools, file: string, words: readonly MouthWord[]): Promise<string> {
  return mouthEnvelope(await decodeSamples(tools, file, MOUTH_RATE), MOUTH_RATE, words);
}

// The words a line's envelope closes on: those timed, else placed in proportion to the text.
export function mouthWords(text: string | null | undefined, duration: number, timed: readonly MouthWord[] | null | undefined, language?: string): MouthWord[] {
  return text ? lineWordTimes(text, duration, timed ?? null, language) : [...(timed ?? [])];
}
