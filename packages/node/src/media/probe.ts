import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { projectDataDir } from '../data-dir.ts';
import { extensionOf, mediaKindOfPath } from '@elabora/core/media/conformance';
import type { MediaInfo } from '@elabora/core/media/conformance';
import { readImageMetadata } from './metadata.ts';
import { findMediaTools, findProberSync, MediaToolsError } from './tools.ts';
import type { MediaTools, Prober } from './tools.ts';
import { writeFileAtomic } from './files.ts';

// ffprobe's JSON turned into MediaInfo, plus what ffprobe does not say: whether an MP4's index
// comes first (top-level boxes read directly) and the EXIF orientation and GPS of images. The
// probing is written once (probeSteps) and driven asynchronously (media jobs) or synchronously
// (the snapshot of a folder, read synchronously by the CLI and the MCP server).

export class MediaProbeError extends Error {
  readonly code = 'E_MEDIA_UNREADABLE';
  readonly file: string;
  constructor(file: string, message: string) {
    super(`${path.basename(file)}: ${message}`);
    this.name = 'MediaProbeError';
    this.file = file;
  }
}

export interface ProbeOptions { tools?: MediaTools }

const IMAGE_CODECS: Readonly<Record<string, string>> = { mjpeg: 'jpeg', png: 'png', apng: 'png', webp: 'webp', gif: 'gif', tiff: 'tiff', bmp: 'bmp', hevc: 'heif', av1: 'avif' };
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const ORIENTATION_DEGREES: Readonly<Record<number, number>> = { 3: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

// The probe of a file as steps: each yield asks for an ffprobe run with these arguments and
// receives its output. major: the ffmpeg major version (stream groups need 7 or later).
function* probeSteps(file: string, major: number | null): Generator<string[], MediaInfo, string> {
  let stat: fs.Stats | null = null;
  try { stat = fs.statSync(file); } catch { /* reported below */ }
  if (!stat?.isFile()) throw new MediaProbeError(file, 'file not found');
  if (extensionOf(file) === '.svg') return emptyInfo('vector', 'svg', stat.size);
  const output = yield ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...(major !== null && major >= 7 ? ['-show_stream_groups'] : []), file];
  let raw: FfprobeOutput;
  try { raw = JSON.parse(output) as FfprobeOutput; } catch { throw new MediaProbeError(file, 'ffprobe gave no readable answer'); }
  const format = raw.format ?? {};
  const streams = raw.streams ?? [];
  const formatName = format.format_name ?? '';
  const layout = /mp4|mov/.test(formatName) ? readMp4LayoutSync(file) : null;
  const brand = (layout?.brand ?? format.tags?.major_brand ?? '').trim();
  const heif = HEIF_BRANDS.has(brand) || AVIF_BRANDS.has(brand);

  const pictures = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1);
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const imageFormat = heif || formatName.endsWith('_pipe') || ['image2', 'gif', 'apng'].includes(formatName) || formatName.startsWith('webp');
  const kind = video && imageFormat ? 'image' : video ? 'video' : audio ? 'audio' : null;
  if (!kind) throw new MediaProbeError(file, 'no audio or video stream');

  const info = emptyInfo(kind, containerName(formatName, brand, kind === 'image' ? video?.codec_name : undefined, file), stat.size);
  if (kind !== 'image') {
    info.duration = number(format.duration) ?? number(video?.duration) ?? number(audio?.duration);
    info.bitrate = number(format.bit_rate) ?? (info.duration ? Math.round((stat.size * 8) / info.duration) : null);
    info.faststart = layout?.faststart ?? null;
    info.location = hasLocation(format.tags) || streams.some((s) => hasLocation(s.tags));
  }
  if (video) {
    info.videoCodec = video.codec_name ?? null;
    info.profile = video.profile ?? null;
    info.pixelFormat = video.pix_fmt ?? null;
    info.pixelAspect = ratio(video.sample_aspect_ratio) || 1;
    const grid = raw.stream_groups?.find((g) => g.type === 'Tile Grid')?.components?.[0];
    let width = grid?.width ?? video.width ?? null;
    let height = grid?.height ?? video.height ?? null;
    if (width && info.pixelAspect !== 1) width = Math.round(width * info.pixelAspect);
    const matrix = video.side_data_list?.find((d) => typeof d.rotation === 'number');
    info.rotation = normaliseDegrees(matrix?.rotation ?? number(video.tags?.rotate) ?? 0);
    info.hdr = video.color_transfer === 'smpte2084' ? 'pq' : video.color_transfer === 'arib-std-b67' ? 'hlg' : null;
    info.alpha = /^(yuva|ya\d|rgba|bgra|argb|abgr|gbrap|pal8)/.test(video.pix_fmt ?? '');
    if (kind === 'video') {
      info.fps = ratio(video.avg_frame_rate) || ratio(video.r_frame_rate) || null;
      info.videoBitrate = number(video.bit_rate) ?? (info.bitrate !== null ? info.bitrate - (number(audio?.bit_rate) ?? 0) : null);
    } else {
      // Animated GIF, WebP or APNG: several frames. GIF reports its frame count; the others are counted.
      if (['gif', 'apng', 'webp'].includes(video.codec_name ?? '')) {
        const frames = number(video.nb_frames);
        info.animated = frames !== null ? frames > 1 : Number((yield ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]).trim()) > 1;
      }
      if (info.container === 'jpeg' || info.container === 'png' || info.container === 'webp') {
        let meta: ReturnType<typeof readImageMetadata> | null = null;
        try { meta = readImageMetadata(file, info.container); } catch { /* unreadable metadata: none */ }
        info.location = !!meta?.location;
        if (meta?.orientation) info.rotation = ORIENTATION_DEGREES[meta.orientation] ?? 0;
      }
    }
    if (info.rotation % 180 !== 0) [width, height] = [height, width];
    info.width = width;
    info.height = height;
  }
  if (audio) {
    info.audioCodec = audio.codec_name ?? null;
    info.audioBitrate = number(audio.bit_rate) ?? (kind === 'audio' ? info.bitrate : null);
    info.channels = audio.channels ?? null;
    info.sampleRate = number(audio.sample_rate);
    info.coverArt = kind === 'audio' && pictures.length > 0;
  }
  return info;
}

