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
// an undo with what it left out. An agent's run a copy sent as one change (D83: command changes, the
// ids of its changes) is one entry here, while the copy's undo names each of its changes: an undo
// that names every change of such a run targets the run's entry (one that names only some of them
// cannot be told apart in its operations, and leaves the run in force).
export function journalOf(log: readonly Committed[]): JournalEntry[] {
  const placed = new Set(log.map((change) => change.id));
  const runOf = new Map<string, { run: string; size: number }>();
  for (const change of log) {
    const ids = change.command?.name === 'changes' ? (change.command.args as { ids?: unknown } | null)?.ids : undefined;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') runOf.set(id, { run: change.id, size: ids.length });
  }
  return log.map((change): JournalEntry => {
    const common = {
      seq: change.seq, id: change.id, at: change.at, author: change.author, batch: change.batch,
      ...(change.command ? { command: change.command } : {}), ops: change.ops, inverse: change.inverse, files: []
    };
    if (!change.undoes) return { type: 'change', ...common };
    const { skipped = [], ...undoes } = change.undoes;
    // The runs whose every change this undo names.
    const named = new Map<string, number>();
    for (const id of undoes.changes) if (!placed.has(id) && runOf.has(id)) named.set(runOf.get(id)!.run, (named.get(runOf.get(id)!.run) ?? 0) + 1);
    const whole = (id: string): string => {
      const of = placed.has(id) ? undefined : runOf.get(id);
      return of && named.get(of.run) === of.size ? of.run : id;
    };
    const changes = [...new Set(undoes.changes.map(whole))];
    return { type: 'undo', ...common, undoes: { ...undoes, changes }, skipped: skipped.map((left) => ({ ...left, change: whole(left.change) })) };
  });
}
