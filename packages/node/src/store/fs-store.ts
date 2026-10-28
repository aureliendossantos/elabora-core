import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { FileInfo, Store } from '@elabora/core/project/store';
import type { FileHash } from '@elabora/core/project/files';
import { projectPath } from '@elabora/core/project/files';
import { isIgnoredPath } from '../project-files.ts';
import { projectDataDir, toolDir } from '../data-dir.ts';
import { HASH_CACHE_FILE } from '../project-reader.ts';
import { HashCache } from '../backups/hash-cache.ts';
import { hashFile } from '../blobs.ts';

// A course folder as a Store (docs/architecture.md, Store): asynchronous reads, atomic writes
// (temporary file, then rename) that retry on the sharing violations of Windows and sync services,
// and recursive watching. The engine uses it; the CLI keeps its synchronous helpers.
//
// The folder holds the same files as project-files.ts lists (tool folders, OS files and
// temporary files left out); sync-service artefacts are listed, readSnapshot sets them apart.

export interface FsStoreOptions {
  // Cache the hashes of binary files by path, size and time in the project's data (the cache the
  // CLI's snapshots use too), so that media are hashed once. On by default.
  hashCache?: boolean;
}

const RETRY_ATTEMPTS = 6;

export class FsStore implements Store {
  readonly id: string;
  readonly #hashCache: boolean;
  #cache: HashCache | null = null;
  #saveTimer: NodeJS.Timeout | null = null;

  constructor(dir: string, options: FsStoreOptions = {}) {
    this.id = path.resolve(dir);
    this.#hashCache = options.hashCache !== false;
  }

