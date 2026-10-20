// Parakeet TDT (docs/decisions.md D46), as Ilya Stupakov's ONNX export for onnx-asr gives it: NeMo's
// 128-band mel features (nemo128.onnx), a FastConformer encoder (a frame every 80 ms) and a fused
// decoder and joint network that gives, for a frame and the last token, the likeliest next token
// and how many frames to move on (token-and-duration transducer). Decoded greedily here as onnx-asr
// does: no language model, no beam. onnxruntime-node is passed in by the caller (loaded on first
// use, in the transcriber's process).
import fs from 'node:fs';
import type * as Ort from 'onnxruntime-node';

export const SAMPLE_RATE = 16000;
const FRAME_SECONDS = 0.08;          // 10 ms features, subsampled 8 times
const MAX_TOKENS_PER_FRAME = 10;     // onnx-asr's guard against a decoder that never moves on

export interface ParakeetModel {
  ort: typeof Ort;
  features: Ort.InferenceSession;
  encoder: Ort.InferenceSession;
  decoder: Ort.InferenceSession;
  vocab: string[];                   // id → piece, « ▁ » read as a space
  blank: number;
  states: [number, number];          // the decoder's state shape: layers, hidden size
}

export async function loadParakeet(ort: typeof Ort, dir: string): Promise<ParakeetModel> {
  // The arena and memory pattern only raise the peak of a model run on audio of any length (align/wav2vec2.ts).
  const options: Ort.InferenceSession.SessionOptions = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
  const [features, encoder, decoder] = await Promise.all(['nemo128.onnx', 'encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx'].map((name) => ort.InferenceSession.create(`${dir}/${name}`, options)));
  const vocab: string[] = [];
  for (const line of fs.readFileSync(`${dir}/vocab.txt`, 'utf8').split('\n')) {
    const space = line.lastIndexOf(' ');
    if (space > 0) vocab[Number(line.slice(space + 1))] = line.slice(0, space).replaceAll('▁', ' ');
  }
  const blank = vocab.indexOf('<blk>');
  const state = decoder.inputMetadata.find((input) => input.name === 'input_states_1');
  const shape = state?.isTensor ? state.shape : [];
  return { ort, features, encoder, decoder, vocab, blank: blank >= 0 ? blank : vocab.length - 1, states: [typeof shape[0] === 'number' ? shape[0] : 2, typeof shape[2] === 'number' ? shape[2] : 640] };
}

export async function releaseParakeet(model: ParakeetModel): Promise<void> {
  await Promise.all([model.features.release(), model.encoder.release(), model.decoder.release()]);
}

export interface Token {
  id: number;
  piece: string;      // its text, a leading space where a word starts
  time: number;       // seconds from the start of the audio
  probability: number;
}

// The tokens a stretch of audio gives, their times from its start.
async function decode(model: ParakeetModel, samples: Float32Array, offset: number): Promise<Token[]> {
  const { ort } = model;
  const prepared = await model.features.run({
    waveforms: new ort.Tensor('float32', samples, [1, samples.length]),
    waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(samples.length)]), [1])
  });
  const encoded = await model.encoder.run({ audio_signal: prepared.features, length: prepared.features_lens });
  prepared.features.dispose?.();
  const outputs = encoded.outputs;
  const frames = Number((encoded.encoded_lengths.data as BigInt64Array)[0]);
  const [, size, stride] = outputs.dims as number[];
  const data = outputs.data as Float32Array;
  const [layers, hidden] = model.states;
  let state1: Ort.Tensor = new ort.Tensor('float32', new Float32Array(layers * hidden), [layers, 1, hidden]);
  let state2: Ort.Tensor = new ort.Tensor('float32', new Float32Array(layers * hidden), [layers, 1, hidden]);
  const vocabSize = model.vocab.length;
  const tokens: Token[] = [];
  const frame = new Float32Array(size);
  let last = model.blank;
  for (let t = 0, emitted = 0; t < frames;) {
    for (let d = 0; d < size; d++) frame[d] = data[d * stride + t];
    const step = await model.decoder.run({
      encoder_outputs: new ort.Tensor('float32', frame, [1, size, 1]),
      targets: new ort.Tensor('int32', Int32Array.from([last]), [1, 1]),
      target_length: new ort.Tensor('int32', Int32Array.from([1]), [1]),
      input_states_1: state1, input_states_2: state2
    });
    const logits = step.outputs.data as Float32Array;
    let token = 0;
    for (let v = 1; v < vocabSize; v++) if (logits[v] > logits[token]) token = v;
    let duration = 0;
    for (let k = vocabSize + 1; k < logits.length; k++) if (logits[k] > logits[vocabSize + duration]) duration = k - vocabSize;
    if (token !== model.blank) {
      state1 = step.output_states_1;
      state2 = step.output_states_2;
      let max = -Infinity;
      for (let v = 0; v < vocabSize; v++) if (logits[v] > max) max = logits[v];
      let sum = 0;
      for (let v = 0; v < vocabSize; v++) sum += Math.exp(logits[v] - max);
      tokens.push({ id: token, piece: model.vocab[token] ?? '', time: Math.round((offset + t * FRAME_SECONDS) * 1000) / 1000, probability: 1 / sum });
      last = token;
      emitted++;
    }
    if (duration > 0) { t += duration; emitted = 0; }
    else if (token === model.blank || emitted >= MAX_TOKENS_PER_FRAME) { t += 1; emitted = 0; }
  }
  outputs.dispose?.();
  return tokens;
}

// Audio longer than a window is cut into windows, each ending in the quietest 20 ms of its last
// third (a pause between words, mostly), and decoded one after the other: the encoder's attention
// grows with the square of its length (a recording of 193 s in one go peaked at 3.6 GB on an Apple
// M5, windows of 30 s at 1.5 GB with the model).
export const WINDOW_SECONDS = 30;

export function windows(samples: Float32Array, windowSeconds = WINDOW_SECONDS): { start: number; end: number }[] {
  const window = Math.round(windowSeconds * SAMPLE_RATE);
  const piece = SAMPLE_RATE / 50;
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < samples.length;) {
    if (samples.length - start <= window) { out.push({ start, end: samples.length }); break; }
    let quietest = start + window;
    let lowest = Infinity;
    for (let at = start + Math.round(window * 2 / 3); at + piece <= start + window; at += piece) {
      let energy = 0;
      for (let i = at; i < at + piece; i++) energy += samples[i] * samples[i];
      if (energy < lowest) { lowest = energy; quietest = at + Math.round(piece / 2); }
    }
    out.push({ start, end: quietest });
    start = quietest;
  }
  return out;
}

export async function parakeetTokens(model: ParakeetModel, samples: Float32Array): Promise<Token[]> {
  const tokens: Token[] = [];
  for (const { start, end } of windows(samples)) {
    // Under a tenth of a second there is nothing to hear (and the encoder wants a few frames).
    if (end - start < SAMPLE_RATE / 10) continue;
    tokens.push(...await decode(model, samples.slice(start, end), start / SAMPLE_RATE));
  }
  return tokens;
}
