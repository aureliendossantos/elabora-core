import { localVoices, uninstallVoices, voiceProviders } from '../voice/index.ts';
import type { VoiceGender } from '../voice/types.ts';
import { alignerVersionState, alignerDownloading, alignerFor, alignerHolders, alignerInstalled, alignerInUse, alignerModels, alignerOnDisk, alignerSize, installAligner, uninstallAligner } from '../align/models.ts';
import { disposeAligner } from '../align/index.ts';
import { transcriberVersionState, installTranscriber, transcriberDownloading, transcriberHolders, transcriberInstalled, transcriberInUse, transcriberModels, transcriberOnDisk, transcriberSize, uninstallTranscriber } from '../transcribe/models.ts';
import { disposeTranscriber } from '../transcribe/index.ts';
import type { DownloadView } from './types.ts';
import { localAiSupported, requireLocalAi } from '../models/platform.ts';

// Optional downloads (docs/decisions.md D38): what Elabora downloads once per computer on first use and
// keeps out of every course: the local voices' models (D25), the word aligners (D27), the transcriber
// (D46), and whatever comes next. Each kind registers here with what it is for, what happens without
// it, its downloads (by language or not), their state (on this computer with its size on disk, or the
// size to download; a download under way in any process; in use) and how to install and remove one.
// Elabora's settings list them all, the command line (elabora downloads) and agents (elabora_downloads)
// too. Removing one is refused while it is in use, in any process, and never touches what modules
// already contain: the next use downloads it again.

export type { DownloadView } from './types.ts';

export interface DownloadInstallOptions {
  updateOnly?: boolean;
  force?: boolean;             // removed first (refused as a removal is), then downloaded again
  signal?: AbortSignal;
  onProgress?: (progress: { received: number; total: number }) => void;
}

export interface DownloadKind {
  kind: string;                // the ids' prefix: voices, aligner, transcriber
  title: string;               // « Local voices », in English (the app has its own words by kind)
  serves: string;              // what it is for
  without: string;             // what happens without it
  // Its downloads: one per language, or one (language null).
  list(): Omit<DownloadView, 'id' | 'kind' | 'title' | 'serves' | 'without'>[];
  install(language: string | null, options: DownloadInstallOptions): Promise<void>;
  // The bytes freed; refused with an E_…_IN_USE code while it is used or downloaded. partial: only
  // what a stopped download left, kept when it is all there (another process finished it meanwhile).
  uninstall(language: string | null, options?: { partial?: boolean }): Promise<number>;
}

export class DownloadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const kinds = new Map<string, DownloadKind>();

export function registerDownloadKind(kind: DownloadKind): void {
  kinds.set(kind.kind, kind);
}

export const downloadKinds = (): DownloadKind[] => [...kinds.values()];

const idOf = (kind: string, language: string | null) => (language ? `${kind}-${language}` : kind);

// Every optional download, by kind in the order they registered then by language code, or those of a kind or a language
// (its primary subtag: fr-CA lists fr).
export function optionalDownloads({ kind, language }: { kind?: string; language?: string } = {}): DownloadView[] {
  const primary = language?.toLowerCase().split('-')[0];
  return downloadKinds()
    .filter((entry) => !kind || entry.kind === kind)
    .flatMap((entry) => entry.list()
      .filter((view) => !primary || view.language === primary)
      .sort((a, b) => (a.language ?? '').localeCompare(b.language ?? ''))
      .map((view) => ({ id: idOf(entry.kind, view.language), kind: entry.kind, title: entry.title, serves: entry.serves, without: entry.without, ...view,
        ...(['voices', 'aligner', 'transcriber'].includes(entry.kind) ? { supported: localAiSupported() } : {}) })));
}

function find(id: string): { kind: DownloadKind; view: DownloadView } {
  const view = optionalDownloads().find((candidate) => candidate.id === id);
  if (!view) throw new DownloadError('E_DOWNLOAD_UNKNOWN', `No optional download "${id}" (elabora downloads list: ${optionalDownloads().map((candidate) => candidate.id).join(', ')}).`);
  return { kind: kinds.get(view.kind)!, view };
}

export async function installDownload(id: string, options: DownloadInstallOptions = {}): Promise<DownloadView> {
  const { kind, view } = find(id);
  if (view.supported === false) requireLocalAi();
  await kind.install(view.language, options);
  return find(id).view;
}

