import { acquireModel, holdModel, installModel, modelBytes, modelDir, modelDownloading, modelHolders, modelInstalled, modelVersionState, removeModels } from '../../models/versions.ts';
import type { VersionedModel } from '../../models/versions.ts';
import path from 'node:path';
import { localDataRoot } from '../../data-dir.ts';
import fs from 'node:fs';
import { filesSize } from '../../models/download.ts';
import type { DownloadProgress, DownloadWording, ModelFile } from '../../models/download.ts';
import { BUNDLES as CORE_BUNDLES, bundleFor as coreBundleFor } from '@elabora/core/voice/pocket/models';
import type { PocketBundle } from '@elabora/core/voice/pocket/models';
import { VoiceError } from '../provider.ts';
import { requireLocalAi } from '../../models/platform.ts';

// The model files of Pocket TTS, downloaded once per computer on first use (never in a course or a
// repository): <local app data>/voices/pocket-tts/<bundle>/, or ELABORA_VOICE_MODELS_DIR. Every file
// is pinned to a revision and checked against its SHA-256; an interrupted download resumes
// (models/download.ts).
// ELABORA_VOICE_MODELS_URL replaces https://huggingface.co (a mirror). An author removes a language's
// model from Elabora settings (elabora voice uninstall), never while it speaks; its next use downloads
// it again.
// ELABORA_VOICE_MODELS_MANIFEST=<file.json> ({ "<bundle id>": [files] }) replaces a bundle's files, for
// tests only: the app's checks install a made-up model of the same sizes from a local server.
// The bundles and their files are the core's (@elabora/core/voice/pocket/models).

export type { ModelFile, DownloadProgress } from '../../models/download.ts';

// The core's bundles (@elabora/core/voice/pocket/models), as this computer's downloads read them.
export interface Bundle extends VersionedModel, PocketBundle {
  files: ModelFile[];
}

export const BUNDLES: readonly Bundle[] = CORE_BUNDLES;
export { ENCODERS } from '@elabora/core/voice/pocket/models';

// The bundles, with a test's made-up files (ELABORA_VOICE_MODELS_MANIFEST).
export function bundles(env: NodeJS.ProcessEnv = process.env): readonly Bundle[] {
  if (!env.ELABORA_VOICE_MODELS_MANIFEST) return BUNDLES;
  const manifest = JSON.parse(fs.readFileSync(env.ELABORA_VOICE_MODELS_MANIFEST, 'utf8')) as Record<string, ModelFile[]>;
  return BUNDLES.map((bundle) => (manifest[bundle.id] ? { ...bundle, files: manifest[bundle.id] } : bundle));
}

// A language's bundle: the course language tag or its primary subtag (fr-CA speaks French).
export const bundleFor = (language: string, env: NodeJS.ProcessEnv = process.env): Bundle | null => coreBundleFor(language, bundles(env)) as Bundle | null;

export const bundleSize = (bundle: Bundle): number => filesSize(bundle.files);

export function modelsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ELABORA_VOICE_MODELS_DIR ? path.resolve(env.ELABORA_VOICE_MODELS_DIR) : path.join(localDataRoot(), 'voices', 'pocket-tts');
}

const bundleBaseDir = (bundle: Bundle, env: NodeJS.ProcessEnv = process.env): string => path.join(modelsRoot(env), bundle.id);
export const bundleDir = (bundle: Bundle, env: NodeJS.ProcessEnv = process.env): string => modelDir(bundleBaseDir(bundle, env), bundle);
export const bundleVersionState = (bundle: Bundle, env: NodeJS.ProcessEnv = process.env) => modelVersionState(bundleBaseDir(bundle, env), bundle);
export const acquireBundle = (bundle: Bundle, signal?: AbortSignal) => acquireModel(bundleBaseDir(bundle), bundle, WORDING, signal);

export function isInstalled(bundle: Bundle, env: NodeJS.ProcessEnv = process.env): boolean {
  return modelInstalled(bundleBaseDir(bundle, env), bundle);
}

export class VoiceDownloadError extends Error {
  readonly code = 'E_VOICE_DOWNLOAD';
}

const WORDING: DownloadWording = {
  what: 'voice model', needs: 'Local voices need', fail: (message) => new VoiceDownloadError(message),
  busy: (message) => new VoiceError('E_VOICE_IN_USE', message), using: 'a generation is saying lines with it'
};

// What the model takes on this computer (0 when absent), and its download under way in any process.
export const bundleOnDisk = (bundle: Bundle, env: NodeJS.ProcessEnv = process.env): number => modelBytes(bundleBaseDir(bundle, env));
export const bundleDownloading = (bundle: Bundle, env: NodeJS.ProcessEnv = process.env) => modelDownloading(bundleBaseDir(bundle, env), bundle);
export const bundleInUse = (bundle: Bundle, env: NodeJS.ProcessEnv = process.env): boolean => modelHolders(bundleBaseDir(bundle, env)).length > 0;

// Held while lines are said with it: removing it is refused meanwhile (models/download.ts).
export const holdBundle = (bundle: Bundle, { signal, env = process.env }: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<() => void> => holdModel(bundleBaseDir(bundle, env), bundle, WORDING, signal);

// Removes the model from this computer; the bytes freed.
// partial: only what a stopped download left (kept when it is all there).
export const uninstallBundle = (bundle: Bundle, { env = process.env, partial = false }: { env?: NodeJS.ProcessEnv; partial?: boolean } = {}): Promise<number> => removeModels(bundleBaseDir(bundle, env), bundle, WORDING, partial);

// extra: files beyond the bundle's (the voice encoder, for scripts/pocket-voices.ts).
export async function installBundle(source: Bundle, { onProgress, signal, updateOnly, env = process.env, extra = [] }: { updateOnly?: boolean; onProgress?: (progress: DownloadProgress) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv; extra?: readonly ModelFile[] } = {}): Promise<string> {
  requireLocalAi();
  const bundle: Bundle = { ...source, files: [...source.files, ...extra] };
  return installModel(bundle.id, bundleBaseDir(bundle, env), bundle, env.ELABORA_VOICE_MODELS_URL || 'https://huggingface.co', WORDING, { onProgress, signal, updateOnly });
}
