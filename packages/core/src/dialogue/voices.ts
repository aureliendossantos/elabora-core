// The voice of each line of a screen's dialogues in the course data (D61): the line's audio in the
// package when the build ships it (one file per line and language), its length, when each word is
// said (aligned, or placed along the line) and the mouth's envelope; without audio, the estimate the
// player would make (@elabora/player character/ textVoice): the core's length, the words placed in
// proportion to the text, the mouth drawn from its letters.

import type { LineVoiceData } from '@elabora/player/dialogue/types';
import { textVoice } from '@elabora/player/character/voice';
import { narrationLines } from '../narration/narration.ts';
import type { NarrationLineInfo } from '../narration/narration.ts';
import { lineWordTimes } from '../narration/words.ts';
import { withoutDirections } from '../narration/directions.ts';
import type { Project } from '../project/model.ts';

// What the build shipped for a line: its path in the package, and the envelope it measured when the
// line's sidecar had none (D61).
export interface PackagedLineAudio {
  src: string;
  mouth?: string | null;
  // Seconds, measured on the decoded audio (the sidecar's otherwise).
  duration?: number;
}

export type PackagedLines = (screen: string, line: string) => PackagedLineAudio | undefined;

// The voice of a line of a screen's dialogues, as dialogueData asks for it (id, text as written).
export function dialogueVoices(project: Project, screen: string, { packaged, language = project.course?.language ?? '' }: { packaged?: PackagedLines; language?: string } = {}): (line: { id: string; text: string; speaker?: string }) => LineVoiceData {
  let infos: Map<string, NarrationLineInfo> | null = null;
  const infoOf = (id: string) => (infos ??= new Map((narrationLines(project, screen, language) ?? []).map((info) => [info.id, info]))).get(id);
  return ({ id, text }) => {
    const info = infoOf(id);
    // A narration without voice, or a line whose audio is not there yet: estimated from its text.
    if (!info || info.status === 'missing' || info.status === 'untranslated' || !info.duration || !info.text) return textVoice(withoutDirections(info?.text ?? text), undefined, language);
    const shipped = packaged?.(screen, id);
    const duration = shipped?.duration ?? info.duration;
    const words = lineWordTimes(info.text, duration, info.words, language);
    return {
      src: shipped?.src ?? null,
      duration,
      words: words.map((word) => [word.text, word.start, word.end]),
      mouth: shipped?.mouth ?? info.mouth ?? null,
      estimated: !shipped || words.some((word) => word.estimated)
    };
  };
}
