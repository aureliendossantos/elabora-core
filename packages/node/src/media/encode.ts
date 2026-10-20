import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { extensionOf } from '@elabora/core/media/conformance';
import type { MediaInfo, MediaPlan } from '@elabora/core/media/conformance';
import { PRESETS } from '@elabora/core/media/presets';
import type { PresetName, VideoPreset } from '@elabora/core/media/presets';
import type { H264Encoder, MediaTools } from './tools.ts';

// ffmpeg command lines for each kind and preset, and the process that runs them (progress,
// cancellation). Outputs never carry metadata: phone videos and photos hold GPS positions.

export interface EncodeRequest {
  input: string;
  output: string;     // file to write; the caller moves it into place once complete
  info: MediaInfo;    // probe of the input
  plan: MediaPlan;    // action 'remux' or 'encode' (masterPlan or renditionPlan)
  preset: PresetName;
}

export interface EncodeAttempt {
  args: string[];
  encoder: string | null; // video encoder, null when the video is copied or absent
  warnings: string[];
}

export interface EncodeResult {
  encoder: string | null;
  warnings: string[];
}

export class MediaEncodeError extends Error {
  readonly code = 'E_MEDIA_ENCODE';
  constructor(message: string) {
    super(message);
    this.name = 'MediaEncodeError';
  }
}

const INPUT = (file: string) => ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', file];
const PROGRESS = ['-progress', 'pipe:1', '-nostats'];
// No global or stream metadata, no chapters, no encoder name: nothing personal, same bytes each time.
const NO_METADATA = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact'];

// Downscale only, aspect ratio kept: the frame fits in a max × max box no larger than itself.
const fitFilter = (max: number, extra = '') => `scale=w='min(iw,${max})':h='min(ih,${max})':force_original_aspect_ratio=decrease${extra}`;

const TONE_MAPPING: Readonly<Record<'zscale' | 'libplacebo', string[]>> = {
  zscale: ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv'],
  libplacebo: ['libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=auto']
};

// The command lines to try, in order: one per usable H.264 encoder (a hardware encoder listed by
// ffmpeg may still fail on this machine), tone-mapped first for HDR.
export function encodeAttempts(request: EncodeRequest, tools: MediaTools): EncodeAttempt[] {
  const { info, plan } = request;
  if (info.kind === 'video') {
    if (plan.video !== 'encode') return [{ args: videoArgs(request, null, null), encoder: null, warnings: [] }];
    const toneMaps: ('zscale' | 'libplacebo' | null)[] = info.hdr && tools.toneMapping ? [tools.toneMapping, null] : [null];
    const attempts: EncodeAttempt[] = [];
    for (const toneMap of toneMaps) {
      for (const encoder of tools.h264) {
        const warnings = info.hdr && !toneMap ? [`HDR video converted to SDR without tone mapping (${tools.toneMapping ? 'tone mapping failed' : 'this ffmpeg has neither zscale nor libplacebo'}): colours may look flat.`] : [];
        attempts.push({ args: videoArgs(request, encoder, toneMap), encoder, warnings });
      }
    }
    return attempts;
  }
  if (info.kind === 'audio') return [{ args: audioArgs(request), encoder: null, warnings: [] }];
  if (info.kind === 'image') {
    // HEIF and AVIF photos are grids of tiles that ffmpeg assembles in a filter graph of its own;
    // a single-image HEIF has no grid, hence the second attempt.
    const grid = info.container === 'heif' || info.container === 'avif';
    return [...(grid ? [true] : []), false].map((tiles) => ({ args: imageArgs(request, tools, tiles), encoder: null, warnings: [] }));
  }
  return [];
}

