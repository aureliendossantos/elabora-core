import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { isTextPath } from '@elabora/core/project/files';
import { blobPath, hasBlob, putFile, type BlobHash } from '../blobs.ts';
import { projectDataDir } from '../data-dir.ts';
import { JOURNAL_DIR, journalBlobReferences } from '../journal/journal.ts';
import { VERSIONS_DIR, isSafeProjectPath, loadVersions, parseVersion, versionFileName } from '../backups/store.ts';
import type { ZipInput } from '../packaging/zip-writer.ts';
import { LibraryError } from './errors.ts';
import { digestBytes, digestFile, moveFile } from './files.ts';

// A project's history in an archive (docs/architecture/storage.md, Backups; docs/architecture/operations.md, Journal and lock), under
// history/ :
//   history/journal/<yyyy-mm>.jsonl   the journal, as it is
//   history/versions/<file>.json      the backup versions' manifests, as they are
//   history/blobs/<sha256 hex>        the contents they refer to, except those that are files of the
//                                     project already (listed in historyBlobsInFiles: stored once)

export const HISTORY_PREFIX = 'history/';
export const HISTORY_PATH = /^history\/(journal\/\d{4}-\d{2}\.jsonl|versions\/[0-9A-Za-z.-]+\.json|blobs\/[0-9a-f]{64})$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

export interface ArchiveFile {
  path: string; // archive entry name
  size: number;
  hash: BlobHash;
}

export interface HistorySummary {
  versions: number;
  journalMonths: number;
  blobs: number; // contents stored in history/blobs
  blobsInFiles: number; // contents that are project files, stored once
  missingBlobs: BlobHash[]; // referenced but no longer in the store (removed by hand, damaged): restore reports them
  problems: string[]; // version manifests that could not be read, left out
}

export interface CollectedHistory {
  inputs: ZipInput[];
  files: ArchiveFile[];
  blobsInFiles: BlobHash[];
  summary: HistorySummary;
}

// Reads the history of a project for an archive. The caller holds the project and backups locks, so
// nothing is appended or collected meanwhile. projectHashes: hashes of the files being exported.
export async function collectHistory(projectDir: string, projectHashes: ReadonlySet<string>, onBytes: (bytes: number) => void): Promise<CollectedHistory> {
  const data = projectDataDir(projectDir);
  const collected: CollectedHistory = {
    inputs: [],
    files: [],
    blobsInFiles: [],
    summary: { versions: 0, journalMonths: 0, blobs: 0, blobsInFiles: 0, missingBlobs: [], problems: [] },
  };
  const add = (name: string, input: ZipInput, digest: { hash: BlobHash; size: number }) => {
    collected.inputs.push(input);
    collected.files.push({ path: name, size: digest.size, hash: digest.hash });
  };

  const journal = path.join(data, JOURNAL_DIR);
  const months = fs.existsSync(journal) ? fs.readdirSync(journal).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort() : [];
  for (const month of months) {
    const file = path.join(journal, month);
    const name = `${HISTORY_PREFIX}journal/${month}`;
    add(name, { name, file }, await digestFile(file, onBytes));
    collected.summary.journalMonths++;
  }

  // Strays (a sync service's copies of manifests) stay behind; unreadable manifests are reported.
  const { versions, problems } = loadVersions(projectDir);
  collected.summary.problems = problems;
  const pathOf = new Map<BlobHash, string>();
  for (const version of versions) {
    const fileName = versionFileName(version);
    const bytes = fs.readFileSync(path.join(data, VERSIONS_DIR, fileName));
    const name = `${HISTORY_PREFIX}versions/${fileName}`;
    add(name, { name, data: bytes }, digestBytes(bytes));
    onBytes(bytes.length);
    collected.summary.versions++;
    for (const [file, entry] of Object.entries(version.files)) if (!pathOf.has(entry.hash)) pathOf.set(entry.hash, file);
  }

  // The journal only refers to binary contents (text travels inside its operations).
  const referenced = new Set<BlobHash>([...pathOf.keys(), ...journalBlobReferences(projectDir)]);
  for (const hash of [...referenced].sort()) {
    if (projectHashes.has(hash)) {
      collected.blobsInFiles.push(hash);
      continue;
    }
    if (!hasBlob(projectDir, hash)) {
      collected.summary.missingBlobs.push(hash);
      continue;
    }
    const file = blobPath(projectDir, hash);
    const digest = await digestFile(file, onBytes);
    // A damaged blob would make the archive fail its own check on import: left out, like a missing one.
    if (digest.hash !== hash) {
      collected.summary.missingBlobs.push(hash);
      continue;
    }
    const name = `${HISTORY_PREFIX}blobs/${hash.slice('sha256:'.length)}`;
    const text = isTextPath(pathOf.get(hash) ?? '');
    add(name, text ? { name, file } : { name, file, store: true, known: { crc: digest.crc, size: digest.size } }, digest);
    collected.summary.blobs++;
  }
  collected.summary.blobsInFiles = collected.blobsInFiles.length;
  return collected;
}

