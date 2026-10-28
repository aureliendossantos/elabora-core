// Is a media file fit to ship as a master, and what turns it into one or into a rendition. The
// snapshot keeps the verdict with each media file (FileMedia); the validator reports it
// (W_MEDIA_NOT_OPTIMIZED); @elabora/node's jobs follow the plans.

import { CANONICAL, PRESETS, fitWithin } from './presets.ts';
import type { MediaKind, PresetName } from './presets.ts';

// What probing a file tells (ffprobe, plus the MP4 box layout and image metadata read directly).
export interface MediaInfo {
  kind: MediaKind;
  // mp4 (any ISO MP4 brand, m4a included), mov, webm, matroska, mp3, wav, ogg, png, jpeg, webp,
  // gif, heif, avif, tiff, bmp, svg; ffprobe's format name for anything else.
  container: string;
  size: number;                  // bytes
  duration: number | null;       // seconds
  bitrate: number | null;        // whole file, bits per second
  videoCodec: string | null;     // ffprobe codec names: h264, hevc, prores, png, mjpeg, webp…
  profile: string | null;        // video profile as ffprobe names it: High, Main, Main 10…
  pixelFormat: string | null;
  width: number | null;          // as displayed: rotation and pixel aspect applied
  height: number | null;
  rotation: number;              // degrees (display matrix or EXIF orientation)
  pixelAspect: number;           // sample aspect ratio, 1 for square pixels
  fps: number | null;
  videoBitrate: number | null;
  hdr: 'pq' | 'hlg' | null;      // HDR transfer function
  alpha: boolean;
  animated: boolean;
  audioCodec: string | null;
  audioBitrate: number | null;
  channels: number | null;
  sampleRate: number | null;
  coverArt: boolean;             // audio file with an attached picture
  faststart: boolean | null;     // MP4 family: the index (moov) comes before the data (mdat)
  location: boolean;             // GPS position in the metadata (phone videos and photos)
}

const EXTENSION_KINDS: Readonly<Record<string, MediaKind>> = {
  '.mp4': 'video', '.m4v': 'video', '.mov': 'video', '.qt': 'video', '.webm': 'video', '.mkv': 'video', '.avi': 'video',
  '.wmv': 'video', '.mpg': 'video', '.mpeg': 'video', '.3gp': 'video', '.ogv': 'video', '.mts': 'video', '.m2ts': 'video', '.flv': 'video',
  '.m4a': 'audio', '.mp3': 'audio', '.wav': 'audio', '.aac': 'audio', '.ogg': 'audio', '.oga': 'audio', '.opus': 'audio',
  '.flac': 'audio', '.aif': 'audio', '.aiff': 'audio', '.wma': 'audio', '.caf': 'audio',
  '.webp': 'image', '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.heic': 'image', '.heif': 'image',
  '.avif': 'image', '.tif': 'image', '.tiff': 'image', '.bmp': 'image',
  '.svg': 'vector'
};

export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(EXTENSION_KINDS));

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

// Kind expected from the file name; probing decides (an .ogg may be audio or video).
export function mediaKindOfPath(path: string): MediaKind | null {
  return EXTENSION_KINDS[extensionOf(path)] ?? null;
}

export function replaceExtension(path: string, extension: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return `${dot > slash + 1 ? path.slice(0, dot) : path}${extension}`;
}

export type ConformanceFix = 'remux' | 'encode';

export interface ConformanceReason {
  code: 'container' | 'faststart' | 'location' | 'cover-art' | 'video-codec' | 'video-profile' | 'pixel-format' | 'hdr'
    | 'dimensions' | 'bitrate' | 'audio-codec' | 'audio-bitrate' | 'image-format' | 'file-size';
  message: string;
  // remux: the streams are kept, only the container changes (no quality loss); encode: re-encoded.
  fix: ConformanceFix;
  stream?: 'video' | 'audio';
}

export interface Conformance {
  conformant: boolean;
  reasons: ConformanceReason[];
}

// What a files snapshot keeps of a media file: its probe and its verdict.
export interface FileMedia extends MediaInfo, Conformance {}

// path: the file's project path; a sound of assets/sounds/ (D67) is kept as it came when it is FLAC
// or a lossy original (Vorbis, Opus, AAC, MP3): the build makes the package's M4A from it.
export function fileMedia(info: MediaInfo, path?: string): FileMedia {
  if (path !== undefined && isSoundMaster(path, info)) return { ...info, ...soundConformance(info) };
  return { ...info, ...conformance(info) };
}

