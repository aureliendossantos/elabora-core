// The transcriber's types that leave the process (the engine's protocol names them), with no import
// of Node's, as align/types.ts: the app window's typecheck never brings Node modules.

import type { Transcript, TranscriptionService } from '@elabora/core/narration/transcript';

export type { Transcript, TranscriptionService };

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
