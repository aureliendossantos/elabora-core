// What each media of a course weighs in its package, at each media quality (docs/architecture/media.md,
// « A package's weight before it is built »). The types and the words are pure; @elabora/node
// packaging/weights.ts weighs the files.

import { sizeText } from '../lms/package-limits.ts';
import type { QualitySize } from '../lms/package-limits.ts';
import { renditionPlan } from './conformance.ts';
import type { FileMedia } from './conformance.ts';
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
  // It seems heavier than it needs to be at the quality of PackageWeights, for a reason its file
  // shows (weightNotice). Absent for nearly every media: a long video that weighs is not one.
  notice?: WeightNotice;
}

// What a package of the course would weigh, at each quality and media by media.
export interface PackageWeights {
  quality: PresetName;    // what media are ordered by and noticed at: the course's (delivery.mediaQuality, else high) unless asked
  qualities: QualitySize[];
  media: MediaWeight[];   // heaviest first at that quality
  rest: number;           // the same at every quality: the player, its sounds, the fonts, the free objects, the texts
}

// Why a media weighs more than it needs to, measured on its file rather than against a size: a
// long video of 500 MB is what it is, a picture of 6 MB is often a photo saved as PNG.
//   not-optimized  a video or an image not in its web format (W_MEDIA_NOT_OPTIMIZED), shipped as it is
//   animated       an animated image (GIF, animated WebP or PNG), which a video makes several times lighter
//   dense-image    a still image shipped as it is with more than a byte a pixel (a photo saved as PNG)
//   dense-video    a video whose own stream ships at more than twice the bitrate Elabora would spend on
//                  its size and frame rate (a 720p screen recording exported at 10 Mb/s)
// why: in English for agents, what it is and what lightens it.
export type WeightNoticeReason = 'not-optimized' | 'animated' | 'dense-image' | 'dense-video';
export interface WeightNotice {
  reason: WeightNoticeReason;
  why: string;
}

// Below it, what a media could save is not worth an author's attention.
export const NOTICE_BYTES = 2 * 1024 * 1024;
// A photo in WebP or JPEG takes about 0.2 to 0.4 bytes a pixel; above 1, it is barely compressed.
export const DENSE_IMAGE_BYTES_PER_PIXEL = 1;
export const DENSE_VIDEO_RATIO = 2;

// The bitrate Elabora spends at most on a video of this size and frame rate: the high quality's
// ceiling for 1080p at 30 fps, scaled by the pixels a second to the power 0.75 as estimateBytes does
// (bitrate grows slower than the pixel count).
export function videoCeiling(width: number, height: number, fps: number): number {
  return PRESETS.high.video.maxBitrate * ((width * height * fps) / (1920 * 1080 * 30)) ** 0.75;
}

export const bytesAt = (media: MediaWeight, quality: PresetName): number => media.qualities.find((size) => size.quality === quality)?.bytes ?? 0;

// The media noticed first, then the others, each heaviest first: the order a list shows them in.
export const noticedFirst = (media: readonly MediaWeight[]): MediaWeight[] => [...media.filter((one) => one.notice), ...media.filter((one) => !one.notice)];

// Whether a media of the list seems heavier than it needs to be at the quality, from its master's probe
// (FileMedia): null for nearly all. A media under NOTICE_BYTES, a narration track, a dialogue and a file
// the qualities leave as they are never are; neither is a rendition, Elabora's own encoding, except as an
// animated image or for a video stream it copies.
export function weightNotice(media: MediaWeight, info: FileMedia | undefined, quality: PresetName): WeightNotice | null {
  const at = media.qualities.find((size) => size.quality === quality);
  if (!info || !at || !media.path || at.bytes < NOTICE_BYTES) return null;
  const size = sizeText(at.bytes);
  const pixels = info.width && info.height ? `${info.width}×${info.height}` : '';
  if (info.kind === 'image' && info.animated) {
    return { reason: 'animated', why: `An animated image of ${size}${pixels ? ` (${pixels}${info.duration ? `, ${durationText(info.duration)}` : ''})` : ''}: as a video (MP4) it would weigh several times less. Make it a video and show it in a video block.` };
  }
  const reasons = info.reasons.filter((reason) => reason.fix === 'encode');
  if (!at.rendition && !info.conformant && reasons.length && (info.kind === 'video' || info.kind === 'image')) {
    return { reason: 'not-optimized', why: `Not in its web format (${reasons.map((reason) => reason.message.replace(/\.$/, '')).join('; ')}): at ${quality} it ships as it is, ${size}. \`elabora media optimize ${media.path}\` makes it a web master, usually much lighter.` };
  }
  if (info.kind === 'image' && !at.rendition && info.width && info.height) {
    const perPixel = at.bytes / (info.width * info.height);
    if (perPixel > DENSE_IMAGE_BYTES_PER_PIXEL) {
      const saved = info.container === 'png' ? 'a photo or a detailed picture saved as PNG, most likely' : 'saved at a very high quality';
      return { reason: 'dense-image', why: `${size} for ${pixels} px, ${perPixel.toFixed(1)} bytes a pixel where a photo in WebP or JPEG takes about 0.3: ${saved}. As WebP${info.alpha ? '' : ' or JPEG'} it would weigh several times less: save it again that way and replace it.${quality === 'high' ? ' The lower qualities re-encode it as WebP.' : ''}` };
    }
  }
  if (info.kind === 'video' && info.width && info.height) {
    const bitrate = info.videoBitrate ?? info.bitrate;
    const kept = quality === 'high' || renditionPlan(info, quality).video === 'copy';
    const fps = info.fps ?? 30;
    const ceiling = videoCeiling(info.width, info.height, fps);
    if (kept && bitrate && bitrate > DENSE_VIDEO_RATIO * ceiling) {
      const rate = (bits: number) => `${(bits / 1e6).toFixed(1)} Mb/s`;
      const seconds = info.duration ?? media.seconds;
      // The first lower quality that lightens it (to 95 % or less).
      const lower = media.qualities.slice(PRESET_NAMES.indexOf(quality) + 1).find((one) => one.bytes < at.bytes * 0.95);
      const lowerText = lower ? `, or choose a lower quality, which re-encodes it (at ${lower.quality}, ${lower.estimated ? 'about ' : ''}${sizeText(lower.bytes)})` : '';
      return { reason: 'dense-video', why: `${rate(bitrate)} for ${pixels} at ${Math.round(fps)} fps, more than twice the ${rate(ceiling)} Elabora spends at most on a video of that size: ${size}${seconds ? ` for ${durationText(seconds)}` : ''}. Export it again at a lower bitrate and replace it${lowerText}.` };
    }
  }
  return null;
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