export const SOUND_MASTER_CODECS: ReadonlySet<string> = new Set(['flac', 'vorbis', 'opus', 'aac', 'mp3']);
const isSoundMaster = (path: string, info: MediaInfo) => path.startsWith('assets/sounds/') && info.kind === 'audio';
function soundConformance(info: MediaInfo): Conformance {
  const reasons: ConformanceReason[] = [];
  if (!info.audioCodec || !SOUND_MASTER_CODECS.has(info.audioCodec)) reasons.push({ code: 'audio-codec', message: `Audio codec ${info.audioCodec ?? 'unknown'}: a sound is kept as FLAC, or as the lossy file it came as (Vorbis, Opus, AAC, MP3).`, fix: 'encode', stream: 'audio' });
  if (info.coverArt) reasons.push({ code: 'cover-art', message: 'Cover art inside the audio file: dead weight in a course.', fix: 'remux' });
  if (info.location) reasons.push({ code: 'location', message: 'GPS position in the metadata: it would ship with the course.', fix: 'remux' });
  return { conformant: reasons.length === 0, reasons };
}

// Whether a package at the high quality still needs a rendition of an audio master: browsers and LMS
// players need AAC or MP3 (a sound kept as FLAC, Vorbis or Opus, D67).
export const audioNeedsRendition = (info: MediaInfo): boolean => info.kind === 'audio' && info.audioCodec !== 'aac' && info.audioCodec !== 'mp3';

const mbps = (bits: number) => `${(bits / 1_000_000).toFixed(1)} Mb/s`;
const kbps = (bits: number) => `${Math.round(bits / 1000)} kb/s`;
const longSide = (info: MediaInfo) => Math.max(info.width ?? 0, info.height ?? 0);

function videoStreamReasons(info: MediaInfo): ConformanceReason[] {
  const v = CANONICAL.video;
  const reasons: ConformanceReason[] = [];
  const encode = (code: ConformanceReason['code'], message: string) => reasons.push({ code, message, fix: 'encode', stream: 'video' });
  if (info.videoCodec !== v.videoCodec) encode('video-codec', `Video codec ${info.videoCodec ?? 'unknown'}: browsers need H.264.`);
  else if (!info.profile || !(v.profiles as readonly string[]).includes(info.profile)) encode('video-profile', `H.264 profile ${info.profile ?? 'unknown'}: browsers need an 8-bit 4:2:0 profile (High).`);
  if (info.videoCodec === v.videoCodec && info.pixelFormat !== v.pixelFormat) encode('pixel-format', `Pixel format ${info.pixelFormat ?? 'unknown'}: browsers need yuv420p.`);
  if (info.hdr) encode('hdr', `HDR video (${info.hdr === 'pq' ? 'PQ' : 'HLG'}): converted to SDR for the web.`);
  if (longSide(info) > v.maxLongSide) encode('dimensions', `${info.width}×${info.height}: the long side is above ${v.maxLongSide} px.`);
  if ((info.bitrate ?? 0) > v.maxBitrate) encode('bitrate', `${mbps(info.bitrate ?? 0)}: above ${mbps(v.maxBitrate)}.`);
  return reasons;
}

function containerReasons(info: MediaInfo, expected: string, label: string): ConformanceReason[] {
  const reasons: ConformanceReason[] = [];
  if (info.container !== expected) reasons.push({ code: 'container', message: `${info.container.toUpperCase()} container: the master format is ${label}.`, fix: 'remux' });
  if (info.container === 'mp4' && info.faststart === false) reasons.push({ code: 'faststart', message: 'The MP4 index (moov) is at the end of the file: playback waits for the whole download.', fix: 'remux' });
  return reasons;
}

