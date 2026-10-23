import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Project } from '@elabora/core/project/model';
import { screenOrder } from '@elabora/core/project/load';
import { narrationLines, screenTiming } from '@elabora/core/narration/narration';
import { narratedLayers, onTimeline } from '@elabora/core/narration/voice-lines';
import { narrationVtt } from '@elabora/core/narration/timing';
import type { NarrationTrack } from '@elabora/core/compile/course-data';
import { canonicalJSON } from '@elabora/core/util/json';
import { projectDataDir } from '../data-dir.ts';
import { projectFileHash } from '../file-hash.ts';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { sha256Hex as sha256, writeFileAtomic } from '../util/fs.ts';

// The narration tracks of a build (docs/decisions.md D24): for each narrated screen whose lines all
// have their audio in the course's language, the lines decoded to PCM, laid end to end with their
// pauses and encoded once into narration/<screen>.m4a, with its WebVTT captions. Times come from
// the decoded samples, so the cues of the course data fall on the sounds. Tracks are cached in the
// project's data by the hash of their inputs: an unchanged screen is never encoded again, and the
// same inputs give the same bytes.
//
// A layer with a narration has its own track (D62), next to its screen's: narration/<screen>.<layer>.m4a
// and .vtt. The dot is never in an id (screens, layers and language folders are slugs or language
// tags), so a layer's track can share a folder with every screen and language without colliding.

// The decoded audio: mono, 48 kHz, 16-bit; the track: AAC-LC at 64 kb/s (about 0.5 MB a minute).
export const SAMPLE_RATE = 48000;
export const TRACK_BITRATE = '64k';
// Changes when the way tracks are made changes: every cached track is made again.
const PIPELINE_VERSION = 1;

export const narrationCacheDir = (projectDir: string): string => path.join(projectDataDir(projectDir), 'cache', 'narration');
// In a package of several languages (D59), the other languages' tracks go in narration/<lang>/.
// layer: the track of that layer of the screen (D62).
export const trackName = (screen: string, layer: string | null = null): string => (layer === null ? screen : `${screen}.${layer}`);
export const trackPath = (screen: string, folder = '', layer: string | null = null): string => `narration/${folder ? `${folder}/` : ''}${trackName(screen, layer)}.m4a`;
export const captionsPath = (screen: string, folder = '', layer: string | null = null): string => `narration/${folder ? `${folder}/` : ''}${trackName(screen, layer)}.vtt`;

export interface BuiltTrack {
  screen: string;
  // The layer whose track it is; null: the screen's.
  layer: string | null;
  // screen, or screen.layer (trackName): the key of tracks by timeline.
  // Package paths, and the cached file the package ships.
  path: string;
  captionsPath: string;
  file: string;
  vtt: string;
  bytes: number;
  duration: number;
  key: string;
  name: string;
  track: NarrationTrack;
  // The credits its voices ask for (their sidecars').
  credits: string[];
}

export interface NarrationTracks {
  tracks: BuiltTrack[];
  // Narrated screens without a track: a line has no audio yet (their timeline runs silent); a
  // layer's as screen.layer (trackName).
  silent: string[];
  failures: { screen: string; layer: string | null; message: string }[];
}

export interface TrackOptions {
  // A folder under narration/ for the tracks (another language of the package, D59).
  folder?: string;
  tools?: MediaTools | null;
  onProgress?: (done: number, total: number) => void;
}

