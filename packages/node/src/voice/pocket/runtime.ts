import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as Ort from 'onnxruntime-node';
import { UnigramTokenizer } from './tokenizer.ts';
import { prepareText, splitIntoChunks } from './text.ts';
import type { TextRules } from './text.ts';
import { requireLocalAi } from '../../models/platform.ts';

// Kyutai's Pocket TTS run with ONNX Runtime (docs/decisions.md D25), from the ONNX export of its
// weights: a text conditioner (token → embedding), the flow language model (a transformer that, from
// the voice, the text and the frames already said, gives the conditioning of the next audio frame and
// whether speech has ended), its flow head (one step from noise to the frame's latent), and the Mimi
// decoder (latents → 24 kHz audio). Ported from Kyutai's pocket_tts (tts_model.py: _generate,
// _autoregressive_generation) and KevinAHM's pocket_tts_onnx.py.

type OrtModule = typeof Ort;
type Tensor = Ort.Tensor;
type State = Record<string, Tensor>;

interface StateEntry {
  dtype: 'float32' | 'int64' | 'bool';
  fill: 'nan' | 'zeros' | 'ones' | 'empty';
  input_name: string;
  output_name: string;
  shape: number[];
}

export interface BundleMeta {
  bundle_name: string;
  sample_rate: number;
  frame_rate: number;
  samples_per_frame: number;
  latent_dim: number;
  conditioning_dim: number;
  max_token_per_chunk: number;
  model_recommended_frames_after_eos: number | null;
  remove_semicolons: boolean;
  pad_with_spaces_for_short_inputs: boolean;
  insert_bos_before_voice: boolean;
  flow_lm_state_manifest: StateEntry[];
  mimi_state_manifest: StateEntry[];
}

// The files of a bundle on disk (models.ts downloads them).
export const BUNDLE_FILES = {
  meta: 'bundle.json',
  bos: 'bos_before_voice.npy',
  tokenizer: 'tokenizer.json',
  textConditioner: 'text_conditioner.onnx',
  flowMain: 'flow_lm_main_int8.onnx',
  flowHead: 'flow_lm_flow_int8.onnx',
  decoder: 'mimi_decoder_int8.onnx',
  encoder: 'mimi_encoder.onnx'
} as const;

// Kyutai's pocket_tts/models/tts_model.py.
const EOS_THRESHOLD = -4.0;
const MIN_FRAMES_BEFORE_EOS = 6;
const TOKENS_PER_SECOND = 3.0;
const GEN_SECONDS_PADDING = 2.0;
const DECODE_CHUNK = 15;
// A chunk that runs to its longest length without the model saying it is done, or that comes out
// silent, is a failed take (Kyutai: "this very often indicates an error"): it is said again with
// other noise, at most this many times.
const RETRIES = 2;
const SILENT_RMS = 0.005;

export interface SynthesisOptions {
  temperature: number;
  seed: number;
  rules: TextRules;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

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

// A float32 .npy array (bos_before_voice.npy), little-endian, C order.
export function readNpyFloat32(file: string): Float32Array {
  const bytes = fs.readFileSync(file);
  if (bytes.toString('latin1', 1, 6) !== 'NUMPY') throw new Error(`${file} is not a .npy file.`);
  const major = bytes[6];
  const headerLength = major === 1 ? bytes.readUInt16LE(8) : bytes.readUInt32LE(8);
  const start = (major === 1 ? 10 : 12) + headerLength;
  const header = bytes.toString('latin1', major === 1 ? 10 : 12, start);
  if (!header.includes("'<f4'")) throw new Error(`${file}: float32 expected (${header.trim()}).`);
  const data = bytes.subarray(start);
  return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

// A voice's embeddings: float16 little-endian, frames × conditioning_dim.
export function readEmbeddings(file: string): Float32Array {
  const bytes = fs.readFileSync(file);
  const halves = new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const out = new Float32Array(halves.length);
  for (let i = 0; i < halves.length; i++) {
    const h = halves[i];
    const sign = h & 0x8000 ? -1 : 1;
    const exponent = (h >> 10) & 0x1f;
    const fraction = h & 0x3ff;
    out[i] = exponent === 0 ? sign * 2 ** -14 * (fraction / 1024) : exponent === 31 ? (fraction ? Number.NaN : sign * Infinity) : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  }
  return out;
}

// A voice prompt ends on exactly 80 ms of silence (Kyutai's end_on_pause, pocket-tts #334): a prompt
// that stops on speech makes the model go on with it (a wrong first word), one that ends on a long
// silence delays the onset. Trailing 20 ms frames 35 dB below the loudest are cut, the last 20 ms
// faded out, then the pause appended.
export function endOnPause(samples: Float32Array, sampleRate: number, { pause = 0.08, fadeSeconds = 0.02, floorDb = 35 } = {}): Float32Array {
  const frame = Math.max(1, Math.floor(0.02 * sampleRate));
  const frames = Math.floor(samples.length / frame);
  if (!frames) return samples;
  const db = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i];
    db[f] = 20 * Math.log10(Math.sqrt(sum / frame) + 1e-12);
  }
  const loudest = Math.max(...db);
  let last = frames - 1;
  while (last > 0 && !(db[last] > loudest - floorDb)) last--;
  const end = (last + 1) * frame;
  const out = new Float32Array(end + Math.floor(pause * sampleRate));
  out.set(samples.subarray(0, end));
  const fade = Math.min(Math.floor(fadeSeconds * sampleRate), end);
  for (let i = 0; i < fade; i++) out[end - fade + i] *= 1 - i / Math.max(1, fade - 1);
  return out;
}

