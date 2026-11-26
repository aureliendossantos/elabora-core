import { acquireModel, holdModel, installModel, modelBytes, modelDir, modelDownloading, modelHolders, modelInstalled, modelVersionState, removeModels } from '../models/versions.ts';
import fs from 'node:fs';
import path from 'node:path';
import { localDataRoot } from '../data-dir.ts';
import { filesSize, ModelsBusyError } from '../models/download.ts';
import type { DownloadProgress, DownloadWording, ModelFile } from '../models/download.ts';
import { requireLocalAi } from '../models/platform.ts';
import { ALIGNER_MODELS, alignerOf } from '@elabora/core/align/models';
import type { AlignerModel } from '@elabora/core/align/models';

// The word aligner's models (docs/decisions.md D27), pinned in the core (@elabora/core/align/models),
// downloaded once per computer on the first alignment in that language, into <local app data>/
// aligners/<model>/ (or ELABORA_ALIGNER_MODELS_DIR), and checked by SHA-256. ELABORA_ALIGNER_MODELS_URL
// replaces https://huggingface.co (a mirror). Listed, removed and downloaded again from Elabora settings
// like every optional download (downloads/, D38), never while words are being placed with it.
// ELABORA_ALIGNER_MODELS_MANIFEST=<file.json> ({ "<model id>": [files] }) gives a model made-up files,
// for tests only.

export { ALIGNER_MODELS } from '@elabora/core/align/models';
export type { AlignerModel } from '@elabora/core/align/models';

// The models, with a test's made-up files (ELABORA_ALIGNER_MODELS_MANIFEST).
export function alignerModels(env: NodeJS.ProcessEnv = process.env): readonly AlignerModel[] {
  if (!env.ELABORA_ALIGNER_MODELS_MANIFEST) return ALIGNER_MODELS;
  const manifest = JSON.parse(fs.readFileSync(env.ELABORA_ALIGNER_MODELS_MANIFEST, 'utf8')) as Record<string, ModelFile[]>;
  return ALIGNER_MODELS.map((model) => (manifest[model.id] ? { ...model, files: manifest[model.id] } : model));
}

// A language's aligner: the course language tag or its primary subtag (fr-CA is French).
export function alignerFor(language: string, env: NodeJS.ProcessEnv = process.env): AlignerModel | null {
  return alignerOf(language, alignerModels(env));
}

export const alignerSize = (model: AlignerModel): number => filesSize(model.files);

export function alignersRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ELABORA_ALIGNER_MODELS_DIR ? path.resolve(env.ELABORA_ALIGNER_MODELS_DIR) : path.join(localDataRoot(), 'aligners');
}

const alignerBaseDir = (model: AlignerModel, env: NodeJS.ProcessEnv = process.env): string => path.join(alignersRoot(env), model.id);
export const alignerDir = (model: AlignerModel, env: NodeJS.ProcessEnv = process.env): string => modelDir(alignerBaseDir(model, env), model);
export const alignerVersionState = (model: AlignerModel, env: NodeJS.ProcessEnv = process.env) => modelVersionState(alignerBaseDir(model, env), model);
export const acquireAligner = (model: AlignerModel, signal?: AbortSignal) => acquireModel(alignerBaseDir(model), model, WORDING, signal);

export function alignerInstalled(model: AlignerModel, env: NodeJS.ProcessEnv = process.env): boolean {
  return modelInstalled(alignerBaseDir(model, env), model);
}

export class AlignerDownloadError extends Error {
  readonly code = 'E_ALIGN_DOWNLOAD';
}

const WORDING: DownloadWording = {
  what: 'word aligner model', needs: 'Word timing needs', fail: (message) => new AlignerDownloadError(message),
  busy: (message) => new ModelsBusyError('E_ALIGN_IN_USE', message), using: 'words are being placed with it'
};

export function installAligner(model: AlignerModel, { onProgress, signal, updateOnly, env = process.env }: { updateOnly?: boolean; onProgress?: (progress: DownloadProgress) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  requireLocalAi();
  return installModel(model.id, alignerBaseDir(model, env), model, env.ELABORA_ALIGNER_MODELS_URL || 'https://huggingface.co', WORDING, { onProgress, signal, updateOnly });
}

// What it takes on this computer, its download under way in any process, whether words are being
// placed with it (models/download.ts).
export const alignerOnDisk = (model: AlignerModel, env: NodeJS.ProcessEnv = process.env): number => modelBytes(alignerBaseDir(model, env));
export const alignerDownloading = (model: AlignerModel, env: NodeJS.ProcessEnv = process.env) => modelDownloading(alignerBaseDir(model, env), model);
export const alignerHolders = (model: AlignerModel, env: NodeJS.ProcessEnv = process.env): number[] => modelHolders(alignerBaseDir(model, env));
export const alignerInUse = (model: AlignerModel, env: NodeJS.ProcessEnv = process.env): boolean => alignerHolders(model, env).length > 0;
export const holdAligner = (model: AlignerModel, { signal, env = process.env }: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<() => void> => holdModel(alignerBaseDir(model, env), model, WORDING, signal);
// partial: only what a stopped download left (kept when it is all there).
export const uninstallAligner = (model: AlignerModel, { env = process.env, partial = false }: { env?: NodeJS.ProcessEnv; partial?: boolean } = {}): Promise<number> => removeModels(alignerBaseDir(model, env), model, WORDING, partial);
