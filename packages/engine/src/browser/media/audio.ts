// Sound in a browser (docs/architecture/media.md, « In a browser »): a narration line's audio as the
// desktop makes it (D24: an M4A in AAC, mono, 48 kHz, 96 kb/s, its index first, its silence cut by the
// core's rule), the samples the waveform and the word aligner read (mono, at the rate asked), and a
// sound added to the course kept or written as the core's plan says (D67). Runs in the media Worker (D106).

import { ALL_FORMATS, AudioSample, AudioSampleSink, BlobSource, Conversion, FlacOutputFormat, Input, Mp4OutputFormat, Output, StreamTarget, canEncodeAudio } from 'mediabunny';
import type { StreamTargetChunk } from 'mediabunny';
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
  const mono = new Float32Array(channels[0]?.length ?? 0);
  // ffmpeg's downmix: a stereo pair at -3 dB each, other layouts averaged.
  const gain = channels.length === 2 ? Math.SQRT1_2 : 1 / channels.length;
  for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] * gain;
  return resample(mono, from, rate);
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
export async function lineAudio(file: Blob, name: string, info: MediaInfo, { trim, target, aac = () => canEncodeAudio('aac'), signal }: SoundOptions & { trim: boolean }): Promise<{ action: 'copy' | 'encode' }> {
  if (info.audioCodec === null) throw new MediaNotDecodable(name, 'a sound');
  const conformant = info.container === 'mp4' && info.audioCodec === 'aac' && info.channels === 1 && info.kind === 'audio' && info.faststart !== false && !trim;
  if (conformant) return { action: 'copy' };
  if (!(await aac())) throw new MediaEncoderMissing(name, 'the AAC sound of a narration line');
  let cut: { start: number; end: number } | undefined;
  if (trim) {
    const { channels, rate } = await decodeSound(file, name, info.duration);
    const { start, end } = silenceTrim(channels, rate);
    if (end <= start) throw new MediaNotDecodable(name, 'a sound above silence');
    cut = { start: start / rate, end: end / rate };
  }
  // A stereo pair mixed down as ffmpeg does (each side at -3 dB), not averaged as Mediabunny would.
  const stereo = info.channels === 2;
  await convert(file, name, target, new Mp4OutputFormat({ fastStart: 'reserve' }), {
    codec: 'aac', bitrate: LINE_BITRATE, sampleRate: LINE_RATE, forceTranscode: true,
    ...(stereo ? { process: downmix, processedNumberOfChannels: 1 } : { numberOfChannels: 1 })
  }, cut, signal);
  return { action: 'encode' };
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

function downmix(sample: AudioSample): AudioSample {
  const planes = [0, 1].map((planeIndex) => {
    const plane = new Float32Array(sample.numberOfFrames);
    sample.copyTo(plane, { planeIndex, format: 'f32-planar' });
    return plane;
  });
  const mono = new Float32Array(sample.numberOfFrames);
  for (let i = 0; i < mono.length; i++) mono[i] = (planes[0][i] + planes[1][i]) * Math.SQRT1_2;
  return new AudioSample({ data: mono, format: 'f32-planar', numberOfChannels: 1, sampleRate: sample.sampleRate, timestamp: sample.timestamp });
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