function videoArgs({ input, output, info, plan, preset }: EncodeRequest, encoder: H264Encoder | null, toneMap: 'zscale' | 'libplacebo' | null): string[] {
  const p = PRESETS[preset].video;
  // 0:V skips attached pictures; timecode and data tracks are left out.
  const args = [...INPUT(input), '-map', '0:V:0', '-map', '0:a:0?'];
  if (plan.video === 'encode' && encoder) {
    const filters: string[] = [];
    if (info.pixelAspect !== 1) filters.push('scale=iw*sar:ih', 'setsar=1');
    if (toneMap) filters.push(...TONE_MAPPING[toneMap]);
    filters.push(fitFilter(p.maxLongSide, ':force_divisible_by=2'), 'setsar=1');
    if (p.maxFps && info.fps && info.fps > p.maxFps + 0.5) filters.push(`fps=${info.fps / 2 >= 23.5 ? Math.round((info.fps / 2) * 1000) / 1000 : p.maxFps}`);
    filters.push('format=yuv420p');
    // The frames' own tags win over encoder options: label the result SDR (BT.709) on the frames.
    if (info.hdr) filters.push('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709');
    args.push('-vf', filters.join(','), ...videoEncoderArgs(encoder, p));
    if (info.hdr) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  } else {
    args.push('-c:v', 'copy');
  }
  if (info.audioCodec) args.push(...(plan.audio === 'encode' ? aacArgs(info, p.audioBitrate) : ['-c:a', 'copy']));
  args.push('-sn', '-dn', ...NO_METADATA, '-movflags', '+faststart', '-max_muxing_queue_size', '4096', ...PROGRESS, '-f', 'mp4', output);
  return args;
}

function videoEncoderArgs(encoder: H264Encoder, p: VideoPreset): string[] {
  const max = String(p.maxBitrate);
  const buffer = String(p.maxBitrate * 2);
  // Hardware encoders have no constant-quality mode everywhere: an average bitrate under the cap.
  const average = String(Math.round(p.maxBitrate * 0.6));
  switch (encoder) {
    case 'libx264': return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(p.crf), '-maxrate', max, '-bufsize', buffer, '-profile:v', 'high'];
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-b:v', average, '-maxrate', max, '-bufsize', buffer, '-profile:v', 'high', '-allow_sw', '1'];
    case 'h264_mf': return ['-c:v', 'h264_mf', '-b:v', average, '-maxrate', max, '-bufsize', buffer];
    case 'libopenh264': return ['-c:v', 'libopenh264', '-b:v', average, '-maxrate', max, '-profile:v', 'high'];
  }
}

// AAC, stereo at most; a mono track needs half the bits.
function aacArgs(info: MediaInfo, bitrate: number): string[] {
  const args = ['-c:a', 'aac', '-b:a', String(info.channels === 1 ? bitrate / 2 : bitrate)];
  if ((info.channels ?? 2) > 2) args.push('-ac', '2');
  if ((info.sampleRate ?? 0) > 48000) args.push('-ar', '48000');
  return args;
}

function audioArgs({ input, output, info, plan, preset }: EncodeRequest): string[] {
  const args = [...INPUT(input), '-map', '0:a:0', '-vn', '-sn', '-dn'];
  args.push(...(plan.audio === 'encode' ? aacArgs(info, PRESETS[preset].audio.bitrate) : ['-c:a', 'copy']), ...NO_METADATA);
  // An MP3 kept as MP3 (cover art removed) loses its ID3 tags; anything else becomes M4A.
  if (plan.audio !== 'encode' && info.container === 'mp3') args.push('-id3v2_version', '0', ...PROGRESS, '-f', 'mp3', output);
  else args.push('-movflags', '+faststart', ...PROGRESS, '-f', 'mp4', output);
  return args;
}

// libjpeg-style quality (0–100) to ffmpeg's MJPEG scale (2 best … 31).
const jpegScale = (quality: number) => String(Math.min(31, Math.max(2, Math.round((100 - quality) / 5 + 1))));

