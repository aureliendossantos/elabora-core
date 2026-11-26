// « Éléments téléchargés » in a browser (D38, D113): the models this origin downloads once and keeps
// in its private file system, the local voices (D25) and the word aligners (D27), listed, downloaded,
// stopped and removed with no session (a window's Réglages, no module open) or beside one: each is
// the same folder a session's voices and word times use (models/store.ts), and Web Locks say what
// another tab downloads or uses. The views are the desktop's (@elabora/node downloads/), ids
// included: voices-fr, aligner-en. Removing one is refused while a session uses it, in any tab.

import { BUNDLES } from '@elabora/core/voice/pocket/models';
import type { CatalogueVoice, PocketBundle } from '@elabora/core/voice/pocket/models';
import { ALIGNER_MODELS } from '@elabora/core/align/models';
import type { AlignerModel } from '@elabora/core/align/models';
import type { DownloadView } from '@elabora/core/downloads/types';
import { MODEL_CHANNEL, ModelError, installModel, keepStorage, modelBytes, modelInstalled, modelSize, removeModel, storageState, using, writing } from './models/store.ts';
import type { ModelChange, ModelProgress, StoredModel } from './models/store.ts';
import { onAPhone, refusal } from './models/refusal.ts';

export type { DownloadView } from '@elabora/core/downloads/types';

// A download as it goes (progress), or one kept or removed (changed), in any context of the origin.
export type DownloadChange = { id: string; progress: ModelProgress } | { id: string; changed: true };

export interface DownloadsHost {
  // The models' origin the host names (C110), as a session's.
  models: string;
  // Where the host serves the local voices' catalogue (voices.json): the voices a language's model
  // holds. Without it, a voices download lists no contents.
  catalogue?: string;
  // The models offered, the core's by default (a test gives small ones).
  voices?: readonly PocketBundle[];
  aligners?: readonly AlignerModel[];
}

export class DownloadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Kind {
  kind: 'voices' | 'aligner';
  model: StoredModel & { language: string; model: string };
  inUse: string; // the code of a removal refused while it is used
}

const TEXTS = {
  voices: {
    title: 'Local voices',
    serves: 'Says the narration lines with free voices made in this browser (Pocket TTS).',
    without: 'Lines are said by ElevenLabs voices or recorded; the next generation with a local voice downloads it again.'
  },
  aligner: {
    title: 'Word aligner',
    serves: 'Places each word of a line said by a local voice or recorded on its audio: the blocks and cues anchored to a word come exactly on it, and the words a voice may have swallowed are found.',
    without: 'Words are placed in proportion to the text (ElevenLabs voices give their own times); the next alignment downloads it again.'
  }
} as const;

export class BrowserDownloads {
  readonly #host: DownloadsHost;
  readonly #kinds: Kind[];
  // This context's downloads: stopped by cancel.
  readonly #running = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  readonly #progress = new Map<string, ModelProgress>();
  #catalogue: Promise<CatalogueVoice[]> | null = null;
  #storage: Promise<boolean> | null = null;

  constructor(host: DownloadsHost) {
    this.#host = host;
    const voices = (host.voices ?? BUNDLES).map((bundle): Kind => ({ kind: 'voices', model: { ...bundle, version: bundle.version ?? 'pinned' }, inUse: 'E_VOICE_IN_USE' }));
    const aligners = (host.aligners ?? ALIGNER_MODELS).map((model): Kind => ({ kind: 'aligner', model, inUse: 'E_ALIGN_IN_USE' }));
    this.#kinds = [...voices.sort((a, b) => a.model.language.localeCompare(b.model.language)), ...aligners.sort((a, b) => a.model.language.localeCompare(b.model.language))];
  }

