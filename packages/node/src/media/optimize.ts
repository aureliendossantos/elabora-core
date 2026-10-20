import path from 'node:path';
import type { Author } from '@elabora/core/ops/types';
import { replaceMediaReferences } from '@elabora/core/commands/media';
import type { MediaMove } from '@elabora/core/commands/media';
import { readProjectFiles } from '../project-reader.ts';
import { runCommand } from '../edit/executor.ts';
import type { EditResult } from '../edit/executor.ts';
import { optimizeInPlace } from './import.ts';
import { getMediaQueue } from './jobs.ts';
import type { MediaJob, MediaJobStatus, MediaQueue } from './jobs.ts';
import type { MediaTools } from './tools.ts';

// `elabora media optimize`: non-conformant media of assets/ become masters next to themselves, then
// one journaled change points the references at the files whose extension changed and removes the
// old files (undoable like any edit).

export interface OptimizeMediaOptions {
  queue?: MediaQueue;
  tools?: MediaTools;
  author?: Author;
  onProgress?: (job: MediaJob) => void;
  onComplete?: (job: MediaJob) => void;
}

export interface OptimizedMedia {
  from: string;
  to: string;
  status: MediaJobStatus | 'conformant';
  error: string | null;
  warnings: string[];
}

export interface OptimizeMediaResult {
  files: OptimizedMedia[];
  change: EditResult | null; // references rewritten and old files removed; null when no name changed
}

// Media files of assets/ that are not masters, from the snapshot.
export function mediaToOptimize(dir: string): string[] {
  return [...readProjectFiles(dir).files].filter(([rel, file]) => rel.startsWith('assets/') && file.kind === 'binary' && file.media && !file.media.conformant).map(([rel]) => rel);
}

export async function optimizeMedia(dir: string, paths: readonly string[], options: OptimizeMediaOptions = {}): Promise<OptimizeMediaResult> {
  const root = path.resolve(dir);
  const queue = options.queue ?? getMediaQueue(root, options.tools ? { tools: options.tools } : {});
  const onProgress = (job: MediaJob) => options.onProgress?.(job);
  const onComplete = (job: MediaJob) => options.onComplete?.(job);
  queue.on('progress', onProgress);
  queue.on('complete', onComplete);
  try {
    const started = [];
    for (const rel of paths) started.push(await optimizeInPlace(root, rel, { queue, tools: options.tools, keepOriginal: true }));
    const done = new Map((await queue.wait(started.flatMap((s) => (s.job ? [s.job.id] : [])))).map((job) => [job.id, job]));
    const files: OptimizedMedia[] = started.map((s) => {
      const job = s.job ? done.get(s.job.id) : undefined;
      return { from: s.from, to: s.to, status: job?.status ?? 'conformant', error: job?.error ?? null, warnings: job?.warnings ?? [] };
    });
    const moves: MediaMove[] = files.filter((f) => f.status === 'done' && f.from !== f.to).map(({ from, to }) => ({ from, to }));
    const change = moves.length
      ? runCommand(root, { name: 'optimize_media', args: { moves }, run: (context) => replaceMediaReferences(context, { moves }) }, options.author ? { author: options.author } : {})
      : null;
    return { files, change };
  } finally {
    queue.off('progress', onProgress);
    queue.off('complete', onComplete);
  }
}
