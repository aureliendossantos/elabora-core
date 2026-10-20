import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FileHash } from '@elabora/core/project/files';
import { projectDataDir } from './data-dir.ts';
import { HashCache } from './backups/hash-cache.ts';
import type { FileInfo } from './project-files.ts';

// Hashes of a project's binary files, cached by path, size and modification time in the project's
// machine-local data. The snapshot (project-reader.ts), the media renditions (keyed by the hash of
// their master) and the media jobs share the cache, so a 300 MB video is hashed once.

export const HASH_CACHE_FILE = path.join('cache', 'hashes.json'); // in projectDataDir

const cachePath = (projectDir: string) => path.join(projectDataDir(projectDir), HASH_CACHE_FILE);

// Read in chunks: a 300 MB video is never held in memory.
export function hashFileSync(file: string): FileHash {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${h.digest('hex')}`;
}

async function hashFileAsync(file: string): Promise<FileHash> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) h.update(chunk as Buffer);
  return `sha256:${h.digest('hex')}`;
}

function lookup(projectDir: string, rel: string): { info: FileInfo; cache: HashCache; known: FileHash | null } {
  const st = fs.statSync(path.join(projectDir, rel));
  const info = { path: rel, size: st.size, mtimeMs: st.mtimeMs };
  const cache = HashCache.load(cachePath(projectDir));
  return { info, cache, known: cache.get(info) };
}

// Another process may write the cache too: the entries of the other files are kept.
function remember(cache: HashCache, info: FileInfo, hash: FileHash, hashedAt: number): void {
  cache.set(info, hash, hashedAt);
  try { cache.save({ prune: false }); } catch { /* read-only data folder: hashed again next time */ }
}

// The hash of one project file (project-relative POSIX path), through the cache.
export function projectFileHashSync(projectDir: string, rel: string): FileHash {
  const { info, cache, known } = lookup(projectDir, rel);
  if (known) return known;
  const hashedAt = Date.now();
  const hash = hashFileSync(path.join(projectDir, rel));
  remember(cache, info, hash, hashedAt);
  return hash;
}

// The same, reading the file without blocking: media jobs run in the editing engine's process.
export async function projectFileHash(projectDir: string, rel: string): Promise<FileHash> {
  const { info, cache, known } = lookup(projectDir, rel);
  if (known) return known;
  const hashedAt = Date.now();
  const hash = await hashFileAsync(path.join(projectDir, rel));
  remember(HashCache.load(cache.file), info, hash, hashedAt);
  return hash;
}
