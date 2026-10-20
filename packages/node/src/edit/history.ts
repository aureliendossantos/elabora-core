import path from 'node:path';
import type { Author, ChangeLike, JournalEntry, SkippedOp } from '@elabora/core/ops/types';
import { invertOps, touchedFiles } from '@elabora/core/ops/apply';
import { undoChanges } from '@elabora/core/ops/undo';
import { changesToUndo, lastAiBatch, summarizeBatches, undoneChanges, type BatchSummary } from '@elabora/core/ops/batch';
import { CommandError } from '@elabora/core/commands/index';
import { hasBlob, type BlobHash } from '../blobs.ts';
import { withProjectLockSync, readJournal, appendUndo, appendMark as appendJournalMark, detectAuthor } from '../journal/index.ts';
import { changedOnDisk, restoreOriginalTexts } from './disk.ts';
import { commit, conflict, editResult, pruneAfter, snapshotFor, translateErrors, type EditOptions, type EditResult } from './executor.ts';
import { takeAutoVersion, type AutoVersion } from './auto-version.ts';

// History and undo, from the journal (journal/<yyyy-mm>.jsonl in the project's data folder).

export interface HistoryEntry {
  seq: number;
  id: string;
  op: string;       // the command (create_screen…), undo, or the author kind for file edits made outside Elabora
  at: string;
  author: Author;
  batch: string;
  files: string[];
  undone: boolean;
}

const nameOf = (entry: ChangeLike): string => entry.command?.name ?? (entry.type === 'undo' ? 'undo' : entry.author.kind);

// The last changes, oldest first.
export function history(dir: string, limit = 20): HistoryEntry[] {
  const entries = readJournal(dir);
  const undone = undoneChanges(entries);
  return entries.filter((entry): entry is ChangeLike => entry.type !== 'mark').slice(-limit).map((entry) => ({
    seq: entry.seq, id: entry.id, op: nameOf(entry), at: entry.at, author: entry.author, batch: entry.batch,
    files: entry.files.map((f) => f.path), undone: undone.has(entry.id)
  }));
}

// The last batches, oldest first: AI work grouped, with the request that opened it.
export function historyBatches(dir: string, limit = 20): BatchSummary[] {
  return summarizeBatches(readJournal(dir)).slice(-limit);
}

export interface UndoResult extends EditResult {
  undone: number | number[]; // the sequence number(s) of the undone change(s)
  skipped: SkippedOp[];      // what was kept because it changed since
}

// Undoes the last change that is not undone yet, or the change with this sequence number (an undo
// too: undoing an undo redoes). Parts of the change whose targets were edited since are kept and
// reported in skipped.
export function undo(dir: string, seq?: number, options: EditOptions = {}): UndoResult {
  let target: ChangeLike | undefined;
  const result = undoAll(dir, (entries) => {
    const undone = undoneChanges(entries);
    if (seq !== undefined) {
      target = entries.find((entry): entry is ChangeLike => entry.type !== 'mark' && entry.seq === seq);
      if (!target) throw new CommandError(`No edit ${seq} in the journal`);
      if (undone.has(target.id)) throw new CommandError(`Edit ${seq} is already undone`);
    } else {
      target = [...entries].reverse().find((entry): entry is ChangeLike => entry.type === 'change' && !undone.has(entry.id));
      if (!target) throw new CommandError('Nothing to undo');
    }
    return { changes: [target], undoes: { changes: [target.id] }, name: 'undo', args: { seq: target.seq } };
  }, options);
  const undoneChange = target as ChangeLike;
  return { ...result, op: nameOf(undoneChange), undone: undoneChange.seq };
}

// Undoes a batch (« Annuler le travail de l'IA »): by default the last AI batch not undone yet.
export function undoBatch(dir: string, batch?: string, options: EditOptions = {}): UndoResult & { batch: string } {
  let id = '';
  let seqs: number[] = [];
  const result = undoAll(dir, (entries) => {
    id = batch ?? lastAiBatch(entries)?.id ?? '';
    if (!id) throw new CommandError('No AI work to undo');
    const changes = changesToUndo(entries, { batch: id });
    if (!changes.length) throw new CommandError(entries.some((e) => e.type !== 'mark' && e.batch === id) ? `Batch ${id} is already undone` : `No batch ${id} in the journal`);
    seqs = changes.map((c) => c.seq).reverse();
    return { changes, undoes: { batch: id, changes: changes.map((c) => c.id) }, name: 'undo_batch', args: { batch: id } };
  }, options);
  return { ...result, batch: id, undone: seqs };
}

// Written when the user asks the AI for something: closes the current batch and labels the next.
export function appendMark(dir: string, request: string, options: { author?: Author } = {}): { ok: true; mark: { id: string; seq: number } } {
  const mark = translateErrors(() => appendJournalMark(dir, { request, author: options.author ?? { kind: 'human' } }));
  return { ok: true, mark: { id: mark.id, seq: mark.seq } };
}

const ATTEMPTS = 3;

interface UndoTarget {
  changes: ChangeLike[]; // newest first
  undoes: { batch?: string; changes: string[] };
  name: string;
  args: unknown;
}

// Chooses what to undo from the journal under the lock (two undos at once never undo the same
// change twice), then undoes it as a change.
function undoAll(dir: string, select: (entries: JournalEntry[]) => UndoTarget, options: EditOptions): UndoResult {
  const root = path.resolve(dir);
  const author = options.author ?? detectAuthor();
  let backup: AutoVersion | null = null;
  let name = 'undo';
  const { entry, ops, skipped, written } = translateErrors(() => withProjectLockSync(root, () => {
    const { changes, undoes, name: command, args } = select(readJournal(root));
    name = command;
    let stale: string[] = [];
    for (let attempt = 1; ; attempt++) {
      const before = snapshotFor(root, options, stale);
      const undone = undoChanges(before, changes, { canRestore: (hash) => hasBlob(root, hash as BlobHash) });
      if (!undone.ops.length) {
        const why = undone.skipped.map((s) => s.message).join('; ');
        throw new CommandError(why ? `Nothing could be undone: ${why}` : 'Nothing to undo');
      }
      const after = restoreOriginalTexts(root, undone.files, changes, undone.ops);
      if (attempt === 1 && options.autoVersion !== false) backup = takeAutoVersion(root, author, before);
      options.beforeWrite?.(attempt);
      const changed = changedOnDisk(root, before, touchedFiles(undone.ops));
      if (changed.length) {
        if (attempt < ATTEMPTS) { stale = changed; continue; }
        throw conflict(changed);
      }
      const inverse = invertOps(before, undone.ops);
      const entry = commit(root, { before, after, ops: undone.ops, inverse }, (files) =>
        appendUndo(root, { author, command: { name: command, args }, ops: undone.ops, inverse, files, undoes, skipped: undone.skipped }));
      return { entry, ops: undone.ops, skipped: undone.skipped, written: { before, after } };
    }
  }, { timeoutMs: options.lockTimeoutMs }));
  pruneAfter(root, backup);
  return { ...editResult(root, name, entry, ops, backup, options, written), undone: [], skipped };
}

