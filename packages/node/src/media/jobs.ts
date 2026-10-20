import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cloneFile, hashFile } from '../blobs.ts';
import { projectDataDir } from '../data-dir.ts';
import type { BlobHash } from '../blobs.ts';
import { extensionOf, masterPlan, renditionPlan } from '@elabora/core/media/conformance';
import type { MediaInfo, MediaPlan } from '@elabora/core/media/conformance';
import { abortError, encodeMedia } from './encode.ts';
import { moveIntoPlace, writeFileAtomic } from './files.ts';
import { stripImageMetadata } from './metadata.ts';
import { probeMedia, rememberProbe } from './probe.ts';
import { projectFileHash } from '../file-hash.ts';
import { findMediaTools } from './tools.ts';
import type { MediaTools } from './tools.ts';
import type { PresetName } from '@elabora/core/media/presets';

// Media jobs run in the background, one at a time by default (ffmpeg already uses every core).
// Each job is a file in <data dir>/media/jobs/ (data-dir.ts: the project's .elabora/, or local app
// data for projects in synced folders), so the queue survives a restart and any Elabora process
// (app, CLI, MCP server) sees the jobs of the others. A process claims a job with an exclusive
// lock file; a job left running by a process that is gone goes back to the queue.

export type MediaJobType = 'import' | 'optimize' | 'rendition';
export type MediaJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface MediaJob {
  id: string;
  type: MediaJobType;
  status: MediaJobStatus;
  input: string;                 // import: absolute path of the original; otherwise project-relative
  output: string;                // project-relative; renditions: relative to the data folder (cache/media/…)
  preset: PresetName;
  replaces: string | null;       // optimize: the file the output replaces (removed when done)
  keepOriginal: boolean;         // optimize: leave the replaced file for the caller to remove
  action: MediaPlan['action'] | null; // decided when the job runs
  progress: number;              // 0 to 1
  encoder: string | null;
  warnings: string[];
  error: string | null;
  inputHash: BlobHash | null;
  outputHash: BlobHash | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  owner: { pid: number; host: string } | null;
}

export interface NewMediaJob {
  type: MediaJobType;
  input: string;
  output: string;
  preset?: PresetName;
  replaces?: string | null;
  keepOriginal?: boolean;
}

export const jobsDir = (projectDir: string) => path.join(projectDataDir(projectDir), 'media', 'jobs');
// Outputs being written: on the machine's disk, never in a synced folder while they grow.
export const mediaTempDir = (projectDir: string) => path.join(projectDataDir(projectDir), 'media', 'tmp');
// Where a job writes its result.
export const jobOutputFile = (projectDir: string, job: Pick<MediaJob, 'type' | 'output'>) =>
  job.type === 'rendition' ? path.join(projectDataDir(projectDir), job.output) : path.join(projectDir, job.output);
const KEEP_FINISHED_MS = 7 * 24 * 3600 * 1000;
const FOREIGN_STALE_MS = 10 * 60 * 1000;

// Jobs running in this process, whichever queue object runs them.
const runningHere = new Set<string>();

export const isFinished = (status: MediaJobStatus) => status === 'done' || status === 'failed' || status === 'cancelled';

export function readJobs(projectDir: string): MediaJob[] {
  const dir = jobsDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  const jobs: MediaJob[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const job = readJobFile(path.join(dir, name));
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

// Project files that media jobs will write: references to them are expected (I_MEDIA_PROCESSING).
export function pendingOutputs(projectDir: string): string[] {
  return readJobs(projectDir).filter((job) => job.type !== 'rendition' && !isFinished(job.status)).map((job) => job.output);
}

function readJobFile(file: string): MediaJob | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as MediaJob; } catch { return null; }
}

export interface MediaQueueOptions {
  concurrency?: number;
  tools?: MediaTools;
  autoStart?: boolean; // run jobs as soon as they are added (default); otherwise on start() or wait()
}

// Events: 'queued', 'start', 'progress' and 'complete' (done, failed or cancelled), each with the job.
export class MediaQueue extends EventEmitter {
  readonly projectDir: string;
  readonly concurrency: number;
  private toolsGiven: MediaTools | undefined;
  readonly autoStart: boolean;
  private started = false;
  private closed = false;
  private readonly active = new Map<string, { job: MediaJob; controller: AbortController }>();

