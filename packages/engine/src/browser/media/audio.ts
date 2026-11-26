// Sound in a browser (docs/architecture/media.md, « In a browser »): a narration line's audio as the
// desktop makes it (D24: an M4A in AAC, mono, 48 kHz, 96 kb/s, its index first, its silence cut by the
// core's rule), the samples the waveform and the word aligner read (mono, at the rate asked), and a
// sound added to the course kept or written as the core's plan says (D67). Runs in the media Worker (D106).

import { ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacketSink, Conversion, FlacOutputFormat, Input, Mp4OutputFormat, Output, StreamTarget, canEncodeAudio } from 'mediabunny';
import type { EncodedPacket, StreamTargetChunk } from 'mediabunny';
import { PEAKS_RATE, peaksOf, silenceTrim, soundPlan, SOUND_AAC_BITRATE } from '@elabora/core/media/audio';
import type { MediaInfo } from '@elabora/core/media/conformance';
import { MediaEncoderMissing, MediaNotDecodable } from './image.ts';
import { withoutNames } from './video.ts';

// The desktop's line bitrate (@elabora/node narration/audio.ts, LINE_BITRATE).
const LINE_BITRATE = 96_000;
const LINE_RATE = 48_000;

export interface SoundOptions {
  target: WritableStream<StreamTargetChunk>;
  // Whether AAC can be encoded here, the wasm encoder loaded if it must (encoders.ts, provideAac).
  aac?: () => Promise<boolean>;
  signal?: AbortSignal;
}

const inputOf = (file: Blob) => new Input({ source: new BlobSource(file, { useStreamReader: false }), formats: ALL_FORMATS });

// The decoded samples of a file's sound, one array a channel, at its own rate: each decoded sample
// laid at its time, what comes before zero (an AAC encoder's priming) and after the length its
// container says (an MP3's padding, `duration`: the probe's) left out, as ffmpeg leaves them out.
export async function decodeSound(file: Blob, name: string, duration?: number | null): Promise<{ channels: Float32Array[]; rate: number }> {
  const input = inputOf(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new MediaNotDecodable(name, 'the sound');
    if (!(await track.canDecode())) throw new MediaNotDecodable(name, `the ${track.codec ?? 'unknown'} sound`);
    const parts: { at: number; planes: Float32Array[] }[] = [];
    let rate = track.sampleRate;
    // An Opus stream's pre-skip in WebM (its OpusHead), which ffmpeg leaves out and the decoded times keep.
    const config = await track.getDecoderConfig();
    const matroska = ['WebM', 'Matroska'].includes((await input.getFormat()).name);
    const head = matroska && track.codec === 'opus' && config?.description ? bytesOf(config.description) : null;
    const preSkip = head && head.length >= 12 && head[0] === 0x4f ? head[10] | (head[11] << 8) : 0;
    let count = 1;
    for await (const sample of new AudioSampleSink(track).samples()) {
      rate = sample.sampleRate;
      count = Math.max(count, sample.numberOfChannels);
      parts.push({ at: Math.round(sample.timestamp * rate) - Math.round(preSkip * rate / 48000), planes: Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
        const plane = new Float32Array(sample.numberOfFrames);
        sample.copyTo(plane, { planeIndex, format: 'f32-planar' });
        return plane;
      }) });
      sample.close();
    }
    const end = parts.reduce((last, p) => Math.max(last, p.at + (p.planes[0]?.length ?? 0)), 0);
    const length = Math.max(0, Math.min(end, duration ? Math.round(duration * rate) : end));
    const channels = Array.from({ length: count }, () => new Float32Array(length));
    for (const { at, planes } of parts) {
      const from = Math.max(0, -at);
      const to = Math.min(planes[0]?.length ?? 0, length - at);
      if (to <= from) continue;
      for (let c = 0; c < count; c++) channels[c].set(planes[Math.min(c, planes.length - 1)].subarray(from, to), at + from);
    }
    return { channels, rate };
  } finally {
    input.dispose();
  }
}

const bytesOf = (source: AllowSharedBufferSource) => (ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source));

// Mono samples at a rate (the waveform's 8 kHz, the aligner's 16 kHz): the channels mixed as ffmpeg
// mixes them, then resampled through a windowed sinc low-passed under the new rate's half.
export async function monoSamples(file: Blob, name: string, rate: number, duration?: number | null): Promise<Float32Array> {
  const { channels, rate: from } = await decodeSound(file, name, duration);
  return resample(mixDown(channels), from, rate);
}

