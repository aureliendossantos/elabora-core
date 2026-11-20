// The models Worker (D114): started by the engine's Worker at the first word to time, one job at a
// time (a French model takes 1.6 GB). It loads onnxruntime-web from the address the app serves it at,
// never bundled (the engine's Worker carries none of it), with min(4, cores / 2) threads when the page
// is cross-origin isolated (C105), one otherwise. The models' files come from the origin's private file
// system (store.ts); it makes no request but for its runtime's script and wasm, and holds no secret.

import { alignEmissions } from '@elabora/core/align/align';
import type { Alignment } from '@elabora/core/align/align';
import type { AlignerModel } from '@elabora/core/align/models';
import { wav2vec2Emissions, wav2vec2Model, wav2vec2SessionOptions } from '@elabora/core/align/wav2vec2';
import type { Wav2Vec2Model } from '@elabora/core/align/wav2vec2';
import type { OnnxRuntime, OnnxSession } from '@elabora/core/util/onnx';
import { useModel } from './store.ts';
import type { WorkerMessage } from '../worker-client.ts';

// ort: onnxruntime-web's ESM build (ort.wasm.min.mjs); wasm: the folder its .wasm and .mjs files are in.
export type ModelsInit = { ort: string; wasm: string };

export type ModelsAsk = { op: 'align'; model: AlignerModel; samples: Float32Array; text: string; language: string };

export type ModelsAnswer = { alignment: Alignment } | { error: string; code?: string };

type OrtWeb = OnnxRuntime & {
  env: { wasm: { wasmPaths?: string; numThreads?: number } };
  InferenceSession: { create(model: Uint8Array, options: object): Promise<OnnxSession> };
};

const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkerMessage<ModelsInit, ModelsAsk>>) => void) | null; postMessage(message: { id: number; answer: ModelsAnswer }): void };

let init: ModelsInit | null = null;
let runtime: Promise<OrtWeb> | null = null;
let loaded: { id: string; model: Wav2Vec2Model } | null = null;
let queue: Promise<unknown> = Promise.resolve();

export const threadsHere = (): number => (globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1);

function ort(): Promise<OrtWeb> {
  if (!init) throw new Error('The models Worker was not given its runtime.');
  const { ort: url, wasm } = init;
  runtime ??= (import(/* @vite-ignore */ url) as Promise<OrtWeb & { default?: OrtWeb }>).then((module) => {
    const loadedRuntime = (module.InferenceSession ? module : module.default) as OrtWeb;
    loadedRuntime.env.wasm.wasmPaths = wasm.endsWith('/') ? wasm : `${wasm}/`;
    loadedRuntime.env.wasm.numThreads = threadsHere();
    return loadedRuntime;
  });
  return runtime;
}

scope.onmessage = ({ data }) => {
  if (data.kind === 'init') { init = data.init; return; }
  if (data.kind !== 'ask') return;
  const { id, ask } = data;
  // One job at a time: each waits for the one before.
  queue = queue.then(() => answer(ask)).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error), ...(typeof (error as { code?: unknown })?.code === 'string' ? { code: (error as { code: string }).code } : {}) }))
    .then((result) => scope.postMessage({ id, answer: result as ModelsAnswer }));
};

async function answer(ask: ModelsAsk): Promise<ModelsAnswer> {
  const runtimeHere = await ort();
  return useModel(ask.model, async (file) => {
    if (loaded?.id !== `${ask.model.id}@${ask.model.version}`) {
      const [model, vocab] = await Promise.all([file('model.onnx'), file('vocab.json')]);
      if (!model || !vocab) throw Object.assign(new Error('The word aligner is no longer kept in this browser: it is downloaded again first.'), { code: 'E_ALIGN_NOT_INSTALLED' });
      await loaded?.model.session.release?.();
      loaded = null;
      const session = await runtimeHere.InferenceSession.create(new Uint8Array(await model.arrayBuffer()), { executionProviders: ['wasm'], ...wav2vec2SessionOptions() });
      loaded = { id: `${ask.model.id}@${ask.model.version}`, model: wav2vec2Model(runtimeHere, session, JSON.parse(await vocab.text()) as Record<string, number>) };
    }
    const emissions = await wav2vec2Emissions(loaded.model, ask.samples);
    return { alignment: alignEmissions(emissions, ask.text, ask.language, { vocab: loaded.model.vocab, blank: loaded.model.blank, delimiter: loaded.model.delimiter }, { startShift: ask.model.startShift, endShift: ask.model.endShift }) };
  });
}
