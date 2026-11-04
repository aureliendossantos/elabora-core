// What each media of a course weighs in its package, at each media quality (docs/architecture/media.md,
// « A package's weight before it is built »). The types and the words are pure; @elabora/node
// packaging/weights.ts weighs the files.

import { sizeText } from '../lms/package-limits.ts';
import type { QualitySize } from '../lms/package-limits.ts';
import { PRESETS, PRESET_NAMES } from './presets.ts';
import type { MediaKind, PresetName } from './presets.ts';

// file: an asset the media qualities leave as it is (a PDF, captions); narration: a narrated screen's
// or layer's track, made from its lines; dialogue: a dialogue block's lines, one file each.
export type MediaWeightKind = MediaKind | 'file' | 'narration' | 'dialogue';

// Where the course shows or plays a media: a block of a screen (and its layer, if it is in one), a
// screen's layout (no block), a narration (its layer, if it is a layer's), or the whole module (no screen): the player's logo, a
// resource, a sound of the interface, a background track.
export interface MediaUse {
  screen: string | null;
  block?: string;
  layer?: string;
  as?: 'logo' | 'resource' | 'interface-sound' | 'background';
}

// A media in a package of one quality.
export interface MediaAtQuality {
  quality: PresetName;
  bytes: number;
  estimated: boolean;  // from bitrates: the rendition or the track is not made yet
  rendition: boolean;  // encoded from the master for this quality; false: the master as it is
  width?: number;      // as shipped (video, raster image)
  height?: number;
}

export interface MediaWeight {
  kind: MediaWeightKind;
  path: string | null; // the project's file (assets/…); null: a narration's track, a dialogue's lines
  uses: MediaUse[];    // in the course's order
  master?: number;     // bytes of the project's file (a dialogue: of its lines)
  width?: number;      // the master's, as displayed
  height?: number;
  seconds?: number;    // a video's or a sound's duration; a narration's or a dialogue's, its lines'
  lines?: number;      // a narration's or a dialogue's lines
  qualities: MediaAtQuality[];
  // It weighs more than five minutes of video at the quality of PackageWeights (heavyBytes), and why.
  heavy: boolean;
  why?: string;
}

// What a package of the course would weigh, at each quality and media by media.
export interface PackageWeights {
  quality: PresetName;    // what media are ordered by and stand out at: the course's (delivery.mediaQuality, else high) unless asked
  qualities: QualitySize[];
  media: MediaWeight[];   // heaviest first at that quality
  rest: number;           // the same at every quality: the player, its sounds, the fonts, the free objects, the texts
}

// A media stands out when it weighs more than five minutes of video at the quality's ceiling: about
// 292 MB at high, 148 MB at medium, 57 MB at low (megabytes as sizeText prints them). Ordinary videos
// of a few minutes never do; a long video still does after its resize, as a large file the qualities
// do not compress.
export const HEAVY_SECONDS = 300;
export function heavyBytes(quality: PresetName): number {
  const video = PRESETS[quality].video;
  return Math.round((HEAVY_SECONDS * (video.maxBitrate + video.audioBitrate)) / 8);
}

export const bytesAt = (media: MediaWeight, quality: PresetName): number => media.qualities.find((size) => size.quality === quality)?.bytes ?? 0;

// What makes a heavy media weigh, in English for agents, and what would lighten it.
export function heavyWhy(media: MediaWeight, quality: PresetName): string {
  const at = (q: PresetName) => sizeText(bytesAt(media, q));
  const lower = PRESET_NAMES.slice(PRESET_NAMES.indexOf(quality) + 1).filter((q) => bytesAt(media, q) < bytesAt(media, quality) * 0.95);
  const lighter = lower.map((q) => `${at(q)} at ${q}`).join(', ');
  if (media.kind === 'file') return `${at(quality)}: the media qualities leave such a file as it is. Make it lighter or split it, or link to it rather than ship it.`;
  const seconds = media.seconds ?? 0;
  const remedy = media.kind === 'video' ? 'Shorten or split it, or host it on a video platform and link to it from the course.' : 'Shorten or split it.';
  if (seconds >= HEAVY_SECONDS) {
    if (!lighter) return `${durationText(seconds)} long: ${quality === 'low' ? 'even ' : ''}${at(quality)} at ${quality}${quality === 'low' ? '' : ', and no lower quality lightens it'}. ${remedy}`;
    return `${durationText(seconds)} long: ${at(quality)} at ${quality}, still ${lighter}. ${remedy}`;
  }
  const rate = seconds ? ` (${(bytesAt(media, quality) * 8 / seconds / 1e6).toFixed(1)} Mb/s over ${durationText(seconds)})` : '';
  return `${at(quality)} at ${quality}${rate}${lighter ? `; ${lighter}` : ''}. ${lighter ? `A lower quality lightens it. ${remedy}` : remedy}`;
}

// 45 s, 4 min 30 s, 24 min, 1 h 05.
export function durationText(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return minutes >= 10 || !rest ? `${Math.round(total / 60)} min` : `${minutes} min ${rest} s`;
  }
  const minutes = Math.round(total / 60);
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}
