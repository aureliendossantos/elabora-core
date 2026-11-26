// A video's master in a browser, by the desktop's plan (masterPlan of @elabora/core/media/conformance,
// docs/architecture/media.md, « In a browser »): an MP4 with its index first and without metadata,
// its streams copied when they are right (H.264 and AAC), encoded by WebCodecs otherwise (H.264 at an
// average bitrate under what Elabora spends at most on its size, AAC). Written as it goes to the
// stream it is given (a file of the origin's private file system): a long video is never held whole.
// Runs in the media Worker (D106).

import { ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, StreamTarget, VideoSample, canEncodeAudio, canEncodeVideo } from 'mediabunny';
import type { ConversionAudioOptions, ConversionVideoOptions, StreamTargetChunk } from 'mediabunny';
import { masterPlan, videoCeiling } from '@elabora/core/media/conformance';
import type { MediaInfo, MediaPlan } from '@elabora/core/media/conformance';
import { fitWithin, PRESETS } from '@elabora/core/media/presets';
import { MediaEncoderMissing, MediaNotDecodable } from './image.ts';

export interface VideoMaster {
  // copy: the file as it is, nothing written; otherwise the MP4 written to the stream.
  action: MediaPlan['action'];
  extension: '.mp4' | null;
}

export interface VideoOptions {
  // Where the master is written, by position (a FileSystemWritableFileStream takes these chunks).
  target: WritableStream<StreamTargetChunk>;
  // Whether AAC can be encoded here, the wasm encoder loaded if it must (encoders.ts, provideAac).
  aac?: () => Promise<boolean>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export async function videoMaster(file: Blob, name: string, info: MediaInfo, { target, aac = () => canEncodeAudio('aac'), onProgress, signal }: VideoOptions): Promise<VideoMaster> {
  const plan = masterPlan(info, { importing: true });
  if (plan.action === 'copy') return { action: 'copy', extension: null };
  // Read by slices as the conversion asks: a stream reader runs ahead of a copy that writes as fast
  // (a third more memory at 290 MB, test/bench/media-memory.ts).
  const input = new Input({ source: new BlobSource(file, { useStreamReader: false }), formats: ALL_FORMATS });
  try {
    const preset = PRESETS.high.video;
    let video: ConversionVideoOptions = { codec: 'avc' };
    if (plan.video === 'encode') {
      // Turned as it shows, square pixels, within the preset, even sides, as the desktop's filters do.
      const { width, height } = fitWithin(info.width ?? 0, info.height ?? 0, preset.maxLongSide);
      const fps = info.fps ?? 30;
      const bitrate = Math.round(Math.min(preset.maxBitrate * 0.6, videoCeiling(width, height, fps)));
      if (!(await canEncodeVideo('avc', { width, height, bitrate }))) throw new MediaEncoderMissing(name, 'the H.264 video');
      // Each picture as the desktop's format=yuv420p makes it: 4:2:0 in the video range, BT.709,
      // whatever range and matrix the source had (a phone's full range), converted from its RGB.
      const process = toVideoRange(width, height);
      video = { codec: 'avc', width, height, fit: 'fill', bitrate, allowRotationMetadata: false, alpha: 'discard', forceTranscode: true, process, processedWidth: width, processedHeight: height };
    }
    let audio: ConversionAudioOptions | undefined;
    if (plan.audio === 'encode') {
      const channels = Math.min(2, info.channels ?? 2);
      const bitrate = channels === 1 ? preset.audioBitrate / 2 : preset.audioBitrate;
      if (!(await aac())) throw new MediaEncoderMissing(name, 'the AAC sound');
      audio = { codec: 'aac', bitrate, numberOfChannels: channels, ...((info.sampleRate ?? 0) > 48000 ? { sampleRate: 48000 } : {}), forceTranscode: true };
    } else if (plan.audio === 'copy') {
      audio = { codec: 'aac' };
    } else {
      audio = { discard: true };
    }
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new StreamTarget(withoutNames(target)) });
    // No metadata, no date of creation: the master says nothing of where or when it was made.
    const conversion = await Conversion.init({ input, output, video, audio, tracks: 'primary', tags: { creationTime: null }, showWarnings: false });
    const lost = conversion.discardedTracks.filter((t) => t.reason !== 'discarded_by_user');
    if (!conversion.isValid || lost.length) {
      if (lost.some((t) => t.reason === 'undecodable_source_codec')) throw new MediaNotDecodable(name, `the ${lost.find((t) => t.reason === 'undecodable_source_codec')!.track.type === 'audio' ? info.audioCodec ?? 'audio' : info.videoCodec ?? 'video'} stream`);
      throw new MediaEncoderMissing(name, `its streams (${lost.map((t) => `${t.track.type}: ${t.reason}`).join(', ')})`);
    }
    if (onProgress) conversion.onProgress = onProgress;
    const abort = () => { void conversion.cancel(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await conversion.execute();
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    return { action: plan.action, extension: '.mp4' };
  } finally {
    input.dispose();
  }
}

// Mediabunny names itself in the index it writes: its version as the picture's compressor, its own
// handler names. The desktop's ffmpeg writes no compressor (bitexact) and the handlers VideoHandler and
// SoundHandler: the same here, at the same sizes, as the index goes to the target.
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const padded = (text: string, length: number) => { const out = new Uint8Array(length); out.set(ascii(text)); return out; };

export function withoutNames(target: WritableStream<StreamTargetChunk>): WritableStream<StreamTargetChunk> {
  const writer = target.getWriter();
  return new WritableStream<StreamTargetChunk>({
    write: (chunk) => writer.write(chunk.type === 'write' ? { ...chunk, data: scrub(chunk.data) } : chunk),
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason)
  });
}

