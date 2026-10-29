// The types of the sound tools that leave the process (the engine's protocol, the app): no import of
// Node's, so that the app's window can name them (docs/decisions.md D67).

import type { Sound } from '@elabora/format';
import type { Quota } from '@elabora/core/ai/quota';
import type { AddedSoundLine } from '@elabora/core/commands/sounds';

// « Ajouter un son » (add_sound): a sound of the library (its id), one found through Openverse
// (openverse:<uuid>) or a file (an absolute path), copied into assets/sounds/ with its sidecar.
export interface AddSoundArgs {
  from: string;
  id?: string;
  // The part kept (seconds) and a fade out at its end (seconds).
  trim?: { start: number; end: number };
  fade?: number;
  loop?: boolean;
  // For a file: what its source says.
  title?: string;
  author?: string;
  license?: string;
  url?: string;
  caption?: Record<string, string>;
  // Made by an AI service (sound generate).
  generated?: Sound['generated'];
  // A sound line saying it in a narration, placed in the same change (« Placer dans le script »).
  line?: AddedSoundLine;
}

export interface AddedSound {
  id: string;
  path: string;
  sidecar: string;
  reused: boolean;
  line?: string;
  source: string;
  license: string;
  duration: number;
}

// A sound one may add, as the sound browser lists it: from is what add_sound takes.
export interface SoundFound {
  from: string;
  title: string;
  // Its title in the author's language when the library has one (fr), else the source's.
  label: string;
  category: string | null;
  kind: 'effect' | 'ambience' | null;
  duration: number | null;
  author: string;
  license: string;
  licenseUrl: string | null;
  url: string | null;
  // library, freesound, wikimedia_audio…
  source: string;
  credit: string | null;
  caption: Record<string, string> | null;
  loop: boolean;
}

export interface SoundSearchParams {
  source: 'library' | 'openverse';
  text?: string;
  category?: string;
  kind?: 'effect' | 'ambience';
  maxDuration?: number;
  // The language titles are shown in (fr, en).
  language?: string;
}

export interface SoundEstimate {
  credits: number;
  quota: Quota | null;
  percent: number | null;
  needsApproval: boolean;
}

export interface GenerateSoundParams {
  prompt: string;
  duration?: number; // 0.5 to 30 s; without it, ElevenLabs chooses
  loop?: boolean;
  influence?: number; // 0 to 1: how closely it follows the description (default 0.3)
  id?: string;
  caption?: Record<string, string>;
  approvedPercent?: number;
}

export interface GeneratedSound extends AddedSound {
  credits: number | null;
  estimatedCredits: number;
  percent: number | null;
  cached: boolean;
  change: { seq: number } | null;
}
