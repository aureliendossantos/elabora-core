import fs from 'node:fs';
import path from 'node:path';
import type { BlobHash } from '../blobs.ts';
import type { FileInfo } from '../project-files.ts';

// Hashes of project files keyed by path, size and modification time, so that a version only reads
// the files that changed. A 300 MB video is hashed once, not every five minutes.

export const HASH_CACHE_FILE = path.join('backups', 'hash-cache.json');

// A file modified this shortly before it was hashed may change again within the same timestamp
// tick (2 s on FAT, 1 s on HFS+) and keep its size and time: such "racy" entries are not cached,
// as in git. They are hashed again next time.
const RACY_MS = 2_000;

type Entry = [size: number, mtimeMs: number, hash: BlobHash];

export class HashCache {
  readonly file: string;
  #entries = new Map<string, Entry>();
  #used = new Set<string>();
  #dirty = false;

  constructor(file: string) {
    this.file = file;
  }

  // A missing or damaged cache is an empty one: it only costs reading the files again.
  static load(file: string): HashCache {
    const cache = new HashCache(file);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { format?: string; entries?: Record<string, Entry> };
      if (data.format === 'elabora-hash-cache/1' && data.entries) {
        for (const [p, e] of Object.entries(data.entries)) {
          if (Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'number' && typeof e[2] === 'string') cache.#entries.set(p, e);
        }
      }
    } catch {
      // start empty
    }
    return cache;
  }

  get(info: FileInfo): BlobHash | null {
    this.#used.add(info.path);
    const e = this.#entries.get(info.path);
    return e && e[0] === info.size && e[1] === info.mtimeMs ? e[2] : null;
  }

  set(info: FileInfo, hash: BlobHash, hashedAtMs: number): void {
    this.#used.add(info.path);
    if (hashedAtMs - info.mtimeMs < RACY_MS) {
      this.#dirty ||= this.#entries.delete(info.path);
      return;
    }
    const e = this.#entries.get(info.path);
    if (e && e[0] === info.size && e[1] === info.mtimeMs && e[2] === hash) return;
    this.#entries.set(info.path, [info.size, info.mtimeMs, hash]);
    this.#dirty = true;
  }

  // Writes the cache, dropping the entries of files that were not looked up (deleted files), unless
  // prune is false (a caller that looked up one file only).
  save({ prune = true }: { prune?: boolean } = {}): void {
    for (const p of this.#entries.keys()) {
      if (prune && !this.#used.has(p)) {
        this.#entries.delete(p);
        this.#dirty = true;
      }
    }
    if (!this.#dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const entries = Object.fromEntries([...this.#entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    fs.writeFileSync(tmp, JSON.stringify({ format: 'elabora-hash-cache/1', entries }));
    fs.renameSync(tmp, this.file);
    this.#dirty = false;
  }
}