function scrub(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  let out = data;
  const replace = (at: number, bytes: Uint8Array) => {
    if (out === data) out = data.slice();
    out.set(bytes, at);
  };
  for (let at = indexOf(data, COMPRESSOR, 0); at >= 0; at = indexOf(data, COMPRESSOR, at + 1)) {
    // A sample entry's compressor name: its length byte, then 31 bytes.
    if (at > 0 && data[at - 1] > 0 && data[at - 1] < 32) replace(at - 1, new Uint8Array(32));
  }
  for (const [from, to] of NAMES) for (let at = indexOf(data, from, 0); at >= 0; at = indexOf(data, from, at + 1)) replace(at, to);
  return out;
}

const COMPRESSOR = ascii('Mediabunny v');
const NAMES: [Uint8Array, Uint8Array][] = (['Video', 'Sound', 'Text'] as const).map((kind) => [ascii(`Mediabunny${kind}Handler`), padded(`${kind}Handler`, `Mediabunny${kind}Handler`.length)]);

function indexOf(data: Uint8Array, pattern: Uint8Array, from: number): number {
  outer: for (let at = from; at + pattern.length <= data.length; at++) {
    for (let i = 0; i < pattern.length; i++) if (data[at + i] !== pattern[i]) continue outer;
    return at;
  }
  return -1;
}

// A picture drawn as RGB, then written as I420 in the video range with BT.709's coefficients, labelled
// so: the encoder keeps that label in the stream it writes.
function toVideoRange(width: number, height: number): (sample: VideoSample) => VideoSample {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const chromaWidth = Math.ceil(width / 2), chromaHeight = Math.ceil(height / 2);
  const planes = new Uint8Array(width * height + 2 * chromaWidth * chromaHeight);
  return (sample) => {
    sample.draw(context, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const u0 = width * height, v0 = u0 + chromaWidth * chromaHeight;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        planes[y * width + x] = Math.round(16 + 0.1826 * rgba[i] + 0.6142 * rgba[i + 1] + 0.062 * rgba[i + 2]);
      }
    }
    for (let y = 0; y < chromaHeight; y++) {
      for (let x = 0; x < chromaWidth; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const px = 2 * x + dx, py = 2 * y + dy;
          if (px >= width || py >= height) continue;
          const i = (py * width + px) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
        }
        r /= n; g /= n; b /= n;
        planes[u0 + y * chromaWidth + x] = Math.round(128 - 0.1006 * r - 0.3386 * g + 0.4392 * b);
        planes[v0 + y * chromaWidth + x] = Math.round(128 + 0.4392 * r - 0.3989 * g - 0.0403 * b);
      }
    }
    return new VideoSample(planes, {
      format: 'I420', codedWidth: width, codedHeight: height, timestamp: sample.timestamp, duration: sample.duration,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
    });
  };
}

// A file of the origin's private file system as the target of a master: written in place through its
// synchronous handle (a dedicated Worker's, every browser), held until the stream closes.
export async function fileTarget(file: FileSystemFileHandle): Promise<WritableStream<StreamTargetChunk>> {
  // A dedicated Worker's API, which the DOM's types leave out.
  const access = await (file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccess> }).createSyncAccessHandle();
  access.truncate(0);
  return new WritableStream<StreamTargetChunk>({
    write: (chunk) => { if (chunk.type === 'write') access.write(chunk.data, { at: chunk.position }); },
    close: () => { access.flush(); access.close(); },
    abort: () => { access.close(); }
  });
}

interface SyncAccess {
  write(data: AllowSharedBufferSource, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