export function conformance(info: MediaInfo): Conformance {
  const reasons: ConformanceReason[] = [];
  if (info.kind === 'video') {
    reasons.push(...containerReasons(info, CANONICAL.video.container, 'MP4'));
    reasons.push(...videoStreamReasons(info));
    if (info.audioCodec && info.audioCodec !== CANONICAL.video.audioCodec) reasons.push({ code: 'audio-codec', message: `Audio codec ${info.audioCodec}: the master format is AAC.`, fix: 'encode', stream: 'audio' });
  } else if (info.kind === 'audio') {
    const a = CANONICAL.audio;
    const mp3 = info.container === a.alsoAccepted.container && info.audioCodec === a.alsoAccepted.codec;
    if (!mp3) reasons.push(...containerReasons(info, a.container, 'M4A'));
    if (!mp3 && info.audioCodec !== a.codec) reasons.push({ code: 'audio-codec', message: `Audio codec ${info.audioCodec ?? 'unknown'}: the master format is AAC (MP3 is accepted too).`, fix: 'encode', stream: 'audio' });
    const bitrate = info.audioBitrate ?? info.bitrate ?? 0;
    if (bitrate > a.maxBitrate) reasons.push({ code: 'audio-bitrate', message: `${kbps(bitrate)}: above ${kbps(a.maxBitrate)}.`, fix: 'encode', stream: 'audio' });
    if (info.coverArt) reasons.push({ code: 'cover-art', message: 'Cover art inside the audio file: dead weight in a course.', fix: 'remux' });
  } else if (info.kind === 'image') {
    const i = CANONICAL.image;
    if (!(i.formats as readonly string[]).includes(info.container)) reasons.push({ code: 'image-format', message: `${info.container.toUpperCase()} image: browsers need WebP, JPEG or PNG.`, fix: 'encode' });
    if (longSide(info) > i.maxLongSide) reasons.push({ code: 'dimensions', message: `${info.width}×${info.height}: the long side is above ${i.maxLongSide} px.`, fix: 'encode' });
    if (info.size > i.maxBytes) reasons.push({ code: 'file-size', message: `${(info.size / 1048576).toFixed(1)} MB: above ${i.maxBytes / 1048576} MB.`, fix: 'encode' });
  }
  if (info.location) reasons.push({ code: 'location', message: 'GPS position in the metadata: it would ship with the course.', fix: 'remux' });
  return { conformant: reasons.length === 0, reasons };
}

// How to make an output from an input:
//   copy   the file as is (byte for byte)
//   remux  the streams as they are in a new container, without metadata (images: metadata
//          removed losslessly, orientation and colour profile kept)
//   encode at least one stream is re-encoded (video and audio say which)
//   reuse  (renditions) the master already fits the preset: ship it
export interface MediaPlan {
  action: 'copy' | 'remux' | 'encode' | 'reuse';
  extension: string | null;      // of the output; null keeps the input's
  video: 'copy' | 'encode' | null;
  audio: 'copy' | 'encode' | null;
  reasons: ConformanceReason[];
}

export interface PlanOptions {
  webp?: boolean;     // the encoder can write WebP (ffmpeg built with libwebp); default true
  importing?: boolean; // imports always rewrite the container, to drop the metadata of phones
}

// Images go to WebP. Without a WebP encoder: PNG keeps transparency and animation (APNG),
// JPEG takes the rest, both accepted masters.
export function imageExtension(info: MediaInfo, { webp = true }: PlanOptions = {}): string {
  if (webp) return CANONICAL.image.extension;
  return info.alpha || info.animated ? '.png' : '.jpg';
}

// Turning an input into a master (import, or optimisation of a file dropped in assets/).
export function masterPlan(info: MediaInfo, options: PlanOptions = {}): MediaPlan {
  const { reasons } = conformance(info);
  const remuxOnly = reasons.every((r) => r.fix === 'remux');
  const plan = (action: MediaPlan['action'], extension: string | null, video: MediaPlan['video'] = null, audio: MediaPlan['audio'] = null): MediaPlan => ({ action, extension, video, audio, reasons });
  if (info.kind === 'vector') return plan('copy', null);
  if (info.kind === 'image') {
    if (!remuxOnly) return plan('encode', imageExtension(info, options), 'encode');
    return plan(options.importing || reasons.length ? 'remux' : 'copy', null);
  }
  if (info.kind === 'audio') {
    const extension = info.container === 'mp3' && info.audioCodec === 'mp3' ? null : CANONICAL.audio.extension;
    if (!remuxOnly) return plan('encode', CANONICAL.audio.extension, null, 'encode');
    if (reasons.length || (options.importing && info.container === 'mp4')) return plan('remux', extension, null, 'copy');
    return plan('copy', null);
  }
  const audio = info.audioCodec ? (reasons.some((r) => r.stream === 'audio') ? 'encode' : 'copy') : null;
  const video = reasons.some((r) => r.stream === 'video') ? 'encode' : 'copy';
  if (video === 'encode' || audio === 'encode') return plan('encode', CANONICAL.video.extension, video, audio);
  if (reasons.length || options.importing) return plan('remux', CANONICAL.video.extension, video, audio);
  return plan('copy', null, video, audio);
}

