import { acquireModel, holdModel, installModel, modelBytes, modelDir, modelDownloading, modelHolders, modelInstalled, modelVersionState, removeModels } from '../../models/versions.ts';
import type { VersionedModel } from '../../models/versions.ts';
import path from 'node:path';
import { localDataRoot } from '../../data-dir.ts';
import fs from 'node:fs';
import { filesSize } from '../../models/download.ts';
import type { DownloadProgress, DownloadWording, ModelFile } from '../../models/download.ts';
import { BUNDLE_FILES } from './runtime.ts';
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
//
// The ONNX graphs are KevinAHM's export of Kyutai's weights (CC-BY 4.0). French is Kyutai's
// french_24l of April 2026 (revision d29db79 of kyutai/pocket-tts-without-voice-cloning), whose
// tokenizer Kyutai published as tokenizer.json in revision 00eac05.

export type { ModelFile, DownloadProgress } from '../../models/download.ts';

export interface Bundle extends VersionedModel {
  id: string;                 // the bundle's folder
  language: string;           // the language its voices speak (course language tags: fr, en)
  model: string;              // what a sidecar records as its model
  files: ModelFile[];
}

// Elabora's mirror, in its Hugging Face organization, of KevinAHM/pocket-tts-onnx at
// 58a6d00cf13d239b6748cb0769f35c580a8f606c (the files of these two bundles, at the same paths): an
// individual's repository, copied byte for byte (the sizes and SHA-256 below are the upstream's) so
// that it cannot disappear under the feature (docs/decisions/D57.md). Kyutai's tokenizers stay where
// their authors publish them: an organization's repository, open to everyone.
const KEVIN = 'elabora/pocket-tts-onnx/resolve/865fdd302dd4e02c3507f1837a137201ff7e53ea/onnx';
const KYUTAI = 'kyutai/pocket-tts-without-voice-cloning/resolve/00eac05ed3d16bdc3f6b5d598874019c34a89214/languages';

const graph = (bundle: string, name: string, size: number, sha256: string): ModelFile => ({ name, url: `${KEVIN}/${bundle}/${name}`, size, sha256 });

export const BUNDLES: readonly Bundle[] = [
  {
    id: 'french_24l',
    version: '2026-04-58a6d00',
    language: 'fr',
    model: 'pocket-tts/french_24l@d29db79',
    files: [
      graph('french_24l', BUNDLE_FILES.meta, 42235, '8a5fe6c59985e3ccb5a6ccb1ffb2e84ac08488c5bfa704053618851436741427'),
      graph('french_24l', BUNDLE_FILES.bos, 4224, '5759269802d691d49481b8e06d6a5649da85ea01135e270bd7641e3b091c7237'),
      graph('french_24l', BUNDLE_FILES.textConditioner, 16388344, '89d1b6ac55e618e42d2bd840438ce918bffb14960475ef091847ca39be641e65'),
      graph('french_24l', BUNDLE_FILES.flowMain, 305144125, '6130a6b98fae175147d82752263e250fb7b8483c1ef5373753ad335c16f4a129'),
      graph('french_24l', BUNDLE_FILES.flowHead, 9962530, 'd340c549d5a1e0e7b88a0fb26fcae53c3b76486872f4418398a395bb1bc88701'),
      graph('french_24l', BUNDLE_FILES.decoder, 22684077, 'b329ff3de3aa95455d2dee1cf371943dec269dd8711008017501ca129cb18d8c'),
      { name: BUNDLE_FILES.tokenizer, url: `${KYUTAI}/french_24l/tokenizer.json`, size: 245903, sha256: '753041d83fe23c610c25a59133be6ea96df8e7954f0ef679a8fb24685a761347' }
    ]
  },
  {
    id: 'english_2026-04',
    version: '2026-04-58a6d00',
    language: 'en',
    model: 'pocket-tts/english_2026-04',
    files: [
      graph('english_2026-04', BUNDLE_FILES.meta, 24381, 'bab643150f437f37df080a710520ff39ed9ebd9a339f8ebdc739f7eddfc28b3f'),
      graph('english_2026-04', BUNDLE_FILES.bos, 4224, 'f46edf4f7007b7ba4ea58831f49d003e59e167b4641c44bb3addfe9231a780b1'),
      graph('english_2026-04', BUNDLE_FILES.textConditioner, 16388344, '4ecee995fb69f85c7a7493d11f7b5ee15d9950facc7ab3f5c9c49ef1e03847bb'),
      graph('english_2026-04', BUNDLE_FILES.flowMain, 76341079, 'f9bd8106b79a0192c1c43399ab938fb24900a95c1c599870d75a884e99000116'),
      graph('english_2026-04', BUNDLE_FILES.flowHead, 9962530, '3dd781ee5abee9e195320bf0106bebd6372a852b3b36352524ee78b40554635d'),
      graph('english_2026-04', BUNDLE_FILES.decoder, 22684077, '3630450a3297a101792a6ac66619ebc70ab916b265e6220c2afaef8b1673f925'),
      { name: BUNDLE_FILES.tokenizer, url: `${KYUTAI}/english_2026-04/tokenizer.json`, size: 245020, sha256: 'f498428e1eafee50492f7be13dc9bfafcfc12e508cd0eb1b01c92ecd5d8c6687' }
    ]
  }
];

// The voice encoder, only to make the catalogue's voices (scripts/pocket-voices.ts).
export const ENCODERS: Readonly<Record<string, ModelFile>> = {
  french_24l: graph('french_24l', BUNDLE_FILES.encoder, 39768446, '790a82fb8041e1035ec8097c6a277c834664a1f6619397d62f3bb46f71d2bfd4'),
  'english_2026-04': graph('english_2026-04', BUNDLE_FILES.encoder, 39768446, '853e2ca623b8782d94c3745ec6133bfdff7ce33d9b11128bd29ea03f28d76e3d')
};

// The bundles, with a test's made-up files (ELABORA_VOICE_MODELS_MANIFEST).
export function bundles(env: NodeJS.ProcessEnv = process.env): readonly Bundle[] {
  if (!env.ELABORA_VOICE_MODELS_MANIFEST) return BUNDLES;
  const manifest = JSON.parse(fs.readFileSync(env.ELABORA_VOICE_MODELS_MANIFEST, 'utf8')) as Record<string, ModelFile[]>;
  return BUNDLES.map((bundle) => (manifest[bundle.id] ? { ...bundle, files: manifest[bundle.id] } : bundle));
}

// A language's bundle: the course language tag or its primary subtag (fr-CA speaks French).
export function bundleFor(language: string, env: NodeJS.ProcessEnv = process.env): Bundle | null {
  const primary = language.toLowerCase().split('-')[0];
  return bundles(env).find((bundle) => bundle.language === primary) ?? null;
}

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
