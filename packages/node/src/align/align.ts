// Word times of a narration line whose text is known (forced alignment; docs/decisions.md D27): the
// emissions of a wav2vec2 CTC character model and a Viterbi search for the line's characters in them
// (the WhisperX approach). Every word of narrationWords gets a start and an end in seconds from the
// start of the audio, and a score: the mean probability the model gives its characters where the
// alignment puts them (low when the voice did not say it).

import { forcedAlign, STAR } from './ctc.ts';
import type { TokenSpan } from './ctc.ts';
import { spokenWords, targetsOf } from './spoken.ts';
import type { ModelEmissions } from './wav2vec2.ts';

export interface AlignedWord {
  text: string;      // as narrationWords gives it
  start: number;     // seconds
  end: number;
  score?: number;    // 0–1; none for a word a wildcard absorbed
  said: string;      // what was aligned ("neuf heures trente"), * for a wildcard
}

export interface Alignment {
  words: AlignedWord[];
  duration: number;  // seconds of audio
}

export interface AlignVocabulary {
  vocab: Readonly<Record<string, number>>;
  blank: number;
  delimiter: number | null;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

// shifts: the model's measured lateness of starts and earliness of ends (AlignerModel).
export function alignEmissions(emissions: ModelEmissions, text: string, language: string, model: AlignVocabulary, { startShift = 0, endShift = 0 }: { startShift?: number; endShift?: number } = {}): Alignment {
  const duration = round(emissions.frames * emissions.frameSeconds);
  const words = spokenWords(text, language);
  if (!words.length) return { words: [], duration };
  const { targets, said } = targetsOf(words, model.vocab, model.delimiter);
  const path = forcedAlign(emissions, targets.map((target) => target.token), model.blank);
  const byWord: TokenSpan[][] = words.map(() => []);
  path.spans.forEach((span, i) => { if (targets[i].word >= 0) byWord[targets[i].word].push(span); });
  const f = emissions.frameSeconds;
  const raw = words.map((word, w) => {
    const spans = byWord[w];
    const scored = spans.filter((span) => span.token !== STAR);
    return {
      text: word.text, said: said[w],
      start: Math.min(...spans.map((span) => span.start)) * f,
      end: Math.max(...spans.map((span) => span.end)) * f,
      score: scored.length && scored.length === spans.length ? scored.reduce((sum, span) => sum + span.score, 0) / scored.length : null
    };
  });
  const starts = raw.map((word) => Math.max(0, word.start + startShift));
  return {
    duration,
    words: raw.map((word, i) => {
      const start = starts[i];
      const limit = i + 1 < raw.length ? Math.max(starts[i + 1], start) : duration;
      const end = Math.min(limit, Math.max(word.end + endShift, start + f));
      return { text: word.text, start: round(start), end: round(Math.max(start, end)), ...(word.score === null ? {} : { score: round(word.score) }), said: word.said };
    })
  };
}
