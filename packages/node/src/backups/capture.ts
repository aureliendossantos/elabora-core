import fs from 'node:fs';
import path from 'node:path';
import { hasBlob, putFileSnapshot } from '../blobs.ts';
import { listProjectFiles } from '../project-files.ts';
import type { HashCache } from './hash-cache.ts';
import type { FileEntry, SkippedFile, Version } from './types.ts';

// Reads the state of a project into the blob store: the files of a version.

export type SkipOption = Iterable<string> | ((path: string) => boolean);

export interface Capture {
  files: Map<string, FileEntry>; // what the version records
  current: Set<string>; // paths whose entry is their content now (others were kept from the previous version)
  present: Set<string>; // every path that exists in the project, captured or not
  skipped: SkippedFile[];
  hashedFiles: number;
  hashedBytes: number;
  reusedFiles: number;
}

export function skipPredicate(skip: SkipOption | undefined): (p: string) => boolean {
  if (!skip) return () => false;
  if (typeof skip === 'function') return skip;
  const set = new Set(skip);
  return (p) => set.has(p);
}

const ATTEMPTS = 3;
const STORE_ERRORS = new Set(['ENOSPC', 'EDQUOT', 'EROFS']);

// Copies a file into the store and checks that it did not change meanwhile (same size and time
// before and after the copy), so the blob is a state the file really had.
async function snapshot(projectDir: string, rel: string, clone: boolean, cache: HashCache): Promise<FileEntry | 'changing'> {
  const abs = path.join(projectDir, rel);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const hashedAt = Date.now();
    const before = await fs.promises.stat(abs);
    const stored = await putFileSnapshot(projectDir, abs, { clone });
    const after = await fs.promises.stat(abs);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs && stored.size === after.size) {
      cache.set({ path: rel, size: after.size, mtimeMs: after.mtimeMs }, stored.hash, hashedAt);
      return stored;
    }
  }
  return 'changing';
}

export async function captureProject(projectDir: string, options: { skip: (p: string) => boolean; previous: Version | null; cache: HashCache; clone: boolean }): Promise<Capture> {
  const { skip, previous, cache, clone } = options;
  const capture: Capture = { files: new Map(), current: new Set(), present: new Set(), skipped: [], hashedFiles: 0, hashedBytes: 0, reusedFiles: 0 };
  const unreadableFolders: string[] = [];

  // A file present but not readable now keeps the content of the previous version, so the version
  // stays complete and restoring it does not delete the file.
  const keepPrevious = (p: string, reason: SkippedFile['reason'], error?: string) => {
    const entry = previous?.files[p];
    if (entry) capture.files.set(p, entry);
    capture.present.add(p);
    capture.skipped.push({ path: p, reason, ...(error ? { error } : {}), ...(entry ? { kept: true } : {}) });
  };

  const { files, artefacts } = listProjectFiles(projectDir, {
    onSkipped: (p, reason, error) => {
      if (reason === 'symlink') {
        capture.present.add(p);
        capture.skipped.push({ path: p, reason });
      } else if (fs.statSync(path.join(projectDir, p), { throwIfNoEntry: false })?.isDirectory()) {
        unreadableFolders.push(p);
        capture.skipped.push({ path: p, reason: 'unreadable', ...(error?.code ? { error: error.code } : {}) });
      } else {
        keepPrevious(p, 'unreadable', error?.code);
      }
    },
  });

  for (const folder of unreadableFolders) {
    for (const [p, entry] of Object.entries(previous?.files ?? {})) {
      if (p.startsWith(`${folder}/`)) {
        capture.files.set(p, entry);
        capture.present.add(p);
      }
    }
  }
  const listed = new Set(files.map((f) => f.path));
  for (const a of artefacts) {
    if (a.kind === 'conflict-copy') capture.skipped.push({ path: a.path, reason: 'conflict-copy', ...(a.original ? { original: a.original } : {}) });
    else if (a.original && !listed.has(a.original)) keepPrevious(a.original, 'cloud-placeholder');
  }

  for (const info of files) {
    capture.present.add(info.path);
    if (skip(info.path)) {
      capture.skipped.push({ path: info.path, reason: 'excluded' });
      continue;
    }
    const cached = cache.get(info);
    if (cached && hasBlob(projectDir, cached)) {
      capture.files.set(info.path, { hash: cached, size: info.size });
      capture.current.add(info.path);
      capture.reusedFiles++;
      continue;
    }
    let entry: FileEntry | 'changing';
    try {
      entry = await snapshot(projectDir, info.path, clone, cache);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // The store cannot be written: the version fails rather than pretending to hold the file.
      if (code && STORE_ERRORS.has(code)) throw e;
      if (code === 'ENOENT') {
        capture.present.delete(info.path); // deleted while the version was taken
        continue;
      }
      keepPrevious(info.path, 'unreadable', code ?? (e as Error).message);
      continue;
    }
    if (entry === 'changing') {
      keepPrevious(info.path, 'changing');
      continue;
    }
    capture.files.set(info.path, entry);
    capture.current.add(info.path);
    capture.hashedFiles++;
    capture.hashedBytes += entry.size;
  }
  return capture;
}

// Plain object with sorted keys, so manifests are stable and diffable.
export function sortedEntries(files: Map<string, FileEntry>): Record<string, FileEntry> {
  return Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function sameFiles(a: Record<string, FileEntry>, b: Map<string, FileEntry>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== b.size) return false;
  return keys.every((p) => b.get(p)?.hash === a[p].hash);
}