  constructor(projectDir: string, { concurrency = 1, tools, autoStart = true }: MediaQueueOptions = {}) {
    super();
    this.projectDir = path.resolve(projectDir);
    this.concurrency = Math.max(1, concurrency);
    this.toolsGiven = tools;
    this.autoStart = autoStart;
  }

  private jobFile(id: string) { return path.join(jobsDir(this.projectDir), `${id}.json`); }
  private lockFile(id: string) { return path.join(jobsDir(this.projectDir), `${id}.lock`); }
  private cancelFile(id: string) { return path.join(jobsDir(this.projectDir), `${id}.cancel`); }

  private save(job: MediaJob): void {
    job.updatedAt = new Date().toISOString();
    writeFileAtomic(this.jobFile(job.id), `${JSON.stringify(job, null, 2)}\n`);
  }

  list(): MediaJob[] {
    return readJobs(this.projectDir).map((job) => this.active.get(job.id)?.job ?? job);
  }

  get(id: string): MediaJob | null {
    return this.active.get(id)?.job ?? readJobFile(this.jobFile(id));
  }

  // Project files that unfinished jobs will write: names taken although the files do not exist yet.
  reservedOutputs(): Set<string> {
    return new Set(this.list().filter((j) => j.type !== 'rendition' && !isFinished(j.status)).map((j) => j.output));
  }

  // start: false only records the job (a caller holding the project lock starts the queue after).
  add(spec: NewMediaJob, { start = true }: { start?: boolean } = {}): MediaJob {
    const now = new Date().toISOString();
    const job: MediaJob = {
      id: `${now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${crypto.randomBytes(3).toString('hex')}`,
      type: spec.type, status: 'queued', input: spec.input, output: spec.output, preset: spec.preset ?? 'high',
      replaces: spec.replaces ?? null, keepOriginal: spec.keepOriginal ?? false,
      action: null, progress: 0, encoder: null, warnings: [], error: null, inputHash: null, outputHash: null,
      createdAt: now, startedAt: null, finishedAt: null, updatedAt: now, owner: null
    };
    this.save(job);
    this.emit('queued', job);
    if (start && (this.autoStart || this.started)) this.start();
    return job;
  }

  // Requeues jobs whose process is gone, forgets old finished jobs, then runs the queue.
  start(): this {
    if (this.closed) return this;
    if (!this.started) {
      this.started = true;
      const now = Date.now();
      for (const job of readJobs(this.projectDir)) {
        if (isFinished(job.status)) {
          if (job.finishedAt && now - Date.parse(job.finishedAt) > KEEP_FINISHED_MS) {
            fs.rmSync(this.jobFile(job.id), { force: true });
            fs.rmSync(this.cancelFile(job.id), { force: true });
          }
        } else if (job.status === 'running' && !this.ownerAlive(job)) {
          this.release(job);
          Object.assign(job, { status: 'queued', progress: 0, owner: null, startedAt: null });
          this.save(job);
        }
      }
    }
    this.pump();
    return this;
  }

  // Cancels a queued or running job, also one run by another process (it watches for a marker).
  cancel(id: string): MediaJob | null {
    const running = this.active.get(id);
    if (running) {
      running.controller.abort();
      return running.job;
    }
    const job = readJobFile(this.jobFile(id));
    if (!job || isFinished(job.status)) return job;
    if (job.status === 'running' && this.ownerAlive(job)) {
      fs.writeFileSync(this.cancelFile(id), '');
      return job;
    }
    this.finish(job, 'cancelled', null);
    return job;
  }

  // Resolves with the jobs once they are finished (all unfinished jobs when no ids are given).
  async wait(ids?: string[]): Promise<MediaJob[]> {
    this.start();
    const targets = ids ?? this.list().filter((j) => !isFinished(j.status)).map((j) => j.id);
    return Promise.all(targets.map((id) => this.waitOne(id)));
  }

