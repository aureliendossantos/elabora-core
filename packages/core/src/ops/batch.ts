import type { Author, ChangeLike, JournalEntry, MarkEntry, UndoEntry } from './types.ts';

// Batches: one piece of AI work, the unit of « Annuler le travail de l'IA ».

export const BATCH_IDLE_MS = 5 * 60 * 1000;

// AI work: agents through Elabora tools, and file edits no Elabora tool made (agents with their own
// tools). Human and system changes (migrations, restores) are never part of AI work.
export function isAiAuthor(author: Author): boolean {
  return author.kind === 'agent' || author.kind === 'external';
}

// The batch of a new change, given the last journal entry. An AI change joins the batch of the
// previous change when that one was also AI work and less than 5 minutes older; a human or
// system change, or a mark, in between closes the batch. Other changes open their own batch,
// named after their id.
// A change an agent makes in Elabora's chat (author.chat) joins its conversation's current turn
// instead: turn, the id of that conversation's last mark, whatever was written since and however
// long the agent thought. Without a turn it goes on its conversation's batch, as above.
export function assignBatch(previous: JournalEntry | undefined, next: { id: string; at: string; author: Author }, turn?: string): string {
  if (!isAiAuthor(next.author)) return next.id;
  if (next.author.chat && turn) return turn;
  // An agent outside the chat never joins a turn; a file written by no Elabora tool (external) joins
  // the AI work just before it, a turn included.
  // Nor the work of an agent another person launched (D78).
  if (!previous || previous.type === 'mark' || !isAiAuthor(previous.author) || previous.author.by !== next.author.by || (next.author.kind === 'agent' && previous.author.chat !== next.author.chat)) return next.id;
  return Date.parse(next.at) - Date.parse(previous.at) < BATCH_IDLE_MS ? previous.batch : next.id;
}

// Undo state (D79). An undo lists the changes it undid and the inverse operations it left out
// (skipped): those are not undone. A change is undone when every inverse operation of it is,
// across the undos that are not themselves undone (an undo only refers to older entries, so newest
// first settles each undo before its targets).
export interface UndoState {
  undone: Set<string>;               // changes wholly undone
  attempted: Set<string>;            // changes an undo in force targeted, wholly or in part
  remaining: Map<string, number[]>;  // a change undone in part: the indexes of its inverse still in force
}

export function undoState(entries: readonly JournalEntry[]): UndoState {
  const byId = new Map(entries.filter((entry): entry is ChangeLike => entry.type !== 'mark').map((entry) => [entry.id, entry]));
  const undoneUndos = new Set<string>();
  const done = new Map<string, Set<number>>();
  for (const entry of [...entries].sort((a, b) => b.seq - a.seq)) {
    if (entry.type !== 'undo' || undoneUndos.has(entry.id)) continue;
    for (const id of entry.undoes.changes) {
      const target = byId.get(id);
      if (!target) continue;
      const left = new Set(entry.skipped.filter((skipped) => skipped.change === id).map((skipped) => JSON.stringify(skipped.op)));
      const indexes = done.get(id) ?? new Set<number>();
      target.inverse.forEach((op, k) => { if (!left.has(JSON.stringify(op))) indexes.add(k); });
      done.set(id, indexes);
      if (target.type === 'undo' && indexes.size === target.inverse.length) undoneUndos.add(id);
    }
  }
  const state: UndoState = { undone: new Set(), attempted: new Set(done.keys()), remaining: new Map() };
  for (const [id, indexes] of done) {
    const target = byId.get(id) as ChangeLike;
    const left = target.inverse.map((_, k) => k).filter((k) => !indexes.has(k));
    if (left.length) state.remaining.set(id, left);
    else state.undone.add(id);
  }
  return state;
}

// Ids of the changes wholly undone.
export function undoneChanges(entries: readonly JournalEntry[]): Set<string> {
  return undoState(entries).undone;
}

// The changes an undo of this batch or change applies to, newest first, leaving out those wholly
// undone; a change undone in part comes with only its operations still in force.
export function changesToUndo(entries: readonly JournalEntry[], target: { batch: string } | { change: string }): ChangeLike[] {
  const state = undoState(entries);
  return entries
    .filter((entry): entry is ChangeLike => entry.type !== 'mark' && !state.undone.has(entry.id) && ('batch' in target ? entry.batch === target.batch : entry.id === target.change))
    .sort((a, b) => b.seq - a.seq)
    .map((entry) => {
      const left = state.remaining.get(entry.id);
      if (!left) return entry;
      const n = entry.ops.length;
      return { ...entry, inverse: left.map((k) => entry.inverse[k]), ops: left.map((k) => entry.ops[n - 1 - k]).reverse() };
    });
}

// ── undo by person (D79) ─────────────────────────────────────────────

// Whether a change is one of this person's steps: their own, or the work of an agent they launched.
// Locally, people have no id: every change is the one person's of this computer, system changes
// (a migration, the agents' rules brought up to date, a medium converted) included. In a project in
// the cloud, a system change is no one's.
export function belongsTo(author: Author, person: Author): boolean {
  if (author.kind === 'system') return person.kind === 'human' && person.id === undefined;
  if (person.kind === 'agent' || person.kind === 'external') return author.kind === person.kind && author.name === person.name && author.chat === person.chat;
  if (author.kind === 'human') return author.id === person.id;
  return author.by === person.id;
}

