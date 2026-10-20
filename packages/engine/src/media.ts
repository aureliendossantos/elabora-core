import path from 'node:path';
import { MediaQueue, isFinished } from '@elabora/node/media/jobs';
import type { MediaJob } from '@elabora/node/media/jobs';
import { importMedia, optimizeInPlace } from '@elabora/node/media/import';
import type { MediaTools } from '@elabora/node/media/tools';
import { putFile } from '@elabora/node/blobs';
import type { Author } from '@elabora/core/ops/types';
import type { MediaJobInfo } from './protocol.ts';

// The project's media jobs, for a session: its own queue (started on open), events for the app,
// the files jobs will write or replace (the watcher leaves them to the job's result), and the
// conversion of media of assets/ that the snapshot says are not conformant masters.

export interface MediaOptions {
  enabled?: boolean;       // run the project's media queue (default true)
  autoOptimize?: boolean;  // convert non-conformant media that appear in assets/ (default true)
  tools?: MediaTools;      // ffmpeg and ffprobe (found on first use otherwise)
  concurrency?: number;
}

export interface MediaHandlers {
  job(job: MediaJob): void;       // queued, started, progress (throttled), finished
  complete(job: MediaJob): void;  // finished: the session reconciles its files
  error(message: string, context: string): void;
}

const PROGRESS_INTERVAL_MS = 250;

export class MediaSupervisor {
  readonly root: string;
  readonly queue: MediaQueue;
  readonly autoOptimize: boolean;
  readonly #tools: MediaTools | undefined;
  readonly #handlers: MediaHandlers;
  readonly #owned = new Map<string, string>(); // project path → id of the unfinished job that writes or replaces it
  readonly #authors = new Map<string, Author>(); // job id → who asked for it
  readonly #progressAt = new Map<string, number>();

  constructor(root: string, options: MediaOptions, handlers: MediaHandlers) {
    this.root = root;
    this.autoOptimize = options.autoOptimize !== false;
    this.#tools = options.tools;
    this.#handlers = handlers;
    this.queue = new MediaQueue(root, { tools: options.tools, concurrency: options.concurrency, autoStart: true });
    this.queue.on('queued', (job: MediaJob) => { this.#own(job); handlers.job(job); });
    this.queue.on('start', (job: MediaJob) => { this.#own(job); handlers.job(job); });
    this.queue.on('progress', (job: MediaJob) => {
      const now = Date.now();
      if (now - (this.#progressAt.get(job.id) ?? 0) < PROGRESS_INTERVAL_MS) return;
      this.#progressAt.set(job.id, now);
      handlers.job(job);
    });
    this.queue.on('complete', (job: MediaJob) => {
      this.#progressAt.delete(job.id);
      handlers.job(job);
      handlers.complete(job);
    });
  }

  // Requeues jobs left by a stopped process and runs the queue.
  start(): void {
    this.queue.start();
    for (const job of this.queue.list()) if (!isFinished(job.status)) this.#own(job);
  }

  // Whether an unfinished job will write or replace this file.
  owns(rel: string): boolean {
    return this.#owned.has(rel);
  }

  // The job's files are the watcher's again (the session reconciled its result).
  release(job: MediaJob): void {
    for (const [rel, id] of this.#owned) if (id === job.id) this.#owned.delete(rel);
    this.#authors.delete(job.id);
  }

  authorOf(job: MediaJob): Author | undefined {
    return this.#authors.get(job.id);
  }

  // Whether an unfinished job converts this file (an input waiting for conversion: versions leave it out).
  replaced(rel: string): boolean {
    const id = this.#owned.get(rel);
    return id !== undefined && this.queue.get(id)?.replaces === rel;
  }

  async import(input: string, options: { to?: string; name?: string }, author: Author) {
    const result = await importMedia(this.root, input, { ...options, queue: this.queue, tools: this.#tools });
    this.#authors.set(result.job.id, author);
    return result;
  }

  // Queues the conversion of media files that are not conformant masters. The original is kept in
  // the blob store first, so that undoing the conversion brings it back.
  async optimize(paths: readonly string[]): Promise<void> {
    for (const rel of paths) {
      if (this.#owned.has(rel)) continue;
      try {
        await putFile(this.root, path.join(this.root, rel));
        const result = await optimizeInPlace(this.root, rel, { queue: this.queue, tools: this.#tools });
        if (result.job) this.#authors.set(result.job.id, { kind: 'system' });
      } catch (error) {
        this.#handlers.error(`${rel}: ${(error as Error).message}`, 'optimizing media');
      }
    }
  }

  jobs(): MediaJob[] {
    return this.queue.list();
  }

  cancel(id: string): MediaJob | null {
    return this.queue.cancel(id);
  }

  // leave: running jobs go on in this process (a job a stopped process left is queued again at the
  // next start); wait: until they finish; cancel: stop them.
  async close(mode: 'leave' | 'wait' | 'cancel'): Promise<void> {
    const closing = this.queue.close({ cancelRunning: mode === 'cancel' });
    if (mode !== 'leave') await closing;
  }

  #own(job: MediaJob): void {
    if (isFinished(job.status) || job.type === 'rendition') return;
    this.#owned.set(job.output, job.id);
    if (job.replaces) this.#owned.set(job.replaces, job.id);
  }
}

export function jobInfo(job: MediaJob): MediaJobInfo {
  return {
    id: job.id, type: job.type, status: job.status, input: job.type === 'import' ? path.basename(job.input) : job.input, output: job.output,
    replaces: job.replaces, progress: job.progress, error: job.error, warnings: [...job.warnings], createdAt: job.createdAt, finishedAt: job.finishedAt
  };
}
