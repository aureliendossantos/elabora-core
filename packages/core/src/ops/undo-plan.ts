import type { Author, ChangeLike, Files, JournalEntry, Op, SkippedOp } from './types.ts';
import { undoChanges, type UndoOptions } from './undo.ts';
import { belongsTo, changesToUndo, lastAiBatch, lastStep, redoStep, undoneChanges } from './batch.ts';
import { CommandError } from '../commands/context.ts';

// What an undo takes back, chosen from a journal (D79, D87), and its operations on the files: the
// same for a folder's journal (@elabora/node edit/history, under the project's lock) and a copy's
// (the browser engine, D104). Pure: the caller reads the journal, writes the undo and its entry.

export type UndoRequest =
  // ⌘Z: the person's last step, their change or the batch of an agent they launched.
  | { undo: 'step'; author: Author }
  // The change with this number (an undo too: undoing an undo redoes).
  | { undo: 'change'; seq: number }
  // ⇧⌘Z: the person's last undo, undone again, while no change of theirs came after it.
  | { undo: 'redo'; author: Author }
  // « Annuler le travail de l'IA »: a batch, the last AI batch not undone by default.
  | { undo: 'batch'; batch?: string };

export interface UndoPlan {
  // The journal's command for the undo, and its arguments.
  name: 'undo' | 'undo_batch';
  args: unknown;
  changes: ChangeLike[]; // what it takes back, newest first
  undoes: { batch?: string; changes: string[] };
  // Chosen as the person's step, not named by the caller: taken even when nothing of it can be undone.
  step: boolean;
  // What it undoes, as a result says it: the target's command (redo for a redo), the numbers of the
  // changes taken back (oldest first), the batch.
  op: string;
  undone: number[];
  batch?: string;
}

// What a change is called in a history: its command, undo, or who wrote it (an edit made outside Elabora).
export const nameOf = (entry: ChangeLike): string => entry.command?.name ?? (entry.type === 'undo' ? 'undo' : entry.author.kind);

export function planUndo(entries: readonly JournalEntry[], request: UndoRequest): UndoPlan {
  const plan = (target: ChangeLike, changes: ChangeLike[], rest: Omit<UndoPlan, 'changes' | 'undone' | 'op'>, op = nameOf(target)): UndoPlan =>
    ({ ...rest, changes, op, undone: changes.map((change) => change.seq).reverse() });
  switch (request.undo) {
    case 'change': {
      const target = entries.find((entry): entry is ChangeLike => entry.type !== 'mark' && entry.seq === request.seq);
      if (!target) throw new CommandError(`No edit ${request.seq} in the journal`);
      if (undoneChanges(entries).has(target.id)) throw new CommandError(`Edit ${request.seq} is already undone`);
      return plan(target, changesToUndo(entries, { change: target.id }), { name: 'undo', args: { seq: target.seq }, undoes: { changes: [target.id] }, step: false });
    }
    case 'step': {
      const step = lastStep(entries, request.author);
      if (!step) throw new CommandError('Nothing to undo');
      if (step.batch) {
        // The batch's changes of this person's (their agents'), never another's that joined it.
        const changes = changesToUndo(entries, { batch: step.batch }).filter((change) => belongsTo(change.author, request.author));
        return plan(step.change, changes, { name: 'undo_batch', args: { batch: step.batch }, undoes: { batch: step.batch, changes: changes.map((change) => change.id) }, step: true });
      }
      return plan(step.change, changesToUndo(entries, { change: step.change.id }), { name: 'undo', args: { seq: step.change.seq }, undoes: { changes: [step.change.id] }, step: true });
    }
    case 'redo': {
      const target = redoStep(entries, request.author);
      if (!target) throw new CommandError('Nothing to redo');
      return plan(target, [target], { name: 'undo', args: { seq: target.seq }, undoes: { changes: [target.id] }, step: false }, 'redo');
    }
    case 'batch': {
      const id = request.batch ?? lastAiBatch(entries)?.id ?? '';
      if (!id) throw new CommandError('No AI work to undo');
      const changes = changesToUndo(entries, { batch: id });
      if (!changes.length) throw new CommandError(entries.some((entry) => entry.type !== 'mark' && entry.batch === id) ? `Batch ${id} is already undone` : `No batch ${id} in the journal`);
      const newest = changes[0]!;
      return plan(newest, changes, { name: 'undo_batch', args: { batch: id }, undoes: { batch: id, changes: changes.map((change) => change.id) }, step: request.batch === undefined, batch: id }, 'undo_batch');
    }
  }
}

// The plan's operations on the files, and what it kept because it changed since. Nothing undoable:
// refused, unless the plan is the person's step (D79: taken all the same, writing nothing, so that
// the next step goes further back).
export function undoOps(files: Files, plan: UndoPlan, options: UndoOptions = {}): { ops: Op[]; skipped: SkippedOp[]; files: Files } {
  const undone = undoChanges(files, plan.changes, options);
  if (!undone.ops.length) {
    const why = undone.skipped.map((skipped) => skipped.message).join('; ');
    if (!why || !plan.step) throw new CommandError(why ? `Nothing could be undone: ${why}` : 'Nothing to undo');
  }
  return undone;
}