  private waitOne(id: string): Promise<MediaJob> {
    return new Promise((resolve, reject) => {
      // Jobs of other processes are seen by polling their file.
      const timer = setInterval(() => check(), 500);
      const onComplete = (job: MediaJob) => { if (job.id === id) check(); };
      const done = () => { clearInterval(timer); this.off('complete', onComplete); };
      const check = () => {
        const job = this.get(id);
        if (!job) { done(); reject(new Error(`No media job ${id}`)); return; }
        if (isFinished(job.status)) { done(); resolve(job); return; }
        if (job.status === 'running' && !this.active.has(id) && !this.ownerAlive(job)) this.pump(true);
      };
      this.on('complete', onComplete);
      check();
    });
  }

  // Stops taking jobs; running ones are cancelled when asked, otherwise awaited.
  async close({ cancelRunning = false } = {}): Promise<void> {
    this.closed = true;
    const running = [...this.active.values()];
    if (cancelRunning) for (const r of running) r.controller.abort();
    await Promise.all(running.map((r) => this.waitOne(r.job.id).catch(() => null)));
  }

  private pump(requeueStale = false): void {
    if (this.closed || this.active.size >= this.concurrency) return;
    for (const job of readJobs(this.projectDir)) {
      if (this.active.size >= this.concurrency) return;
      if (requeueStale && job.status === 'running' && !this.active.has(job.id) && !this.ownerAlive(job)) {
        this.release(job);
        Object.assign(job, { status: 'queued', progress: 0, owner: null, startedAt: null });
        this.save(job);
      }
      if (job.status !== 'queued' || !this.claim(job)) continue;
      const controller = new AbortController();
      Object.assign(job, { status: 'running', startedAt: new Date().toISOString(), owner: { pid: process.pid, host: os.hostname() } });
      this.save(job);
      this.active.set(job.id, { job, controller });
      runningHere.add(job.id);
      this.emit('start', job);
      void this.run(job, controller).finally(() => {
        this.active.delete(job.id);
        runningHere.delete(job.id);
        this.pump();
      });
    }
  }

