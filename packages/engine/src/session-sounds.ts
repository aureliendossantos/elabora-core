import type { Author } from '@elabora/core/ops/types';
import type { Project } from '@elabora/core/project/model';
import { courseSounds } from '@elabora/core/sounds/sounds';
import type { CourseSound } from '@elabora/core/sounds/sounds';
import { searchSounds, soundPreview } from '@elabora/node/sounds/search';
import { OpenverseError } from '@elabora/node/sounds/openverse';
import { estimateSound, generateSoundWith } from '@elabora/node/sounds/generate';
import type { GenerateSoundParams, GeneratedSound, SoundEstimate, SoundFound, SoundSearchParams } from '@elabora/node/sounds/types';
import { EngineError } from './errors.ts';
import type { Session } from './session.ts';

// The sounds of an editing session (docs/decisions.md D67): what the sound browser searches and hears
// (« Sons courants », Openverse), the module's own sounds with their sidecars, and a sound made with
// ElevenLabs, added through the session's queue (add_sound) as one change ⌘Z undoes.

const SOURCES = ['library', 'openverse'] as const;

export class SessionSounds {
  readonly #project: () => Project;
  readonly #run: Session['run'];
  readonly #assertOpen: () => void;

  constructor(init: { project: () => Project; run: Session['run']; assertOpen: () => void }) {
    this.#project = init.project;
    this.#run = init.run;
    this.#assertOpen = init.assertOpen;
  }

  async soundSearch(params: SoundSearchParams): Promise<{ sounds: SoundFound[] }> {
    this.#assertOpen();
    if (!SOURCES.includes(params?.source)) throw new EngineError('bad-request', 'soundSearch takes source: library or openverse');
    try {
      return { sounds: await searchSounds(params) };
    } catch (error) { throw soundError(error); }
  }

  async soundPreview({ from }: { from: string }): Promise<{ audio: Uint8Array; type: string }> {
    this.#assertOpen();
    if (typeof from !== 'string' || !from) throw new EngineError('bad-request', 'soundPreview takes from: a library id or openverse:<id>');
    try {
      return await soundPreview(from);
    } catch (error) {
      if (error instanceof OpenverseError) throw soundError(error);
      throw new EngineError('not-found', error instanceof Error ? error.message : String(error));
    }
  }

  // The module's sounds (assets/sounds/), each with its sidecar's licence, credit and uses.
  courseSounds(): CourseSound[] {
    this.#assertOpen();
    return courseSounds(this.#project());
  }

  async soundEstimate({ duration }: { duration?: number }): Promise<SoundEstimate> {
    this.#assertOpen();
    try {
      return await estimateSound(duration !== undefined ? { duration } : {});
    } catch (error) { throw soundError(error); }
  }

  async generateSound(params: GenerateSoundParams, author: Author): Promise<GeneratedSound> {
    this.#assertOpen();
    if (typeof params?.prompt !== 'string') throw new EngineError('bad-request', 'generateSound takes prompt: the sound described');
    try {
      return await generateSoundWith(params, async (request) => {
        const { signal: _signal, ...args } = request;
        const ran = await this.#run('add_sound', args, author);
        const added = ran.result as { id: string; path: string; sidecar: string; reused: boolean; source: string; license: string; duration: number };
        return { ...added, change: ran.change ? { seq: ran.change.seq } : null };
      });
    } catch (error) { throw soundError(error); }
  }
}

// Openverse's refusals and the voice service's (a key, its permission, the quota) as the protocol
// says them, with their code: the app says each in its words.
function soundError(error: unknown): unknown {
  if (error instanceof EngineError) return error;
  if (error instanceof OpenverseError) return new EngineError('not-available', error.message, { code: error.status === 429 ? 'E_SOUND_OPENVERSE_LIMIT' : 'E_SOUND_OPENVERSE' });
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E_VOICE_/.test(error.code)) {
    return new EngineError(error.code === 'E_VOICE_OFFLINE' ? 'not-available' : 'refused', error.message, { code: error.code });
  }
  return error;
}
