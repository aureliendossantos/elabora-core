import path from 'node:path';
import type { Author, ChangeLike, FileHash, Op, SkippedOp } from '@elabora/core/ops/types';
import { invertOps, touchedFiles } from '@elabora/core/ops/apply';
import { summarizeBatches, undoneChanges, type BatchSummary } from '@elabora/core/ops/batch';
import { planUndo, undoOps, type UndoPlan, type UndoRequest } from '@elabora/core/ops/undo-plan';
import { CommandError } from '@elabora/core/commands/index';
import { hasBlob, type BlobHash } from '../blobs.ts';
import { withProjectLockSync, readJournal, appendUndo, appendMark as appendJournalMark, detectAuthor, journalAuthor, CHAT_ID } from '../journal/index.ts';
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

// Undoes the author's last step (D79: their last change no undo targeted yet, or the whole batch of
// an agent they launched), or the change with this sequence number (an undo too: undoing an undo
// redoes). Parts of the change whose targets were edited since are kept and reported in skipped;
// they stay in force. What is taken back is planned by the core (ops/undo-plan.ts).
export function undo(dir: string, seq?: number, options: EditOptions = {}): UndoResult {
  const author = journalAuthor(dir, options.author ?? detectAuthor());
  const { plan, ...rest } = undoAll(dir, seq !== undefined ? { undo: 'change', seq } : { undo: 'step', author }, { ...options, author });
  return { ...rest, op: plan.op, undone: plan.undone.length > 1 ? plan.undone : plan.undone[0]! };
}

// Undoes the author's last undo again (⇧⌘Z), while no change of theirs came after it.
export function redo(dir: string, options: EditOptions = {}): UndoResult {
  const author = journalAuthor(dir, options.author ?? detectAuthor());
  const { plan, ...rest } = undoAll(dir, { undo: 'redo', author }, { ...options, author });
  return { ...rest, op: plan.op, undone: plan.undone[0]! };
}

// Undoes a batch (« Annuler le travail de l'IA »): by default the last AI batch not undone yet.
export function undoBatch(dir: string, batch?: string, options: EditOptions = {}): UndoResult & { batch: string } {
  const { plan, ...rest } = undoAll(dir, { undo: 'batch', ...(batch !== undefined ? { batch } : {}) }, options);
  return { ...rest, batch: plan.batch!, undone: plan.undone };
}

// Written when the user asks the AI for something: closes the current batch and labels the next.
// chat: a turn of Elabora's chat; the mark's id is the turn's, and its batch's.
export function appendMark(dir: string, request: string, options: { author?: Author; chat?: string } = {}): { ok: true; mark: { id: string; seq: number } } {
  if (options.chat !== undefined && !CHAT_ID.test(options.chat)) throw new CommandError(`Not a chat id: ${JSON.stringify(options.chat)} (letters, digits, - and _, at most 64)`);
  const mark = translateErrors(() => appendJournalMark(dir, { request, author: options.author ?? { kind: 'human' }, ...(options.chat ? { chat: options.chat } : {}) }));
  return { ok: true, mark: { id: mark.id, seq: mark.seq } };
}

const ATTEMPTS = 3;

// Chooses what to undo from the journal under the lock (two undos at once never undo the same
// change twice), then undoes it as a change.
function undoAll(dir: string, request: UndoRequest, options: EditOptions): UndoResult & { plan: UndoPlan } {
  const root = path.resolve(dir);
  const author = options.author ?? detectAuthor();
  let backup: AutoVersion | null = null;
  const { plan, entry, ops, skipped, written } = translateErrors(() => withProjectLockSync(root, () => {
    const plan = planUndo(readJournal(root), request);
    const record = (ops: Op[], inverse: Op[], files: FileHash[], skipped: SkippedOp[]) =>
      appendUndo(root, { author, command: { name: plan.name, args: plan.args }, ops, inverse, files, undoes: plan.undoes, skipped });
    let stale: string[] = [];
    for (let attempt = 1; ; attempt++) {
      const before = snapshotFor(root, options, stale);
      const undone = undoOps(before, plan, { canRestore: (hash) => hasBlob(root, hash as BlobHash) });
      // A step (⌘Z, the last AI work) whose every part was changed since is still taken, as an
      // undo that writes nothing and says what it kept: the next step goes further back (D79).
      if (!undone.ops.length) return { plan, entry: record([], [], [], undone.skipped), ops: [], skipped: undone.skipped, written: { before, after: before } };
      const after = restoreOriginalTexts(root, undone.files, plan.changes, undone.ops);
      if (attempt === 1 && options.autoVersion !== false) backup = takeAutoVersion(root, author, before);
      options.beforeWrite?.(attempt);
      const changed = changedOnDisk(root, before, touchedFiles(undone.ops));
      if (changed.length) {
        if (attempt < ATTEMPTS) { stale = changed; continue; }
        throw conflict(changed);
      }
      const inverse = invertOps(before, undone.ops);
      const entry = commit(root, { before, after, ops: undone.ops, inverse }, (files) => record(undone.ops, inverse, files, undone.skipped));
      return { plan, entry, ops: undone.ops, skipped: undone.skipped, written: { before, after } };
    }
  }, { timeoutMs: options.lockTimeoutMs }));
  pruneAfter(root, backup);
  return { ...editResult(root, plan.name, entry, ops, backup, options, written), undone: [], skipped, plan };
}
