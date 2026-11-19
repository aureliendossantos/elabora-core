// The word aligner's model on this computer: its session made by onnxruntime-node from the model's
// file, its vocabulary read from disk; its emissions are the core's (@elabora/core/align/wav2vec2).
import fs from 'node:fs';
import type * as Ort from 'onnxruntime-node';
import { wav2vec2Model, wav2vec2SessionOptions } from '@elabora/core/align/wav2vec2';
import type { Wav2Vec2Model } from '@elabora/core/align/wav2vec2';
import type { OnnxRuntime } from '@elabora/core/util/onnx';

export { SAMPLE_RATE, WINDOW_SECONDS, MARGIN_SECONDS, wav2vec2Emissions } from '@elabora/core/align/wav2vec2';
export type { ModelEmissions, Wav2Vec2Model } from '@elabora/core/align/wav2vec2';

export interface LoadOptions {
  threads?: number;                // intra-op threads (default: ONNX Runtime's choice)
  arena?: boolean;                 // keep ONNX Runtime's memory arena (default false)
}

export async function loadWav2Vec2(ort: typeof Ort, modelFile: string, vocabFile: string, options: LoadOptions = {}): Promise<Wav2Vec2Model> {
  const vocab = JSON.parse(fs.readFileSync(vocabFile, 'utf8')) as Record<string, number>;
  const session = await ort.InferenceSession.create(modelFile, { executionProviders: ['cpu'], ...wav2vec2SessionOptions(options) });
  return wav2vec2Model(ort as unknown as OnnxRuntime, session as never, vocab);
}
