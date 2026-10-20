import type { Author, ChangeLike, JournalEntry } from './types.ts';

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
export function assignBatch(previous: JournalEntry | undefined, next: { id: string; at: string; author: Author }): string {
  if (!isAiAuthor(next.author) || !previous || previous.type === 'mark' || !isAiAuthor(previous.author)) return next.id;
  return Date.parse(next.at) - Date.parse(previous.at) < BATCH_IDLE_MS ? previous.batch : next.id;
}

// Ids of the changes currently undone: listed by an undo that is not itself undone.
export function undoneChanges(entries: readonly JournalEntry[]): Set<string> {
  const undone = new Set<string>();
  // An undo only refers to older entries, so newest first settles each undo before its targets.
  for (const entry of [...entries].sort((a, b) => b.seq - a.seq)) {
    if (entry.type === 'undo' && !undone.has(entry.id)) for (const id of entry.undoes.changes) undone.add(id);
  }
  return undone;
}

// The changes an undo of this batch or change applies to, newest first, leaving out those
// already undone.
export function changesToUndo(entries: readonly JournalEntry[], target: { batch: string } | { change: string }): ChangeLike[] {
  const undone = undoneChanges(entries);
  return entries
    .filter((entry): entry is ChangeLike => entry.type !== 'mark' && !undone.has(entry.id) && ('batch' in target ? entry.batch === target.batch : entry.id === target.change))
    .sort((a, b) => b.seq - a.seq);
}

export interface BatchSummary {
  id: string;
  label?: string;       // the request of the mark that opened it
  ai: boolean;
  authors: Author[];
  changes: string[];    // oldest first
  firstSeq: number;
  lastSeq: number;
  start: string;
  end: string;
  files: string[];
  undone: boolean;      // every change of the batch is undone
}

// Batches in journal order, for history views and for picking what to undo.
export function summarizeBatches(entries: readonly JournalEntry[]): BatchSummary[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const undone = undoneChanges(sorted);
  const batches = new Map<string, BatchSummary & { fileSet: Set<string> }>();
  // A mark labels the next AI batch, even when the human edits something before the AI starts.
  let request: string | undefined;
  for (const entry of sorted) {
    if (entry.type === 'mark') {
      request = entry.request;
      continue;
    }
    let batch = batches.get(entry.batch);
    if (!batch) {
      batch = {
        id: entry.batch, ai: isAiAuthor(entry.author), authors: [], changes: [], firstSeq: entry.seq, lastSeq: entry.seq,
        start: entry.at, end: entry.at, files: [], undone: true, fileSet: new Set()
      };
      if (batch.ai && request !== undefined) {
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
    if (!undone.has(entry.id)) batch.undone = false;
  }
  return [...batches.values()].map(({ fileSet, ...batch }) => ({ ...batch, files: [...fileSet].sort() }));
}

// The newest AI batch that is not undone yet: what « Annuler le travail de l'IA » undoes.
export function lastAiBatch(entries: readonly JournalEntry[]): BatchSummary | undefined {
  return summarizeBatches(entries).filter((batch) => batch.ai && !batch.undone).pop();
}
