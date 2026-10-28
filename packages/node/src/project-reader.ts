import fs from 'node:fs';
import path from 'node:path';
import { isTextPath, textFile } from '@elabora/core/project/files';
import type { ProjectFiles, SourceFile, BinaryFile, FileHash, SyncArtefact, MediaStatus } from '@elabora/core/project/files';
import { MEDIA_EXTENSIONS, extensionOf, fileMedia } from '@elabora/core/media/conformance';
import type { FileMedia } from '@elabora/core/media/conformance';
import { loadProject } from '@elabora/core/project/load';
import type { Project } from '@elabora/core/project/model';
import { validateProject } from '@elabora/core/validate/index';
import { listProjectFiles } from './project-files.ts';
import type { FileInfo } from './project-files.ts';
import { projectDataDir } from './data-dir.ts';
import { HashCache } from './backups/hash-cache.ts';
import { HASH_CACHE_FILE, hashFileSync } from './file-hash.ts';
import { probeProjectMediaSync } from './media/probe.ts';
import { pendingOutputs } from './media/jobs.ts';

// A course folder read into a files snapshot, synchronously (the CLI and the MCP server read the
// folder at each command). Text files are read; binary files are only listed: their hash is
// computed the first time something asks for it, through a cache keyed by path, size and
// modification time in the project's machine-local data, so media are hashed once, not at every
// command. Media files in assets/ carry their probe and verdict (media), from a cache in the same
// place: only new or changed files are probed (ffprobe), so a snapshot stays fast.

export { HASH_CACHE_FILE };

export interface FolderSnapshot {
  root: string; // absolute folder path
  files: ProjectFiles;
  artefacts: SyncArtefact[]; // sync-service files set apart (reported as W_SYNC_CONFLICT_COPY)
  media: MediaStatus; // media jobs under way, unreadable media, ffprobe missing
}

export function readProjectFiles(dir: string): FolderSnapshot {
  const root = path.resolve(dir);
  // A missing folder is an empty project: validation reports the missing course.json.
  if (!fs.existsSync(root)) return { root, files: new Map(), artefacts: [], media: { processing: [], unreadable: [], toolsMissing: false } };
  const { files: listed, artefacts } = listProjectFiles(root);
  const binaries = listed.filter((f) => !isTextPath(f.path));
  const hashes = hashCache(root, binaries);
  const mediaFiles = binaries.filter((f) => f.path.startsWith('assets/') && MEDIA_EXTENSIONS.has(extensionOf(f.path)));
  const probed = mediaFiles.length ? probeProjectMediaSync(root, mediaFiles) : null;
  const verdicts = new Map<string, FileMedia>();
  for (const [rel, info] of probed?.media ?? []) verdicts.set(rel, fileMedia(info, rel));
  const files = new Map<string, SourceFile>();
  for (const f of listed) {
    if (isTextPath(f.path)) {
      let text: string;
      try { text = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // deleted while listing
        throw e;
      }
      files.set(f.path, textFile(text));
    } else files.set(f.path, binaryEntry(f.path, f.size, hashes, verdicts.get(f.path)));
  }
  return { root, files, artefacts, media: mediaStatus(root, probed?.unreadable ?? [], probed?.toolsMissing ?? false) };
}

// Outputs of media jobs are read when something asks (a missing asset): finding the jobs needs the
// project's data folder, which a project without media never needs.
function mediaStatus(root: string, unreadable: MediaStatus['unreadable'], toolsMissing: boolean): MediaStatus {
  let processing: string[] | undefined;
  const status = { unreadable, toolsMissing } as MediaStatus;
  Object.defineProperty(status, 'processing', { enumerable: true, get: () => (processing ??= pendingOutputs(root)) });
  return Object.freeze(status);
}

export function loadProjectFromDir(dir: string): Project {
  const { root, files, artefacts, media } = readProjectFiles(dir);
  return loadProject(files, { root, artefacts, media });
}

// validateProject for a folder (CLI, MCP, tests).
export function validateDir(dir: string, options: { profiles?: string[]; release?: boolean } = {}) {
  return validateProject(loadProjectFromDir(dir), options);
}

function binaryEntry(rel: string, size: number, hashes: ReturnType<typeof hashCache>, media: FileMedia | undefined): BinaryFile {
  let hash: FileHash | undefined;
  const entry = { kind: 'binary', size, ...(media ? { media } : {}) } as BinaryFile;
  Object.defineProperty(entry, 'hash', { enumerable: true, get: () => (hash ??= hashes.get(rel)) });
  return Object.freeze(entry);
}

// The cache is read when the first hash is needed (finding the data folder may create the
// project's id) and written once per batch of new hashes.
function hashCache(root: string, binaries: readonly FileInfo[]) {
  let cache: HashCache | null = null;
  let flushQueued = false;
  const load = () => (cache ??= HashCache.load(path.join(projectDataDir(root), HASH_CACHE_FILE)));
  const flush = () => {
    flushQueued = false;
    const c = load();
    // Saving drops the entries not looked up: every binary file of the project keeps its own.
    for (const f of binaries) c.get(f);
    try { c.save(); } catch { /* read-only folder: hashes are computed again next time */ }
  };
  return {
    get(rel: string): FileHash | undefined {
      const abs = path.join(root, rel);
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { return undefined; }
      const info = { path: rel, size: st.size, mtimeMs: st.mtimeMs };
      const c = load();
      const known = c.get(info);
      if (known) return known;
      const hashedAt = Date.now();
      const hash = hashFileSync(abs);
      c.set(info, hash, hashedAt);
      if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
      return hash;
    }
  };
}
