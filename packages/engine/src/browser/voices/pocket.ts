// Pocket TTS in a browser (D25, D114): the catalogue's voices, read from where the host serves them
// (voices.json and each voice's embeddings, checked by their SHA-256), the model of a language kept in
// the origin's private file system (store.ts, D113), the line said in the models Worker by the core's
// model. Not on a phone, nor a language's model on a computer with too little memory for it.

import { withoutDirections } from '@elabora/core/narration/directions';
import { BUNDLES, DEFAULT_TEMPERATURE, RULES, bundleFor } from '@elabora/core/voice/pocket/models';
import type { CatalogueVoice, PocketBundle } from '@elabora/core/voice/pocket/models';
import { VoiceError } from '@elabora/core/voice/provider';
import type { SynthesisRequest, SynthesisResult, VoiceProvider } from '@elabora/core/voice/provider';
import type { InstallProgress, VoiceInfo, VoiceStatus } from '@elabora/core/voice/types';
import { sha256 } from '@elabora/core/util/sha256';
import { holdModel, installModel, modelBytes, modelInstalled, modelSize, removeModel } from '../models/store.ts';
import type { StoredModel } from '../models/store.ts';
import { onAPhone, refusal } from '../models/refusal.ts';
import type { ModelsWorker } from '../models/align.ts';

const primary = (language: string) => language.toLowerCase().split('-')[0];
const stored = (bundle: PocketBundle): PocketBundle & StoredModel => ({ ...bundle, version: bundle.version ?? 'pinned' });
const number = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export interface PocketHost {
  // Where the host serves the catalogue (packages/node/voices/pocket-tts/: voices.json, the embeddings).
  catalogue: string;
  // The models' origin the host names (C110).
  models: string;
}

export class BrowserPocket implements VoiceProvider {
  readonly id = 'pocket-tts';
  readonly name = 'Pocket TTS (Kyutai)';
  readonly #worker: ModelsWorker;
  readonly #host: PocketHost;
  #voices: CatalogueVoice[] | null = null;
  readonly #embeddings = new Map<string, Promise<Uint8Array>>();
  // What this browser keeps, read again before each request (status() answers from it).
  readonly #installed = new Map<string, boolean>();
  readonly #onDisk = new Map<string, number>();
  readonly #installing = new Map<string, { received: number; total: number }>();
  readonly #held = new Map<string, number>();

  constructor(worker: ModelsWorker, host: PocketHost) {
    this.#worker = worker;
    this.#host = host;
  }

  // The catalogue and what is kept, read before the synchronous calls of a request answer from them.
  async ready(): Promise<void> {
    if (!this.#voices) {
      const response = await fetch(new URL('voices.json', this.#base()), { credentials: 'omit' }).catch(() => null);
      if (!response?.ok) throw new VoiceError('E_VOICE_RUNTIME', `The local voices' catalogue could not be read (${response ? response.status : 'offline'}).`);
      this.#voices = ((await response.json()) as { voices: CatalogueVoice[] }).voices;
    }
    for (const bundle of BUNDLES) await this.#refresh(bundle);
  }

  #base = () => (this.#host.catalogue.endsWith('/') ? this.#host.catalogue : `${this.#host.catalogue}/`);

  async #refresh(bundle: PocketBundle): Promise<boolean> {
    const installed = await modelInstalled(stored(bundle));
    this.#installed.set(bundle.id, installed);
    this.#onDisk.set(bundle.id, installed ? modelSize(stored(bundle)) : await modelBytes(stored(bundle)));
    return installed;
  }

  #catalogue(): CatalogueVoice[] {
    return this.#voices ?? [];
  }

  voices(language?: string): VoiceInfo[] {
    return this.#catalogue()
      .filter((voice) => !language || voice.language === primary(language))
      .map(({ bundle: _bundle, file: _file, frames: _frames, sha256: _sha256, ...voice }) => ({ ...voice, provider: this.id }));
  }

