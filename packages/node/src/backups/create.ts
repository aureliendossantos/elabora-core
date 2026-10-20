import path from 'node:path';
import { HashCache, HASH_CACHE_FILE } from './hash-cache.ts';
import { withBackupsLock } from './lock.ts';
import { captureProject, sameFiles, skipPredicate, sortedEntries, type Capture, type SkipOption } from './capture.ts';
import { FORMAT, newestVersion, newestVersionTime, newVersionId, toMs, writeVersion } from './store.ts';
import type { Author, Version, VersionReason, VersionReport } from './types.ts';
import { projectDataDir } from '../data-dir.ts';

export interface CreateVersionOptions {
  reason: VersionReason;
  name?: string | null; // a named version is kept until the user deletes it, and taken even when nothing changed
  batch?: string | null;
  author?: Author | null;
  skip?: SkipOption; // project paths to leave out (raw media waiting for conversion)
  now?: Date | number;
  // false forces plain copies instead of copy-on-write clones: a clone shares its disk blocks with
  // the project file, so it protects against edits and deletions, not against a damaged disk.
  clone?: boolean;
  onReport?: (report: VersionReport) => void;
}

// Versions taken within this window of the newest one are placed just after it, so that versions
// stay in the order they were taken when the clock is coarse or steps back a little. A larger gap
// (a computer with a wrong clock writing into a synced folder) is left as it is.
const REORDER_WINDOW_MS = 60_000;

function versionTime(now: number, newest: Version | null): string {
  const last = newest ? Date.parse(newest.time) : -Infinity;
  const t = now <= last && last - now < REORDER_WINDOW_MS ? last + 1 : now;
  return new Date(t).toISOString();
}

// Takes a version; the caller holds the backups lock. Returns the capture too, so that restore knows
// the current hash of every file.
export async function takeVersion(projectDir: string, options: CreateVersionOptions): Promise<{ version: Version | null; previous: Version | null; capture: Capture }> {
  const started = Date.now();
  const previous = newestVersion(projectDir);
  const cache = HashCache.load(path.join(projectDataDir(projectDir), HASH_CACHE_FILE));
  const capture = await captureProject(projectDir, { skip: skipPredicate(options.skip), previous, cache, clone: options.clone !== false });
  cache.save();
  const name = options.name?.trim() || null;
  let version: Version | null = null;
  if (!previous || name || !sameFiles(previous.files, capture.files)) {
    version = {
      format: FORMAT,
      id: newVersionId(),
      time: versionTime(toMs(options.now ?? Date.now()), previous),
      reason: options.reason,
      name,
      batch: options.batch ?? null,
      author: options.author ?? null,
      files: sortedEntries(capture.files),
      trimmed: {},
      skipped: capture.skipped,
    };
    writeVersion(projectDir, version);
  }
  options.onReport?.({
    created: version !== null,
    version: version?.id ?? null,
    hashedFiles: capture.hashedFiles,
    hashedBytes: capture.hashedBytes,
    reusedFiles: capture.reusedFiles,
    skipped: capture.skipped,
    durationMs: Date.now() - started,
  });
  return { version, previous, capture };
}

// Takes a version of the project, or returns null when nothing changed since the newest version
// (a named version is always taken). Only files that changed since the last version are read.
export async function createVersion(projectDir: string, options: CreateVersionOptions): Promise<Version | null> {
  return withBackupsLock(projectDir, `create (${options.reason})`, async () => (await takeVersion(projectDir, options)).version);
}

// Whether an automatic version is due: no version yet, or the newest is older than minIntervalMs.
// Cheap (file names only), so the CLI can ask before every write.
export function shouldTakeVersion(projectDir: string, options: { now?: Date | number; minIntervalMs?: number } = {}): boolean {
  const newest = newestVersionTime(projectDir);
  return newest === null || toMs(options.now ?? Date.now()) - newest >= (options.minIntervalMs ?? 5 * 60_000);
}
