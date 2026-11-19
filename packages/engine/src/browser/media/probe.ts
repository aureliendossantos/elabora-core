// The facts of a file in a browser, in the desktop's form (MediaInfo, as @elabora/node media/probe.ts
// reads them from ffprobe): what an import decides on and what a copy gives its room (D106,
// docs/architecture/media.md, « In a browser »). Images are read from their headers; videos and sounds
// by Mediabunny, which reads containers without decoding. What both hosts read the same way (EXIF,
// GPS, an MP4's boxes) is the core's (@elabora/core/media/metadata). Runs in the media Worker.

import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { InputAudioTrack, InputVideoTrack } from 'mediabunny';
import { readAsync, u16be, u32be, latin1 } from '@elabora/core/media/bytes';
import type { ByteSteps } from '@elabora/core/media/bytes';
import { AVIF_BRANDS, HEIF_BRANDS, imageMetadataSteps, jpegHead, mp4LayoutSteps, ORIENTATION_DEGREES, pngChunks, webpChunks } from '@elabora/core/media/metadata';
import type { Mp4Layout } from '@elabora/core/media/metadata';
import { emptyMediaInfo, extensionOf } from '@elabora/core/media/conformance';
import type { MediaInfo } from '@elabora/core/media/conformance';

// The file cannot be read here (E_MEDIA_UNREADABLE): not a media file, or a container no browser reads.
export class MediaUnreadable extends Error {
  readonly file: string;
  constructor(file: string, reason: string) {
    super(`${file}: not a readable media file (${reason})`);
    this.file = file;
  }
}

export async function probeFile(file: Blob, name: string): Promise<MediaInfo> {
  if (extensionOf(name) === '.svg') return emptyMediaInfo('vector', 'svg', file.size);
  const read = (position: number, length: number) => slice(file, position, length);
  const head = await read(0, 32);
  const image = imageContainer(head);
  if (image) return probeImage(file, name, image, read);
  return probeStreams(file, name, read);
}

const slice = async (file: Blob, position: number, length: number) => new Uint8Array(await file.slice(position, position + length).arrayBuffer());
type Read = (position: number, length: number) => Promise<Uint8Array>;

// --- images, from their headers

type ImageKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'heif' | 'avif';

function imageContainer(head: Uint8Array): ImageKind | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (latin1(head, 1, 4) === 'PNG') return 'png';
  if (latin1(head, 0, 4) === 'GIF8') return 'gif';
  if (latin1(head, 0, 4) === 'RIFF' && latin1(head, 8, 12) === 'WEBP') return 'webp';
  if (latin1(head, 0, 2) === 'BM') return 'bmp';
  if (latin1(head, 0, 4) === 'II*\0' || latin1(head, 0, 4) === 'MM\0*') return 'tiff';
  if (latin1(head, 4, 8) === 'ftyp') {
    const brand = latin1(head, 8, 12).trim();
    if (HEIF_BRANDS.has(brand)) return 'heif';
    if (AVIF_BRANDS.has(brand)) return 'avif';
  }
  return null;
}

interface Picture { codec: string; profile?: string | null; pixelFormat: string | null; width: number | null; height: number | null; animated?: boolean }

async function probeImage(file: Blob, name: string, container: ImageKind, read: Read): Promise<MediaInfo> {
  const picture = await readAsync(pictureSteps(container, file.size), read);
  if (!picture) throw new MediaUnreadable(name, `a ${container.toUpperCase()} image whose header cannot be read`);
  const info = emptyMediaInfo('image', container, file.size);
  info.videoCodec = picture.codec;
  info.profile = picture.profile ?? null;
  info.pixelFormat = picture.pixelFormat;
  info.alpha = ALPHA_FORMATS.test(picture.pixelFormat ?? '');
  info.animated = picture.animated ?? false;
  let { width, height } = picture;
  if (container === 'jpeg' || container === 'png' || container === 'webp') {
    const meta = await readAsync(imageMetadataSteps(file.size, container), read).catch(() => null);
    info.location = !!meta?.location;
    if (meta?.orientation) info.rotation = ORIENTATION_DEGREES[meta.orientation] ?? 0;
  }
  if (info.rotation % 180 !== 0) [width, height] = [height, width];
  info.width = width;
  info.height = height;
  return info;
}

