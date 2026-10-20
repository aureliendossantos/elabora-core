import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { workerExecArgv } from '../edit/auto-version.ts';

// A model run by ONNX Runtime in a process of its own (the word aligner, align/worker.ts; the
// transcriber, transcribe/worker.ts), started on the first job and kept; it stops after two idle
// minutes, which frees the model's memory (0.8 to 1.5 GB) as the end of a process does. ONNX Runtime
// is native code that answers a request it cannot fit in memory by aborting the process: in a thread
// of the engine that stopped the engine and closed the module the author was editing (a recording of
// 90 s, 12 Oct 2026); in a process of its own, that stops the model alone, and the job it was running
// fails with the model's « crashed » code. The process is the program that runs this one (the app's
// own, as its command line is, ELECTRON_RUN_AS_NODE); it keeps the engine alive only while it works.

const BOOTSTRAP = 'import(process.env.ELABORA_MODEL_MODULE).then((worker) => worker.serve({ on: (event, listener) => process.on(event, listener), postMessage: (message) => process.send(message) }));';
const IDLE_MS = 120_000;

// The messages between a process and the module it serves.
export type ToModel<Job> =
  | { kind: 'run'; id: number; job: Job }
  | { kind: 'release' };

export type FromModel<Result> =
  | { kind: 'done'; id: number; result: Result }
  | { kind: 'failed'; id: number; error: { message: string; name: string; code?: string } }
  | { kind: 'released' };

// Where messages come from and go to, as the module that serves them sees it.
export interface ModelPort<Job, Result> {
  on(event: 'message', listener: (message: ToModel<Job>) => void): unknown;
  postMessage(message: FromModel<Result>): unknown;
}

// What the model is called in messages, and its errors (a code of the model: E_ALIGN_…, E_TRANSCRIBE_…).
export interface ModelProcessWording {
  name: string;                                       // « The word aligner »
  error: (code: string, message: string) => Error;
  crashed: string;                                    // the code of a process that stopped or could not be reached
  failed: string;                                     // the code of a job that failed without one
}

interface Pending<Result> {
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
}

export class ModelProcess<Job, Result> {
  #child: ChildProcess | null = null;
  #pending = new Map<number, Pending<Result>>();
  #next = 0;
  #idle: NodeJS.Timeout | null = null;
  #exits = new Set<Promise<void>>();
  readonly #module: string;
  readonly #wording: ModelProcessWording;
  // module: what the process serves (tests give a stand-in).
  constructor(module: string, wording: ModelProcessWording) {
    this.#module = module;
    this.#wording = wording;
  }

  run(job: Job): Promise<Result> {
    const child = this.#start();
    const id = ++this.#next;
    if (this.#idle) { clearTimeout(this.#idle); this.#idle = null; }
    return new Promise<Result>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const message: ToModel<Job> = { kind: 'run', id, job };
      child.send(message, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        this.#hold();
        reject(this.#wording.error(this.#wording.crashed, `${this.#wording.name} could not be reached: ${error.message}`));
      });
      this.#hold();
    });
  }

  // Stops the process (tests, a closing engine); a later job starts another.
  async dispose(): Promise<void> {
    if (this.#idle) { clearTimeout(this.#idle); this.#idle = null; }
    this.#stop();
    await Promise.all([...this.#exits]);
  }

  // The process is not held while it is idle (#hold), so the program that started it can end; but
  // one that is being stopped is held until it has gone: dispose() waits for its exit, and with
  // nothing else holding the event loop open a command's process ended there, before the exit it was
  // waiting for, and the rest of the command (its answer) never ran (elabora narration transcribe
  // printed nothing and exited 0, 13 October 2026).
  #stop(): void {
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    child.ref();
    child.channel?.ref();
    child.kill();
  }

  #start(): ChildProcess {
    if (this.#child) return this.#child;
    const execArgv = workerExecArgv(process.execArgv) ?? process.execArgv;
    const child = spawn(process.execPath, [...execArgv, '--input-type=module', '-e', BOOTSTRAP], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELABORA_MODEL_MODULE: this.#module }
    });
    // What it said before it stopped (ONNX Runtime and Node write the reason there).
    let said = '';
    child.stderr?.on('data', (chunk: Buffer) => { said = (said + chunk.toString('utf8')).slice(-600); });
    child.on('message', (message: FromModel<Result>) => this.#receive(message));
    let stopped!: () => void;
    const exited = new Promise<void>((resolve) => { stopped = resolve; });
    this.#exits.add(exited);
    void exited.then(() => this.#exits.delete(exited));
    let lost = false;
    const lose = (reason: string) => {
      if (lost) return;
      lost = true;
      if (this.#child === child) this.#child = null;
      const failure = said.trim().split('\n').filter(Boolean).pop();
      for (const [id, pending] of this.#pending) { this.#pending.delete(id); pending.reject(this.#wording.error(this.#wording.crashed, `${reason}${failure ? ` (${failure.slice(0, 200)})` : ''}`)); }
      stopped();
    };
    child.on('error', (error) => lose(`${this.#wording.name} could not start: ${error.message}`));
    child.on('exit', (code, signal) => lose(`${this.#wording.name} stopped (${signal ?? `exit code ${code}`}): the recording was too heavy for it, or the computer ran out of memory.`));
    child.unref();
    child.channel?.unref();
    this.#child = child;
    return child;
  }

  #hold(): void {
    const child = this.#child;
    if (!child) return;
    if (this.#pending.size) { child.ref(); child.channel?.ref(); }
    else { child.unref(); child.channel?.unref(); }
  }

  #receive(message: FromModel<Result>): void {
    if (message.kind === 'released') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    this.#hold();
    // Idle: the process ends after a while (its model takes a gigabyte or so), the next job starts it again.
    if (!this.#pending.size) this.#idle ??= setTimeout(() => { this.#idle = null; if (!this.#pending.size) this.#stop(); }, IDLE_MS).unref();
    if (message.kind === 'done') pending.resolve(message.result);
    else pending.reject(this.#wording.error(message.error.code ?? this.#wording.failed, message.error.message));
  }
}

// What the module a process runs does with the messages: one job at a time, in the order they came;
// an error is sent back, never thrown out of a process running an ONNX session (Node aborts: "mutex
// lock failed"). run: the job's result; release: frees the model (another folder, a removal).
export function serveModel<Job, Result>(port: ModelPort<Job, Result>, { run, release }: { run: (job: Job) => Promise<Result>; release: () => Promise<void> }): void {
  let queue: Promise<unknown> = Promise.resolve();
  const send = (message: FromModel<Result>) => port.postMessage(message);
  const job = async (id: number, payload: Job) => {
    try {
      send({ kind: 'done', id, result: await run(payload) });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const code = (failure as Error & { code?: unknown }).code;
      send({ kind: 'failed', id, error: { message: failure.message, name: failure.name, ...(typeof code === 'string' ? { code } : {}) } });
    }
  };
  port.on('message', (message: ToModel<Job>) => {
    if (message.kind === 'run') queue = queue.then(() => job(message.id, message.job));
    else if (message.kind === 'release') queue = queue.then(release).then(() => send({ kind: 'released' }), () => send({ kind: 'released' }));
  });
}
