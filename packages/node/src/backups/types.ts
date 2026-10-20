import type { BlobHash } from '../blobs.ts';

// Why a version was taken (docs/architecture/storage.md, Backups).
export type VersionReason = 'auto' | 'before-ai' | 'after-ai' | 'close' | 'publish' | 'migration' | 'import' | 'restore' | 'manual';

export const VERSION_REASONS: readonly VersionReason[] = ['auto', 'before-ai', 'after-ai', 'close', 'publish', 'migration', 'import', 'restore', 'manual'];

// Same shape as the author of a journal change.
export interface Author {
  kind: 'human' | 'agent' | 'external' | 'system';
  name?: string;
}

export interface FileEntry {
  hash: BlobHash;
  size: number;
}

// A file of the project that the version does not hold as it was at that time.
//   excluded           left out by the caller (raw media waiting for conversion)
//   unreadable         could not be read (locked by another program, permissions, unreadable folder)
//   changing           kept changing while it was copied
//   cloud-placeholder  only in the cloud (iCloud stub); the file itself is not on this computer
//   conflict-copy      a sync service's conflict copy of `original`: not content
//   symlink            symbolic links are never followed
// `kept` means the version holds the content the previous version had for that path, so restoring
// the version does not lose the file.
export interface SkippedFile {
  path: string;
  reason: 'excluded' | 'unreadable' | 'changing' | 'cloud-placeholder' | 'conflict-copy' | 'symlink';
  error?: string;
  original?: string;
  kept?: boolean;
}

export interface Version {
  format: 'elabora-backup/1';
  id: string;
  time: string; // ISO 8601, UTC
  reason: VersionReason;
  name: string | null;
  batch: string | null;
  author: Author | null;
  files: Record<string, FileEntry>; // project-relative POSIX path → content
  // Binary files removed by the retention: the version still says what they were, but their content
  // is no longer kept.
  trimmed: Record<string, FileEntry>;
  skipped: SkippedFile[];
}

export interface VersionSummary {
  id: string;
  time: string;
  reason: VersionReason;
  name: string | null;
  batch: string | null;
  author: Author | null;
  files: number;
  bytes: number; // total size of the files the version holds
  trimmed: number;
  skipped: number;
}

export interface VersionDiff {
  added: { path: string; after: FileEntry }[];
  removed: { path: string; before: FileEntry }[];
  changed: { path: string; before: FileEntry; after: FileEntry }[];
}

// One file a restore wrote or deleted, in the shape of a journal change's `files`.
export interface RestoredFile {
  path: string;
  before: BlobHash | null;
  after: BlobHash | null;
}

export interface RestoreResult {
  version: string; // the version restored
  before: string | null; // the version that holds the project as it was just before the restore
  changes: RestoredFile[];
  // Files of the version whose content is not in the store any more: trimmed by the retention,
  // missing, or damaged (the stored copy no longer matches its hash).
  unavailable: { path: string; reason: 'trimmed' | 'missing' | 'damaged' }[];
  // Files left as they are because their current content is in no backup (unreadable now, a cloud
  // placeholder, a symbolic link): a restore never destroys what it could not save first.
  kept: { path: string; reason: SkippedFile['reason'] }[];
  failed: { path: string; error: string }[]; // writes or deletions that failed (file locked by another program)
  unmatched: string[]; // selection patterns that matched no file of the version
}

export interface PruneResult {
  removed: string[]; // ids of the versions deleted by the retention
  trimmed: { id: string; paths: string[] }[];
  blobsRemoved: number;
  bytesFreed: number;
  problems: string[]; // manifests that could not be read; garbage collection is skipped while any exists
}

export interface BackupStatus {
  versions: number;
  named: number;
  oldest: VersionSummary | null;
  newest: VersionSummary | null;
  lastVersionTime: string | null;
  blobs: number;
  storedBytes: number; // logical size of .elabora/blobs (shared with the journal); clones may cost less on disk
  problems: string[];
}

// What a call to createVersion did, for the CLI's messages and for measurements.
export interface VersionReport {
  created: boolean;
  version: string | null;
  hashedFiles: number;
  hashedBytes: number;
  reusedFiles: number;
  skipped: SkippedFile[];
  durationMs: number;
}