export async function narrationTracks(project: Project, options: TrackOptions = {}): Promise<NarrationTracks> {
  const out: NarrationTracks = { tracks: [], silent: [], failures: [] };
  const language = project.course?.language ?? '';
  // Each narrated timeline, in the order of the course: a screen's, then its layers'.
  const timelines = screenOrder(project).flatMap(({ id }) => {
    const data = project.screens.get(id)?.data;
    return [...(data?.narration ? [{ screen: id, layer: null }] : []), ...narratedLayers(data).map((layer) => ({ screen: id, layer }))];
  });
  let tools: MediaTools | null | undefined = options.tools;
  let done = 0;
  for (const { screen, layer } of timelines) {
    const name = trackName(screen, layer);
    const lines = narrationLines(project, screen, language)?.filter((line) => onTimeline(line.track, layer));
    if (!lines?.length || lines.some((line) => line.status === 'missing' || line.status === 'untranslated')) { out.silent.push(name); continue; }
    try {
      // The silences come from the timeline: each line's pause, made longer where an effect anchored
      // at the end of a step needs time before the next one, and after the last line as long as the
      // screen's last effects last.
      const laid = screenTiming(project, screen, { language, layer });
      if (!laid) continue;
      const gaps = laid.gaps;
      const hashes = await Promise.all(lines.map((line) => projectFileHash(project.root, line.audio)));
      const key = sha256(canonicalJSON({ v: PIPELINE_VERSION, rate: SAMPLE_RATE, bitrate: TRACK_BITRATE, lines: lines.map((line, index) => [hashes[index], gaps[index]]), ...(gaps[lines.length] ? { tail: gaps[lines.length] } : {}) })).slice(0, 32);
      const dir = narrationCacheDir(project.root);
      const file = path.join(dir, `${key}.m4a`);
      const facts = path.join(dir, `${key}.json`);
      let durations = readDurations(facts, lines.length);
      if (!durations || !fs.existsSync(file)) {
        if (tools === undefined) tools = await findMediaTools().catch(() => null);
        if (!tools) throw new Error('ffmpeg is needed to make the narration track: install it (or set ELABORA_FFMPEG).');
        const decoded: Buffer[] = [];
        for (const line of lines) decoded.push(await decodePcm(tools, path.join(project.root, line.audio)));
        durations = decoded.map((pcm) => Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000) / 1000);
        const parts: Buffer[] = [];
        decoded.forEach((pcm, index) => { parts.push(Buffer.alloc(Math.round(gaps[index] * SAMPLE_RATE) * 2), pcm); });
        if (gaps[lines.length] > 0) parts.push(Buffer.alloc(Math.round(gaps[lines.length] * SAMPLE_RATE) * 2));
        fs.mkdirSync(dir, { recursive: true });
        await encodeTrack(tools, Buffer.concat(parts), file);
        writeFileAtomic(facts, `${JSON.stringify({ durations })}\n`);
      }
      const measured = new Map(lines.map((line, index) => [line.id, (durations as number[])[index]]));
      const timing = screenTiming(project, screen, { language, durations: measured, gaps, layer });
      if (!timing) continue;
      const vtt = narrationVtt(timing.lines.map((line) => ({ ...line, speaker: line.info.speakerName })));
      const src = trackPath(screen, options.folder, layer);
      const captions = captionsPath(screen, options.folder, layer);
      out.tracks.push({
        screen, layer, name, path: src, captionsPath: captions, file, vtt, bytes: fs.statSync(file).size, duration: timing.duration, key,
        credits: [...new Set(lines.map((line) => line.credit).filter((credit): credit is string => !!credit))],
        track: { src, captions, durations: measured, gaps }
      });
    } catch (error) {
      out.failures.push({ screen, layer, message: error instanceof Error ? error.message : String(error) });
    }
    options.onProgress?.(++done, timelines.length);
  }
  return out;
}

function readDurations(file: string, count: number): number[] | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const durations = value && typeof value === 'object' ? (value as { durations?: unknown }).durations : null;
    return Array.isArray(durations) && durations.length === count && durations.every((d) => typeof d === 'number') ? durations : null;
  } catch {
    return null;
  }
}

// The audio of a file as raw samples: mono, 48 kHz, signed 16-bit little-endian.
export function decodePcm(tools: MediaTools, file: string): Promise<Buffer> {
  return run(tools, ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], null);
}

// The audio of a file as float samples, mono, at rate samples a second (a line's waveform, its
// mouth's envelope).
export async function decodeSamples(tools: MediaTools, file: string, rate: number): Promise<Float32Array> {
  const bytes = await run(tools, ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], null);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 4)));
}

// Raw samples into an M4A track, written next to its place and moved there once complete.
export async function encodeTrack(tools: MediaTools, pcm: Buffer, file: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await run(tools, [
      '-nostdin', '-v', 'error', '-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'aac', '-b:a', TRACK_BITRATE, '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart', '-f', 'mp4', temp
    ], pcm);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function run(tools: MediaTools, args: string[], input: Buffer | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr!.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(-4000); });
    child.on('error', (error) => reject(new Error(`ffmpeg did not start: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' ') || 'no message'}`));
    });
    if (input) {
      child.stdin!.on('error', () => {}); // ffmpeg may close its input early; its exit code says why
      child.stdin!.end(input);
    }
  });
}
