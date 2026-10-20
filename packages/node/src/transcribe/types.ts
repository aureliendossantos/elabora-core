// The transcriber's types that leave the process (the engine's protocol names them), with no import,
// as align/types.ts: the app window's typecheck never brings Node modules.

export interface Transcript {
  // What the recording says, as the transcriber writes it: punctuation and capitals (Parakeet,
  // ElevenLabs), numbers mostly in words.
  text: string;
  // Its words and when they are said (seconds from the start of the file): the transcriber's own,
  // coarse (80 ms steps); the word aligner times the text again when the line is written.
  words: { text: string; start: number; end: number; score?: number }[];
  transcriber: string;     // the model (parakeet-tdt-0.6b-v3@8f23f0c int8, scribe_v2…)
  duration: number;
  // Who heard it: this computer (free, nothing leaves it) or ElevenLabs (the author's quota).
  service?: TranscriptionService;
  // ElevenLabs: the share of the monthly quota it took (D30).
  percent?: number;
}

export type TranscriptionService = 'local' | 'elevenlabs';

// What can transcribe a language here: the local model (installed or its download's size) and
// whether ElevenLabs can (the author gave a key).
export interface TranscriberView {
  language: string;
  local: { model: string; installed: boolean; size: number; installing: { received: number; total: number } | null } | null;
  elevenlabs: boolean;
}

// What transcribing a recording with ElevenLabs would take of the author's monthly quota (D30): its
// length, the credits expected, the share (null when the quota cannot be read) and whether the author
// must approve it first (from 1 %).
export interface TranscriptionEstimate {
  seconds: number;
  credits: number;
  percent: number | null;
  needsApproval: boolean;
}

export type TranscribeProgress =
  | { phase: 'install'; received: number; total: number }
  | { phase: 'transcribe'; fraction: number };
