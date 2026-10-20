import { acquireModel, holdModel, installModel, modelBytes, modelDir, modelDownloading, modelHolders, modelInstalled, modelVersionState, removeModels } from '../models/versions.ts';
import type { VersionedModel } from '../models/versions.ts';
import fs from 'node:fs';
import path from 'node:path';
import { localDataRoot } from '../data-dir.ts';
import { filesSize, ModelsBusyError } from '../models/download.ts';
import type { DownloadProgress, DownloadWording, ModelFile } from '../models/download.ts';
import { requireLocalAi } from '../models/platform.ts';

// The transcriber's model (docs/decisions.md D46): NVIDIA's Parakeet TDT 0.6B v3 (CC-BY-4.0), one
// model for 25 European languages, with punctuation and capitals, as Ilya Stupakov's ONNX export for
// onnx-asr (its encoder quantized to int8, its decoder and joint network, NeMo's 128-band mel
// features as a graph), pinned at revision 8f23f0c. Downloaded once per computer on the first
// transcription into <local app data>/transcribers/<model>/ (or ELABORA_TRANSCRIBER_MODELS_DIR),
// checked by SHA-256, resumed, listed and removed in Elabora settings as every optional download
// (downloads/, D38), never while it transcribes. ELABORA_TRANSCRIBER_MODELS_URL replaces
// https://huggingface.co (a mirror); ELABORA_TRANSCRIBER_MODELS_MANIFEST=<file.json> ({ "<model id>":
// [files] }) gives it made-up files, for tests only.

export interface TranscriberModel extends VersionedModel {
  id: string;                 // its folder
  model: string;              // what Elabora records as the transcriber
  languages: readonly string[]; // primary language subtags it transcribes
  credit: string;             // the model and its licence (notices)
  files: ModelFile[];
}

// Elabora's mirror, in its Hugging Face organization, of istupakov/parakeet-tdt-0.6b-v3-onnx at
// 8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce: an individual's repository, copied byte for byte (the
// sizes and SHA-256 below are the upstream's) so that it cannot disappear under the feature
// (docs/decisions/D57.md).
const STUPAKOV = 'elabora/parakeet-tdt-0.6b-v3-onnx/resolve/bde36490a07ff71e2f67fdeb16791e5040f46493';

export const TRANSCRIBER_MODELS: readonly TranscriberModel[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    version: '8f23f0c-int8',
    model: 'parakeet-tdt-0.6b-v3@8f23f0c int8',
    languages: ['bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu', 'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk'],
    credit: 'Parakeet TDT 0.6B v3 by NVIDIA (CC-BY-4.0), converted to ONNX and quantized by Ilya Stupakov',
    files: [
      { name: 'nemo128.onnx', url: `${STUPAKOV}/nemo128.onnx`, size: 139764, sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f' },
      { name: 'encoder-model.int8.onnx', url: `${STUPAKOV}/encoder-model.int8.onnx`, size: 652183999, sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09' },
      { name: 'decoder_joint-model.int8.onnx', url: `${STUPAKOV}/decoder_joint-model.int8.onnx`, size: 18202004, sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70' },
      { name: 'vocab.txt', url: `${STUPAKOV}/vocab.txt`, size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' }
    ]
  }
];

// The models, with a test's made-up files (ELABORA_TRANSCRIBER_MODELS_MANIFEST).
export function transcriberModels(env: NodeJS.ProcessEnv = process.env): readonly TranscriberModel[] {
  if (!env.ELABORA_TRANSCRIBER_MODELS_MANIFEST) return TRANSCRIBER_MODELS;
  const manifest = JSON.parse(fs.readFileSync(env.ELABORA_TRANSCRIBER_MODELS_MANIFEST, 'utf8')) as Record<string, ModelFile[]>;
  return TRANSCRIBER_MODELS.map((model) => (manifest[model.id] ? { ...model, files: manifest[model.id] } : model));
}

// The model that transcribes a language: the course language tag or its primary subtag (fr-CA is French).
export function transcriberFor(language: string, env: NodeJS.ProcessEnv = process.env): TranscriberModel | null {
  const primary = language.toLowerCase().split('-')[0];
  return transcriberModels(env).find((model) => model.languages.includes(primary)) ?? null;
}

export const transcriberSize = (model: TranscriberModel): number => filesSize(model.files);

export function transcribersRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ELABORA_TRANSCRIBER_MODELS_DIR ? path.resolve(env.ELABORA_TRANSCRIBER_MODELS_DIR) : path.join(localDataRoot(), 'transcribers');
}

const transcriberBaseDir = (model: TranscriberModel, env: NodeJS.ProcessEnv = process.env): string => path.join(transcribersRoot(env), model.id);
export const transcriberDir = (model: TranscriberModel, env: NodeJS.ProcessEnv = process.env): string => modelDir(transcriberBaseDir(model, env), model);
export const transcriberVersionState = (model: TranscriberModel, env: NodeJS.ProcessEnv = process.env) => modelVersionState(transcriberBaseDir(model, env), model);
export const acquireTranscriber = (model: TranscriberModel, signal?: AbortSignal) => acquireModel(transcriberBaseDir(model), model, WORDING, signal);

export function transcriberInstalled(model: TranscriberModel, env: NodeJS.ProcessEnv = process.env): boolean {
  return modelInstalled(transcriberBaseDir(model, env), model);
}

export class TranscriberDownloadError extends Error {
  readonly code = 'E_TRANSCRIBE_DOWNLOAD';
}

const WORDING: DownloadWording = {
  what: 'transcription model', needs: 'Transcription needs', fail: (message) => new TranscriberDownloadError(message),
  busy: (message) => new ModelsBusyError('E_TRANSCRIBE_IN_USE', message), using: 'a recording is being transcribed with it'
};

export function installTranscriber(model: TranscriberModel, { onProgress, signal, updateOnly, env = process.env }: { updateOnly?: boolean; onProgress?: (progress: DownloadProgress) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  requireLocalAi();
  return installModel(model.id, transcriberBaseDir(model, env), model, env.ELABORA_TRANSCRIBER_MODELS_URL || 'https://huggingface.co', WORDING, { onProgress, signal, updateOnly });
}

// What it takes on this computer, its download under way in any process, whether a recording is
// being transcribed with it (models/download.ts).
export const transcriberOnDisk = (model: TranscriberModel, env: NodeJS.ProcessEnv = process.env): number => modelBytes(transcriberBaseDir(model, env));
export const transcriberDownloading = (model: TranscriberModel, env: NodeJS.ProcessEnv = process.env) => modelDownloading(transcriberBaseDir(model, env), model);
export const transcriberHolders = (model: TranscriberModel, env: NodeJS.ProcessEnv = process.env): number[] => modelHolders(transcriberBaseDir(model, env));
export const transcriberInUse = (model: TranscriberModel, env: NodeJS.ProcessEnv = process.env): boolean => transcriberHolders(model, env).length > 0;
export const holdTranscriber = (model: TranscriberModel, { signal, env = process.env }: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<() => void> => holdModel(transcriberBaseDir(model, env), model, WORDING, signal);
// partial: only what a stopped download left (kept when it is all there).
export const uninstallTranscriber = (model: TranscriberModel, { env = process.env, partial = false }: { env?: NodeJS.ProcessEnv; partial?: boolean } = {}): Promise<number> => removeModels(transcriberBaseDir(model, env), model, WORDING, partial);