  private claim(job: MediaJob): boolean {
    const lock = this.lockFile(job.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }), { flag: 'wx' });
        // Another process may have finished it between our read and the claim.
        const current = readJobFile(this.jobFile(job.id));
        if (current?.status !== 'queued') { fs.rmSync(lock, { force: true }); return false; }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let owner: { pid?: number; host?: string; at?: string } = {};
        try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* being written */ }
        if (owner.pid && processAlive(job.id, owner.pid, owner.host, owner.at ?? job.updatedAt)) return false;
        fs.rmSync(lock, { force: true });
      }
    }
    return false;
  }

  private release(job: MediaJob): void {
    fs.rmSync(this.lockFile(job.id), { force: true });
    fs.rmSync(path.join(mediaTempDir(this.projectDir), job.id), { recursive: true, force: true });
  }

  private ownerAlive(job: MediaJob): boolean {
    return !!job.owner && processAlive(job.id, job.owner.pid, job.owner.host, job.updatedAt);
  }

  private finish(job: MediaJob, status: MediaJobStatus, error: string | null): void {
    Object.assign(job, { status, error, finishedAt: new Date().toISOString(), owner: null });
    if (status === 'done') job.progress = 1;
    this.save(job);
    this.release(job);
    fs.rmSync(this.cancelFile(job.id), { force: true });
    this.emit('complete', job);
  }

  private async tools(): Promise<MediaTools> {
    this.toolsGiven ??= await findMediaTools();
    return this.toolsGiven;
  }

  private async run(job: MediaJob, controller: AbortController): Promise<void> {
    const { signal } = controller;
    let lastSaved = 0;
    const watcher = setInterval(() => { if (fs.existsSync(this.cancelFile(job.id))) controller.abort(); }, 500);
    watcher.unref();
    const onProgress = (fraction: number) => {
      job.progress = Math.round(fraction * 1000) / 1000;
      if (Date.now() - lastSaved > 1000) { lastSaved = Date.now(); this.save(job); }
      this.emit('progress', job);
    };
    try {
      await this.execute(job, signal, onProgress);
      this.finish(job, 'done', null);
    } catch (error) {
      if (signal.aborted) this.finish(job, 'cancelled', null);
      else this.finish(job, 'failed', (error as Error).message);
    } finally {
      clearInterval(watcher);
    }
  }

  private async execute(job: MediaJob, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<void> {
    const projectDir = this.projectDir;
    const input = job.type === 'import' ? job.input : path.join(projectDir, job.input);
    const output = jobOutputFile(projectDir, job);
    const info = await probeMedia(input, { tools: this.toolsGiven });
    // SVG needs no ffmpeg: it is only ever copied.
    const tools = info.kind === 'vector' ? null : await this.tools();
    job.inputHash = job.type === 'import' ? await hashFile(input) : await projectFileHash(projectDir, job.input);
    const options = { webp: tools?.webp ?? true, importing: job.type === 'import' };
    const computed = job.type === 'rendition' ? renditionPlan(info, job.preset, options) : masterPlan(info, options);
    // The output name was chosen when the job was created: its extension decides the format.
    const plan: MediaPlan = { ...computed, extension: extensionOf(job.output) };
    job.action = plan.action;
    const temporaryDir = path.join(mediaTempDir(projectDir), job.id);
    fs.mkdirSync(temporaryDir, { recursive: true });
    const temporary = path.join(temporaryDir, `output${extensionOf(job.output)}`);
    if (signal.aborted) throw abortError(signal);

    if (plan.action === 'copy' || plan.action === 'reuse') {
      await copyOrClone(input, temporary);
    } else if (info.kind === 'image' && plan.action === 'remux' && stripImageMetadata(input, temporary, info.container as 'jpeg' | 'png' | 'webp')) {
      // metadata removed without re-encoding
    } else {
      if (info.kind === 'image' && plan.action === 'remux') Object.assign(plan, { action: 'encode', video: 'encode' });
      const result = await encodeMedia({ input, output: temporary, info, plan, preset: job.preset }, tools!, { signal, onProgress });
      job.encoder = result.encoder;
      job.warnings.push(...result.warnings);
    }
    if (signal.aborted) throw abortError(signal);

    // A rendition never weighs more than its master: ship the master's bytes then.
    if (job.type === 'rendition' && fs.statSync(temporary).size >= info.size) {
      await fs.promises.rm(temporary, { force: true });
      await copyOrClone(input, temporary);
      job.warnings.push('The rendition was not smaller than the master: the master is used.');
    }
    const outputInfo: MediaInfo = await probeMedia(temporary, { tools: tools ?? undefined });
    job.outputHash = await hashFile(temporary);
    if (signal.aborted) throw abortError(signal);
    await moveIntoPlace(temporary, output);
    fs.rmSync(temporaryDir, { recursive: true, force: true });
    if (job.type !== 'rendition') rememberProbe(projectDir, job.output, outputInfo);
    if (job.type === 'optimize' && job.replaces && job.replaces !== job.output && !job.keepOriginal) {
      await fs.promises.rm(path.join(projectDir, job.replaces), { force: true });
    }
  }
}

// A process of another computer (a project in a synced folder) cannot be checked: its job is
// considered abandoned when it has not been updated for ten minutes.
function processAlive(jobId: string, pid: number, host: string | undefined, updatedAt: string): boolean {
  if (host && host !== os.hostname()) return Date.now() - Date.parse(updatedAt) < FOREIGN_STALE_MS;
  if (pid === process.pid) return runningHere.has(jobId);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A clone shares the disk blocks of the source where the file system can (APFS, Btrfs, XFS).
async function copyOrClone(source: string, target: string): Promise<void> {
  if (!(await cloneFile(source, target))) await fs.promises.copyFile(source, target);
}

const queues = new Map<string, MediaQueue>();

// The queue of a project in this process: one per folder, created and started on first use.
export function getMediaQueue(projectDir: string, options: MediaQueueOptions = {}): MediaQueue {
  const key = path.resolve(projectDir);
  let queue = queues.get(key);
  if (!queue) {
    queue = new MediaQueue(key, options);
    queues.set(key, queue);
  }
  return queue;
}