// The desktop's rule (ffprobe's pixel formats with an alpha plane, a palette included).
const ALPHA_FORMATS = /^(yuva|ya\d|rgba|bgra|argb|abgr|gbrap|pal8)/;

function* pictureSteps(container: ImageKind, size: number): ByteSteps<Picture | null> {
  if (container === 'jpeg') return yield* jpegPicture();
  if (container === 'png') return yield* pngPicture(size);
  if (container === 'gif') return yield* gifPicture(size);
  if (container === 'webp') return yield* webpPicture(size);
  if (container === 'bmp') return yield* bmpPicture();
  if (container === 'tiff') return yield* tiffPicture();
  return yield* heifPicture(container, size);
}

// ffprobe's names: the frame type (SOF0 to SOF3) and the sampling of the first component.
const JPEG_PROFILES: Readonly<Record<number, string>> = { 0xc0: 'Baseline', 0xc1: 'Sequential', 0xc2: 'Progressive', 0xc3: 'Lossless' };

function* jpegPicture(): ByteSteps<Picture | null> {
  const head = yield* jpegHead();
  const frame = head?.segments.find((s) => s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc);
  if (!frame || frame.payload.length < 6) return null;
  const p = frame.payload;
  const components = p[5];
  let pixelFormat: string | null = null;
  if (components === 1) pixelFormat = 'gray';
  else if (components === 3 && p.length >= 9) {
    const h = p[7] >> 4, v = p[7] & 0x0f;
    pixelFormat = h === 2 && v === 2 ? 'yuvj420p' : h === 2 && v === 1 ? 'yuvj422p' : h === 1 && v === 1 ? 'yuvj444p' : h === 1 && v === 2 ? 'yuvj440p' : h === 4 && v === 1 ? 'yuvj411p' : null;
  }
  return { codec: 'mjpeg', profile: JPEG_PROFILES[frame.marker] ?? null, pixelFormat, width: u16be(p, 3), height: u16be(p, 1) };
}

// ffprobe's pixel formats of a PNG, by colour type and bit depth.
const PNG_FORMATS: Readonly<Record<number, Readonly<Record<number, string>>>> = {
  0: { 1: 'monob', 2: 'gray', 4: 'gray', 8: 'gray', 16: 'gray16be' },
  2: { 8: 'rgb24', 16: 'rgb48be' },
  3: { 1: 'pal8', 2: 'pal8', 4: 'pal8', 8: 'pal8' },
  4: { 8: 'ya8', 16: 'ya16be' },
  6: { 8: 'rgba', 16: 'rgba64be' }
};

function* pngPicture(size: number): ByteSteps<Picture | null> {
  const chunks = yield* pngChunks(size);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) return null;
  const data = yield { position: ihdr.dataStart, length: 13 };
  const actl = chunks.find((c) => c.type === 'acTL');
  const frames = actl ? u32be(yield { position: actl.dataStart, length: 4 }, 0) : 1;
  return { codec: actl ? 'apng' : 'png', pixelFormat: PNG_FORMATS[data[9]]?.[data[8]] ?? null, width: u32be(data, 0), height: u32be(data, 4), animated: frames > 1 };
}

