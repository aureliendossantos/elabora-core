// Canonical media formats and quality presets (docs/architecture/media.md).

import type { MediaQuality } from '@elabora/format';

export type MediaKind = 'video' | 'audio' | 'image' | 'vector';
// The presets are the values of course.json delivery.mediaQuality.
export type PresetName = MediaQuality;

export const PRESET_NAMES: readonly PresetName[] = ['high', 'medium', 'low'];

export interface VideoPreset {
  maxLongSide: number;
  crf: number;          // libx264 constant quality
  maxBitrate: number;   // bits per second, video stream (also the VBV cap of libx264)
  maxFps: number | null;
  audioBitrate: number; // bits per second
}
export interface AudioPreset { bitrate: number }
export interface ImagePreset { maxLongSide: number; quality: number }

export interface Preset {
  name: PresetName;
  video: VideoPreset;
  audio: AudioPreset;
  image: ImagePreset;
}

export const PRESETS: Readonly<Record<PresetName, Preset>> = {
  high: {
    name: 'high',
    video: { maxLongSide: 1920, crf: 21, maxBitrate: 8_000_000, maxFps: null, audioBitrate: 160_000 },
    audio: { bitrate: 160_000 },
    image: { maxLongSide: 3200, quality: 88 }
  },
  medium: {
    name: 'medium',
    video: { maxLongSide: 1280, crf: 24, maxBitrate: 4_000_000, maxFps: null, audioBitrate: 128_000 },
    audio: { bitrate: 128_000 },
    image: { maxLongSide: 2400, quality: 80 }
  },
  low: {
    name: 'low',
    video: { maxLongSide: 854, crf: 27, maxBitrate: 1_500_000, maxFps: 30, audioBitrate: 96_000 },
    audio: { bitrate: 96_000 },
    image: { maxLongSide: 1600, quality: 72 }
  }
};

export const isPresetName = (value: unknown): value is PresetName => value === 'high' || value === 'medium' || value === 'low';

// What a master must be to ship as is. Looser than the high preset on purpose: a file a little
// above it (a 9 Mb/s screen recording) is kept rather than re-encoded with generation loss.
export const CANONICAL = {
  video: {
    extension: '.mp4',
    container: 'mp4',
    videoCodec: 'h264',
    // The encoder writes High; browsers play every 8-bit 4:2:0 profile, so these are kept as is.
    profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'],
    pixelFormat: 'yuv420p',
    audioCodec: 'aac',
    maxLongSide: 1920,
    maxBitrate: 10_000_000
  },
  audio: {
    extension: '.m4a',
    container: 'mp4',
    codec: 'aac',
    alsoAccepted: { container: 'mp3', codec: 'mp3' },
    maxBitrate: 192_000
  },
  image: {
    extension: '.webp',
    formats: ['webp', 'jpeg', 'png'],
    maxLongSide: 3840,
    maxBytes: 8 * 1024 * 1024
  },
  vector: { extension: '.svg' }
} as const;

// Bumped when the encoding arguments change in a way that changes renditions, so caches refill.
export const MEDIA_PIPELINE_VERSION = 1;

// The parameters a rendition of this kind depends on: a video rendition does not change when the
// image quality of the preset does.
export function presetParameters(name: PresetName, kind: MediaKind): Record<string, unknown> {
  const preset = PRESETS[name];
  const parameters = kind === 'video' ? preset.video : kind === 'audio' ? preset.audio : kind === 'image' ? preset.image : {};
  return { pipeline: MEDIA_PIPELINE_VERSION, kind, ...parameters };
}

// Stable short hash of the parameters (FNV-1a, 64 bits, of their canonical JSON): part of the
// rendition cache key, so changing a preset never serves a stale rendition.
export function presetHash(name: PresetName, kind: MediaKind): string {
  return fnv1a64(canonicalJSON(presetParameters(name, kind))).slice(0, 12);
}

// Largest size that fits in maxLongSide, keeping the aspect ratio, never upscaling, with even
// dimensions (4:2:0 video needs them; harmless for images).
export function fitWithin(width: number, height: number, maxLongSide: number, { even = true } = {}): { width: number; height: number; scaled: boolean } {
  const scale = Math.min(1, maxLongSide / Math.max(width, height));
  // Rounding to an even number may go one pixel above the limit or the source: round down then.
  const fit = (value: number, limit: number) => {
    if (!even) return Math.max(1, Math.min(limit, Math.round(value)));
    const result = Math.round(value / 2) * 2;
    return Math.max(2, result > limit ? Math.floor(limit / 2) * 2 : result);
  };
  const w = fit(width * scale, Math.min(width, maxLongSide));
  const h = fit(height * scale, Math.min(height, maxLongSide));
  return { width: w, height: h, scaled: w !== width || h !== height };
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(record[k])}`).join(',')}}`;
}

// Over UTF-16 code units, which needs no TextEncoder (absent from pure packages' types).
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
