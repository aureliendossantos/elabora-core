// A wav2vec2 CTC character model in ONNX (docs/decisions.md D27; a Hugging Face Wav2Vec2ForCTC
// export): 16 kHz mono audio, normalized to zero mean and unit variance, in; logits over its
// characters, one frame per 20 ms (320 samples), out. onnxruntime-node is passed in by the caller
// (loaded on first use, in the aligner's thread).
import fs from 'node:fs';
import type * as Ort from 'onnxruntime-node';
import { AlignmentError, logSoftmax } from './ctc.ts';
import type { Emissions } from './ctc.ts';

export const SAMPLE_RATE = 16000;

export interface Wav2Vec2Model {
  session: Ort.InferenceSession;
  ort: typeof Ort;
  vocab: Record<string, number>;   // character → id (Hugging Face vocab.json)
  blank: number;                   // <pad>
  delimiter: number | null;        // "|", between words
  vocabSize: number;
}

export interface LoadOptions {
  threads?: number;                // intra-op threads (default: ONNX Runtime's choice)
  arena?: boolean;                 // keep ONNX Runtime's memory arena (default false: see below)
}

export async function loadWav2Vec2(ort: typeof Ort, modelFile: string, vocabFile: string, options: LoadOptions = {}): Promise<Wav2Vec2Model> {
  const vocab = JSON.parse(fs.readFileSync(vocabFile, 'utf8')) as Record<string, number>;
  const session = await ort.InferenceSession.create(modelFile, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    // The arena keeps every block it grew to (it rounds each request up to the next power of two)
    // and the memory pattern plans a long run's buffers at its first size: both only raise the peak
    // of a model that runs on audio of any length, for no gain on a line of seconds.
    enableCpuMemArena: !!options.arena,
    enableMemPattern: !!options.arena,
    ...(options.threads ? { intraOpNumThreads: options.threads } : {})
  });
  const blank = vocab['<pad>'] ?? 0;
  return { session, ort, vocab, blank, delimiter: vocab['|'] ?? null, vocabSize: Math.max(...Object.values(vocab)) + 1 };
}

export interface ModelEmissions extends Emissions {
  frameSeconds: number;            // audio seconds per frame (samples / frames / rate)
}

// Audio longer than a window is cut into overlapping windows (the model's memory grows with the
// length, its self-attention with the square of it: a recording of 90 s in one go asked for several
// GB and stopped the engine); each window gives up the frames of its overlap's outer MARGIN_SECONDS,
// where a window has the least context on one side, and the kept stretches are laid end to end. CTC
// emissions are local (a frame sees a few hundred ms around it), so the seams keep the alignment's
// times (measured in docs/decisions.md D27).
export const WINDOW_SECONDS = 10;
export const MARGIN_SECONDS = 2;
const SAMPLES_PER_FRAME = 320;

async function logits(model: Wav2Vec2Model, samples: Float32Array): Promise<{ data: Float32Array; frames: number; vocab: number }> {
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length || 1;
  let variance = 0;
  for (let i = 0; i < samples.length; i++) variance += (samples[i] - mean) ** 2;
  variance /= samples.length || 1;
  const scale = 1 / Math.sqrt(variance + 1e-7);
  const input = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) input[i] = (samples[i] - mean) * scale;
  const feeds = { [model.session.inputNames[0]]: new model.ort.Tensor('float32', input, [1, input.length]) };
  const output = await model.session.run(feeds);
  const tensor = output[model.session.outputNames[0]];
  const [, frames, vocab] = tensor.dims as number[];
  const data = new Float32Array(tensor.data as Float32Array);
  tensor.dispose?.();
  return { data, frames, vocab };
}

export async function wav2vec2Emissions(model: Wav2Vec2Model, samples: Float32Array, { windowSeconds = WINDOW_SECONDS, marginSeconds = MARGIN_SECONDS }: { windowSeconds?: number; marginSeconds?: number } = {}): Promise<ModelEmissions> {
  if (samples.length < SAMPLES_PER_FRAME * 2) throw new AlignmentError('E_ALIGN_SHORT', 'The audio is too short to align (under 40 ms).');
  const window = Math.round(windowSeconds * SAMPLE_RATE / SAMPLES_PER_FRAME) * SAMPLES_PER_FRAME;
  const margin = Math.round(marginSeconds * SAMPLE_RATE / SAMPLES_PER_FRAME) * SAMPLES_PER_FRAME;
  if (samples.length <= window) {
    const { data, frames, vocab } = await logits(model, samples);
    return { logProbs: logSoftmax(data, frames, vocab), frames, vocab, frameSeconds: samples.length / frames / SAMPLE_RATE };
  }
  const parts: Float32Array[] = [];
  let vocabSize = model.vocabSize;
  let kept = 0;
  for (let start = 0; ; start += window - 2 * margin) {
    const end = Math.min(samples.length, start + window);
    const last = end === samples.length;
    const { data, frames, vocab } = await logits(model, samples.subarray(start, end));
    vocabSize = vocab;
    // Frames of the whole audio this window gives: from where the one before stopped to its own
    // margin before its end (the last gives all it has).
    const firstFrame = Math.round(start / SAMPLES_PER_FRAME);
    const from = kept - firstFrame;
    const to = last ? frames : Math.min(frames, Math.round((end - margin - start) / SAMPLES_PER_FRAME));
    if (to > from) { parts.push(data.slice(from * vocab, to * vocab)); kept += to - from; }
    if (last) break;
  }
  const all = new Float32Array(kept * vocabSize);
  let offset = 0;
  for (const part of parts) { all.set(part, offset); offset += part.length; }
  return { logProbs: logSoftmax(all, kept, vocabSize), frames: kept, vocab: vocabSize, frameSeconds: samples.length / kept / SAMPLE_RATE };
}