// A GIF's frames counted by walking its blocks; ffmpeg decodes every GIF to bgra.
function* gifPicture(size: number): ByteSteps<Picture | null> {
  const header = yield { position: 0, length: 13 };
  if (header.length < 13) return null;
  const width = header[6] | (header[7] << 8), height = header[8] | (header[9] << 8);
  const table = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  let p = 13 + table(header[10]);
  let frames = 0;
  function* subBlocks(): ByteSteps<boolean> {
    for (;;) {
      const length = (yield { position: p, length: 1 })[0];
      if (length === undefined) return false;
      p += 1 + length;
      if (length === 0) return true;
    }
  }
  while (p < size && frames < 2) {
    const kind = (yield { position: p, length: 1 })[0];
    if (kind === 0x2c) {
      const descriptor = yield { position: p, length: 10 };
      if (descriptor.length < 10) break;
      frames++;
      p += 10 + table(descriptor[9]) + 1; // the LZW code size, then the image's sub-blocks
      if (!(yield* subBlocks())) break;
    } else if (kind === 0x21) {
      p += 2;
      if (!(yield* subBlocks())) break;
    } else break;
  }
  return { codec: 'gif', pixelFormat: 'bgra', width, height, animated: frames > 1 };
}

function* webpPicture(size: number): ByteSteps<Picture | null> {
  const chunks = yield* webpChunks(size);
  const first = chunks?.[0];
  if (!chunks || !first) return null;
  const data = yield { position: first.dataStart, length: Math.min(first.length, 30) };
  if (first.type === 'VP8X' && data.length >= 10) {
    const flags = data[0];
    const width = 1 + (data[4] | (data[5] << 8) | (data[6] << 16)), height = 1 + (data[7] | (data[8] << 8) | (data[9] << 16));
    const animated = !!(flags & 0x02) && chunks.filter((c) => c.type === 'ANMF').length > 1;
    const lossless = chunks.some((c) => c.type === 'VP8L');
    const pixelFormat = flags & 0x02 ? 'argb' : lossless ? 'argb' : chunks.some((c) => c.type === 'ALPH') ? 'yuva420p' : 'yuv420p';
    return { codec: 'webp', pixelFormat, width, height, animated };
  }
  if (first.type === 'VP8 ' && data.length >= 10) return { codec: 'webp', pixelFormat: 'yuv420p', width: (data[6] | (data[7] << 8)) & 0x3fff, height: (data[8] | (data[9] << 8)) & 0x3fff };
  if (first.type === 'VP8L' && data.length >= 5) {
    const bits = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
    return { codec: 'webp', pixelFormat: 'argb', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function* bmpPicture(): ByteSteps<Picture | null> {
  const header = yield { position: 0, length: 30 };
  if (header.length < 30) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const bits = view.getUint16(28, true);
  const formats: Record<number, string> = { 1: 'monob', 4: 'pal8', 8: 'pal8', 16: 'rgb555le', 24: 'bgr24', 32: 'bgra' };
  return { codec: 'bmp', pixelFormat: formats[bits] ?? null, width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
}

// A TIFF's first image: its width and length tags.
function* tiffPicture(): ByteSteps<Picture | null> {
  const header = yield { position: 0, length: 8 };
  if (header.length < 8) return null;
  const little = header[0] === 0x49;
  const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(at, little);
  const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, little);
  const ifd = u32(header, 4);
  const count = u16(yield { position: ifd, length: 2 }, 0);
  const entries = yield { position: ifd + 2, length: count * 12 };
  let width: number | null = null, height: number | null = null;
  for (let i = 0; i + 12 <= entries.length; i += 12) {
    const tag = u16(entries, i), type = u16(entries, i + 2);
    const value = type === 3 ? u16(entries, i + 8) : u32(entries, i + 8);
    if (tag === 256) width = value;
    else if (tag === 257) height = value;
  }
  return { codec: 'tiff', pixelFormat: null, width, height };
}

// A HEIF or AVIF image: its largest image spatial extent (ispe), the grid's when the picture is
// tiled as a phone writes it; its rotation (irot) is applied to the size by the desktop's rule.
function* heifPicture(container: 'heif' | 'avif', size: number): ByteSteps<Picture | null> {
  const layout = yield* topBoxes(size);
  const meta = layout.find((b) => b.type === 'meta');
  if (!meta) return null;
  const bytes = yield { position: meta.start, length: Math.min(meta.size, 1024 * 1024) };
  let width = 0, height = 0;
  let profile: string | null = null, pixelFormat: string | null = null;
  const box = (at: number, type: string) => bytes[at] === type.charCodeAt(0) && latin1(bytes, at, at + 4) === type;
  for (let at = 4; at + 20 <= bytes.length; at++) {
    if (box(at, 'ispe')) {
      const w = u32be(bytes, at + 8), h = u32be(bytes, at + 12);
      if (w * h > width * height) { width = w; height = h; }
    } else if (box(at, 'av1C') && !profile) {
      // seq_profile, then the bit depth, monochrome and chroma subsampling flags.
      const flags = bytes[at + 6];
      profile = ({ 0: 'Main', 1: 'High', 2: 'Professional' } as Record<number, string>)[bytes[at + 5] >> 5] ?? null;
      const depth = flags & 0x40 ? (flags & 0x20 ? 12 : 10) : 8;
      pixelFormat = pixelFormatOf(flags & 0x10 ? 0 : flags & 0x08 ? (flags & 0x04 ? 1 : 2) : 3, depth, false);
    } else if (box(at, 'hvcC') && !profile) {
      profile = HEVC_PROFILES[bytes[at + 5] & 0x1f] ?? null;
      pixelFormat = pixelFormatOf(bytes[at + 20] & 0x03, (bytes[at + 21] & 0x07) + 8, false);
    }
  }
  return { codec: container === 'heif' ? 'hevc' : 'av1', profile, pixelFormat, width: width || null, height: height || null };
}

function* topBoxes(size: number): ByteSteps<{ type: string; start: number; size: number }[]> {
  const boxes: { type: string; start: number; size: number }[] = [];
  let position = 0;
  while (position + 8 <= size && boxes.length < 100) {
    const header = yield { position, length: 16 };
    let boxSize = u32be(header, 0);
    if (boxSize === 1 && header.length >= 16) boxSize = Number(new DataView(header.buffer, header.byteOffset).getBigUint64(8));
    else if (boxSize === 0) boxSize = size - position;
    if (boxSize < 8) break;
    boxes.push({ type: latin1(header, 4, 8), start: position, size: boxSize });
    position += boxSize;
  }
  return boxes;
}

// --- videos and sounds, by Mediabunny

const VIDEO_CODECS: Readonly<Record<string, string>> = { avc: 'h264', hevc: 'hevc', vp8: 'vp8', vp9: 'vp9', av1: 'av1', prores: 'prores' };
const AUDIO_CODECS: Readonly<Record<string, string>> = {
  'pcm-s16': 'pcm_s16le', 'pcm-s16be': 'pcm_s16be', 'pcm-s24': 'pcm_s24le', 'pcm-s24be': 'pcm_s24be', 'pcm-s32': 'pcm_s32le', 'pcm-s32be': 'pcm_s32be',
  'pcm-f32': 'pcm_f32le', 'pcm-f32be': 'pcm_f32be', 'pcm-f64': 'pcm_f64le', 'pcm-f64be': 'pcm_f64be', 'pcm-u8': 'pcm_u8', 'pcm-s8': 'pcm_s8', ulaw: 'pcm_mulaw', alaw: 'pcm_alaw'
};

async function probeStreams(file: Blob, name: string, read: Read): Promise<MediaInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const format = await input.getFormat().catch(() => null);
    if (!format) throw new MediaUnreadable(name, 'no container this browser reads');
    const iso = format.name === 'MP4' || format.name === 'QuickTime File Format';
    const layout = iso ? await readAsync(mp4LayoutSteps(file.size), read) : null;
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const kind = video ? 'video' : audio ? 'audio' : null;
    if (!kind) throw new MediaUnreadable(name, 'no audio or video stream');
    const info = emptyMediaInfo(kind, containerName(format.name, layout, name), file.size);
    const tags = await input.getMetadataTags().catch(() => ({} as Awaited<ReturnType<Input['getMetadataTags']>>));
    const mp3 = format.name === 'MP3' ? await readAsync(mp3Header(), read) : null;
    // The container's word first, as ffprobe's (Matroska's segment, an MP3's frames less its encoder's
    // padding), then the packets'.
    info.duration = round6(mp3?.duration ?? (await input.getDurationFromMetadata()) ?? await input.computeDuration());
    info.bitrate = info.duration ? Math.floor((file.size * 8) / info.duration) : null;
    info.faststart = layout?.faststart ?? null;
    info.location = Object.keys(tags.raw ?? {}).some((key) => /location|gps|xyz/i.test(key));
    const streamRates = iso || format.name === 'MP3' || format.name === 'WAVE';
    const audioBitrate = audio ? mp3 ? mp3.bitrate : await audioRate(audio, streamRates) : null;
    if (video) await videoFacts(info, video, streamRates, audioBitrate);
    if (audio) {
      const codec = await audio.getCodec();
      info.audioCodec = codec ? AUDIO_CODECS[codec] ?? codec : null;
      info.audioBitrate = audioBitrate ?? (kind === 'audio' ? info.bitrate : null);
      info.channels = await audio.getNumberOfChannels();
      info.sampleRate = await audio.getSampleRate();
      info.coverArt = kind === 'audio' && (tags.images?.length ?? 0) > 0;
    }
    return info;
  } catch (error) {
    if (error instanceof MediaUnreadable) throw error;
    throw new MediaUnreadable(name, error instanceof Error ? error.message : String(error));
  } finally {
    input.dispose();
  }
}

// The desktop's names (containerName of @elabora/node media/probe.ts): an ISO file by its brand, a
// Matroska file by its extension.
function containerName(format: string, layout: Mp4Layout | null, name: string): string {
  if (layout) return layout.brand?.trim() === 'qt' ? 'mov' : 'mp4';
  if (format === 'Matroska' || format === 'WebM') return extensionOf(name) === '.webm' ? 'webm' : 'matroska';
  const names: Record<string, string> = { MP3: 'mp3', WAVE: 'wav', Ogg: 'ogg', FLAC: 'flac', ADTS: 'aac', 'MPEG Transport Stream': 'mpegts' };
  return names[format] ?? format.toLowerCase();
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// A stream's own bitrate where ffprobe gives one: its packets' bytes over its duration in an ISO
// file, the frame header's in an MP3, the sample size's in a WAV; Matroska and Ogg give none.
async function audioRate(track: InputAudioTrack, streamRates: boolean): Promise<number | null> {
  if (!streamRates) return null;
  const codec = await track.getCodec();
  if (codec && AUDIO_CODECS[codec]) {
    const bits = Number(/\d+/.exec(AUDIO_CODECS[codec])?.[0] ?? 8);
    return (await track.getSampleRate()) * (await track.getNumberOfChannels()) * bits;
  }
  return Math.floor((await track.computePacketStats()).averageBitrate);
}

// An MP3's bitrate and duration as FFmpeg's demuxer gives them: a VBR file's bitrate from its Xing
// header (bytes over frames), any other's from its first frame's header; the duration from the
// Xing header's frames less the encoder's delay and padding of its LAME tag.
const MP3_RATES = [[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]];
const MP3_SAMPLE_RATES = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];

function* mp3Header(): ByteSteps<{ bitrate: number; duration: number | null } | null> {
  let start = 0;
  const id3 = yield { position: 0, length: 10 };
  if (latin1(id3, 0, 3) === 'ID3' && id3.length === 10) start = 10 + ((id3[6] << 21) | (id3[7] << 14) | (id3[8] << 7) | id3[9]) + (id3[5] & 0x10 ? 10 : 0);
  const bytes = yield { position: start, length: 4096 };
  for (let p = 0; p + 4 <= bytes.length; p++) {
    if (bytes[p] !== 0xff || (bytes[p + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[p + 1] >> 3) & 0x03; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
    const layer = (bytes[p + 1] >> 1) & 0x03;    // 1: layer III
    const rateIndex = bytes[p + 2] >> 4, srIndex = (bytes[p + 2] >> 2) & 0x03;
    if (version === 1 || layer !== 1 || rateIndex === 0 || rateIndex === 15 || srIndex === 3) continue;
    const mpeg1 = version === 3;
    const sampleRate = MP3_SAMPLE_RATES[mpeg1 ? 0 : version === 2 ? 1 : 2][srIndex];
    const mono = (bytes[p + 3] >> 6) === 3;
    const at = p + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
    const spf = mpeg1 ? 1152 : 576;
    const header = MP3_RATES[mpeg1 ? 0 : 1][rateIndex] * 1000;
    const tag = at + 16 <= bytes.length ? latin1(bytes, at, at + 4) : '';
    if (tag !== 'Xing' && tag !== 'Info') return { bitrate: header, duration: null };
    const flags = u32be(bytes, at + 4);
    const frames = flags & 1 ? u32be(bytes, at + 8) : 0;
    const size = flags & 2 ? u32be(bytes, at + 8 + (flags & 1 ? 4 : 0)) : 0;
    const lame = at + 8 + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0);
    const pads = lame + 24 <= bytes.length ? (bytes[lame + 21] << 16) | (bytes[lame + 22] << 8) | bytes[lame + 23] : 0;
    const samples = frames * spf - (pads >> 12) - (pads & 0xfff);
    return {
      bitrate: tag === 'Xing' && frames && size ? Math.round((size * 8 * sampleRate) / (frames * spf)) : header,
      duration: frames ? samples / sampleRate : null
    };
  }
  return null;
}

async function videoFacts(info: MediaInfo, track: InputVideoTrack, streamRates: boolean, audioBitrate: number | null): Promise<void> {
  const codec = await track.getCodec();
  info.videoCodec = codec ? VIDEO_CODECS[codec] ?? codec : null;
  const parameters = await track.getCodecParameterString();
  const colour = await track.getColorSpace();
  const config = await track.getDecoderConfig();
  const described = describe(info.videoCodec, parameters, config?.description, colour.fullRange === true);
  info.profile = described.profile;
  info.pixelFormat = described.pixelFormat;
  const aspect = await track.getPixelAspectRatio();
  info.pixelAspect = aspect.den ? round3(aspect.num / aspect.den) : 1;
  let width = await track.getCodedWidth();
  let height = await track.getCodedHeight();
  if (info.pixelAspect !== 1) width = Math.round(width * info.pixelAspect);
  // Mediabunny turns clockwise; ffprobe's display matrix, which the desktop keeps, the other way.
  info.rotation = (360 - (await track.getRotation())) % 360;
  const transfer: string | null | undefined = colour.transfer;
  info.hdr = transfer === 'pq' ? 'pq' : transfer === 'hlg' ? 'hlg' : null;
  info.alpha = ALPHA_FORMATS.test(info.pixelFormat ?? '') || await track.canBeTransparent();
  const stats = await track.computePacketStats();
  info.fps = stats.averagePacketRate && Number.isFinite(stats.averagePacketRate) ? round3(stats.averagePacketRate) : null;
  info.videoBitrate = streamRates && Number.isFinite(stats.averageBitrate) ? Math.floor(stats.averageBitrate) : info.bitrate !== null ? info.bitrate - (audioBitrate ?? 0) : null;
  if (info.rotation % 180 !== 0) [width, height] = [height, width];
  info.width = width;
  info.height = height;
}

// --- profiles and pixel formats as ffprobe names them, from the codec's parameters

const H264_PROFILES: Readonly<Record<number, string>> = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4 Predictive', 44: 'CAVLC 4:4:4' };
const HEVC_PROFILES: Readonly<Record<number, string>> = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Rext' };
const CHROMA = ['gray', '420', '422', '444'];

function pixelFormatOf(chroma: number, depth: number, fullRange: boolean): string {
  if (chroma === 0) return depth > 8 ? `gray${depth}le` : 'gray';
  const base = `yuv${CHROMA[chroma]}p`;
  if (depth > 8) return `${base}${depth}le`;
  return fullRange ? base.replace('yuv', 'yuvj') : base;
}

function describe(codec: string | null, parameters: string | null, description: AllowSharedBufferSource | undefined, fullRange: boolean): { profile: string | null; pixelFormat: string | null } {
  const parts = (parameters ?? '').split('.');
  if (codec === 'h264') {
    const profileIdc = parseInt(parts[1]?.slice(0, 2) ?? '', 16);
    const constraints = parseInt(parts[1]?.slice(2, 4) ?? '', 16);
    let profile = H264_PROFILES[profileIdc] ?? null;
    if (profileIdc === 66 && constraints & 0x40) profile = 'Constrained Baseline';
    if (profileIdc === 110 && constraints & 0x10) profile = 'High 10 Intra';
    const ext = avcExtension(description);
    const chroma = ext?.chroma ?? (profileIdc === 122 ? 2 : profileIdc === 244 || profileIdc === 44 ? 3 : 1);
    const depth = ext?.depth ?? (profileIdc === 110 ? 10 : 8);
    return { profile, pixelFormat: pixelFormatOf(chroma, depth, fullRange) };
  }
  if (codec === 'hevc') {
    const idc = Number(/^\D*(\d+)/.exec(parts[1] ?? '')?.[1]);
    const profile = HEVC_PROFILES[idc] ?? null;
    return { profile, pixelFormat: idc === 2 ? 'yuv420p10le' : idc === 1 || idc === 3 ? 'yuv420p' : null };
  }
  if (codec === 'vp9') {
    const profile = parts[1] !== undefined ? Number(parts[1]) : NaN;
    const depth = parts[3] !== undefined ? Number(parts[3]) : profile >= 2 ? 10 : 8;
    const chroma = parts[4] !== undefined ? (Number(parts[4]) <= 1 ? 1 : Number(parts[4])) : profile === 1 || profile === 3 ? 3 : 1;
    return { profile: Number.isFinite(profile) ? `Profile ${profile}` : null, pixelFormat: pixelFormatOf(chroma, depth, false) };
  }
  if (codec === 'av1') {
    const profile = ({ 0: 'Main', 1: 'High', 2: 'Professional' } as Record<number, string>)[Number(parts[1])] ?? null;
    const depth = Number(parts[3]) || 8;
    const mono = parts[4] === '1';
    const sub = parts[5] ?? '110';
    const chroma = mono ? 0 : sub.startsWith('11') ? 1 : sub.startsWith('10') ? 2 : 3;
    return { profile, pixelFormat: pixelFormatOf(chroma, depth, false) };
  }
  return { profile: null, pixelFormat: null };
}

// The avcC record's extension of the High profiles: chroma format and bit depth.
function avcExtension(description: AllowSharedBufferSource | undefined): { chroma: number; depth: number } | null {
  if (!description) return null;
  const bytes = ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description);
  if (bytes.length < 7 || ![100, 110, 122, 144].includes(bytes[1])) return null;
  let p = 5;
  const sps = bytes[p++] & 0x1f;
  for (let i = 0; i < sps && p + 2 <= bytes.length; i++) p += 2 + ((bytes[p] << 8) | bytes[p + 1]);
  if (p >= bytes.length) return null;
  const pps = bytes[p++];
  for (let i = 0; i < pps && p + 2 <= bytes.length; i++) p += 2 + ((bytes[p] << 8) | bytes[p + 1]);
  if (p + 3 > bytes.length) return null;
  return { chroma: bytes[p] & 0x03, depth: (bytes[p + 1] & 0x07) + 8 };
}