export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const cutoff = Math.min(1, to / from);
  const taps = 16;
  const reach = Math.ceil(taps / cutoff);
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const center = i * ratio;
    const first = Math.max(0, Math.ceil(center - reach));
    const last = Math.min(samples.length - 1, Math.floor(center + reach));
    let sum = 0, weights = 0;
    for (let s = first; s <= last; s++) {
      const x = (s - center) * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (s - center)) / (reach + 1)); // Hann window
      sum += samples[s] * sinc * w;
      weights += sinc * w;
    }
    out[i] = weights ? sum / weights : 0;
  }
  return out;
}

// A line's waveform for the Chronologie, by the core's rule on its 8 kHz samples.
export async function linePeaks(file: Blob, name: string, perSecond: number, duration?: number | null): Promise<Uint8Array> {
  return peaksOf(await monoSamples(file, name, PEAKS_RATE, duration), PEAKS_RATE, perSecond);
}

// A line's audio (D24). A file already an M4A in AAC, mono, its index first, is kept as it is unless its
// silence is to be cut (a recording); anything else is converted.
export async function lineAudio(file: Blob, name: string, info: MediaInfo, { trim, target, aac = () => canEncodeAudio('aac'), signal, encode = encodeAac }: SoundOptions & { trim: boolean; encode?: AacEncode }): Promise<{ action: 'copy' | 'encode' }> {
  if (info.audioCodec === null) throw new MediaNotDecodable(name, 'a sound');
  const conformant = info.container === 'mp4' && info.audioCodec === 'aac' && info.channels === 1 && info.kind === 'audio' && info.faststart !== false && !trim;
  if (conformant) return { action: 'copy' };
  if (!(await aac())) throw new MediaEncoderMissing(name, 'the AAC sound of a narration line');
  // Its samples as ffmpeg reads them (priming, padding and pre-skip left out, D24), its silence cut,
  // mixed down and brought to 48 kHz here: the line's length is that of these samples, whatever
  // the encoder (test/e2e/media-browser.test.ts, « a line »).
  const { channels, rate } = await decodeSound(file, name, info.duration);
  let start = 0, end = channels[0]?.length ?? 0;
  if (trim) {
    ({ start, end } = silenceTrim(channels, rate));
    if (end <= start) throw new MediaNotDecodable(name, 'a sound above silence');
  }
  const samples = resample(mixDown(channels.map((channel) => channel.subarray(start, end))), rate, LINE_RATE);
  signal?.throwIfAborted();
  const encoded = await encode(samples, LINE_RATE, LINE_BITRATE);
  signal?.throwIfAborted();
  await writeLine(encoded, await primingOf(encoded, samples), samples.length / LINE_RATE, target);
  return { action: 'encode' };
}

// An AAC encoder of mono samples into an M4A (in memory: a line lasts seconds). The browser's own or
// the wasm one (provideAac), through Mediabunny; a test gives one that primes as another would.
export type AacEncode = (samples: Float32Array, rate: number, bitrate: number) => Promise<Blob>;

export const encodeAac: AacEncode = async (samples, rate, bitrate) => {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const source = new AudioSampleSource({ codec: 'aac', bitrate });
  output.addAudioTrack(source);
  await output.start();
  const chunk = rate / 10;
  for (let at = 0; at < samples.length; at += chunk) {
    const sample = new AudioSample({ data: samples.slice(at, at + chunk), format: 'f32-planar', numberOfChannels: 1, sampleRate: rate, timestamp: at / rate });
    await source.add(sample);
    sample.close();
  }
  source.close();
  await output.finalize();
  return new Blob([target.buffer!]);
};

// A stereo pair mixed down as ffmpeg does (each side at -3 dB); other layouts averaged.
function mixDown(channels: readonly Float32Array[]): Float32Array {
  const mono = new Float32Array(channels[0]?.length ?? 0);
  const gain = channels.length === 2 ? Math.SQRT1_2 : 1 / Math.max(1, channels.length);
  for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] * gain;
  return mono;
}

// How many samples late an encoded line starts, against the samples it was made from: an encoder's
// priming it did not declare (Apple's AudioToolbox primes 2112 samples; the wasm encoder declares its
// own, read as 0 here). Found where the two agree best, around the line's first sound.
export async function primingOf(encoded: Blob, samples: Float32Array): Promise<number> {
  const { channels } = await decodeSound(encoded, 'line.m4a');
  const heard = channels[0] ?? new Float32Array(0);
  let onset = samples.findIndex((value) => Math.abs(value) > 0.01);
  if (onset < 0) return 0;
  onset = Math.max(0, onset - 256);
  const length = Math.min(4096, samples.length - onset);
  const scores = new Map<number, number>();
  let best = 0;
  for (let lag = -1024; lag <= 4096; lag++) {
    if (onset + lag < 0 || onset + lag + length > heard.length) continue;
    let dot = 0, energy = 0;
    for (let i = 0; i < length; i++) { const h = heard[onset + lag + i]; dot += samples[onset + i] * h; energy += h * h; }
    const score = energy ? dot / Math.sqrt(energy) : 0;
    scores.set(lag, score);
    best = Math.max(best, score);
  }
  // A steady sound agrees as well a period later: the nearest of the best is the line's start.
  let at = 0;
  for (const [lag, score] of scores) if (score >= best * 0.995 && Math.abs(lag) < Math.abs(at) || (score >= best * 0.995 && scores.get(at)! < best * 0.995)) at = lag;
  return Math.abs(at) <= 2 ? 0 : at;
}

