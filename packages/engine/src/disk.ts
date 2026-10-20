import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { binaryFile, isTextPath, textFile } from '@elabora/core/project/files';
import type { FileHash, ProjectFiles, SourceFile } from '@elabora/core/project/files';
import type { FileInfo, Store } from '@elabora/core/project/store';
import type { FileContent, Files } from '@elabora/core/ops/types';
import { applyOps } from '@elabora/core/ops/apply';
import { OpError } from '@elabora/core/ops/errors';
import type { Op } from '@elabora/core/ops/types';
import { hashBytes } from '@elabora/node/blobs';

// Reading project files as the engine compares them with its snapshot: text with its text, binary
// files with their hash. A binary file whose size or time changed while it was hashed is still
// being written (an agent copying a video): it is read again later.

// The engine needs a store that can say a file's size and time and hash it (FsStore can).
export type SessionStore = Store & Required<Pick<Store, 'stat' | 'hash'>>;

export type DiskRead =
  | { kind: 'file'; file: SourceFile; info: FileInfo }
  | { kind: 'missing' }
  | { kind: 'unstable' };

// settleMs: a binary file modified more recently than this is still being written: it is not
// hashed yet (a 300 MB video being copied is hashed once, when it is complete).
export async function readDisk(store: SessionStore, rel: string, options: { settleMs?: number } = {}): Promise<DiskRead> {
  const info = await store.stat(rel);
  if (!info) return { kind: 'missing' };
  try {
    if (isTextPath(rel)) return { kind: 'file', file: textFile(await store.readText(rel)), info };
    if (options.settleMs && Date.now() - info.mtimeMs < options.settleMs) return { kind: 'unstable' };
    const hash = await store.hash(rel);
    const again = await store.stat(rel);
    if (!again || again.size !== info.size || again.mtimeMs !== info.mtimeMs) return { kind: 'unstable' };
    return { kind: 'file', file: binaryFile(info.size, { hash }), info };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
}

// The same, synchronously, for the rare moment a command finds a file it touches changed on disk
// (the executor asks for a fresh snapshot from inside its synchronous attempt).
export function readDiskSync(root: string, rel: string): DiskRead {
  const file = path.join(root, ...rel.split('/'));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { kind: 'missing' };
  }
  if (!stat.isFile()) return { kind: 'missing' };
  const info: FileInfo = { path: rel, size: stat.size, mtimeMs: stat.mtimeMs };
  try {
    if (isTextPath(rel)) return { kind: 'file', file: textFile(fs.readFileSync(file, 'utf8')), info };
    const hash = hashFileSync(file);
    const again = fs.statSync(file);
    if (again.size !== stat.size || again.mtimeMs !== stat.mtimeMs) return { kind: 'unstable' };
    return { kind: 'file', file: binaryFile(stat.size, { hash }), info };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
}

function hashFileSync(file: string): FileHash {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest('hex')}`;
}

// sha256 of a file's bytes, as the journal records it; null for a binary file of unknown hash.
export function hashOf(file: SourceFile | FileContent | null | undefined): string | null {
  if (!file) return null;
  return file.kind === 'text' ? hashBytes(file.text) : file.hash ?? null;
}

// A file of the operations' world (what an edit wrote) as a snapshot entry. Binary files written by
// operations know their hash; their size is read from the file written.
export function toSourceFile(root: string, rel: string, content: FileContent | undefined): SourceFile | null {
  if (!content) return null;
  if (content.kind === 'text') return content;
  let size = content.size;
  if (size === undefined) {
    try { size = fs.statSync(path.join(root, ...rel.split('/'))).size; } catch { size = 0; }
  }
  return binaryFile(size, content.hash ? { hash: content.hash as FileHash } : {});
}

// The snapshot with some files set or removed (null).
export function withUpdates(files: ProjectFiles, updates: ReadonlyMap<string, SourceFile | null>): Map<string, SourceFile> {
  const next = new Map(files);
  for (const [rel, file] of updates) {
    if (file === null) next.delete(rel);
    else next.set(rel, file);
  }
  return next;
}

// Operations applied to files, or null when they do not apply (the files are not what they were
// computed on).
export function tryApply(files: Files, ops: readonly Op[]): Files | null {
  try {
    return applyOps(files, ops);
  } catch (error) {
    if (error instanceof OpError) return null;
    throw error;
  }
}

// Paths of the snapshot inside a folder (a folder that was deleted or renamed).
export function pathsInside(files: ProjectFiles, folder: string): string[] {
  const prefix = `${folder}/`;
  return [...files.keys()].filter((rel) => rel.startsWith(prefix));
}
