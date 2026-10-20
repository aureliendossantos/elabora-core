import fs from 'node:fs';
import path from 'node:path';
import { renditionPlan } from '@elabora/core/media/conformance';
import { projectDataDir } from '../data-dir.ts';
import { toPosix } from './files.ts';
import { getMediaQueue, isFinished } from './jobs.ts';
import type { MediaJob, MediaQueue } from './jobs.ts';
import { presetHash, PRESET_NAMES } from '@elabora/core/media/presets';
import type { MediaKind, PresetName } from '@elabora/core/media/presets';
import { listProjectFiles, isTextFile } from '../project-files.ts';
import { probeProjectFile } from './probe.ts';
import { projectFileHash } from '../file-hash.ts';
import { findMediaTools } from './tools.ts';
import type { MediaTools } from './tools.ts';

// Packages at the medium and low presets ship renditions encoded from the masters, cached in
// <data dir>/cache/media/ (data-dir.ts) under the master's hash and the preset's parameters: a
// rendition is made once, and remade only when the master or the preset changes.

export const renditionsDir = (projectDir: string) => path.join(projectDataDir(projectDir), 'cache', 'media');

export interface RenditionOptions {
  queue?: MediaQueue;
  tools?: MediaTools | null;
  signal?: AbortSignal;
  onProgress?: (job: MediaJob) => void; // while the rendition is encoded, and once it is done
}

// Absolute path of the file a package at this preset ships for this master: the master itself at
// high, for SVG and when it already fits the preset; a file of the rendition cache otherwise.
export async function renditionPath(projectDir: string, relPath: string, preset: PresetName, options: RenditionOptions = {}): Promise<string> {
  const root = path.resolve(projectDir);
  const rel = toPosix(relPath);
  const master = path.join(root, rel);
  if (preset === 'high') return master;
  // Without ffmpeg nothing can be encoded, but the path is still known (WebP is then assumed).
  const tools = options.tools !== undefined ? options.tools : await findMediaTools().catch(() => null);
  const info = await probeProjectFile(root, rel, tools ? { tools } : {});
  const plan = renditionPlan(info, preset, { webp: tools?.webp ?? true });
  if (plan.action === 'reuse' || !plan.extension) return master;
  const hash = (await projectFileHash(root, rel)).slice('sha256:'.length, 'sha256:'.length + 32);
  return path.join(renditionsDir(root), `${hash}-${preset}-${presetHash(preset, info.kind)}${plan.extension}`);
}

export interface RenditionResult {
  file: string;          // absolute path
  reused: boolean;       // the master is shipped as is
  job: MediaJob | null;  // the job that made it, null when it was cached or reused
}

// Returns the rendition, encoding it first when it is not cached.
export async function ensureRendition(projectDir: string, relPath: string, preset: PresetName, options: RenditionOptions = {}): Promise<RenditionResult> {
  const root = path.resolve(projectDir);
  const rel = toPosix(relPath);
  const file = await renditionPath(root, rel, preset, options);
  if (file === path.join(root, rel)) return { file, reused: true, job: null };
  if (fs.existsSync(file)) return { file, reused: false, job: null };
  const queue = options.queue ?? getMediaQueue(root, options.tools ? { tools: options.tools } : {});
  const output = toPosix(path.relative(projectDataDir(root), file));
  const job = queue.list().find((j) => j.type === 'rendition' && j.output === output && !isFinished(j.status))
    ?? queue.add({ type: 'rendition', input: rel, output, preset });
  const onAbort = () => queue.cancel(job.id);
  const onProgress = (progressed: MediaJob) => { if (progressed.id === job.id) options.onProgress?.(progressed); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  queue.on('progress', onProgress);
  try {
    const [done] = await queue.wait([job.id]);
    options.onProgress?.(done);
    if (done.status !== 'done') throw new Error(`Rendition of ${rel} at ${preset} ${done.status}${done.error ? `: ${done.error}` : ''}`);
    return { file, reused: false, job: done };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    queue.off('progress', onProgress);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const MEDIA_KINDS: readonly MediaKind[] = ['video', 'audio', 'image', 'vector'];

// Removes the renditions no package can use any more: of masters the project no longer has (a
// video replaced or deleted), or made with preset parameters that changed since. They go once
// they are a week old, so that a deletion undone meanwhile finds its rendition again; a rendition
// is a cache, encoded again from its master when needed.
export async function pruneRenditions(projectDir: string, options: { now?: Date; graceMs?: number } = {}): Promise<{ removed: number; bytesFreed: number }> {
  const dir = renditionsDir(projectDir);
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  if (!names.length) return { removed: 0, bytesFreed: 0 };
  const root = path.resolve(projectDir);
  const masters = new Set<string>();
  for (const file of listProjectFiles(root).files) {
    if (!isTextFile(file.path)) masters.add((await projectFileHash(root, file.path)).slice('sha256:'.length, 'sha256:'.length + 32));
  }
  const parameters = new Set(PRESET_NAMES.flatMap((preset) => MEDIA_KINDS.map((kind) => `${preset}-${presetHash(preset, kind)}`)));
  const now = (options.now ?? new Date()).getTime();
  const grace = options.graceMs ?? 7 * DAY;
  let removed = 0;
  let bytesFreed = 0;
  for (const name of names) {
    const match = /^([0-9a-f]{32})-([a-z]+-[0-9a-f]{12})\./.exec(name);
    if (match && masters.has(match[1]) && parameters.has(match[2])) continue;
    const file = path.join(dir, name);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile() || now - stat.mtimeMs < grace) continue;
    await fs.promises.rm(file, { force: true });
    removed++;
    bytesFreed += stat.size;
  }
  return { removed, bytesFreed };
}