export async function uninstallDownload(id: string, options: { partial?: boolean } = {}): Promise<{ id: string; freed: number }> {
  const { kind, view } = find(id);
  return { id, freed: await kind.uninstall(view.language, options) };
}

// ── the first kinds ──────────────────────────────────────────────────

// The local voices (D25): each language's model of the voice providers that download one.
const localProviders = (language: string) => voiceProviders().filter((provider) => !provider.paid && provider.uninstall && provider.status(language));

registerDownloadKind({
  kind: 'voices',
  title: 'Local voices',
  serves: 'Says the narration lines with free voices made on this computer (Pocket TTS).',
  without: 'Lines are said by ElevenLabs voices or recorded; the next generation with a local voice downloads it again.',
  list: () => localVoices().map(({ language, model, voices, installed, size, download, installing, inUse, installedVersion, desiredVersion, update }) => ({
    language, model, ...(update ? { installedVersion, desiredVersion, update } : {}), contents: voices.map(({ id, name, gender }) => ({ id, name, ...(gender ? { gender: gender as VoiceGender } : {}) })), installed, size, download, installing, inUse
  })),
  async install(language, { force, signal, onProgress, updateOnly }) {
    for (const provider of localProviders(language!)) await provider.install(language!, { force, signal, updateOnly, onProgress: (p) => onProgress?.({ received: p.received, total: p.total }) });
  },
  uninstall: async (language, options) => (await uninstallVoices(language!, options)).freed
});

// The word aligners (D27): a model per language that places each word of a voiced line on its audio.
registerDownloadKind({
  kind: 'aligner',
  title: 'Word aligner',
  serves: 'Places each word of a line said by a local voice or recorded on its audio: the blocks and cues anchored to a word come exactly on it, the words a voice may have swallowed are found, and a recording without its text gets a draft of it.',
  without: 'Words are placed in proportion to the text (ElevenLabs voices give their own times); the next alignment downloads it again.',
  list: () => alignerModels().map((model) => {
    const installed = alignerInstalled(model);
    return { ...alignerVersionState(model), language: model.language, model: model.model, installed, size: installed ? alignerOnDisk(model) : alignerSize(model), download: alignerSize(model), installing: alignerDownloading(model), inUse: alignerInUse(model) };
  }),
  async install(language, { force, signal, onProgress, updateOnly }) {
    const model = alignerFor(language!)!;
    if (force) await this.uninstall(language);
    await installAligner(model, { signal, updateOnly, onProgress: (p) => onProgress?.({ received: p.received, total: p.total }) });
  },
  async uninstall(language, options) {
    const model = alignerFor(language!)!;
    // The aligners' process (one for every language) keeps its model open between alignments: stopped
    // first, unless this process is aligning in any language.
    if (!alignerModels().some((other) => alignerHolders(other).includes(process.pid))) await disposeAligner();
    return uninstallAligner(model, { partial: options?.partial });
  }
});

// The transcriber (D46): one model for 25 European languages that writes what a recording says.
registerDownloadKind({
  kind: 'transcriber',
  title: 'Transcription',
  serves: 'Writes what a recording says, on this computer: the text of a line made from an audio file, or of a line whose recording says something else.',
  without: 'Lines made from a recording get their text typed, or from ElevenLabs with your key; the next transcription downloads it again.',
  list: () => transcriberModels().map((model) => {
    const installed = transcriberInstalled(model);
    return { ...transcriberVersionState(model), language: null, model: model.model, installed, size: installed ? transcriberOnDisk(model) : transcriberSize(model), download: transcriberSize(model), installing: transcriberDownloading(model), inUse: transcriberInUse(model) };
  }),
  async install(_language, { force, signal, onProgress, updateOnly }) {
    if (force) await this.uninstall(null);
    for (const model of transcriberModels()) await installTranscriber(model, { signal, updateOnly, onProgress: (p) => onProgress?.({ received: p.received, total: p.total }) });
  },
  async uninstall(_language, options) {
    let freed = 0;
    for (const model of transcriberModels()) {
      // Its process keeps the model open between transcriptions: stopped first, unless this process transcribes.
      if (!transcriberHolders(model).includes(process.pid)) await disposeTranscriber();
      freed += await uninstallTranscriber(model, { partial: options?.partial });
    }
    return freed;
  }
});
