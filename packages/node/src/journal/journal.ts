import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Author, ChangeEntry, ChangeLike, FileContent, FileHash, Files, JournalEntry, MarkEntry, Op, SkippedOp, UndoEntry } from '@elabora/core/ops/types';
import { assignBatch } from '@elabora/core/ops/batch';
import { touchedFiles } from '@elabora/core/ops/apply';
import { blobPath, hasBlob, hashBytes, putBytes, putFileSnapshot, BLOBS_TMP_DIR, type BlobHash } from '../blobs.ts';
import { projectDataDir } from '../data-dir.ts';
import { copyFileCloneSync } from '../util/copy-sync.ts';
import { withProjectLockSync, type LockOptions } from './lock.ts';

// The journal: journal/<yyyy-mm>.jsonl in the project's data folder (data-dir.ts; .elabora/ by
// default), one change, undo record or mark per line,
// append-only, written under the project lock. Sequence numbers run across months. Readers need
// no lock: a line is written in one call, and a line cut short by a crash is ignored.
// Binary contents never go in the journal: write operations and their inverses name blobs.

// Relative to the project's data folder.
export const JOURNAL_DIR = 'journal';
export const JOURNAL_RETENTION_DAYS = 30;

export class JournalError extends Error {
  readonly code: 'E_BLOB_MISSING';

  constructor(code: 'E_BLOB_MISSING', message: string) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
  }
}

export interface NewChange {
  author: Author;
  command?: { name: string; args: unknown };
  ops: Op[];
  inverse: Op[];
  files: FileHash[];
  // Previous contents that are in no store (a binary file overwritten or deleted by a program that
  // is not an Elabora tool, before anything kept it): the change is journaled all the same, and undo
  // skips the inverse writes naming them (reason unavailable).
  unavailable?: string[];
}

export interface NewUndo extends NewChange {
  undoes: UndoEntry['undoes'];
  skipped: SkippedOp[];
}

export interface AppendOptions {
  now?: Date;
  lock?: LockOptions;
}

// ── writing ──────────────────────────────────────────────────────────

export function appendChange(dir: string, change: NewChange, options: AppendOptions = {}): ChangeEntry {
  assertBlobs(dir, change);
  return append(dir, options, (head, previous): ChangeEntry => ({
    type: 'change', ...head, author: change.author, batch: assignBatch(previous, { ...head, author: change.author }),
    ...(change.command ? { command: change.command } : {}), ops: change.ops, inverse: change.inverse, files: change.files,
    ...(change.unavailable?.length ? { unavailable: change.unavailable } : {})
  }));
}

export function appendUndo(dir: string, undo: NewUndo, options: AppendOptions = {}): UndoEntry {
  assertBlobs(dir, undo);
  return append(dir, options, (head, previous): UndoEntry => ({
    type: 'undo', ...head, author: undo.author, batch: assignBatch(previous, { ...head, author: undo.author }),
    ...(undo.command ? { command: undo.command } : {}), undoes: undo.undoes, skipped: undo.skipped,
    ops: undo.ops, inverse: undo.inverse, files: undo.files, ...(undo.unavailable?.length ? { unavailable: undo.unavailable } : {})
  }));
}

// Written when the user asks the AI for something: closes the current batch, labels the next.
export function appendMark(dir: string, mark: { request: string; author?: Author }, options: AppendOptions = {}): MarkEntry {
  return append(dir, options, (head): MarkEntry => ({ type: 'mark', ...head, author: mark.author ?? { kind: 'human' }, request: mark.request }));
}

function append<T extends JournalEntry>(dir: string, options: AppendOptions, build: (head: { seq: number; id: string; at: string }, previous: JournalEntry | undefined) => T): T {
  const root = path.resolve(dir);
  return withProjectLockSync(root, () => {
    const previous = lastEntry(root);
    const at = (options.now ?? new Date()).toISOString();
    const entry = build({ seq: (previous?.seq ?? 0) + 1, id: crypto.randomBytes(6).toString('hex'), at }, previous);
    // A clock set back across a month boundary must not reorder the files.
    const months = monthFiles(root);
    const newest = months.length ? path.basename(months[months.length - 1], '.jsonl') : '';
    const month = at.slice(0, 7) > newest ? at.slice(0, 7) : newest;
    appendLine(path.join(projectDataDir(root), JOURNAL_DIR, `${month}.jsonl`), JSON.stringify(entry));
    return entry;
  }, options.lock);
}

function appendLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+');
  try {
    // A line cut short by a crash stays alone on its line, where readers skip it.
    const size = fs.fstatSync(fd).size;
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    fs.writeSync(fd, `${prefix}${line}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

// Drops entries older than the retention period (the newest entry always stays, so sequence
// numbers go on). Returns the number of lines removed.
export function pruneJournal(dir: string, options: { now?: Date; days?: number; lock?: LockOptions } = {}): { removed: number } {
  const root = path.resolve(dir);
  const cutoff = (options.now ?? new Date()).getTime() - (options.days ?? JOURNAL_RETENTION_DAYS) * 86_400_000;
  return withProjectLockSync(root, () => {
    const newest = lastEntry(root)?.seq;
    let removed = 0;
    for (const file of monthFiles(root)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
      const kept = lines.filter((line) => {
        const entry = parseEntry(line);
        return entry !== undefined && (entry.seq === newest || Date.parse(entry.at) >= cutoff);
      });
      removed += lines.length - kept.length;
      if (!kept.length) fs.rmSync(file, { force: true });
      else if (kept.length < lines.length) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${kept.join('\n')}\n`);
        fs.renameSync(tmp, file);
      }
    }
    return { removed };
  }, options.lock);
}

// ── reading ──────────────────────────────────────────────────────────

// Every entry of every month, in sequence order.
export function readJournal(dir: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const file of monthFiles(dir)) entries.push(...readMonth(file));
  return entries.sort((a, b) => a.seq - b.seq);
}

export function lastEntry(dir: string): JournalEntry | undefined {
  for (const file of monthFiles(dir).reverse()) {
    const entry = lastEntryOf(file);
    if (entry) return entry;
  }
  return undefined;
}

// The last changes and undos, newest first, reading only the months needed.
export function lastChanges(dir: string, limit = 20): ChangeLike[] {
  const out: ChangeLike[] = [];
  for (const file of monthFiles(dir).reverse()) {
    const changes = readMonth(file).filter((entry): entry is ChangeLike => entry.type !== 'mark').sort((a, b) => b.seq - a.seq);
    for (const change of changes) {
      if (out.length >= limit) return out;
      out.push(change);
    }
  }
  return out;
}

// The changes of a batch, oldest first.
export function batchChanges(dir: string, batch: string): ChangeLike[] {
  return readJournal(dir).filter((entry): entry is ChangeLike => entry.type !== 'mark' && entry.batch === batch);
}

function monthFiles(dir: string): string[] {
  const folder = path.join(projectDataDir(dir), JOURNAL_DIR);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().map((name) => path.join(folder, name));
}

function readMonth(file: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

// The last valid line of a month file, read backwards by chunks: the file can be large.
function lastEntryOf(file: string): JournalEntry | undefined {
  const fd = fs.openSync(file, 'r');
  try {
    let end = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - 65536);
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      const buffer = Buffer.concat([chunk, carry]);
      // Newlines never occur inside UTF-8 sequences, so splitting bytes on them is safe.
      let lineEnd = buffer.length;
      for (;;) {
        const newline = lineEnd > 0 ? buffer.lastIndexOf(0x0a, lineEnd - 1) : -1;
        if (newline < 0 && start > 0) break; // the line may begin in an earlier chunk
        const entry = parseEntry(buffer.subarray(newline + 1, lineEnd).toString('utf8'));
        if (entry) return entry;
        if (newline < 0) return undefined;
        lineEnd = newline;
      }
      carry = buffer.subarray(0, lineEnd);
      end = start;
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

function parseEntry(line: string): JournalEntry | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as Partial<JournalEntry> | null;
    if (value && typeof value.seq === 'number' && typeof value.id === 'string' && typeof value.at === 'string' && (value.type === 'change' || value.type === 'undo' || value.type === 'mark')) {
      return value as JournalEntry;
    }
  } catch {
    // A line cut short by a crash.
  }
  return undefined;
}

// ── binary contents ──────────────────────────────────────────────────

// Puts in the blob store the binary contents that a change's write operations and their inverses
// name. Call it before writing the files: what an inverse restores is still in the project then.
// sources gives contents that are not in the project (an imported file), by hash: the bytes, or
// the path of a file. Files are copied first and the copy is hashed (putFileSnapshot), so a file
// that changed since it was read is refused rather than stored under the wrong hash.
// Contents the change records as unavailable are not looked for.
export async function storeChangeBlobs(dir: string, change: { ops: readonly Op[]; inverse: readonly Op[]; unavailable?: readonly string[] }, sources: ReadonlyMap<string, Uint8Array | string> = new Map()): Promise<void> {
  const root = path.resolve(dir);
  for (const op of [...change.inverse, ...change.ops]) {
    if (op.op !== 'write' || !('blob' in op)) continue;
    const hash = op.blob as BlobHash;
    if (hasBlob(root, hash) || (change.inverse.includes(op) && change.unavailable?.includes(hash))) continue;
    const source = sources.get(hash) ?? path.join(root, op.file);
    let stored: BlobHash;
    if (typeof source !== 'string') stored = putBytes(root, source);
    else if (!fs.existsSync(source)) throw new JournalError('E_BLOB_MISSING', `No content for ${op.file} (${hash}): ${source} does not exist`);
    else stored = (await putFileSnapshot(root, source)).hash;
    // What was stored keeps its own hash (garbage collection removes it); the change cannot go on.
    if (stored !== hash) throw new JournalError('E_BLOB_MISSING', `No content for ${op.file} (${hash}): ${typeof source === 'string' ? `${source} changed since it was read` : 'the bytes given have another hash'}`);
  }
}