const failure = (file: string, stderr: string, fallback: string) => new MediaProbeError(file, `not a readable media file (${(stderr || fallback).trim().split('\n').pop()})`);

export async function probeMedia(file: string, { tools }: ProbeOptions = {}): Promise<MediaInfo> {
  // SVG needs no ffprobe.
  const t = tools ?? (extensionOf(file) === '.svg' ? null : await findMediaTools());
  const steps = probeSteps(file, t?.major ?? null);
  let step = steps.next();
  while (!step.done) {
    const args = step.value;
    const output = await new Promise<string>((resolve, reject) => {
      execFile(t!.ffprobe, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject(failure(file, String(stderr), error.message));
        else resolve(stdout);
      });
    });
    step = steps.next(output);
  }
  return step.value;
}

// The same, synchronously. prober: findProberSync(); without one, only SVG can be probed.
export function probeMediaSync(file: string, prober: Prober | null = findProberSync()): MediaInfo {
  const steps = probeSteps(file, prober?.major ?? null);
  let step = steps.next();
  while (!step.done) {
    if (!prober) throw new MediaToolsError('ffprobe not found. Install ffmpeg (it includes ffprobe) or set ELABORA_FFPROBE to the executable.', ['ffprobe']);
    const run = spawnSync(prober.ffprobe, step.value, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (run.status !== 0) throw failure(file, run.stderr ?? '', run.error?.message ?? `ffprobe exited with ${run.status}`);
    step = steps.next(run.stdout);
  }
  return step.value;
}

function emptyInfo(kind: MediaInfo['kind'], container: string, size: number): MediaInfo {
  return {
    kind, container, size, duration: null, bitrate: null,
    videoCodec: null, profile: null, pixelFormat: null, width: null, height: null, rotation: 0, pixelAspect: 1, fps: null, videoBitrate: null,
    hdr: null, alpha: false, animated: false,
    audioCodec: null, audioBitrate: null, channels: null, sampleRate: null, coverArt: false,
    faststart: null, location: false
  };
}

function containerName(formatName: string, brand: string, imageCodec: string | undefined, file: string): string {
  if (imageCodec) {
    if (HEIF_BRANDS.has(brand)) return 'heif';
    if (AVIF_BRANDS.has(brand)) return 'avif';
    return IMAGE_CODECS[imageCodec] ?? formatName.replace(/_pipe$/, '');
  }
  if (/mp4|mov/.test(formatName)) return brand === 'qt' ? 'mov' : 'mp4';
  if (formatName.includes('matroska')) return extensionOf(file) === '.webm' ? 'webm' : 'matroska';
  return formatName.split(',')[0];
}

const hasLocation = (tags: Record<string, string> | undefined) => !!tags && Object.keys(tags).some((k) => /location|gps/i.test(k));
const normaliseDegrees = (degrees: number) => ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;

function number(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function ratio(value: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?)[:/](\d+(?:\.\d+)?)$/.exec(value ?? '');
  if (!m || Number(m[2]) === 0) return 0;
  return Math.round((Number(m[1]) / Number(m[2])) * 1000) / 1000;
}

// --- MP4 top-level boxes

export interface Mp4Layout {
  brand: string | null;      // major brand of ftyp
  faststart: boolean | null; // moov before the first mdat; null without moov
  boxes: string[];           // top-level box types in file order
}

export function readMp4LayoutSync(file: string): Mp4Layout {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    const boxes: string[] = [];
    let brand: string | null = null;
    let position = 0;
    while (position + 8 <= size && boxes.length < 10_000) {
      const bytesRead = fs.readSync(fd, header, 0, 16, position);
      if (bytesRead < 8) break;
      const type = header.toString('latin1', 4, 8);
      let boxSize = header.readUInt32BE(0);
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        boxSize = Number(header.readBigUInt64BE(8));
      } else if (boxSize === 0) {
        boxSize = size - position; // extends to the end of the file
      }
      if (boxSize < 8) break;
      if (type === 'ftyp' && bytesRead >= 12) brand = header.toString('latin1', 8, 12);
      boxes.push(type);
      if (boxes.includes('moov') && boxes.includes('mdat')) break;
      position += boxSize;
    }
    const moov = boxes.indexOf('moov');
    const mdat = boxes.indexOf('mdat');
    return { brand, faststart: moov < 0 ? null : mdat < 0 || moov < mdat, boxes };
  } finally {
    fs.closeSync(fd);
  }
}

