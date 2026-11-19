// Rules on a sound's samples that both hosts follow (docs/architecture/media.md, « One reading of the
// bytes »): where a recorded line's silence is cut, the waveform the Chronologie draws, and what an
// added sound is kept as. The desktop reads samples from ffmpeg, a browser from WebCodecs.

import type { MediaInfo } from './conformance.ts';

// A recorded line keeps 0.1 s of silence at each end: the pauses between lines come from the script
// (D24). Silence is a moving RMS under -50 dB over 20 ms on every channel, as ffmpeg's silenceremove
// measures it (start_threshold=-50dB, start_silence=0.1, detection rms, window 0.02), at each end.
export const LINE_SILENCE = { threshold: 10 ** (-50 / 20), keep: 0.1, window: 0.02 } as const;

// The samples to keep of a sound (channels of the same length, at rate): from start to end, in samples.
// A sound that is silent all along keeps nothing.
export function silenceTrim(channels: readonly Float32Array[], rate: number, rule: { threshold: number; keep: number; window: number } = LINE_SILENCE): { start: number; end: number } {
  const length = channels[0]?.length ?? 0;
  const first = firstSound(channels, rate, rule, false);
  if (first === null) return { start: 0, end: 0 };
  const last = firstSound(channels, rate, rule, true)!;
  const keep = Math.round(rule.keep * rate);
  return { start: Math.max(0, first - keep), end: Math.min(length, length - last + keep) };
}

// The first sample, from the start or from the end, whose window is above the threshold on a channel:
// as a count of samples from that end.
function firstSound(channels: readonly Float32Array[], rate: number, { threshold, window }: { threshold: number; window: number }, fromEnd: boolean): number | null {
  const length = channels[0]?.length ?? 0;
  const size = Math.max(1, Math.round(window * rate));
  const limit = threshold * threshold * size;
  const sums = channels.map(() => 0);
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels.length; c++) {
      const samples = channels[c];
      const at = fromEnd ? length - 1 - i : i;
      const value = samples[at];
      sums[c] += value * value;
      if (i >= size) { const gone = samples[fromEnd ? at + size : at - size]; sums[c] -= gone * gone; }
      if (sums[c] >= limit) return i;
    }
  }
  return null;
}

// The waveform of a line, for the Chronologie: the loudest sample of each slice, 0 to 255, perSecond
// slices a second, on mono samples at rate (8000 Hz at the desktop).
export const PEAKS_RATE = 8000;

export function peaksOf(samples: Float32Array, rate: number, perSecond: number): Uint8Array {
  const slice = rate / perSecond;
  const peaks = new Uint8Array(Math.ceil(samples.length / slice));
  for (let i = 0; i < peaks.length; i++) {
    let peak = 0;
    const end = Math.min(samples.length, Math.round((i + 1) * slice));
    for (let s = Math.round(i * slice); s < end; s++) { const value = Math.abs(samples[s]); if (value > peak) peak = value; }
    peaks[i] = Math.min(255, Math.round(peak * 255));
  }
  return peaks;
}

// What an added sound of assets/sounds/ is kept as (D67). Lossy files are kept as they came when nothing
// is cut (never encoded twice), FLAC too when it is short and does not loop. Anything else is written
// as FLAC, or as AAC at 256 kb/s for an ambience or a long sound. A host without a FLAC encoder writes
// AAC at 256 kb/s instead.
export const SOUND_KEPT: ReadonlyMap<string, string> = new Map([['flac', '.flac'], ['vorbis', '.ogg'], ['opus', '.opus'], ['aac', '.m4a'], ['mp3', '.mp3']]);
// Above this, in seconds, AAC at 256 kb/s rather than FLAC.
export const SOUND_LONG = 20;
export const SOUND_AAC_BITRATE = 256_000;

export function soundPlan(info: MediaInfo, { loops = false, trim = null, fade = null }: { loops?: boolean; trim?: { start: number; end: number } | null; fade?: number | null } = {}): { keep: boolean; extension: string } {
  const codec = info.audioCodec ?? '';
  const keep = !trim && !fade && SOUND_KEPT.has(codec) && (codec !== 'flac' || (!loops && (info.duration ?? 0) <= SOUND_LONG))
    && (codec !== 'aac' || info.container === 'mp4') && (codec !== 'opus' || info.container === 'ogg') && (codec !== 'vorbis' || info.container === 'ogg');
  if (keep) return { keep, extension: SOUND_KEPT.get(codec)! };
  const length = trim ? trim.end - trim.start : info.duration ?? 0;
  return { keep, extension: loops || length > SOUND_LONG ? '.m4a' : '.flac' };
}