// The same, synchronously, for writers that are (the CLI's edits): a file is copied (a clone where
// the file system allows it), then the copy is hashed before it becomes a blob.
export function storeChangeBlobsSync(dir: string, change: { ops: readonly Op[]; inverse: readonly Op[]; unavailable?: readonly string[] }, sources: ReadonlyMap<string, Uint8Array | string> = new Map()): void {
  const root = path.resolve(dir);
  for (const op of [...change.inverse, ...change.ops]) {
    if (op.op !== 'write' || !('blob' in op)) continue;
    const hash = op.blob as BlobHash;
    if (hasBlob(root, hash) || (change.inverse.includes(op) && change.unavailable?.includes(hash))) continue;
    const source = sources.get(hash) ?? path.join(root, op.file);
    if (typeof source !== 'string') {
      if (putBytes(root, source) !== hash) throw new JournalError('E_BLOB_MISSING', `No content for ${op.file} (${hash}): the bytes given have another hash`);
    } else if (!fs.existsSync(source)) throw new JournalError('E_BLOB_MISSING', `No content for ${op.file} (${hash}): ${source} does not exist`);
    else storeFileSync(root, source, hash, op.file);
  }
}

function storeFileSync(root: string, file: string, hash: BlobHash, name: string): void {
  const tmpDir = path.join(projectDataDir(root), BLOBS_TMP_DIR);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    copyFileCloneSync(file, tmp);
    if (hashFileSync(tmp) !== hash) throw new JournalError('E_BLOB_MISSING', `No content for ${name} (${hash}): ${file} changed since it was read`);
    const target = blobPath(root, hash);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function hashFileSync(file: string): BlobHash {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest('hex')}`;
}

function assertBlobs(dir: string, change: { ops: readonly Op[]; inverse: readonly Op[]; unavailable?: readonly string[] }): void {
  const root = path.resolve(dir);
  const unavailable = new Set(change.unavailable);
  for (const op of [...change.ops, ...change.inverse.filter((inverse) => !(inverse.op === 'write' && 'blob' in inverse && unavailable.has(inverse.blob)))]) {
    if (op.op === 'write' && 'blob' in op && !hasBlob(root, op.blob as BlobHash)) {
      throw new JournalError('E_BLOB_MISSING', `${op.file}: content ${op.blob} is not in the blob store (call storeChangeBlobs before writing the files)`);
    }
  }
}

// Every blob the journal refers to, for the garbage collection of the store (backups prune and
// collectGarbage take it as extraReferences): undo needs them for as long as the entries are kept.
// That is the contents of binary writes and their inverses, and the files as they were before each
// change (a writer keeps the text of a JSON file in another formatting, so that undo gives it back
// as it was; hashes of contents not kept are harmless).
export function journalBlobReferences(dir: string): BlobHash[] {
  const hashes = new Set<BlobHash>();
  const add = (ops: readonly Op[]) => {
    for (const op of ops) if (op.op === 'write' && 'blob' in op) hashes.add(op.blob as BlobHash);
  };
  for (const entry of readJournal(dir)) {
    if (entry.type === 'mark') continue;
    add(entry.ops);
    add(entry.inverse);
    if (entry.type === 'undo') add(entry.skipped.map((skipped) => skipped.op));
    for (const file of entry.files) if (file.before) hashes.add(file.before as BlobHash);
  }
  return [...hashes].sort();
}

// ── file hashes ──────────────────────────────────────────────────────

// sha256 of a file's bytes (text as UTF-8), as recorded in Change.files; null when absent (or a
// binary file whose snapshot does not know its hash).
export function contentHash(content: FileContent | undefined): string | null {
  if (!content) return null;
  return content.kind === 'binary' ? content.hash ?? null : hashBytes(content.text);
}

// The files a change touches, with their hashes before and after.
export function changeFileHashes(before: Files, after: Files, ops: readonly Op[]): FileHash[] {
  return touchedFiles(ops).sort().map((file) => ({ path: file, before: contentHash(before.get(file)), after: contentHash(after.get(file)) }));
}