export const readMp4Layout = async (file: string): Promise<Mp4Layout> => readMp4LayoutSync(file);

// --- project cache: <data dir>/media/probe-cache.json, keyed by path, size and mtime. Files that
// cannot be probed are cached with their error, so they are not probed again at every snapshot.

const CACHE_VERSION = 2;
export const probeCachePath = (projectDir: string) => path.join(projectDataDir(projectDir), 'media', 'probe-cache.json');

interface CacheEntry { size: number; mtimeMs: number; info?: MediaInfo; error?: string }
interface CacheFile { version: number; entries: Record<string, CacheEntry> }

// A file modified this shortly before it was probed may change again within the same timestamp
// tick and keep its size and time: such entries are not cached (as hashes are not).
const RACY_MS = 2_000;

function readCache(projectDir: string): CacheFile {
  try {
    const value = JSON.parse(fs.readFileSync(probeCachePath(projectDir), 'utf8')) as CacheFile;
    if (value.version === CACHE_VERSION && value.entries && typeof value.entries === 'object') return value;
  } catch { /* missing or unreadable: start again */ }
  return { version: CACHE_VERSION, entries: {} };
}

// Another process may have added entries since we read: merge, then write atomically. keep: when
// given, the only paths whose entries stay (the snapshot knows every media file of the project).
function writeCache(projectDir: string, updates: Record<string, CacheEntry>, keep?: ReadonlySet<string>): void {
  const current = readCache(projectDir);
  const stale = keep ? Object.keys(current.entries).filter((p) => !keep.has(p)) : [];
  if (!Object.keys(updates).length && !stale.length) return;
  for (const p of stale) delete current.entries[p];
  Object.assign(current.entries, updates);
  const sorted = Object.fromEntries(Object.entries(current.entries).sort(([a], [b]) => (a < b ? -1 : 1)));
  try {
    writeFileAtomic(probeCachePath(projectDir), `${JSON.stringify({ version: CACHE_VERSION, entries: sorted })}\n`);
  } catch { /* read-only data folder: probed again next time */ }
}

const fresh = (entry: CacheEntry | undefined, size: number, mtimeMs: number): entry is CacheEntry => !!entry && entry.size === size && entry.mtimeMs === mtimeMs;

const cacheEntry = (size: number, mtimeMs: number, probedAt: number, result: { info: MediaInfo } | { error: string }): CacheEntry | null =>
  probedAt - mtimeMs < RACY_MS ? null : { size, mtimeMs, ...result };

export interface ListedMediaFile { path: string; size: number; mtimeMs: number }

