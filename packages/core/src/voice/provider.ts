// Voice providers (docs/decisions.md D25): what makes the audio of a narration line from its text.
// The first is local and free, Kyutai's Pocket TTS run on the author's computer (voice/pocket/); the
// second a paid service with the author's own key, ElevenLabs (D29), whose thousands of voices are
// searched rather than listed and whose generations cost credits. A provider lists its voices, says
// whether its model is here and how much it weighs, installs it, and says a text. The course names a
// voice per speaker and language: course.json speakers[].voices[<lang>] = { provider, voice, settings }.
// Each host gives its own providers (the desktop's processes, a browser's Workers) to a registry.

import type { Quota } from '../ai/quota.ts';
import type { VoiceInfo, VoiceStatus, InstallProgress, VoiceQuery, VoiceSearchResult, VoiceAccount } from './types.ts';

export interface SynthesisRequest {
  text: string;                  // what to say: the line's text after its pronunciations (spokenText)
  voice: string;
  language: string;
  settings: Readonly<Record<string, unknown>>;
  seed: number;                  // the same seed says it the same way on this computer
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  // The lines said before and after it, for a voice that carries the tone over (ElevenLabs).
  context?: { before?: string; after?: string };
  voiceName?: string;            // a voice service's voice as course.json names it (its credit)
}

// Lines of several speakers said as one exchange (D29), each turn its own voice.
export interface DialogueRequest {
  turns: { text: string; voice: string; voiceName?: string }[];
  language: string;
  settings: Readonly<Record<string, unknown>>;
  seed: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  // Where each turn's words are in the exchange's audio (a word aligner finds them, in seconds), or null
  // when none can: the exchange is then cut where the service's times say, which can run ahead of its audio.
  hear?: (exchange: { samples: Float32Array; sampleRate: number }) => Promise<{ start: number; end: number }[] | null>;
}

export interface DialogueResult {
  sampleRate: number;
  // Each turn cut from the exchange: its audio, its words, where it started in the exchange, the
  // silence before it there, and whether the next speaker cut in.
  lines: { samples: Float32Array; words: { text: string; start: number; end: number }[]; start: number; gap: number; interrupted: boolean }[];
  model: string;
  credits: string[];
  cached: boolean;
  cost?: number | null;          // credits the service charged (0 from the cache; null: it did not say)
}

export interface SynthesisResult {
  samples: Float32Array;         // mono PCM, -1 to 1
  sampleRate: number;
  model: string;                 // recorded in the sidecar, information only
  credit: string;                // for the module credits, in the language spoken
  words?: { text: string; start: number; end: number }[];
  retries: number;               // parts the provider had to say again (failed takes it caught)
  settings: Readonly<Record<string, unknown>>; // the settings it applied (unknown ones dropped)
  cached?: boolean;              // a paid request answered from this computer's cache
  cost?: number | null;          // credits the service charged (0 from the cache; null: it did not say)
}

export interface VoiceProvider {
  readonly id: string;
  readonly name: string;
  voices(language?: string): VoiceInfo[];
  // null: the provider has no voice in that language.
  status(language: string): VoiceStatus | null;
  // force: the model removed first (refused as uninstall is), then downloaded again: a reinstall.
  install(language: string, options?: { onProgress?: (progress: InstallProgress) => void; signal?: AbortSignal; force?: boolean; updateOnly?: boolean }): Promise<void>;
  // A model downloaded on this computer (local voices): what it is, removed (refused with
  // E_VOICE_IN_USE while lines are said with it or it is downloaded, in any process; the lines
  // already made stay in their modules, and the next use downloads it again), and held by a
  // generation from its first line to its last.
  model?(language: string): { id: string; model: string } | null;
  // partial: only what a stopped download left (kept when it is all there).
  uninstall?(language: string, options?: { partial?: boolean }): Promise<{ freed: number }>;
  hold?(language: string, signal?: AbortSignal): Promise<() => void>;
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
  // Frees the model held in memory (a long-lived process calls it when idle, a command at its end).
  dispose(): Promise<void>;
  // A voice service (D29): its voices are found by searching and looked up by id, any of them speaks
  // every language of its model, and a generation costs credits of the author's account.
  readonly paid?: boolean;
  search?(query: VoiceQuery, signal?: AbortSignal): Promise<VoiceSearchResult>;
  lookup?(id: string, signal?: AbortSignal): Promise<VoiceInfo | null>;
  // The plan and its quota (key: a key to check before it is kept, else the one in use).
  account?(options?: { signal?: AbortSignal; check?: boolean; key?: string }): Promise<VoiceAccount>;
  // What saying a text costs before anything is spent: about (credits) and at most (ceiling).
  estimate?(text: string, voice: string, settings: Readonly<Record<string, unknown>>): Promise<{ characters: number; credits: number; ceiling: number }>;
  // The month's quota, what this process spent included (D30: costs are told as shares of it).
  quota?(signal?: AbortSignal): Promise<Quota>;
  synthesizeDialogue?(request: DialogueRequest): Promise<DialogueResult>;
}

export class VoiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}

// Whether a voice speaks a language: its own, or any for a voice service's (its model's languages).
export const speaks = (voice: VoiceInfo, language: string): boolean => !!voice.multilingual || voice.language === language.toLowerCase().split('-')[0];

// A host's providers, by id.
export class VoiceRegistry {
  readonly #providers = new Map<string, VoiceProvider>();

  register(provider: VoiceProvider): void {
    this.#providers.set(provider.id, provider);
  }

  list(): VoiceProvider[] {
    return [...this.#providers.values()];
  }

  provider(id: string): VoiceProvider {
    const provider = this.#providers.get(id);
    if (!provider) throw new VoiceError('E_VOICE_PROVIDER', `Unknown voice provider "${id}" (known: ${[...this.#providers.keys()].join(', ') || 'none'}).`);
    return provider;
  }

  // Every voice of every provider, or those of one language (its primary subtag: fr-CA lists fr).
  voices(language?: string): VoiceInfo[] {
    return this.list().flatMap((provider) => provider.voices(language));
  }

  find(id: string, provider?: string): VoiceInfo | null {
    return this.voices().find((voice) => voice.id === id && (!provider || voice.provider === provider)) ?? null;
  }

  // A voice of any provider: listed, or looked up from its service (a voice service's voices are not listed).
  async resolve(id: string, provider?: string, signal?: AbortSignal): Promise<VoiceInfo | null> {
    const listed = this.find(id, provider);
    if (listed) return listed;
    for (const candidate of provider ? [this.provider(provider)] : this.list().filter((p) => p.lookup)) {
      const found = await candidate.lookup?.(id, signal);
      if (found) return found;
    }
    return null;
  }
}