// ⌘Z: this person's last step that no undo targeted yet: one of their changes, or the whole batch
// of an agent they launched.
export function lastStep(entries: readonly JournalEntry[], person: Author): { change: ChangeLike; batch?: string } | null {
  const state = undoState(entries);
  const sorted = [...entries].sort((a, b) => b.seq - a.seq);
  for (const entry of sorted) {
    // The lock a build writes is no step to take back, nor what a project's room wrote in the
    // folder (command sync, D83): a change made here is its own entry.
    if (entry.type !== 'change' || state.attempted.has(entry.id) || !entry.ops.length || entry.command?.name === 'build' || entry.command?.name === 'sync' || !belongsTo(entry.author, person)) continue;
    return isAiAuthor(entry.author) && !isAiAuthor(person) ? { change: entry, batch: entry.batch } : { change: entry };
  }
  return null;
}

// ⇧⌘Z: this person's last undo, undone again, while no change of theirs came after it. A redo
// (an undo of an undo) and the undo it undid are passed over, so that redo steps back one undo at
// a time. Others' changes in between do not count.
export function redoStep(entries: readonly JournalEntry[], person: Author): UndoEntry | null {
  const kinds = new Map(entries.map((entry) => [entry.id, entry.type]));
  const passed = new Set<string>();
  for (const entry of [...entries].sort((a, b) => b.seq - a.seq)) {
    if (entry.type === 'mark' || !belongsTo(entry.author, person) || passed.has(entry.id)) continue;
    if (entry.type === 'change') return null;
    if (entry.undoes.changes.some((id) => kinds.get(id) === 'undo')) {
      for (const id of entry.undoes.changes) passed.add(id);
      continue;
    }
    if (entry.ops.length) return entry; // an undo that kept everything has nothing to redo

  }
  return null;
}

export interface BatchSummary {
  id: string;
  label?: string;       // the request of the mark that opened it
  chat?: string;        // a turn of Elabora's chat: its conversation (the batch's id is the turn's)
  ai: boolean;
  authors: Author[];
  changes: string[];    // oldest first
  firstSeq: number;
  lastSeq: number;
  start: string;
  end: string;
  files: string[];
  undone: boolean;      // every change of the batch is wholly undone
  // Undone in part: an undo in force targeted every change of it, but left out operations whose
  // targets were changed since (they are still in force: undoing the batch again tries them).
  partly: boolean;
}

// Batches in journal order, for history views and for picking what to undo.
export function summarizeBatches(entries: readonly JournalEntry[]): BatchSummary[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const state = undoState(sorted);
  const batches = new Map<string, BatchSummary & { fileSet: Set<string> }>();
  // A mark labels the next AI batch, even when the human edits something before the AI starts.
  // A turn of the chat labels its own batch, named after it.
  let request: string | undefined;
  const turns = new Map<string, MarkEntry>();
  for (const entry of sorted) {
    if (entry.type === 'mark') {
      if (entry.chat) turns.set(entry.id, entry);
      else request = entry.request;
      continue;
    }
    let batch = batches.get(entry.batch);
    if (!batch) {
      batch = {
        id: entry.batch, ai: isAiAuthor(entry.author), authors: [], changes: [], firstSeq: entry.seq, lastSeq: entry.seq,
        start: entry.at, end: entry.at, files: [], undone: true, partly: true, fileSet: new Set()
      };
      const turn = turns.get(entry.batch);
      if (turn) {
        batch.label = turn.request;
        batch.chat = turn.chat;
      } else if (batch.ai && request !== undefined) {
        batch.label = request;
        request = undefined;
      }
      batches.set(entry.batch, batch);
    }
    if (!batch.authors.some((a) => a.kind === entry.author.kind && a.name === entry.author.name)) batch.authors.push(entry.author);
    batch.changes.push(entry.id);
    batch.lastSeq = entry.seq;
    batch.end = entry.at;
    for (const file of entry.files) batch.fileSet.add(file.path);
    if (!state.undone.has(entry.id)) batch.undone = false;
    if (!state.attempted.has(entry.id)) batch.partly = false;
  }
  return [...batches.values()].map(({ fileSet, ...batch }) => ({ ...batch, partly: batch.partly && !batch.undone, files: [...fileSet].sort() }));
}

// The newest AI batch that is not undone yet, wholly or in part: what « Annuler le travail de
// l'IA » undoes. Newest by its last change: a turn of the chat goes on while another agent's batch
// begins and ends.
export function lastAiBatch(entries: readonly JournalEntry[]): BatchSummary | undefined {
  return summarizeBatches(entries).filter((batch) => batch.ai && !batch.undone && !batch.partly).reduce<BatchSummary | undefined>((newest, batch) => (!newest || batch.lastSeq > newest.lastSeq ? batch : newest), undefined);
}