  // Absolute path of a project file; refuses paths that leave the folder or name tool data.
  #resolve(rel: string): string {
    const key = projectPath(rel);
    if (key === null || key !== rel) throw new Error(`Not a project-relative POSIX path: "${rel}"`);
    return path.join(this.id, ...rel.split('/'));
  }

  async list(): Promise<FileInfo[]> {
    const found: FileInfo[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(abs, { withFileTypes: true });
      } catch (error) {
        // A folder removed while listing, or the project folder itself missing (an empty project).
        if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return;
        throw error;
      }
      await Promise.all(entries.map(async (entry) => {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        // Symbolic links are never followed: nothing outside the project is read.
        if (entry.isDirectory()) {
          // A folder is skipped when its own name is a tool folder (.elabora, dist, node_modules…).
          if (!isIgnoredPath(`${childRel}/-`)) await walk(path.join(abs, entry.name), childRel);
        } else if (entry.isFile() && !isIgnoredPath(childRel)) {
          try {
            const stat = await fs.promises.stat(path.join(abs, entry.name));
            found.push({ path: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
          } catch (error) {
            if (!isCode(error, 'ENOENT')) throw error; // deleted since the folder was read
          }
        }
      }));
    };
    await walk(this.id, '');
    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async stat(rel: string): Promise<FileInfo | null> {
    try {
      const stat = await fs.promises.stat(this.#resolve(rel));
      return stat.isFile() ? { path: rel, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    } catch (error) {
      if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return null;
      throw error;
    }
  }

  async readText(rel: string): Promise<string> {
    return fs.promises.readFile(this.#resolve(rel), 'utf8');
  }

  async readBytes(rel: string): Promise<Uint8Array> {
    const buffer = await fs.promises.readFile(this.#resolve(rel));
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  // SHA-256 of a file's bytes, read as a stream; from the cache when its size and time match.
  async hash(rel: string): Promise<FileHash> {
    const file = this.#resolve(rel);
    if (!this.#hashCache) return hashFile(file);
    const stat = await fs.promises.stat(file);
    const info: FileInfo = { path: rel, size: stat.size, mtimeMs: stat.mtimeMs };
    const cache = this.#loadCache();
    const known = cache.get(info);
    if (known) return known;
    const hashedAt = Date.now();
    const hash = await hashFile(file);
    // A file that changed while it was hashed keeps no entry: its next hash is computed again.
    const after = await fs.promises.stat(file).catch(() => null);
    if (after && after.size === stat.size && after.mtimeMs === stat.mtimeMs) {
      cache.set(info, hash, hashedAt);
      this.#scheduleSave();
    }
    return hash;
  }

  async write(rel: string, data: string | Uint8Array): Promise<void> {
    const file = this.#resolve(rel);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // The .tmp suffix keeps the temporary file out of listings and watchers (project-files.ts).
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(temporary, data);
    try {
      await retrying(() => fs.promises.rename(temporary, file));
    } catch (error) {
      await fs.promises.rm(temporary, { force: true });
      throw error;
    }
  }

  async remove(rel: string): Promise<void> {
    const file = this.#resolve(rel);
    try {
      await retrying(() => fs.promises.unlink(file));
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
  }

  // Recursive watching of the folder (FSEvents on macOS, ReadDirectoryChangesW on Windows; inotify
  // on Linux, folder by folder: watchFolders). Paths in tool folders (.elabora/ included) and
  // temporary files are left out.
  // onReady: inotify and ReadDirectoryChangesW watch from the call. FSEvents does not: the watchers
  // of a thread share one stream, built again on libuv's own thread a moment after each fs.watch
  // starts or stops, and what is written meanwhile is never reported. On macOS the folder is
  // watched from a thread of its own (watchInThread), whose stream no other watcher of the process
  // rebuilds, and the store writes a probe file in the project's .elabora/ until its watcher reports
  // it (watchProbe).
  watch(onChange: (paths: string[]) => void, onReady?: () => void): () => void {
    if (process.platform === 'linux') {
      if (onReady) queueMicrotask(onReady);
      return watchFolders(this.id, onChange);
    }
    let watcher: Watcher;
    try {
      watcher = process.platform === 'darwin' ? watchInThread(this.id) : fs.watch(this.id, { recursive: true });
    } catch {
      // Nothing to watch (the folder is missing): report unknown changes once, the caller lists again.
      queueMicrotask(() => {
        onChange([]);
        onReady?.();
      });
      return () => {};
    }
    const probe = onReady && process.platform === 'darwin' ? watchProbe(this.id, onReady) : null;
    if (onReady && !probe) queueMicrotask(onReady);
    watcher.on('change', (_event, filename) => {
      if (filename === null || filename === undefined) {
        onChange([]);
        return;
      }
      const rel = String(filename).split(path.sep).join('/');
      if (probe && rel === probe.path) probe.seen();
      if (!rel || isIgnoredPath(rel)) return;
      onChange([rel]);
    });
    // A watcher that fails (the folder was removed, too many files) reports unknown changes.
    watcher.on('error', () => onChange([]));
    return () => {
      probe?.stop();
      watcher.close();
    };
  }

  // Writes the hash cache now (the store also saves it a second after new hashes).
  flush(): void {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    // A folder moved or deleted while open is not recreated for the cache.
    if (!fs.existsSync(this.id)) return;
    try {
      this.#cache?.save();
    } catch {
      // A read-only folder: hashes are computed again next time.
    }
  }

  #loadCache(): HashCache {
    this.#cache ??= HashCache.load(path.join(projectDataDir(this.id), HASH_CACHE_FILE));
    return this.#cache;
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.flush();
    }, 1000);
    this.#saveTimer.unref();
  }
}

// Windows refuses to replace or delete a file another program has open (antivirus, sync client,
// preview): wait a little and try again. EBUSY means the same elsewhere.
async function retrying<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EBUSY' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
      if (!transient || attempt >= RETRY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

// What FsStore needs of a watcher: fs.watch's events and close.
interface Watcher {
  on(event: 'change', listener: (event: string, filename: string | Buffer | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  close(): void;
}

// On macOS libuv keeps one FSEvents stream per event loop: every fs.watch of a thread starts and
// stops in it, and each start or stop builds it again, losing what is written from about 16 ms
// before to 10 ms after for every watcher of that loop (the app's preview, another project opened
// or closed: packages/engine/bench/watch-rebuild.ts). A worker has its own event loop, hence its own
// stream: a folder watched from a worker of its own loses nothing when other watchers come and go.
// The worker is plain JavaScript evaluated from a string (no file to resolve in an app bundle);
// about 20 ms to start and 10 MB per folder watched.
const THREAD_WATCHER = `
const { parentPort, workerData } = require('node:worker_threads');
const watcher = require('node:fs').watch(workerData, { recursive: true });
watcher.on('change', (_event, filename) => parentPort.postMessage(filename === null || filename === undefined ? null : String(filename)));
watcher.on('error', (error) => parentPort.postMessage({ error: String(error) }));
`;

function watchInThread(dir: string): Watcher {
  // Missing or not a folder: thrown here, as fs.watch would.
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`);
  const events = new EventEmitter();
  const worker = new Worker(THREAD_WATCHER, { eval: true, workerData: dir, execArgv: [] });
  let closed = false;
  // Nothing is reported once closed (messages already sent by the thread included), as fs.watch.
  worker.on('message', (message: string | null | { error: string }) => {
    if (closed) return;
    if (message !== null && typeof message === 'object') events.emit('error', new Error(message.error));
    else events.emit('change', 'change', message);
  });
  worker.on('error', (error) => {
    if (!closed) events.emit('error', error);
  });
  worker.on('exit', () => {
    if (!closed) events.emit('error', new Error(`The watcher of ${dir} stopped`));
  });
  return Object.assign(events, {
    close: () => {
      closed = true;
      void worker.terminate();
    }
  });
}

// A file in .elabora/ (a tool folder: never content, left out of what the watcher reports), written
// every 25 ms until the watcher reports it, then removed; ready is called then. Not reported in 2 s
// (a volume without FSEvents), or not written (a read-only folder): ready is called all the same,
// and the caller's periodic listing finds what the watcher misses. Its name is the watcher's own,
// so that two watchers of one folder (two processes) never take each other's probe.
const PROBE_INTERVAL_MS = 25;
const PROBE_TIMEOUT_MS = 2000;

function watchProbe(root: string, ready: () => void): { path: string; seen: () => void; stop: () => void } {
  const rel = `${path.basename(toolDir(root))}/watch-${process.pid}-${crypto.randomBytes(4).toString('hex')}.probe`;
  const file = path.join(root, ...rel.split('/'));
  const started = Date.now();
  let done = false;
  let timer: NodeJS.Timeout | null = null;
  const remove = () => void fs.promises.rm(file, { force: true }).catch(() => {});
  const stop = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    remove();
  };
  const finish = () => {
    if (done) return;
    stop();
    ready();
  };
  const write = async () => {
    if (Date.now() - started >= PROBE_TIMEOUT_MS) return finish();
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, String(Date.now()));
    } catch {
      return finish();
    }
    if (done) remove(); // reported, or stopped, while it was written
    else timer = setTimeout(() => void write(), PROBE_INTERVAL_MS);
  };
  void write();
  return { path: rel, seen: finish, stop };
}

// Watches every folder of a project, each on its own. Node's recursive watcher on Linux watches each
// file by its inode, so a file replaced by a rename (an atomic write, the engine's own included) is
// no longer seen when it is written again. inotify reports a folder's children by name, whatever
// becomes of their inodes. A new folder is watched as it appears and reported as unknown changes
// (files may have been written in it first): the caller lists again.
export function watchFolders(root: string, onChange: (paths: string[]) => void): () => void {
  const watchers = new Map<string, fs.FSWatcher>();
  let closed = false;
  const unwatch = (rel: string) => {
    for (const [folder, watcher] of watchers) {
      if (folder === rel || folder.startsWith(`${rel}/`)) {
        watcher.close();
        watchers.delete(folder);
      }
    }
  };
  const watchTree = (rel: string): boolean => {
    if (closed || watchers.has(rel)) return false;
    const folder = rel ? path.join(root, ...rel.split('/')) : root;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(folder);
    } catch {
      return false; // gone, or not a folder
    }
    watchers.set(rel, watcher);
    watcher.on('change', (_event, filename) => {
      if (filename === null || filename === undefined) {
        onChange([]);
        return;
      }
      const child = rel ? `${rel}/${String(filename)}` : String(filename);
      if (isIgnoredPath(child)) return;
      let isFolder = false;
      try {
        isFolder = fs.lstatSync(path.join(root, ...child.split('/'))).isDirectory();
      } catch {
        unwatch(child); // removed: a folder takes its watchers with it
      }
      if (isFolder) {
        if (watchTree(child)) onChange([]);
        return;
      }
      onChange([child]);
    });
    watcher.on('error', () => {
      unwatch(rel);
      onChange([]);
    });
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      // Unreadable: its own changes are still reported.
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !isIgnoredPath(child)) watchTree(child);
    }
    return true;
  };
  if (!watchTree('')) queueMicrotask(() => onChange([])); // nothing to watch: the caller lists again
  return () => {
    closed = true;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