// Turning a master into a rendition at a lower preset. Streams already within the preset are
// copied, not re-encoded: a 720p master at medium only gets its audio re-encoded.
export function renditionPlan(master: MediaInfo, preset: PresetName, options: PlanOptions = {}): MediaPlan {
  const p = PRESETS[preset];
  const plan = (action: MediaPlan['action'], extension: string | null, video: MediaPlan['video'] = null, audio: MediaPlan['audio'] = null): MediaPlan => ({ action, extension, video, audio, reasons: [] });
  const tolerance = 1.05; // encoders overshoot their target a little
  if (master.kind === 'vector') return plan('reuse', null);
  // An image's quality cannot be read from the file: always encoded, kept only if smaller.
  if (master.kind === 'image') return plan('encode', imageExtension(master, options), 'encode');
  const audioFits = (bitrate: number) => master.audioCodec === 'aac' && (master.audioBitrate ?? bitrate) <= bitrate * tolerance;
  if (master.kind === 'audio') {
    if ((master.audioCodec === 'aac' || master.audioCodec === 'mp3') && (master.audioBitrate ?? master.bitrate ?? Infinity) <= p.audio.bitrate * tolerance) return plan('reuse', null);
    return plan('encode', CANONICAL.audio.extension, null, 'encode');
  }
  const masterReasons = conformance(master).reasons;
  const videoFits = !masterReasons.some((r) => r.stream === 'video')
    && longSide(master) <= p.video.maxLongSide
    && (master.videoBitrate ?? master.bitrate ?? Infinity) <= p.video.maxBitrate * tolerance
    && (p.video.maxFps === null || (master.fps ?? 0) <= p.video.maxFps + 0.5);
  const video = videoFits ? 'copy' : 'encode';
  const audio = master.audioCodec ? (audioFits(p.video.audioBitrate) ? 'copy' : 'encode') : null;
  if (video === 'copy' && audio !== 'encode' && master.container === 'mp4' && master.faststart !== false) return plan('reuse', null, video, audio);
  return plan(video === 'copy' && audio !== 'encode' ? 'remux' : 'encode', CANONICAL.video.extension, video, audio);
}

// Output size of a video or image at a preset (downscale only, aspect kept, even sides).
export function presetDimensions(info: MediaInfo, preset: PresetName): { width: number; height: number } | null {
  if (!info.width || !info.height) return null;
  const max = info.kind === 'image' ? PRESETS[preset].image.maxLongSide : PRESETS[preset].video.maxLongSide;
  const { width, height } = fitWithin(info.width, info.height, max, { even: info.kind === 'video' });
  return { width, height };
}

// Expected size of a master's rendition at a preset, before it exists: the master itself when it
// already fits the preset; otherwise from the bitrates (the video bitrate scaled by the pixel count
// to the power 0.75, as bitrate grows slower than the pixel count, and capped by the preset). An
// estimate for E_PACKAGE_TOO_LARGE: renditions that exist are measured instead.
export function estimateBytes(info: MediaInfo, preset: PresetName): number {
  if (preset === 'high' || info.kind === 'vector') return info.size;
  const plan = renditionPlan(info, preset);
  if (plan.action === 'reuse') return info.size;
  const p = PRESETS[preset];
  const dims = presetDimensions(info, preset);
  const pixels = dims && info.width && info.height ? (dims.width * dims.height) / (info.width * info.height) : 1;
  const estimate = (bytes: number) => Math.min(info.size, Math.round(bytes));
  if (info.kind === 'image') return estimate(info.size * pixels * (preset === 'medium' ? 0.7 : 0.5));
  const duration = info.duration ?? 0;
  if (info.kind === 'audio') return estimate((duration * Math.min(info.audioBitrate ?? info.bitrate ?? 0, p.audio.bitrate)) / 8);
  const sourceVideo = info.videoBitrate ?? info.bitrate ?? 0;
  const video = plan.video === 'copy' ? sourceVideo : Math.min(sourceVideo * pixels ** 0.75, p.video.maxBitrate);
  const audioTarget = info.channels === 1 ? p.video.audioBitrate / 2 : p.video.audioBitrate;
  const audio = !info.audioCodec ? 0 : plan.audio === 'copy' ? (info.audioBitrate ?? 0) : Math.min(info.audioBitrate ?? audioTarget, audioTarget);
  return estimate((duration * (video + audio) * 1.01) / 8); // about 1 % of container
}

// Where an optimised file goes: same folder and name, the master format's extension.
export function canonicalPath(path: string, info: MediaInfo, options: PlanOptions = {}): string {
  const { extension } = masterPlan(info, options);
  return extension && extension !== extensionOf(path) ? replaceExtension(path, extension) : path;
}