// Checks history entries extracted to `stage` (history/ removed from their names) before anything
// is installed: manifests the backups can read under their own names, journal operations that only
// touch project paths.
export async function checkHistory(stage: string, files: readonly ArchiveFile[]): Promise<void> {
  for (const entry of files) {
    const rest = entry.path.slice(HISTORY_PREFIX.length);
    const file = path.join(stage, ...rest.split('/'));
    if (rest.startsWith('versions/')) {
      let version;
      try {
        version = parseVersion(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        throw new LibraryError('E_ARCHIVE_DAMAGED', `${entry.path} is not a backup version this Elabora can read (${(error as Error).message}).`);
      }
      if (versionFileName(version) !== rest.slice('versions/'.length)) throw new LibraryError('E_ARCHIVE_DAMAGED', `${entry.path} does not have its version's name.`);
    } else if (rest.startsWith('journal/')) {
      const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue; // a line cut short by a crash: the journal skips it too
        }
        const unsafe = unsafeJournalPath(value);
        if (unsafe !== null) throw new LibraryError('E_ARCHIVE_UNSAFE_PATH', `${entry.path} has an operation on ${JSON.stringify(unsafe)}, outside the project's files.`, { path: unsafe });
      }
    }
  }
}

// The first path of a journal entry that undo could not safely write to, or null.
function unsafeJournalPath(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as { ops?: unknown; inverse?: unknown; skipped?: unknown; files?: unknown };
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const ops = [...list(record.ops), ...list(record.inverse), ...list(record.skipped).map((skipped) => (skipped as { op?: unknown } | null)?.op)];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const { file, to, blob } = op as { file?: unknown; to?: { file?: unknown }; blob?: unknown };
    if (typeof file === 'string' && !isSafeProjectPath(file)) return file;
    if (to && typeof to === 'object' && typeof to.file === 'string' && !isSafeProjectPath(to.file)) return to.file;
    if (blob !== undefined && (typeof blob !== 'string' || !HASH.test(blob))) return String(blob);
  }
  for (const changed of list(record.files)) {
    const file = (changed as { path?: unknown } | null)?.path;
    if (typeof file === 'string' && !isSafeProjectPath(file)) return file;
  }
  return null;
}

// Installs checked history entries into the project's data folder. `own`: the project is new and
// the journal becomes its journal. `merge`: the project keeps its own journal (an import replaced its
// files); the archive's journal is kept beside it, under journal/imported/<time>/, which the journal
// does not read, and its versions and contents join the backups.
export async function installHistory(projectDir: string, stage: string, files: readonly ArchiveFile[], blobsInFiles: readonly BlobHash[], projectFiles: readonly ArchiveFile[], mode: { kind: 'own' } | { kind: 'merge'; stamp: string }): Promise<HistorySummary> {
  const data = projectDataDir(projectDir);
  const summary: HistorySummary = { versions: 0, journalMonths: 0, blobs: 0, blobsInFiles: 0, missingBlobs: [], problems: [] };
  for (const entry of files) {
    const rest = entry.path.slice(HISTORY_PREFIX.length);
    const from = path.join(stage, ...rest.split('/'));
    const name = rest.slice(rest.indexOf('/') + 1);
    if (rest.startsWith('versions/')) {
      const to = path.join(data, VERSIONS_DIR, name);
      if (fs.existsSync(to)) continue; // the same version, imported before
      await moveFile(from, to);
      summary.versions++;
    } else if (rest.startsWith('blobs/')) {
      const to = blobPath(projectDir, entry.hash);
      if (fs.existsSync(to)) continue;
      await moveFile(from, to);
      summary.blobs++;
    } else {
      const to = mode.kind === 'own' ? path.join(data, JOURNAL_DIR, name) : path.join(data, JOURNAL_DIR, 'imported', mode.stamp, name);
      await moveFile(from, to);
      summary.journalMonths++;
    }
  }
  for (const hash of blobsInFiles) {
    if (hasBlob(projectDir, hash)) continue;
    const file = projectFiles.find((candidate) => candidate.hash === hash);
    if (!file) continue;
    // A clone where the file system allows it: the project file and its blob share their blocks.
    await putFile(projectDir, path.join(projectDir, ...file.path.split('/')), hash);
    summary.blobsInFiles++;
  }
  return summary;
}
