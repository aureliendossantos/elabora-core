import { acquireModel, holdModel, installModel, modelBytes, modelDir, modelDownloading, modelHolders, modelInstalled, modelVersionState, removeModels } from '../models/versions.ts';
import type { VersionedModel } from '../models/versions.ts';
import fs from 'node:fs';
import path from 'node:path';
import { localDataRoot } from '../data-dir.ts';
import { filesSize, ModelsBusyError } from '../models/download.ts';
import type { DownloadProgress, DownloadWording, ModelFile } from '../models/download.ts';
import { requireLocalAi } from '../models/platform.ts';

// The word aligner's models (docs/decisions.md D27): a wav2vec2 CTC character model per language,
// downloaded once per computer on the first alignment in that language, into <local app data>/
// aligners/<model>/ (or ELABORA_ALIGNER_MODELS_DIR), pinned to a revision and checked by SHA-256.
// ELABORA_ALIGNER_MODELS_URL replaces https://huggingface.co (a mirror). Listed, removed and downloaded
// again from Elabora settings like every optional download (downloads/, D38), never while words are
// being placed with it. ELABORA_ALIGNER_MODELS_MANIFEST=<file.json> ({ "<model id>": [files] }) gives a
// model made-up files, for tests only.
//
// French: jonatasgrosman/wav2vec2-large-xlsr-53-french (Apache-2.0) at revision 7c79e10, exported to
// ONNX (opset 17) with its matrix products quantized to int8; the file is XDcobra's export, pinned,
// which aligns as our own export of the same revision does. English:
// facebook/wav2vec2-base-960h (Apache-2.0) as Xenova's quantized ONNX export.
//
// Those exports are individuals' repositories, which could be renamed or deleted: every file is
// downloaded from Elabora's own copy in its Hugging Face organization (docs/decisions/D57.md), an
// unmodified mirror, byte for byte, so the sizes and SHA-256 are the upstream's. The upstream of each
// is named beside its constant.

export interface AlignerModel extends VersionedModel {
  id: string;                 // its folder
  language: string;           // primary language subtag
  model: string;              // what a sidecar records as its aligner
  credit: string;             // the model and its licence (notices)
  files: ModelFile[];         // model.onnx and vocab.json
  // Measured on Pocket TTS voices (D27): word starts come about a frame late and ends early.
  startShift: number;         // seconds added to every word start
  endShift: number;           // seconds added to every word end, up to the next word's start
}

// Mirror of XDcobra/wav2vec2-large-xlsr-53-french-ONNX at feb7081bd901fc393812dddd9b0768ae05f730bf.
const XDCOBRA = 'elabora/wav2vec2-large-xlsr-53-french-onnx/resolve/fc9754dc06b837bed27113a60c2521b5377cbb4b';
// Mirror of jonatasgrosman/wav2vec2-large-xlsr-53-french at 7c79e105a6525d38e1e69f640b974b4a679723cc (its vocab.json alone).
const JONATAS = 'elabora/wav2vec2-large-xlsr-53-french/resolve/dc59d3c754de8aa70f134a69d5a10d2767f8cac0';
// Mirror of Xenova/wav2vec2-base-960h at a19f851b3d42865797e410752b4c570c871e4825.
const XENOVA = 'elabora/wav2vec2-base-960h-onnx/resolve/045b40925359ddb3fdb15aa2ae4141e61cc90ebc';

export const ALIGNER_MODELS: readonly AlignerModel[] = [
  {
    id: 'wav2vec2-xlsr53-french-int8',
    version: '7c79e10-feb7081',
    language: 'fr',
    model: 'wav2vec2-large-xlsr-53-french@7c79e10 int8',
    credit: 'wav2vec2-large-xlsr-53-french by Jonatas Grosman (Apache-2.0), converted to ONNX and quantized',
    files: [
      { name: 'model.onnx', url: `${XDCOBRA}/onnx/model_int8.onnx`, size: 355034715, sha256: 'fbe07a90dcb44f768f42d8eaed0154b5a2d44b9ee31bff40cf3234cadcfc2f88' },
      { name: 'vocab.json', url: `${JONATAS}/vocab.json`, size: 560, sha256: 'e83a3c849e480757fabd9fe927b870581e926407bcc7e1b6dcc8bda1e78a8d78' }
    ],
    startShift: -0.02,
    endShift: 0.034
  },
  {
    id: 'wav2vec2-base-960h-q8',
    version: 'a19f851',
    language: 'en',
    model: 'wav2vec2-base-960h@a19f851 quantized',
    credit: 'wav2vec2-base-960h by Meta AI (Apache-2.0), converted to ONNX and quantized by Xenova',
    files: [
      { name: 'model.onnx', url: `${XENOVA}/onnx/model_quantized.onnx`, size: 95286046, sha256: 'cd5040c147381580ed73258143dd8e0c28e800a09e74ee42ee2b3e8cb4d760a3' },
      { name: 'vocab.json', url: `${XENOVA}/vocab.json`, size: 358, sha256: '4178db26b3c7570f6a47f14ac6a1c7b32950b8c2800fb097287e53776934f1c5' }
    ],
    startShift: -0.02,
    endShift: 0.112
  }
];

// The models, with a test's made-up files (ELABORA_ALIGNER_MODELS_MANIFEST).
export function alignerModels(env: NodeJS.ProcessEnv = process.env): readonly AlignerModel[] {
  if (!env.ELABORA_ALIGNER_MODELS_MANIFEST) return ALIGNER_MODELS;
  const manifest = JSON.parse(fs.readFileSync(env.ELABORA_ALIGNER_MODELS_MANIFEST, 'utf8')) as Record<string, ModelFile[]>;
  return ALIGNER_MODELS.map((model) => (manifest[model.id] ? { ...model, files: manifest[model.id] } : model));
}

// A language's aligner: the course language tag or its primary subtag (fr-CA is French).
export function alignerFor(language: string, env: NodeJS.ProcessEnv = process.env): AlignerModel | null {
  const primary = language.toLowerCase().split('-')[0];
  return alignerModels(env).find((model) => model.language === primary) ?? null;
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