// A seeded generator of normal samples: the same take of a line is the same sound on this computer.
export function gaussian(seed: number): () => number {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  return () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    const u = Math.max(uniform(), 1e-12);
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

const rms = (samples: Float32Array): number => {
  let sum = 0;
  for (const value of samples) sum += value * value;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
};

// ONNX Runtime 1.23 aborts (« libc++abi: mutex lock failed ») when a process that has run a session
// ends with process.exit(), released or not; a process that ends on its own (the CLI sets
// process.exitCode, the MCP server ends with its input, the app kills its engine host) does not.

export class PocketModel {
  readonly meta: BundleMeta;
  readonly tokenizer: UnigramTokenizer;
  private readonly ort: OrtModule;
  private readonly bos: Float32Array;
  private readonly sessions: { textConditioner: Ort.InferenceSession; flowMain: Ort.InferenceSession; flowHead: Ort.InferenceSession; decoder: Ort.InferenceSession; encoder: Ort.InferenceSession | null };

  private constructor(ort: OrtModule, meta: BundleMeta, tokenizer: UnigramTokenizer, bos: Float32Array, sessions: PocketModel['sessions']) {
    this.ort = ort;
    this.meta = meta;
    this.tokenizer = tokenizer;
    this.bos = bos;
    this.sessions = sessions;
  }

  // threads: a small model stepping one frame at a time gains nothing past four (measured).
  static async load(dir: string, { threads = Math.min(4, Math.max(1, os.availableParallelism())), encoder = false }: { threads?: number; encoder?: boolean } = {}): Promise<PocketModel> {
    const ort = await loadOrt();
    const file = (name: string) => path.join(dir, name);
    const meta = JSON.parse(fs.readFileSync(file(BUNDLE_FILES.meta), 'utf8')) as BundleMeta;
    // No memory arena: it keeps the largest step's buffers for the session's life (300 MB more, for
    // the same speed, measured with the 24-layer model).
    const options: Ort.InferenceSession.SessionOptions = { intraOpNumThreads: threads, interOpNumThreads: 1, executionMode: 'sequential', graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
    const open = (name: string) => ort.InferenceSession.create(file(name), options);
    const [textConditioner, flowMain, flowHead, decoder, encoderSession] = await Promise.all([
      open(BUNDLE_FILES.textConditioner), open(BUNDLE_FILES.flowMain), open(BUNDLE_FILES.flowHead), open(BUNDLE_FILES.decoder),
      encoder ? open(BUNDLE_FILES.encoder) : Promise.resolve(null)
    ]);
    const bos = meta.insert_bos_before_voice ? readNpyFloat32(file(BUNDLE_FILES.bos)) : new Float32Array(0);
    return new PocketModel(ort, meta, UnigramTokenizer.fromFile(file(BUNDLE_FILES.tokenizer)), bos, { textConditioner, flowMain, flowHead, decoder, encoder: encoderSession });
  }

  async release(): Promise<void> {
    this.buffers = null;
    const { textConditioner, flowMain, flowHead, decoder, encoder } = this.sessions;
    await Promise.all([textConditioner.release(), flowMain.release(), flowHead.release(), decoder.release(), encoder?.release()]);
  }

  get sampleRate(): number { return this.meta.sample_rate; }

  private tensor(type: 'float32', data: Float32Array, dims: readonly number[]): Tensor;
  private tensor(type: 'int64', data: BigInt64Array, dims: readonly number[]): Tensor;
  private tensor(type: 'float32' | 'int64', data: Float32Array | BigInt64Array, dims: readonly number[]): Tensor {
    return new this.ort.Tensor(type, data, dims);
  }

  private initialState(manifest: readonly StateEntry[]): State {
    const state: State = {};
    for (const entry of manifest) {
      const size = entry.shape.reduce((a, b) => a * b, 1);
      if (entry.dtype === 'int64') state[entry.input_name] = new this.ort.Tensor('int64', new BigInt64Array(size), entry.shape);
      else if (entry.dtype === 'bool') state[entry.input_name] = new this.ort.Tensor('bool', new Uint8Array(size).fill(entry.fill === 'ones' ? 1 : 0), entry.shape);
      else state[entry.input_name] = new this.ort.Tensor('float32', new Float32Array(size).fill(entry.fill === 'nan' ? Number.NaN : entry.fill === 'ones' ? 1 : 0), entry.shape);
    }
    return state;
  }

  private static nextState(manifest: readonly StateEntry[], result: Ort.InferenceSession.OnnxValueMapType): State {
    const state: State = {};
    for (const entry of manifest) state[entry.input_name] = result[entry.output_name] as Tensor;
    return state;
  }

  // The flow model's state is 200 MB with the 24-layer French model (an attention cache of 1000
  // frames for each layer): its outputs are written into two sets of tensors allocated once, used in
  // turn, rather than allocated anew at every frame (a peak of 2.4 GB measured that way).
  private buffers: [State, State] | null = null;

  private async runFlow(sequence: Tensor, textEmbeddings: Tensor, input: State, output: State): Promise<{ conditioning: Tensor; eos: number }> {
    const fetches: Record<string, Tensor | null> = { conditioning: null, eos_logit: null };
    for (const entry of this.meta.flow_lm_state_manifest) fetches[entry.output_name] = output[entry.input_name];
    const result = await this.sessions.flowMain.run({ sequence, text_embeddings: textEmbeddings, ...input }, fetches as Ort.InferenceSession.FetchesType);
    return { conditioning: result.conditioning as Tensor, eos: (result.eos_logit.data as Float32Array)[0] };
  }

  // The model's state after hearing the voice (its embeddings: frames × conditioning_dim, as
  // encodeVoice gives them), from which every chunk of text is spoken.
  async voiceState(embeddings: Float32Array): Promise<State> {
    const dim = this.meta.conditioning_dim;
    if (embeddings.length % dim) throw new Error(`Voice embeddings of ${embeddings.length} values: a multiple of ${dim} expected.`);
    const prompt = new Float32Array(this.bos.length + embeddings.length);
    prompt.set(this.bos, 0);
    prompt.set(embeddings, this.bos.length);
    const manifest = this.meta.flow_lm_state_manifest;
    const result = await this.sessions.flowMain.run({
      sequence: this.tensor('float32', new Float32Array(0), [1, 0, this.meta.latent_dim]),
      text_embeddings: this.tensor('float32', prompt, [1, prompt.length / dim, dim]),
      ...this.initialState(manifest)
    });
    return PocketModel.nextState(manifest, result);
  }

  // The Mimi encoder's latents of a recording (mono, at the bundle's sample rate): a voice of the
  // catalogue is made once from its recording (scripts/pocket-voices.ts), never at the author's.
  async encodeVoice(samples: Float32Array): Promise<Float32Array> {
    if (!this.sessions.encoder) throw new Error('This model was loaded without its voice encoder.');
    const result = await this.sessions.encoder.run({ audio: this.tensor('float32', samples, [1, 1, samples.length]) });
    return Float32Array.from(result.latents.data as Float32Array);
  }

  async synthesize(text: string, voice: State, options: SynthesisOptions): Promise<Float32Array> {
    return (await this.synthesizeWithReport(text, voice, options)).samples;
  }

  // retries: how many chunks had to be said again (a runaway or a silent take).
  async synthesizeWithReport(text: string, voice: State, { temperature, seed, rules, onProgress, signal }: SynthesisOptions): Promise<{ samples: Float32Array; retries: number }> {
    const chunks = splitIntoChunks(this.tokenizer, text, rules, this.meta.max_token_per_chunk);
    const random = gaussian(seed);
    const pieces: Float32Array[] = [];
    let retries = 0;
    const weights = chunks.map((chunk) => this.tokenizer.encode(prepareText(chunk, rules).text).length);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let done = 0;
    for (const [index, chunk] of chunks.entries()) {
      const prepared = prepareText(chunk, rules);
      const framesAfterEos = this.meta.model_recommended_frames_after_eos ?? prepared.framesAfterEos + 2;
      let audio: Float32Array = new Float32Array(0);
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        const { frames, ended } = await this.latents(prepared.text, voice, { temperature, random, framesAfterEos, signal, onFrame: (fraction) => onProgress?.((done + weights[index] * fraction) / total) });
        audio = await this.decode(frames);
        const level = rms(audio);
        if (ended && Number.isFinite(level) && level >= SILENT_RMS) break;
        if (attempt === RETRIES) {
          const error = new Error('The local voice could not produce a complete, non-silent take after three attempts. No usable audio was produced.');
          Object.assign(error, { code: 'E_VOICE_SYNTHESIS' });
          throw error;
        }
        if (attempt < RETRIES) retries++;
      }
      pieces.push(audio);
      done += weights[index];
      onProgress?.(done / total);
    }
    const out = new Float32Array(pieces.reduce((n, piece) => n + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) { out.set(piece, offset); offset += piece.length; }
    return { samples: out, retries };
  }

  private async latents(text: string, voice: State, { temperature, random, framesAfterEos, signal, onFrame }: { temperature: number; random: () => number; framesAfterEos: number; signal?: AbortSignal; onFrame: (fraction: number) => void }): Promise<{ frames: Float32Array[]; ended: boolean }> {
    const { latent_dim: latentDim, conditioning_dim: dim, frame_rate: frameRate } = this.meta;
    const manifest = this.meta.flow_lm_state_manifest;
    const tokens = this.tokenizer.encode(text);
    const ids = this.tensor('int64', BigInt64Array.from(tokens, (id) => BigInt(id)), [1, tokens.length]);
    const embeddings = (await this.sessions.textConditioner.run({ token_ids: ids })).embeddings as Tensor;
    const textEmbeddings = embeddings.dims.length === 2 ? this.tensor('float32', embeddings.data as Float32Array, [1, ...embeddings.dims]) : embeddings;
    this.buffers ??= [this.initialState(manifest), this.initialState(manifest)];
    const [a, b] = this.buffers;
    // The voice's state is read, never written: the text goes on from it into a.
    await this.runFlow(this.tensor('float32', new Float32Array(0), [1, 0, latentDim]), textEmbeddings, voice, a);
    let state = a;
    let next = b;
    const noText = this.tensor('float32', new Float32Array(0), [1, 0, dim]);
    const zero = this.tensor('float32', Float32Array.of(0), [1, 1]);
    const one = this.tensor('float32', Float32Array.of(1), [1, 1]);
    const std = Math.sqrt(temperature);
    const maxFrames = Math.ceil((tokens.length / TOKENS_PER_SECOND + GEN_SECONDS_PADDING) * frameRate);
    const out: Float32Array[] = [];
    let previous = new Float32Array(latentDim).fill(Number.NaN);
    let eosStep: number | null = null;
    for (let step = 0; step < maxFrames; step++) {
      signal?.throwIfAborted();
      const result = await this.runFlow(this.tensor('float32', previous, [1, 1, latentDim]), noText, state, next);
      [state, next] = [next, state];
      const eos = result.eos > EOS_THRESHOLD;
      if (eos && eosStep === null && step >= MIN_FRAMES_BEFORE_EOS) eosStep = step;
      if (eosStep !== null && step >= eosStep + framesAfterEos) break;
      const x = new Float32Array(latentDim);
      if (temperature > 0) for (let i = 0; i < latentDim; i++) x[i] = random() * std;
      // One flow step (lsd_decode_steps 1): the latent is the noise moved along the flow from s = 0 to t = 1.
      const flow = (await this.sessions.flowHead.run({ c: result.conditioning, s: zero, t: one, x: this.tensor('float32', x, [1, latentDim]) })).flow_dir.data as Float32Array;
      for (let i = 0; i < latentDim; i++) x[i] += flow[i];
      out.push(x);
      previous = x;
      onFrame(eosStep === null ? Math.min(0.95, step / Math.max(1, tokens.length * frameRate / TOKENS_PER_SECOND)) : 0.97);
    }
    return { frames: out, ended: eosStep !== null };
  }

  private async decode(latents: readonly Float32Array[]): Promise<Float32Array> {
    const manifest = this.meta.mimi_state_manifest;
    const latentDim = this.meta.latent_dim;
    let state = this.initialState(manifest);
    const pieces: Float32Array[] = [];
    for (let start = 0; start < latents.length; start += DECODE_CHUNK) {
      const chunk = latents.slice(start, start + DECODE_CHUNK);
      const data = new Float32Array(chunk.length * latentDim);
      chunk.forEach((latent, i) => data.set(latent, i * latentDim));
      const result = await this.sessions.decoder.run({ latent: this.tensor('float32', data, [1, chunk.length, latentDim]), ...state });
      const audio = Float32Array.from(result.audio_frame.data as Float32Array);
      // A fresh Mimi state puts a small step (about -41 dBFS) in its first samples, heard as a
      // click at the start of every chunk: the first 5 ms fade in (Kyutai's _decode_audio_worker).
      if (start === 0) {
        const fade = Math.min(audio.length, Math.floor(this.meta.sample_rate / 200));
        for (let i = 0; i < fade; i++) audio[i] *= i / Math.max(1, fade - 1);
      }
      pieces.push(audio);
      state = PocketModel.nextState(manifest, result);
    }
    const out = new Float32Array(pieces.reduce((n, piece) => n + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) { out.set(piece, offset); offset += piece.length; }
    return out;
  }
}