// The encoded line written to its target, its packets moved earlier by the priming found: the file
// says it (an edit list), so that every player and ffmpeg start where the line starts; its last packet
// lasts only what is left of the line, so that its length is the line's, not a whole AAC frame's.
async function writeLine(encoded: Blob, priming: number, duration: number, target: WritableStream<StreamTargetChunk>): Promise<void> {
  const input = inputOf(encoded);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('The encoder gave no sound.');
    const config = await track.getDecoderConfig();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new StreamTarget(withoutNames(target)) });
    const source = new EncodedAudioPacketSource('aac');
    const rate = track.sampleRate;
    const packets: EncodedPacket[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
    output.addAudioTrack(source, { maximumPacketCount: packets.length });
    output.setMetadataTags({ creationTime: null });
    await output.start();
    for (const [i, packet] of packets.entries()) {
      const timestamp = packet.timestamp - priming / rate;
      const last = i === packets.length - 1 && duration > timestamp && duration < timestamp + packet.duration;
      await source.add(packet.clone({ timestamp, ...(last ? { duration: duration - timestamp } : {}) }), i === 0 && config ? { decoderConfig: config } : undefined);
    }
    source.close();
    await output.finalize();
  } finally {
    input.dispose();
  }
}

// A sound of assets/sounds/ (D67): kept as it came when the core's plan says so; otherwise FLAC, or
// AAC at 256 kb/s for a long or looping sound, and where this browser writes no FLAC.
export async function soundMaster(file: Blob, name: string, info: MediaInfo, { loops = false, target, aac = () => canEncodeAudio('aac'), signal }: SoundOptions & { loops?: boolean }): Promise<{ action: 'copy' | 'encode'; extension: string }> {
  if (info.kind !== 'audio' || !info.audioCodec) throw new MediaNotDecodable(name, 'a sound');
  const plan = soundPlan(info, { loops });
  if (plan.keep) return { action: 'copy', extension: plan.extension };
  const flac = plan.extension === '.flac' && await canEncodeAudio('flac');
  if (!flac && !(await aac())) throw new MediaEncoderMissing(name, 'the sound');
  const channels = Math.min(2, info.channels ?? 2);
  if (flac) await convert(file, name, target, new FlacOutputFormat(), { codec: 'flac', numberOfChannels: channels, forceTranscode: true }, undefined, signal);
  else await convert(file, name, target, new Mp4OutputFormat({ fastStart: 'reserve' }), { codec: 'aac', bitrate: SOUND_AAC_BITRATE, numberOfChannels: channels, ...((info.sampleRate ?? 0) > 48000 ? { sampleRate: 48000 } : {}), forceTranscode: true }, undefined, signal);
  return { action: 'encode', extension: flac ? '.flac' : '.m4a' };
}


async function convert(file: Blob, name: string, target: WritableStream<StreamTargetChunk>, format: Mp4OutputFormat | FlacOutputFormat, audio: NonNullable<Parameters<typeof Conversion.init>[0]['audio']>, trim: { start: number; end: number } | undefined, signal?: AbortSignal): Promise<void> {
  const input = inputOf(file);
  try {
    const output = new Output({ format, target: new StreamTarget(withoutNames(target)) });
    const conversion = await Conversion.init({ input, output, audio, video: { discard: true }, tracks: 'primary', ...(trim ? { trim } : {}), tags: { creationTime: null }, showWarnings: false });
    const lost = conversion.discardedTracks.filter((t) => t.reason !== 'discarded_by_user');
    if (!conversion.isValid || lost.length) {
      if (lost.some((t) => t.reason === 'undecodable_source_codec')) throw new MediaNotDecodable(name, 'the sound');
      throw new MediaEncoderMissing(name, `the sound (${lost.map((t) => t.reason).join(', ')})`);
    }
    const abort = () => { void conversion.cancel(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await conversion.execute();
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  } finally {
    input.dispose();
  }
}
