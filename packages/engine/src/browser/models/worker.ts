// The models Worker (D114): started by the engine's Worker at the first word to time or line to say,
// one job at a time (a French aligner takes 1.6 GB, a French voice 2.3 GB). It keeps the last aligner
// and the last voice loaded, both when their language is light, one only otherwise (refusal.ts). It loads onnxruntime-web from the address the app serves it at,
// never bundled (the engine's Worker carries none of it), with min(4, cores / 2) threads when the page
// is cross-origin isolated (C105), one otherwise. The models' files come from the origin's private file
// system (store.ts); it makes no request but for its runtime's script and wasm, and holds no secret.

import { alignEmissions } from '@elabora/core/align/align';
import type { Alignment } from '@elabora/core/align/align';
import type { AlignerModel } from '@elabora/core/align/models';
import { wav2vec2Emissions, wav2vec2Model, wav2vec2SessionOptions } from '@elabora/core/align/wav2vec2';
import type { Wav2Vec2Model } from '@elabora/core/align/wav2vec2';
import type { OnnxRuntime, OnnxSession } from '@elabora/core/util/onnx';
import { PocketModel, BUNDLE_FILES, embeddingsOf, npyFloat32, pocketSessionOptions } from '@elabora/core/voice/pocket/runtime';
import type { BundleMeta } from '@elabora/core/voice/pocket/runtime';
import type { PocketBundle, Rules } from '@elabora/core/voice/pocket/models';
import type { UnigramJson } from '@elabora/core/voice/pocket/tokenizer';
import { useModel } from './store.ts';
import type { StoredModel } from './store.ts';
import { heavy } from './refusal.ts';
import type { WorkerMessage } from '../worker-client.ts';

// ort: onnxruntime-web's ESM build (ort.wasm.min.mjs); wasm: the folder its .wasm and .mjs files are in,
// or each one's address.
export type ModelsInit = { ort: string; wasm: string | { mjs: string; wasm: string } };

// speak: a line said by a local voice (Pocket TTS), its voice's embeddings given (the catalogue's).
export type ModelsAsk =
  | { op: 'align'; model: AlignerModel; samples: Float32Array; text: string; language: string }
  | { op: 'speak'; bundle: PocketBundle & StoredModel; voice: string; embeddings: Uint8Array; text: string; temperature: number; seed: number; rules: Rules };

export type ModelsAnswer = { alignment: Alignment } | { samples: Float32Array; sampleRate: number; retries: number } | { error: string; code?: string };

type OrtWeb = OnnxRuntime & {
  env: { wasm: { wasmPaths?: string | { mjs: string; wasm: string }; numThreads?: number } };
  InferenceSession: { create(model: Uint8Array, options: object): Promise<OnnxSession> };
};

const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkerMessage<ModelsInit, ModelsAsk>>) => void) | null; postMessage(message: { id: number; answer: ModelsAnswer } | { id: number; progress: number }, transfer?: Transferable[]): void };

let init: ModelsInit | null = null;
let runtime: Promise<OrtWeb> | null = null;
let loaded: { id: string; language: string; model: Wav2Vec2Model } | null = null;
let voice: { id: string; language: string; model: PocketModel; voice: string | null; state: Awaited<ReturnType<PocketModel['voiceState']>> | null } | null = null;
let queue: Promise<unknown> = Promise.resolve();
const running = new Map<number, AbortController>();

async function releaseAligner(): Promise<void> {
  const model = loaded?.model;
  loaded = null;
  await model?.session.release?.();
}

async function releaseVoice(): Promise<void> {
  const model = voice?.model;
  voice = null;
  await model?.release();
}

export const threadsHere = (): number => (globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1);

function ort(): Promise<OrtWeb> {
  if (!init) throw new Error('The models Worker was not given its runtime.');
  const { ort: url, wasm } = init;
  runtime ??= (import(/* @vite-ignore */ url) as Promise<OrtWeb & { default?: OrtWeb }>).then((module) => {
    const loadedRuntime = (module.InferenceSession ? module : module.default) as OrtWeb;
    loadedRuntime.env.wasm.wasmPaths = typeof wasm !== 'string' ? wasm : wasm.endsWith('/') ? wasm : `${wasm}/`;
    loadedRuntime.env.wasm.numThreads = threadsHere();
    return loadedRuntime;
  });
  return runtime;
}

// What onnxruntime-web says when its memory cannot grow: the computer has too little of it for this
// model (Safari and Firefox do not say how much they have, D113). The runtime is loaded again after it.
const OUT_OF_MEMORY = /out of memory|Memory\.grow|maximum memory|bad_alloc|failed to allocate|\bOOM\b/i;

function failure(error: unknown): ModelsAnswer {
  const message = error instanceof Error ? error.message : String(error);
  if (OUT_OF_MEMORY.test(message)) {
    runtime = null;
    loaded = null;
    voice = null;
    return { error: 'This computer has too little memory free for this model: close other tabs or programs, then try again.', code: 'E_LOCAL_AI_MEMORY' };
  }
  const code = (error as { code?: unknown } | null)?.code;
  return { error: message, ...(typeof code === 'string' ? { code } : {}) };
}