export interface ProjectMedia {
  media: Map<string, MediaInfo>;                    // by project-relative path
  unreadable: { path: string; message: string }[];  // not media, or damaged
  toolsMissing: boolean;                            // some files were not probed: no ffprobe
}

// The media files of a project folder, as the snapshot lists them (path, size, mtime): from the
// cache, probing only new or changed files, synchronously. Without ffprobe, cached answers are
// still given.
export function probeProjectMediaSync(projectDir: string, files: readonly ListedMediaFile[], prober?: Prober | null): ProjectMedia {
  const cache = readCache(projectDir);
  const updates: Record<string, CacheEntry> = {};
  const out: ProjectMedia = { media: new Map(), unreadable: [], toolsMissing: false };
  let tool = prober;
  for (const f of files) {
    const entry = cache.entries[f.path];
    if (fresh(entry, f.size, f.mtimeMs)) {
      if (entry.info) out.media.set(f.path, entry.info);
      else out.unreadable.push({ path: f.path, message: entry.error ?? 'not a readable media file' });
      continue;
    }
    tool ??= findProberSync();
    if (!tool) { out.toolsMissing = true; continue; }
    const probedAt = Date.now();
    let result: { info: MediaInfo } | { error: string };
    try {
      result = { info: probeMediaSync(path.join(projectDir, f.path), tool) };
      out.media.set(f.path, result.info);
    } catch (error) {
      if (!(error instanceof MediaProbeError)) throw error;
      result = { error: error.message };
      out.unreadable.push({ path: f.path, message: error.message });
    }
    const updated = cacheEntry(f.size, f.mtimeMs, probedAt, result);
    if (updated) updates[f.path] = updated;
  }
  writeCache(projectDir, updates, new Set(files.map((f) => f.path)));
  return out;
}

// Probes project files (project-relative POSIX paths) through the same cache, asynchronously.
// Files that cannot be probed map to their error: MediaProbeError, or MediaToolsError when ffprobe
// is missing.
export async function probeProjectMedia(projectDir: string, relPaths: string[], options: ProbeOptions = {}): Promise<Map<string, MediaInfo | MediaProbeError | MediaToolsError>> {
  const cache = readCache(projectDir);
  const updates: Record<string, CacheEntry> = {};
  const results = new Map<string, MediaInfo | MediaProbeError | MediaToolsError>();
  const queue = [...new Set(relPaths)];
  const worker = async () => {
    for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
      const file = path.join(projectDir, rel);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat) { results.set(rel, new MediaProbeError(file, 'file not found')); continue; }
      const entry = cache.entries[rel];
      if (fresh(entry, stat.size, stat.mtimeMs)) { results.set(rel, entry.info ?? new MediaProbeError(file, entry.error ?? 'not a readable media file')); continue; }
      const probedAt = Date.now();
      let result: { info: MediaInfo } | { error: string };
      try {
        result = { info: await probeMedia(file, options) };
        results.set(rel, result.info);
      } catch (error) {
        if (error instanceof MediaToolsError) { results.set(rel, error); continue; }
        if (!(error instanceof MediaProbeError)) throw error;
        result = { error: error.message };
        results.set(rel, error);
      }
      const updated = cacheEntry(stat.size, stat.mtimeMs, probedAt, result);
      if (updated) updates[rel] = updated;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  writeCache(projectDir, updates);
  return new Map(relPaths.map((rel) => [rel, results.get(rel)!]));
}

export async function probeProjectFile(projectDir: string, relPath: string, options: ProbeOptions = {}): Promise<MediaInfo> {
  const result = (await probeProjectMedia(projectDir, [relPath], options)).get(relPath)!;
  if (result instanceof Error) throw result;
  return result;
}

// Records the probe of a file a job just wrote, so the next snapshot does not probe it again.
export function rememberProbe(projectDir: string, relPath: string, info: MediaInfo): void {
  const stat = fs.statSync(path.join(projectDir, relPath));
  writeCache(projectDir, { [relPath]: { size: stat.size, mtimeMs: stat.mtimeMs, info: { ...info, size: stat.size } } });
}

// --- ffprobe JSON (the parts read)

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  duration?: string;
  nb_frames?: string;
  channels?: number;
  sample_rate?: string;
  color_transfer?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> };
  streams?: FfprobeStream[];
  stream_groups?: { type?: string; components?: { width?: number; height?: number }[] }[];
}
