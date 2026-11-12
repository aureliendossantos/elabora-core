import type { JournalEntry, Op, SkippedOp } from '../ops/types.ts';
import type { Committed, Undoes } from './protocol.ts';
import type { RebaseResult } from './rebase.ts';

// Undo across a project's server (D87). An undo carries what it left out (Undoes.skipped), so that
// what it did not take back stays in force for a later undo (D79) wherever its state is read: in the
// journal of the copy that made it, and in the server's log, which an agent of the cloud reads.

// What a rebase left out of an undo as it placed it, added to the undo's left-out operations: named
// after the undo itself (it does not know which change each operation is the inverse of).
export function leftByRebase(undoes: Undoes, id: string, ops: readonly Op[], left: RebaseResult['left']): Undoes {
  if (!left.length) return undoes;
  const added: SkippedOp[] = left.map(({ index, reason, message }) => ({ change: id, op: structuredClone(ops[index]), reason, message }));
  return { ...undoes, skipped: [...(undoes.skipped ?? []), ...added] };
}

// A server's log as journal entries, for the core's undo rules (undoState, changesToUndo, lastStep):
// an undo with what it left out.
export function journalOf(log: readonly Committed[]): JournalEntry[] {
  return log.map((change): JournalEntry => {
    const common = {
      seq: change.seq, id: change.id, at: change.at, author: change.author, batch: change.batch,
      ...(change.command ? { command: change.command } : {}), ops: change.ops, inverse: change.inverse, files: []
    };
    if (!change.undoes) return { type: 'change', ...common };
    const { skipped = [], ...undoes } = change.undoes;
    return { type: 'undo', ...common, undoes, skipped };
  });
}