scope.onmessage = ({ data }) => {
  if (data.kind === 'init') { init = data.init; return; }
  if (data.kind === 'cancel') { running.get(data.id)?.abort(); return; }
  if (data.kind !== 'ask') return;
  const { id, ask } = data;
  const controller = new AbortController();
  running.set(id, controller);
  // One job at a time: each waits for the one before.
  queue = queue.then(() => answer(ask, controller.signal, (fraction) => scope.postMessage({ id, progress: fraction }))).catch(failure).then((result) => {
    running.delete(id);
    scope.postMessage({ id, answer: result }, 'samples' in result ? [result.samples.buffer as ArrayBuffer] : []);
  });
};

// intraOpNumThreads is the desktop's: here the threads are the runtime's (numThreads).
const sessionOf = (runtime: OrtWeb, bytes: Uint8Array, { intraOpNumThreads: _threads, ...options }: { intraOpNumThreads?: number } & object) => runtime.InferenceSession.create(bytes, { executionProviders: ['wasm'], ...options });

async function answer(ask: ModelsAsk, signal: AbortSignal, progress: (fraction: number) => void): Promise<ModelsAnswer> {
  signal.throwIfAborted();
  const runtimeHere = await ort();
  return ask.op === 'speak' ? speak(runtimeHere, ask, signal, progress) : align(runtimeHere, ask);
}

async function align(runtimeHere: OrtWeb, ask: Extract<ModelsAsk, { op: 'align' }>): Promise<ModelsAnswer> {
  return useModel(ask.model, async (file) => {
    if (loaded?.id !== `${ask.model.id}@${ask.model.version}`) {
      const [model, vocab] = await Promise.all([file('model.onnx'), file('vocab.json')]);
      if (!model || !vocab) throw Object.assign(new Error('The word aligner is no longer kept in this browser: it is downloaded again first.'), { code: 'E_ALIGN_NOT_INSTALLED' });
      await releaseAligner();
      if (voice && (heavy(voice.language) || heavy(ask.model.language))) await releaseVoice();
      const session = await sessionOf(runtimeHere, new Uint8Array(await model.arrayBuffer()), wav2vec2SessionOptions());
      loaded = { id: `${ask.model.id}@${ask.model.version}`, language: ask.model.language, model: wav2vec2Model(runtimeHere, session, JSON.parse(await vocab.text()) as Record<string, number>) };
    }
    const emissions = await wav2vec2Emissions(loaded.model, ask.samples);
    return { alignment: alignEmissions(emissions, ask.text, ask.language, { vocab: loaded.model.vocab, blank: loaded.model.blank, delimiter: loaded.model.delimiter }, { startShift: ask.model.startShift, endShift: ask.model.endShift }) };
  });
}

// A line said by a voice of the catalogue: Pocket TTS's model of its language, loaded from the files
// kept (the core's model, D25), the voice's state kept for the next line.
async function speak(runtimeHere: OrtWeb, ask: Extract<ModelsAsk, { op: 'speak' }>, signal: AbortSignal, progress: (fraction: number) => void): Promise<ModelsAnswer> {
  const { bundle } = ask;
  return useModel(bundle, async (file) => {
    if (voice?.id !== `${bundle.id}@${bundle.version}`) {
      const files = await Promise.all([BUNDLE_FILES.meta, BUNDLE_FILES.tokenizer, BUNDLE_FILES.bos, BUNDLE_FILES.textConditioner, BUNDLE_FILES.flowMain, BUNDLE_FILES.flowHead, BUNDLE_FILES.decoder].map((name) => file(name)));
      if (files.some((one) => !one)) throw Object.assign(new Error('The local voices\' model is no longer kept in this browser: it is downloaded again first.'), { code: 'E_VOICE_NOT_INSTALLED' });
      const [meta, tokenizer, bos, textConditioner, flowMain, flowHead, decoder] = files as File[];
      await releaseVoice();
      if (loaded && (heavy(loaded.language) || heavy(bundle.language))) await releaseAligner();
      const metaJson = JSON.parse(await meta.text()) as BundleMeta;
      const options = pocketSessionOptions(threadsHere());
      const open = async (one: File) => sessionOf(runtimeHere, new Uint8Array(await one.arrayBuffer()), options);
      const sessions = { textConditioner: await open(textConditioner), flowMain: await open(flowMain), flowHead: await open(flowHead), decoder: await open(decoder), encoder: null };
      const model = new PocketModel(runtimeHere, { meta: metaJson, tokenizer: JSON.parse(await tokenizer.text()) as UnigramJson, bos: metaJson.insert_bos_before_voice ? npyFloat32(new Uint8Array(await bos.arrayBuffer()), BUNDLE_FILES.bos) : new Float32Array(0) }, sessions);
      voice = { id: `${bundle.id}@${bundle.version}`, language: bundle.language, model, voice: null, state: null };
    }
    const current = voice;
    // One voice's state kept (200 MB in French): a dialogue computes the other's again.
    if (current.voice !== ask.voice || !current.state) {
      current.state = null;
      current.state = await current.model.voiceState(embeddingsOf(ask.embeddings));
      current.voice = ask.voice;
    }
    const rules = { ...ask.rules, removeSemicolons: current.model.meta.remove_semicolons, padWithSpacesForShortInputs: current.model.meta.pad_with_spaces_for_short_inputs };
    const { samples, retries } = await current.model.synthesizeWithReport(ask.text, current.state, { temperature: ask.temperature, seed: ask.seed, rules, signal, onProgress: progress });
    return { samples, sampleRate: current.model.sampleRate, retries };
  });
}
