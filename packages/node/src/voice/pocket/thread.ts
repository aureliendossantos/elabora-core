import { Worker } from 'node:worker_threads';
import { workerExecArgv } from '../../edit/auto-version.ts';
import { VoiceError } from '../provider.ts';
import type { FromThread, ThreadJob, ToThread } from './worker.ts';

// Pocket TTS in a worker thread (worker.ts): the thread that asks for a voice (the engine of the
// desktop app, the MCP server) goes on answering while the model speaks, and a generation can be
// stopped between two of its steps. The thread is started on the first line said and kept, its model
// freed by release(); it keeps the process alive only while it is saying something.

const WORKER = new URL('./worker.ts', import.meta.url);

// The thread's first code, evaluated: no file to resolve, so it runs with whatever flags the thread
// inherits and reads as CommonJS or as a module alike (as auto-version.ts's).
const BOOTSTRAP = `import('node:worker_threads').then(({ parentPort, workerData }) => import(workerData.module).then((worker) => worker.serve(parentPort)));`;

export interface ThreadResult {
  samples: Float32Array;
  sampleRate: number;
  retries: number;
}

interface Pending {
  resolve: (result: ThreadResult) => void;
  reject: (error: Error) => void;
  onProgress?: (fraction: number) => void;
}

export class PocketThread {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #released: (() => void)[] = [];
  #next = 0;

  synthesize(job: Omit<ThreadJob, 'id'>, { signal, onProgress }: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<ThreadResult> {
    signal?.throwIfAborted();
    const worker = this.#start();
    const id = ++this.#next;
    return new Promise<ThreadResult>((resolve, reject) => {
      const abort = () => this.#post(worker, { kind: 'abort', id });
      signal?.addEventListener('abort', abort, { once: true });
      const done = () => signal?.removeEventListener('abort', abort);
      this.#pending.set(id, {
        resolve: (result) => { done(); resolve(result); },
        reject: (error) => { done(); reject(signal?.aborted ? signal.reason ?? error : error); },
        onProgress
      });
      this.#post(worker, { kind: 'synthesize', job: { ...job, id } });
      this.#hold();
    });
  }

  // Frees the model held in memory; the thread stays, for the next line.
  release(): Promise<void> {
    const worker = this.#worker;
    if (!worker) return Promise.resolve();
    return new Promise((resolve) => {
      this.#released.push(resolve);
      this.#post(worker, { kind: 'release' });
      this.#hold();
    });
  }

  // The model freed, then the thread stopped.
  async dispose(): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    await this.release();
    this.#worker = null;
    await worker.terminate();
  }

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const execArgv = workerExecArgv(process.execArgv);
    const options = { eval: true, workerData: { module: WORKER.href } };
    let worker: Worker;
    try {
      worker = new Worker(BOOTSTRAP, { ...options, ...(execArgv ? { execArgv } : {}) });
    } catch (error) {
      if (!execArgv || (error as NodeJS.ErrnoException).code !== 'ERR_WORKER_INVALID_EXEC_ARGV') throw error;
      worker = new Worker(BOOTSTRAP, options);
    }
    worker.on('message', (message: FromThread) => this.#receive(message));
    // The thread failed to load or stopped: what it was saying fails, the next line starts another.
    const lost = (reason: string) => {
      if (this.#worker === worker) this.#worker = null;
      for (const [id, pending] of this.#pending) { this.#pending.delete(id); pending.reject(new VoiceError('E_VOICE_RUNTIME', reason)); }
      for (const resolve of this.#released.splice(0)) resolve();
    };
    worker.on('error', (error) => lost(`The voice thread failed: ${error instanceof Error ? error.message : String(error)}`));
    worker.on('exit', (code) => lost(`The voice thread stopped (exit code ${code}).`));
    // Unreferenced once its listeners are on (a 'message' listener references it again).
    worker.unref();
    this.#worker = worker;
    return worker;
  }

  // Referenced while a line or a release is under way: a command waiting for its voice does not end
  // before it; idle, the thread lets the process exit.
  #hold(): void {
    if (!this.#worker) return;
    if (this.#pending.size || this.#released.length) this.#worker.ref();
    else this.#worker.unref();
  }

  #post(worker: Worker, message: ToThread): void {
    worker.postMessage(message);
  }

  #receive(message: FromThread): void {
    if (message.kind === 'released') { this.#released.shift()?.(); this.#hold(); return; }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (message.kind === 'progress') { pending.onProgress?.(message.fraction); return; }
    this.#pending.delete(message.id);
    this.#hold();
    if (message.kind === 'done') pending.resolve({ samples: message.samples, sampleRate: message.sampleRate, retries: message.retries });
    else {
      const { name, message: text, code } = message.error;
      if (name === 'AbortError') pending.reject(new DOMException(text, 'AbortError'));
      else pending.reject(code ? new VoiceError(code, text) : new Error(text));
    }
  }
}