  status(language: string): VoiceStatus | null {
    const bundle = bundleFor(language);
    if (!bundle || !this.#catalogue().some((voice) => voice.bundle === bundle.id)) return null;
    const installed = this.#installed.get(bundle.id) ?? false;
    const download = modelSize(stored(bundle));
    return { installed, supported: !onAPhone(), size: installed ? 0 : download, onDisk: this.#onDisk.get(bundle.id) ?? 0, download, installing: this.#installing.get(bundle.id) ?? null, inUse: (this.#held.get(bundle.id) ?? 0) > 0 };
  }

  model(language: string) {
    const bundle = bundleFor(language);
    return bundle ? { id: bundle.id, model: bundle.model } : null;
  }

  #bundle(language: string): PocketBundle {
    const bundle = bundleFor(language);
    if (!bundle) throw new VoiceError('E_VOICE_LANGUAGE', `Pocket TTS has no voice in ${language} (it speaks ${BUNDLES.map((b) => b.language).join(', ')}).`);
    const refused = refusal(bundle.language, 'Saying lines with a local voice');
    if (refused) throw refused;
    return bundle;
  }

  async install(language: string, { onProgress, signal }: { onProgress?: (progress: InstallProgress) => void; signal?: AbortSignal } = {}): Promise<void> {
    const bundle = this.#bundle(language);
    try {
      await installModel(stored(bundle), this.#host.models, { signal, onProgress: (progress) => { this.#installing.set(bundle.id, progress); onProgress?.(progress); } });
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = (error as { code?: string }).code;
      throw new VoiceError(code === 'E_LOCAL_AI_STORAGE' ? code : 'E_VOICE_DOWNLOAD', error instanceof Error ? error.message : String(error));
    } finally {
      this.#installing.delete(bundle.id);
      await this.#refresh(bundle);
    }
  }

  // Refused while lines are said with it, in any tab (Web Locks, store.ts).
  async uninstall(language: string): Promise<{ freed: number }> {
    const bundle = bundleFor(language);
    if (!bundle) throw new VoiceError('E_VOICE_LANGUAGE', `Pocket TTS has no voice in ${language}.`);
    const freed = await modelBytes(stored(bundle));
    try {
      await removeModel(stored(bundle));
    } catch (error) {
      throw new VoiceError('E_VOICE_IN_USE', error instanceof Error ? error.message : String(error));
    } finally {
      await this.#refresh(bundle);
    }
    return { freed };
  }

  // Held from a generation's first line to its last: not removed meanwhile, in any tab.
  async hold(language: string): Promise<() => void> {
    const bundle = this.#bundle(language);
    const release = await holdModel(stored(bundle));
    this.#held.set(bundle.id, (this.#held.get(bundle.id) ?? 0) + 1);
    await this.#refresh(bundle);
    let released = false;
    return () => { if (!released) { released = true; this.#held.set(bundle.id, (this.#held.get(bundle.id) ?? 1) - 1); release(); } };
  }

  async #embeddingsOf(voice: CatalogueVoice): Promise<Uint8Array> {
    let bytes = this.#embeddings.get(voice.id);
    if (!bytes) {
      bytes = (async () => {
        const response = await fetch(new URL(voice.file, this.#base()), { credentials: 'omit' }).catch(() => null);
        if (!response?.ok) throw new VoiceError('E_VOICE_RUNTIME', `The voice « ${voice.name} » could not be read (${response ? response.status : 'offline'}).`);
        const read = new Uint8Array(await response.arrayBuffer());
        if (sha256(read) !== voice.sha256) throw new VoiceError('E_VOICE_RUNTIME', `The voice « ${voice.name} » is not the one Elabora knows.`);
        return read;
      })();
      this.#embeddings.set(voice.id, bytes);
      bytes.catch(() => this.#embeddings.delete(voice.id));
    }
    return bytes;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    await this.ready();
    const voice = this.#catalogue().find((v) => v.id === request.voice);
    if (!voice) throw new VoiceError('E_VOICE_UNKNOWN', `Pocket TTS has no voice "${request.voice}".`);
    if (voice.language !== primary(request.language)) throw new VoiceError('E_VOICE_LANGUAGE', `The voice "${voice.id}" speaks ${voice.language}, not ${request.language}.`);
    const bundle = BUNDLES.find((b) => b.id === voice.bundle);
    if (!bundle) throw new VoiceError('E_VOICE_UNKNOWN', `The voice "${voice.id}" needs the model ${voice.bundle}, which this version of Elabora does not know.`);
    this.#bundle(bundle.language);
    const temperature = number(request.settings.temperature, DEFAULT_TEMPERATURE, 0.05, 1);
    const embeddings = await this.#embeddingsOf(voice);
    const say = async () => {
      if (!(await this.#refresh(bundle))) await this.install(bundle.language, { signal: request.signal });
      const { answer } = await this.#worker.ask({ op: 'speak', bundle: stored(bundle), voice: voice.id, embeddings, text: withoutDirections(request.text), temperature, seed: request.seed, rules: RULES[bundle.id] ?? { replaceCharacters: {} } }, request.signal, request.onProgress);
      request.signal?.throwIfAborted();
      if ('error' in answer) throw new VoiceError(answer.code ?? 'E_VOICE_RUNTIME', answer.error);
      if (!('samples' in answer)) throw new VoiceError('E_VOICE_RUNTIME', 'The models Worker said nothing.');
      return answer;
    };
    let said;
    try {
      said = await say();
    } catch (error) {
      // The browser erased the model meanwhile: downloaded again, then once more.
      if ((error as { code?: string }).code !== 'E_VOICE_NOT_INSTALLED') throw error;
      said = await say();
    }
    return {
      samples: said.samples, sampleRate: said.sampleRate, model: bundle.model, retries: said.retries,
      credit: voice.credit[primary(request.language)] ?? voice.credit.en ?? Object.values(voice.credit)[0] ?? '',
      settings: { temperature }
    };
  }

  async dispose(): Promise<void> {}
}
