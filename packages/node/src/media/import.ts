import fs from 'node:fs';
import path from 'node:path';
import { extensionOf, masterPlan, mediaKindOfPath, replaceExtension } from '@elabora/core/media/conformance';
import type { MediaInfo, MediaPlan } from '@elabora/core/media/conformance';
import { isSafeRelativePath, slugify, toPosix } from './files.ts';
import { getMediaQueue, isFinished } from './jobs.ts';
import type { MediaJob, MediaQueue } from './jobs.ts';
import { probeMedia, probeProjectFile } from './probe.ts';
import { withProjectLockSync } from '../journal/lock.ts';
import { findMediaTools } from './tools.ts';
import type { MediaTools } from './tools.ts';

// Media enter a project as masters: imported files are converted (or remuxed) into assets/ and
// the original is never copied; files dropped into assets/ by hand are optimised in place.

export const MEDIA_FOLDERS = { video: 'assets/video', audio: 'assets/audio', image: 'assets/images', vector: 'assets/images' } as const;

export interface MediaRequestOptions {
  queue?: MediaQueue;
  tools?: MediaTools;
}

export interface ImportOptions extends MediaRequestOptions {
  to?: string;   // project folder under assets/ (default by kind: assets/video, assets/audio, assets/images)
  name?: string; // file name without extension (default: the original's), made portable
}

export interface ImportResult {
  path: string;  // project-relative path of the master, present once the job is done
  job: MediaJob;
  info: MediaInfo;
  plan: MediaPlan;
}

// Probes the file now (so a file that is not media fails at once), reserves the output name under
// the project lock (another process importing the same name gets the next one) and queues the job.
// The output appears atomically when the job is done: await queue.wait([job.id]).
export async function importMedia(projectDir: string, inputPath: string, options: ImportOptions = {}): Promise<ImportResult> {
  const root = path.resolve(projectDir);
  const input = path.resolve(inputPath);
  // SVG is copied as is: no ffmpeg needed.
  const tools = options.tools ?? (mediaKindOfPath(input) === 'vector' ? undefined : await findMediaTools());
  const info = await probeMedia(input, { tools });
  const plan = masterPlan(info, { webp: tools?.webp ?? true, importing: true });
  const folder = (options.to ?? MEDIA_FOLDERS[info.kind]).replace(/\/+$/, '');
  if (!isSafeRelativePath(folder) || !(folder === 'assets' || folder.startsWith('assets/'))) {
    throw new Error(`Media go under assets/: "${options.to}" is not a folder of assets/.`);
  }
  const extension = plan.extension ?? normaliseExtension(extensionOf(input));
  const queue = options.queue ?? getMediaQueue(root, { tools });
  const base = slugify(options.name ?? path.basename(input, path.extname(input)));
  const { output, job } = withProjectLockSync(root, () => {
    const output = uniquePath(root, `${folder}/${base}${extension}`, queue.reservedOutputs());
    return { output, job: queue.add({ type: 'import', input, output, preset: 'high' }, { start: false }) };
  });
  if (queue.autoStart) queue.start();
  return { path: output, job, info, plan };
}

export interface OptimizeResult {
  from: string;            // the file as it is
  to: string;              // the master once the job is done (equal to `from` when the name stays)
  job: MediaJob | null;    // null: the file is already a conformant master
  info: MediaInfo;
  plan: MediaPlan;
}

// Converts a non-conformant project file into a master. When the extension changes the old file
// is removed once the new one exists (unless keepOriginal); references are the caller's to rewrite.
export async function optimizeInPlace(projectDir: string, relPath: string, options: MediaRequestOptions & { keepOriginal?: boolean } = {}): Promise<OptimizeResult> {
  const root = path.resolve(projectDir);
  const rel = toPosix(relPath);
  if (!isSafeRelativePath(rel)) throw new Error(`Not a project path: ${relPath}`);
  const tools = options.tools ?? (mediaKindOfPath(rel) === 'vector' ? undefined : await findMediaTools());
  const info = await probeProjectFile(root, rel, { tools });
  const plan = masterPlan(info, { webp: tools?.webp ?? true });
  if (plan.action === 'copy') return { from: rel, to: rel, job: null, info, plan };
  const queue = options.queue ?? getMediaQueue(root, { tools });
  const pending = queue.list().find((j) => j.type === 'optimize' && j.input === rel && !isFinished(j.status));
  if (pending) return { from: rel, to: pending.output, job: pending, info, plan };
  const target = plan.extension && plan.extension !== extensionOf(rel) ? replaceExtension(rel, plan.extension) : rel;
  const { to, job } = withProjectLockSync(root, () => {
    const to = target === rel ? rel : uniquePath(root, target, queue.reservedOutputs());
    return { to, job: queue.add({ type: 'optimize', input: rel, output: to, preset: 'high', replaces: rel, keepOriginal: options.keepOriginal }, { start: false }) };
  });
  if (queue.autoStart) queue.start();
  return { from: rel, to, job, info, plan };
}

function normaliseExtension(extension: string): string {
  return extension === '.jpeg' ? '.jpg' : extension === '.tiff' ? '.tif' : extension;
}

// intro.mp4, then intro-2.mp4, intro-3.mp4…: never a file that exists or that a job will write.
// Compared without case: macOS and Windows file systems ignore it.
export function uniquePath(projectDir: string, relPath: string, reserved: ReadonlySet<string> = new Set()): string {
  const taken = new Set([...reserved].map((p) => p.toLowerCase()));
  const extension = extensionOf(relPath);
  const stem = extension ? relPath.slice(0, -extension.length) : relPath;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? relPath : `${stem}-${n}${extension}`;
    if (!taken.has(candidate.toLowerCase()) && !fs.existsSync(path.join(projectDir, candidate))) return candidate;
  }
}
