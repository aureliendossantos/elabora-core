import fs from 'node:fs';
import path from 'node:path';
import { BLOBS_TMP_DIR, blobPath, listBlobs, type BlobHash } from '../blobs.ts';
import { isTextFile, listProjectFiles } from '../project-files.ts';
import { HashCache, HASH_CACHE_FILE } from './hash-cache.ts';
import { withBackupsLock } from './lock.ts';
import { DAY, retentionPlan } from './retention.ts';
import { loadVersions, removeVersionFile, toMs, writeVersion } from './store.ts';
import type { PruneResult, Version } from './types.ts';
import { projectDataDir } from '../data-dir.ts';

// Blobs referenced by something else than the backups (the journal's binary writes and inverses).
export type ExtraReferences = () => Iterable<BlobHash> | Promise<Iterable<BlobHash>>;

export interface PruneOptions {
  now?: Date | number;
  extraReferences?: ExtraReferences;
  // Blobs younger than this (real time) are never collected: another writer (the journal) may have
  // stored one and not recorded it yet.
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 10 * 60_000;
const TMP_MAX_AGE_MS = 60 * 60_000;

function addHashes(into: Set<BlobHash>, v: Version): void {
  for (const e of Object.values(v.files)) into.add(e.hash);
}

// Hashes of the project as it is: the newest version, and the files whose cached hash is still valid
// (unchanged since they were last hashed). Nothing is read.
function currentHashes(projectDir: string, newest: Version | null): Set<BlobHash> {
  const hashes = new Set<BlobHash>();
  if (newest) addHashes(hashes, newest);
  const cache = HashCache.load(path.join(projectDataDir(projectDir), HASH_CACHE_FILE));
  const { files } = listProjectFiles(projectDir, { onSkipped: () => {} });
  for (const info of files) {
    const hash = cache.get(info);
    if (hash) hashes.add(hash);
  }
  return hashes;
}

// Removes a blob, also when it was stored read-only (Windows refuses to delete read-only files).
function removeBlobFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM' && (e as NodeJS.ErrnoException).code !== 'EACCES') throw e;
    fs.chmodSync(file, 0o666);
    fs.rmSync(file, { force: true });
  }
}

async function collect(projectDir: string, referenced: Set<BlobHash>, graceMs: number): Promise<{ blobsRemoved: number; bytesFreed: number }> {
  let blobsRemoved = 0;
  let bytesFreed = 0;
  const realNow = Date.now();
  for (const hash of listBlobs(projectDir)) {
    if (referenced.has(hash)) continue;
    const file = blobPath(projectDir, hash);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) continue;
    // A clone keeps the time of its source; the change time tells when it entered the store.
    if (realNow - Math.max(st.ctimeMs, st.mtimeMs, st.birthtimeMs) < graceMs) continue;
    removeBlobFile(file);
    blobsRemoved++;
    bytesFreed += st.size;
  }
  // Temporary files left by a process that died while storing a blob.
  const tmpDir = path.join(projectDataDir(projectDir), BLOBS_TMP_DIR);
  for (const name of fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []) {
    const file = path.join(tmpDir, name);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && realNow - Math.max(st.ctimeMs, st.mtimeMs) > TMP_MAX_AGE_MS) fs.rmSync(file, { force: true });
  }
  return { blobsRemoved, bytesFreed };
}

async function referencedBlobs(versions: Version[], extraReferences?: ExtraReferences): Promise<Set<BlobHash>> {
  const referenced = new Set<BlobHash>();
  for (const v of versions) addHashes(referenced, v);
  if (extraReferences) for (const hash of await extraReferences()) referenced.add(hash);
  return referenced;
}

// Applies the retention, trims the binary files of versions older than 30 days that nothing else
// needs, then deletes the blobs no version and no other referrer uses. Nothing is collected while a
// manifest cannot be read: its blobs might be the only copy of something.
export async function prune(projectDir: string, options: PruneOptions = {}): Promise<PruneResult> {
  return withBackupsLock(projectDir, 'prune', async () => {
    const now = toMs(options.now ?? Date.now());
    const { versions, strays, problems } = loadVersions(projectDir);
    const plan = retentionPlan(versions.map((v) => ({ id: v.id, time: Date.parse(v.time), name: v.name })), now);
    const kept = versions.filter((v) => plan.keep.has(v.id));
    const result: PruneResult = { removed: [], trimmed: [], blobsRemoved: 0, bytesFreed: 0, problems };

    // A binary file leaves an old version only when that frees its content: it is not in the current
    // project, in a named version, in a version of the last 30 days, or used by another referrer.
    const needed = currentHashes(projectDir, versions.length ? versions[versions.length - 1] : null);
    for (const v of kept) if (v.name !== null || now - Date.parse(v.time) <= 30 * DAY) addHashes(needed, v);
    for (const v of strays) addHashes(needed, v);
    if (options.extraReferences) for (const hash of await options.extraReferences()) needed.add(hash);

    for (const v of kept) {
      if (!plan.weekly.has(v.id)) continue;
      const paths = Object.keys(v.files).filter((p) => !isTextFile(p) && !needed.has(v.files[p].hash));
      if (!paths.length) continue;
      for (const p of paths) {
        v.trimmed[p] = v.files[p];
        delete v.files[p];
      }
      v.trimmed = Object.fromEntries(Object.entries(v.trimmed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      writeVersion(projectDir, v);
      result.trimmed.push({ id: v.id, paths });
    }
    for (const v of versions) {
      if (plan.keep.has(v.id)) continue;
      removeVersionFile(projectDir, v);
      result.removed.push(v.id);
    }

    if (!problems.length) {
      const referenced = await referencedBlobs([...kept, ...strays], options.extraReferences);
      Object.assign(result, await collect(projectDir, referenced, options.graceMs ?? DEFAULT_GRACE_MS));
    }
    return result;
  });
}

// Garbage collection alone, for other referrers (the journal after compaction).
export async function collectGarbage(projectDir: string, options: { extraReferences?: ExtraReferences; graceMs?: number } = {}): Promise<{ blobsRemoved: number; bytesFreed: number; problems: string[] }> {
  return withBackupsLock(projectDir, 'collect', async () => {
    const { versions, strays, problems } = loadVersions(projectDir);
    if (problems.length) return { blobsRemoved: 0, bytesFreed: 0, problems };
    const referenced = await referencedBlobs([...versions, ...strays], options.extraReferences);
    return { ...(await collect(projectDir, referenced, options.graceMs ?? DEFAULT_GRACE_MS)), problems };
  });
}

// Deletes a version (the user deleting a named version); its blobs go at the next pruning.
export async function deleteVersion(projectDir: string, id: string): Promise<boolean> {
  return withBackupsLock(projectDir, 'delete', async () => {
    const v = loadVersions(projectDir).versions.find((x) => x.id === id);
    if (!v) return false;
    removeVersionFile(projectDir, v);
    return true;
  });
}

// Names a version so the retention keeps it, or removes its name (null) so it ages like the others.
export async function nameVersion(projectDir: string, id: string, name: string | null): Promise<Version | null> {
  return withBackupsLock(projectDir, 'name', async () => {
    const v = loadVersions(projectDir).versions.find((x) => x.id === id);
    if (!v) return null;
    v.name = name?.trim() || null;
    writeVersion(projectDir, v);
    return v;
  });
}