function imageArgs({ input, output, info, plan, preset }: EncodeRequest, tools: MediaTools, tiles: boolean): string[] {
  const p = PRESETS[preset].image;
  const extension = plan.extension ?? extensionOf(input);
  const fit = fitFilter(p.maxLongSide, ':flags=lanczos');
  const args = [...INPUT(input), ...(tiles ? ['-filter_complex', `[0:g:0]${fit}[image]`, '-map', '[image]'] : ['-map', '0:v:0', '-vf', fit]), ...NO_METADATA, '-flags:v', '+bitexact'];
  if (!info.animated) args.push('-frames:v', '1');
  if (extension === '.webp') {
    if (!tools.webp) throw new MediaEncodeError('This ffmpeg cannot write WebP (it was built without libwebp).');
    if (info.animated) args.push('-c:v', 'libwebp_anim', '-quality', String(p.quality), '-loop', '0', ...PROGRESS, '-f', 'webp', output);
    else args.push('-c:v', 'libwebp', '-quality', String(p.quality), '-compression_level', '6', ...PROGRESS, '-f', 'webp', output);
  } else if (extension === '.png') {
    if (info.animated) args.push('-c:v', 'apng', '-plays', '0', ...PROGRESS, '-f', 'apng', output);
    else args.push('-c:v', 'png', '-pred', 'mixed', ...PROGRESS, '-f', 'image2', '-update', '1', output);
  } else {
    args.push('-c:v', 'mjpeg', '-q:v', jpegScale(p.quality), ...PROGRESS, '-f', 'image2', '-update', '1', output);
  }
  return args;
}

// Runs the attempts in order until one succeeds. The output is removed after a failure.
export async function encodeMedia(request: EncodeRequest, tools: MediaTools, options: RunOptions = {}): Promise<EncodeResult> {
  const attempts = encodeAttempts(request, tools);
  if (!attempts.length) {
    throw new MediaEncodeError(request.info.kind === 'video'
      ? 'This ffmpeg has no H.264 encoder (libx264, h264_videotoolbox, h264_mf or libopenh264).'
      : `Nothing to encode for a ${request.info.kind} file.`);
  }
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      await runFfmpeg(tools, attempt.args, { ...options, duration: request.info.duration });
      return { encoder: attempt.encoder, warnings: [...failures, ...attempt.warnings] };
    } catch (error) {
      await fs.promises.rm(request.output, { force: true });
      if (options.signal?.aborted) throw error;
      failures.push(`${attempt.encoder ?? 'ffmpeg'} failed: ${(error as Error).message}`);
    }
  }
  throw new MediaEncodeError(failures.join('\n'));
}

export interface RunOptions {
  signal?: AbortSignal;
  duration?: number | null;                // seconds, to turn ffmpeg's position into a fraction
  onProgress?: (fraction: number) => void;
}

// ffmpeg processes still running when this process exits are killed with it.
const running = new Set<ChildProcess>();
let exitHook = false;

export function runFfmpeg(tools: MediaTools, args: string[], { signal, duration, onProgress }: RunOptions = {}): Promise<void> {
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => { for (const child of running) child.kill('SIGKILL'); });
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const child = spawn(tools.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    running.add(child);
    let stderr = '';
    let pending = '';
    child.stdout!.setEncoding('utf8').on('data', (text: string) => {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const position = /^out_time_us=(\d+)/.exec(line);
        if (position && duration) onProgress?.(Math.min(1, Number(position[1]) / 1e6 / duration));
      }
    });
    child.stderr!.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(-4000); });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    let failed: Error | null = null;
    child.on('error', (error) => { failed = error; });
    child.on('close', (code, killedBy) => {
      running.delete(child);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(abortError(signal));
      else if (failed) reject(new MediaEncodeError(`ffmpeg did not start: ${(failed as Error).message}`));
      else if (code === 0) { onProgress?.(1); resolve(); }
      else reject(new MediaEncodeError(`ffmpeg exited with ${code ?? killedBy}: ${stderr.trim().split('\n').slice(-3).join(' ') || 'no message'}`));
    });
  });
}

export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Cancelled');
  error.name = 'AbortError';
  return error;
}
