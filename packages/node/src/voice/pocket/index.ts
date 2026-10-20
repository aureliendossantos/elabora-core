import fs from 'node:fs';
import { withoutDirections } from '@elabora/core/narration/directions';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Rules } from './worker.ts';
import { PocketThread } from './thread.ts';
import { acquireBundle, bundleVersionState, bundleDir, bundleDownloading, bundleFor, bundleInUse, bundleOnDisk, bundles, bundleSize, holdBundle, installBundle, isInstalled, uninstallBundle } from './models.ts';
import { VoiceError } from '../provider.ts';
import type { SynthesisRequest, SynthesisResult, VoiceInfo, VoiceProvider } from '../provider.ts';
import { localAiSupported, requireLocalAi } from '../../models/platform.ts';

// Kyutai's Pocket TTS as a voice provider (docs/decisions.md D25). Its voices are made once from
// recordings given for speech synthesis (packages/node/voices/pocket-tts/: sources.json by hand,
// voices.json and the voices' embeddings written by scripts/pocket-voices.ts); the model of a
// language is downloaded on first use (models.ts). The model speaks in a worker thread (thread.ts),
// one at a time in memory, freed after two idle minutes.

export interface CatalogueVoice extends Omit<VoiceInfo, 'provider'> {
  bundle: string;
  file: string;      // embeddings, float16, frames × 1024, relative to the catalogue
  frames: number;
  sha256: string;
}

export const CATALOGUE_DIR = fileURLToPath(new URL('../../../voices/pocket-tts/', import.meta.url));

let catalogue: CatalogueVoice[] | null = null;

export function pocketCatalogue(): CatalogueVoice[] {
  if (!catalogue) {
    const file = path.join(CATALOGUE_DIR, 'voices.json');
    catalogue = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { voices: CatalogueVoice[] }).voices : [];
  }
  return catalogue;
}

// Kyutai's pocket_tts/config/<bundle>.yaml: characters absent from the training data.
const RULES: Readonly<Record<string, Rules>> = {
  french_24l: {
    replaceCharacters: { '"': '', '“': '', '”': '', '„': '', '«': '', '»': '', '’': "'", '‘': "'", ':': ',', '(': '', ')': '', '[': '', ']': '' }
  },
  'english_2026-04': { replaceCharacters: {} }
};

// Temperature 0.5: measured on French voices made from recordings, fewer failed takes than
// Kyutai's 0.3 (some voices fall silent) and fewer slips than 0.7.
export const DEFAULT_TEMPERATURE = 0.5;

const primary = (language: string) => language.toLowerCase().split('-')[0];

const number = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

class PocketProvider implements VoiceProvider {
  readonly id = 'pocket-tts';
  readonly name = 'Pocket TTS (Kyutai)';
  private thread = new PocketThread();
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  voices(language?: string): VoiceInfo[] {
    return pocketCatalogue()
      .filter((voice) => !language || voice.language === primary(language))
      .map(({ bundle: _bundle, file: _file, frames: _frames, sha256: _sha256, ...voice }) => ({ ...voice, provider: this.id }));
  }

  status(language: string) {
    const bundle = bundleFor(language);
    if (!bundle || !pocketCatalogue().some((voice) => voice.bundle === bundle.id)) return null;
    const installed = isInstalled(bundle);
    const download = bundleSize(bundle);
    return { ...bundleVersionState(bundle), installed, supported: localAiSupported(), size: installed ? 0 : download, onDisk: installed ? bundleOnDisk(bundle) : 0, download, installing: bundleDownloading(bundle), inUse: bundleInUse(bundle) };
  }

  model(language: string) {
    const bundle = bundleFor(language);
    return bundle ? { id: bundle.id, model: bundle.model } : null;
  }

  #bundle(language: string) {
    const bundle = bundleFor(language);
    if (!bundle) throw new VoiceError('E_VOICE_LANGUAGE', `Pocket TTS has no voice in ${language} (it speaks ${bundles().map((b) => b.language).join(', ')}).`);
    return bundle;
  }

  async install(language: string, { onProgress, signal, force, updateOnly }: { updateOnly?: boolean; onProgress?: (progress: { received: number; total: number; file?: string }) => void; signal?: AbortSignal; force?: boolean } = {}) {
    requireLocalAi();
    const bundle = this.#bundle(language);
    if (force) await this.uninstall(language);
    await installBundle(bundle, { signal, updateOnly, onProgress: (progress) => onProgress?.({ received: progress.received, total: progress.total, file: progress.file }) });
  }

  // Refused while lines are said with it (here or in another process); the model this process keeps
  // in memory between lines is freed first, so that no file of it is still open.
  async uninstall(language: string, { partial }: { partial?: boolean } = {}) {
    const bundle = this.#bundle(language);
    // Held (a generation between two lines): refused below, the model left in memory for its next line.
    if (!this.#saying && !bundleInUse(bundle)) {
      if (this.idle) { clearTimeout(this.idle); this.idle = null; }
      await this.thread.release();
    }
    return { freed: await uninstallBundle(bundle, { partial }) };
  }

  hold(language: string, signal?: AbortSignal) {
    requireLocalAi();
    return holdBundle(this.#bundle(language), { signal });
  }

  synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    // One synthesis at a time: one model in memory, and each already uses four cores.
    const run = this.queue.then(() => this.run(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  #saying = 0;

  private async run(request: SynthesisRequest): Promise<SynthesisResult> {
    requireLocalAi();
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    this.#saying++;
    let release: (() => void) | null = null;
    try {
      const voice = pocketCatalogue().find((v) => v.id === request.voice);
      if (!voice) throw new VoiceError('E_VOICE_UNKNOWN', `Pocket TTS has no voice "${request.voice}" (elabora voice list).`);
      if (voice.language !== primary(request.language)) throw new VoiceError('E_VOICE_LANGUAGE', `The voice "${voice.id}" speaks ${voice.language}, not ${request.language}.`);
      const bundle = bundles().find((b) => b.id === voice.bundle);
      if (!bundle) throw new VoiceError('E_VOICE_UNKNOWN', `The voice "${voice.id}" needs the model ${voice.bundle}, which this version of Elabora does not know.`);
      // Held while it speaks, so that it is not removed under it (a generation holds it longer).
      if (!isInstalled(bundle)) await installBundle(bundle, { signal: request.signal });
      const active = await acquireBundle(bundle, request.signal);
      release = active.release;
      const temperature = number(request.settings.temperature, DEFAULT_TEMPERATURE, 0.05, 1);
      const { samples, sampleRate, retries } = await this.thread.synthesize({
        dir: active.dir, voice: voice.id, voiceFile: path.join(CATALOGUE_DIR, voice.file), text: withoutDirections(request.text), temperature, seed: request.seed, rules: RULES[bundle.id] ?? { replaceCharacters: {} }
      }, { signal: request.signal, onProgress: request.onProgress });
      return {
        samples, sampleRate, model: active.model, retries,
        credit: voice.credit[primary(request.language)] ?? voice.credit.en ?? Object.values(voice.credit)[0] ?? '',
        settings: { temperature }
      };
    } finally {
      release?.();
      this.#saying--;
      this.idle = setTimeout(() => { void this.thread.release(); }, 120_000);
      this.idle.unref();
    }
  }

  async dispose() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    await this.queue;
    await this.thread.dispose();
  }
}

export const pocketProvider: VoiceProvider = new PocketProvider();

// Read by tests and scripts from here as before.
export { readEmbeddings } from './runtime.ts';
