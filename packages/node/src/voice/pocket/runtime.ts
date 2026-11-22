import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as Ort from 'onnxruntime-node';
import { BUNDLE_FILES, PocketModel as Model, embeddingsOf, npyFloat32, pocketSessionOptions } from '@elabora/core/voice/pocket/runtime';
import type { BundleMeta, PocketSessions } from '@elabora/core/voice/pocket/runtime';
import type { OnnxRuntime, OnnxSession } from '@elabora/core/util/onnx';
import type { UnigramJson } from '@elabora/core/voice/pocket/tokenizer';
import { requireLocalAi } from '../../models/platform.ts';

// Kyutai's Pocket TTS on this computer (docs/decisions.md D25): the core's model
// (@elabora/core/voice/pocket/runtime), its sessions made by onnxruntime-node from the bundle's files.

export { BUNDLE_FILES, endOnPause, gaussian } from '@elabora/core/voice/pocket/runtime';
export type { BundleMeta, SynthesisOptions } from '@elabora/core/voice/pocket/runtime';

type OrtModule = typeof Ort;

let ortModule: Promise<OrtModule> | null = null;

// onnxruntime-node is an optional dependency, loaded on first use: Elabora works without it, only
// local voices need it. Required from this module's place, as the other optional modules, so that a
// bundle (the desktop app) finds it in the core's node_modules with its native binding.
const require = createRequire(import.meta.url);

export function loadOrt(): Promise<OrtModule> {
  requireLocalAi();
  ortModule ??= Promise.resolve().then(() => require('onnxruntime-node') as OrtModule).catch((error: unknown) => {
    ortModule = null;
    const failure = new Error(ortLoadFailure(error instanceof Error ? error.message : String(error)));
    Object.assign(failure, { code: 'E_VOICE_RUNTIME' });
    throw failure;
  });
  return ortModule;
}

// On Windows, ONNX Runtime's DLLs need Microsoft's Visual C++ runtime (MSVCP140, VCRUNTIME140),
// which Electron does not carry and some computers lack: Windows then says a module is missing.
export function ortLoadFailure(message: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch, needs = 'Local voices need'): string {
  const missingDll = platform === 'win32' && /specified module could not be found|\.dll|0x7e/i.test(message);
  return `${needs} ONNX Runtime (onnxruntime-node), which is not installed or does not load on this computer (${platform}-${arch}): ${message}${missingDll ? ' On Windows it needs the Microsoft Visual C++ Redistributable (x64), installed by https://aka.ms/vs/17/release/vc_redist.x64.exe.' : ''}`;
}

// A float32 .npy array (bos_before_voice.npy) read from a file.
export const readNpyFloat32 = (file: string): Float32Array => npyFloat32(fs.readFileSync(file), file);

// A voice's embeddings read from a file (float16, frames × conditioning_dim).
export const readEmbeddings = (file: string): Float32Array => embeddingsOf(fs.readFileSync(file));
// ONNX Runtime 1.23 aborts (« libc++abi: mutex lock failed ») when a process that has run a session
// ends with process.exit(), released or not; a process that ends on its own (the CLI sets
// process.exitCode, the MCP server ends with its input, the app kills its engine host) does not.

export class PocketModel extends Model {
  static async load(dir: string, { threads = Math.min(4, Math.max(1, os.availableParallelism())), encoder = false }: { threads?: number; encoder?: boolean } = {}): Promise<PocketModel> {
    const ort = await loadOrt();
    const file = (name: string) => path.join(dir, name);
    const meta = JSON.parse(fs.readFileSync(file(BUNDLE_FILES.meta), 'utf8')) as BundleMeta;
    const options = pocketSessionOptions(threads) as Ort.InferenceSession.SessionOptions;
    const open = (name: string) => ort.InferenceSession.create(file(name), options) as unknown as Promise<OnnxSession>;
    const [textConditioner, flowMain, flowHead, decoder, encoderSession] = await Promise.all([
      open(BUNDLE_FILES.textConditioner), open(BUNDLE_FILES.flowMain), open(BUNDLE_FILES.flowHead), open(BUNDLE_FILES.decoder),
      encoder ? open(BUNDLE_FILES.encoder) : Promise.resolve(null)
    ]);
    const bos = meta.insert_bos_before_voice ? readNpyFloat32(file(BUNDLE_FILES.bos)) : new Float32Array(0);
    const tokenizer = JSON.parse(fs.readFileSync(file(BUNDLE_FILES.tokenizer), 'utf8')) as UnigramJson;
    const sessions: PocketSessions = { textConditioner, flowMain, flowHead, decoder, encoder: encoderSession };
    return new PocketModel(ort as unknown as OnnxRuntime, { meta, tokenizer, bos }, sessions);
  }
}
