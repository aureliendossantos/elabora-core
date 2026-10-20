import { Worker, MessageChannel, receiveMessageOnPort, type WorkerOptions } from 'node:worker_threads';
import type { Author } from '@elabora/core/ops/types';
import type { ProjectFiles } from '@elabora/core/project/files';
import { shouldTakeVersion } from '../backups/index.ts';
import type { VersionReason } from '../backups/index.ts';

// Automatic versions before writes (docs/architecture/storage.md, Backups): when the newest version is
// older than 5 minutes, the project is saved as it is just before the edit writes, and the
// project's data is pruned once the edit is done. Edits are synchronous (the CLI and the MCP server
// call them so) and backups are not, so the work runs in a worker thread while this thread waits.

export interface AutoVersion {
  version: string | null; // null: nothing changed since the newest version
  error?: string;         // the version could not be taken; the edit goes on
}

export type WorkerTask = { kind: 'version'; dir: string; author: Author; skip: string[]; reason: VersionReason } | { kind: 'prune'; dir: string };

// A first version of a project with large media can take a while (every file is hashed once).
const TIMEOUT_MS = 10 * 60_000;
const WORKER = new URL('./auto-version-worker.ts', import.meta.url);

// The worker's first code. Evaluated, it has no file to resolve, so it runs with whatever flags the
// thread inherits (`--input-type` included) and reads as CommonJS or as a module alike. It wakes
// the waiting thread in every case: with the task's outcome; with the error that kept the task
// module from loading or the task from finishing; from its exit event when the thread stops first
// (an uncaught error, process.exit).
const BOOTSTRAP = `import('node:worker_threads').then(({ workerData: { module, task, signal, port } }) => {
  let uncaught;
  const done = (outcome) => {
    if (Atomics.load(signal, 0) !== 0) return;
    port.postMessage(outcome);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  };
  const failed = (error) => done({ version: null, error: error instanceof Error ? error.message : String(error) });
  process.on('uncaughtExceptionMonitor', (error) => { uncaught = error; });
  process.on('exit', (code) => failed(uncaught ?? 'the worker stopped before finishing (exit code ' + code + ')'));
  return import(module).then((worker) => worker.runTask(task)).then(done, failed);
});`;

// files: the snapshot the edit read (media not conformant yet are left out of the version).
// reason: why the version is taken; anything but `auto` is taken whenever the edit writes (a format
// migration), and when nothing changed since the newest version, that one is the version returned.
export function takeAutoVersion(dir: string, author: Author, files: ProjectFiles, reason: VersionReason = 'auto'): AutoVersion | null {
  if (reason === 'auto' && !shouldTakeVersion(dir)) return null;
  // Raw media waiting for conversion are inputs, not sources (backups skip them).
  const skip = [...files].filter(([, file]) => file.kind === 'binary' && file.media && !file.media.conformant).map(([path]) => path);
  return runInWorker({ kind: 'version', dir, author, skip, reason });
}

// Prunes the journal and the backups (pruneProjectData). The caller must not hold the project lock.
export function pruneAfterVersion(dir: string): AutoVersion {
  return runInWorker({ kind: 'prune', dir });
}

// Runs a task in a worker thread and waits for its outcome. Tests give another module (what exports
// runTask) and a shorter wait.
export function runInWorker(task: WorkerTask, { module = WORKER, timeoutMs = TIMEOUT_MS }: { module?: URL; timeoutMs?: number } = {}): AutoVersion {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  let worker: Worker;
  try {
    worker = startWorker({ eval: true, workerData: { module: module.href, task, signal, port: port2 }, transferList: [port2] });
  } catch (error) {
    port1.close();
    return { version: null, error: `${task.kind} could not start: ${error instanceof Error ? error.message : String(error)}` };
  }
  // The bootstrap reports what stops the worker; unheard, its error event would end this process.
  worker.on('error', () => {});
  worker.unref();
  const waited = Atomics.wait(signal, 0, 0, timeoutMs);
  const message = receiveMessageOnPort(port1)?.message as AutoVersion | undefined;
  port1.close();
  if (waited === 'timed-out') void worker.terminate();
  return message ?? { version: null, error: waited === 'timed-out' ? `${task.kind} took too long` : `${task.kind} failed` };
}

// The worker does without the flags of the main entry. Given explicitly, flags of V8 or of the
// process (--max-old-space-size) are refused: the worker then inherits all of them, which the
// bootstrap runs with.
function startWorker(options: WorkerOptions): Worker {
  const execArgv = workerExecArgv(process.execArgv);
  try {
    return new Worker(BOOTSTRAP, { ...options, execArgv });
  } catch (error) {
    if (!execArgv || (error as NodeJS.ErrnoException).code !== 'ERR_WORKER_INVALID_EXEC_ARGV') throw error;
    return new Worker(BOOTSTRAP, options);
  }
}

// Flags that only apply to the main entry (`node --input-type=module -e "…"`, `node -p "…"`): a
// worker inheriting `--input-type` fails before running any code.
const ENTRY_FLAGS = new Set(['--input-type', '-e', '--eval', '-p', '--print', '-pe']);

// process.execArgv without the flags of the main entry and their values; undefined when it has
// none (the worker inherits the flags as they are).
export function workerExecArgv(execArgv: readonly string[]): string[] | undefined {
  const kept: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const flag = execArgv[i].split('=', 1)[0];
    if (!ENTRY_FLAGS.has(flag)) kept.push(execArgv[i]);
    else if (flag === execArgv[i] && i + 1 < execArgv.length && !execArgv[i + 1].startsWith('-')) i++; // its value
  }
  return kept.length < execArgv.length ? kept : undefined;
}