  // Every download, or those of a kind or a language (its primary subtag).
  async list({ kind, language }: { kind?: string; language?: string } = {}): Promise<DownloadView[]> {
    const primary = language?.toLowerCase().split('-')[0];
    const supported = !onAPhone() && await this.#kept();
    const [catalogue, locks] = await Promise.all([this.#voices(), navigator.locks.query()]);
    const held = new Set((locks.held ?? []).flatMap((lock) => (lock.name ? [lock.name] : [])));
    const views: DownloadView[] = [];
    for (const entry of this.#kinds) {
      if ((kind && entry.kind !== kind) || (primary && entry.model.language !== primary)) continue;
      views.push(await this.#view(entry, supported, held, catalogue));
    }
    return views;
  }

  async #view(entry: Kind, supported: boolean, held: Set<string>, catalogue: CatalogueVoice[]): Promise<DownloadView> {
    const { model } = entry;
    const installed = supported && await modelInstalled(model);
    const download = modelSize(model);
    const downloading = held.has(writing(model));
    const contents = entry.kind === 'voices' ? catalogue.filter((voice) => voice.bundle === model.id).map(({ id, name, gender }) => ({ id, name, ...(gender ? { gender } : {}) })) : undefined;
    return {
      id: `${entry.kind}-${model.language}`, kind: entry.kind, ...TEXTS[entry.kind], language: model.language, model: model.model,
      ...(contents ? { contents } : {}), supported, installed,
      size: download, download,
      installing: downloading ? this.#progress.get(model.id) ?? { received: supported ? await modelBytes(model) : 0, total: download } : null,
      inUse: held.has(using(model))
    };
  }

  // Downloaded (force: removed first, as a removal is refused); its progress here and on the channel.
  async install(id: string, { force = false, signal, onProgress }: { force?: boolean; signal?: AbortSignal; onProgress?: (progress: ModelProgress) => void } = {}): Promise<DownloadView> {
    const entry = this.#find(id);
    const refused = refusal(entry.model.language, entry.kind === 'voices' ? 'Saying lines with a local voice' : 'Timing words');
    if (refused) throw refused;
    if (!(await this.#kept())) throw new ModelError('E_LOCAL_AI_STORAGE', 'This browser keeps no files for this site (a private window?): the models cannot be downloaded.');
    if (force) await this.uninstall(id);
    const controller = new AbortController();
    const stop = () => controller.abort(signal!.reason);
    signal?.addEventListener('abort', stop, { once: true });
    const done = installModel(entry.model, this.#host.models, { signal: controller.signal, onProgress: (progress) => { this.#progress.set(entry.model.id, progress); onProgress?.(progress); } });
    this.#running.set(id, { controller, done: done.catch(() => {}) });
    try {
      await done;
    } finally {
      signal?.removeEventListener('abort', stop);
      this.#running.delete(id);
      this.#progress.delete(entry.model.id);
    }
    return (await this.list()).find((view) => view.id === id)!;
  }

  // This context's download stopped; what it left removed, unless preserve (the next one goes on from it).
  async cancel(id: string, { preserve = false }: { preserve?: boolean } = {}): Promise<{ cancelled: boolean }> {
    const entry = this.#find(id);
    const running = this.#running.get(id);
    if (!running) return { cancelled: false };
    running.controller.abort(new DOMException('The download was stopped.', 'AbortError'));
    await running.done;
    if (!preserve && !(await modelInstalled(entry.model))) await removeModel(entry.model).catch(() => {});
    return { cancelled: true };
  }

  // Removed, with the bytes it freed; refused while a session uses it or it is being downloaded.
  async uninstall(id: string): Promise<{ freed: number }> {
    const entry = this.#find(id);
    const freed = await modelBytes(entry.model);
    try {
      await removeModel(entry.model);
    } catch (error) {
      if (error instanceof ModelError && error.code === 'E_MODEL_IN_USE') throw new DownloadError(entry.inUse, error.message);
      throw error;
    }
    return { freed };
  }

  // What the browser lets this site keep, and whether for good.
  storage(): Promise<{ used: number; quota: number; persisted: boolean }> {
    return storageState();
  }

  // Asked of the browser, from a window: kept for good, or not.
  keep(): Promise<boolean> {
    return keepStorage();
  }

  // The downloads' changes, from every context of the origin (a session's own downloads included).
  onChange(listener: (change: DownloadChange) => void): () => void {
    const channel = new BroadcastChannel(MODEL_CHANNEL);
    const ids = new Map(this.#kinds.map((entry) => [entry.model.id, `${entry.kind}-${entry.model.language}`]));
    channel.onmessage = ({ data }: MessageEvent<ModelChange>) => {
      const id = ids.get(data?.model);
      if (!id) return;
      listener('progress' in data ? { id, progress: data.progress } : { id, changed: true });
    };
    return () => channel.close();
  }

  #find(id: string): Kind {
    const entry = this.#kinds.find((one) => `${one.kind}-${one.model.language}` === id);
    if (!entry) throw new DownloadError('E_DOWNLOAD_UNKNOWN', `No optional download "${id}" (${this.#kinds.map((one) => `${one.kind}-${one.model.language}`).join(', ')}).`);
    return entry;
  }

  // Whether this origin keeps files (a private window of Safari does not).
  #kept(): Promise<boolean> {
    this.#storage ??= navigator.storage.getDirectory().then(() => true, () => false);
    return this.#storage;
  }

  #voices(): Promise<CatalogueVoice[]> {
    if (!this.#host.catalogue) return Promise.resolve([]);
    const base = this.#host.catalogue.endsWith('/') ? this.#host.catalogue : `${this.#host.catalogue}/`;
    this.#catalogue ??= fetch(new URL('voices.json', new URL(base, location.href)), { credentials: 'omit' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return ((await response.json()) as { voices: CatalogueVoice[] }).voices;
      })
      // Read again next time.
      .catch(() => { this.#catalogue = null; return []; });
    return this.#catalogue;
  }
}
