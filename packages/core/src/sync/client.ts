import type { Author, FileContent, Files, Op, SkippedOp } from '../ops/types.ts';
import { applyOps, invertOps } from '../ops/apply.ts';
import { binaryFile, textFile } from '../ops/json.ts';
import { rebase } from './rebase.ts';
import type { Committed, Overwrite, Refusal, ServerMessage, Submission } from './protocol.ts';

// A copy of a project in the cloud (D73): the files the server confirmed, and the changes made here
// that it has not placed yet, oldest first. What the copy shows (and writes in its folder) is always
// computed again from those two: confirmed, then each waiting change rebased on top. One change is
// in flight at a time: the next is rebased on what the server placed before it is sent, so its base
// is exact and the server only meets the changes of others.
// Pure: the desktop engine, the CLI and (later) the browser hold one each, and do the I/O.

export interface LocalChange {
  id: string;
  at: string;
  author: Author;
  batch?: string;
  command?: { name: string; args: unknown };
  ops: Op[];
  undoes?: { batch?: string; changes: string[] };
  // What it replaced that its author may not have seen (an agent's file edit, D75): told to whoever wrote it.
  overwrote?: Overwrite[];
}

// The end of a change made here: placed (with what it left out or overwrote, here and on the
// server) or refused. The copy tells its author.
export type Outcome =
  | { id: string; placed: Committed; skipped: SkippedOp[]; overwrote: Overwrite[] }
  | { id: string; refused: Refusal; skipped: SkippedOp[]; overwrote: Overwrite[] };

interface Waiting {
  change: LocalChange;
  inverse: Op[];         // on the files the change was computed on (the view when it was made)
  // Once prepared for sending: the change rebased on confirmed, and what that rebase left out.
  sent?: Submission;
  skipped: SkippedOp[];
  overwrote: Overwrite[];
}

export class SyncClient {
  private confirmedFiles: Files;
  private headSeq: number;
  private readonly waiting: Waiting[] = [];
  private inFlight = false;
  private viewFiles: Files;
  private readonly outcomes: Outcome[] = [];

  constructor(files: Files, head: number) {
    this.confirmedFiles = files;
    this.headSeq = head;
    this.viewFiles = files;
  }

  get head(): number { return this.headSeq; }
  get confirmed(): Files { return this.confirmedFiles; }
  // What the copy shows: confirmed with the waiting changes on top.
  get view(): Files { return this.viewFiles; }
  get pending(): number { return this.waiting.length; }

  // A change made here, computed on the view. Its effect shows at once.
  record(change: LocalChange): void {
    if (!change.ops.length) return;
    const inverse = invertOps(this.viewFiles, change.ops);
    this.waiting.push({ change, inverse, skipped: [], overwrote: [] });
    this.viewFiles = applyOps(this.viewFiles, change.ops);
  }

  // The next submission to send, or null (one in flight already, or nothing waiting). The first
  // waiting change is rebased on confirmed; when nothing of it is left, it ends here.
  next(): Submission | null {
    while (!this.inFlight && this.waiting.length) {
      const first = this.waiting[0];
      if (!first.sent) {
        const placed = rebase(this.confirmedFiles, { id: first.change.id, author: first.change.author, ops: first.change.ops, inverse: first.inverse });
        first.skipped = placed.skipped;
        first.overwrote = [...(first.change.overwrote ?? []), ...placed.overwrote];
        if (placed.refusal) {
          this.settle({ id: first.change.id, refused: { id: first.change.id, ...placed.refusal }, skipped: first.skipped, overwrote: first.overwrote });
          continue;
        }
        const { id, at, author, batch, command, undoes } = first.change;
        first.sent = {
          id, base: this.headSeq, at, author, ops: placed.ops, inverse: invertOps(this.confirmedFiles, placed.ops),
          ...(batch ? { batch } : {}), ...(command ? { command } : {}), ...(undoes ? { undoes } : {}),
          ...(first.overwrote.length ? { overwrote: first.overwrote } : {})
        };
      }
      this.inFlight = true;
      return first.sent;
    }
    return null;
  }

  // A message of the server. Returns 'gap' when a change is missing before this one: ask for a
  // catchup from head. A snapshot (the server no longer keeps that far back) replaces confirmed.
  receive(message: ServerMessage): 'ok' | 'gap' {
    switch (message.type) {
      case 'ack':
      case 'change':
        return this.placed(message.change);
      case 'catchup':
        for (const change of message.changes) {
          if (change.seq <= this.headSeq) continue;
          if (this.placed(change) === 'gap') return 'gap';
        }
        return 'ok';
      case 'refused': {
        const first = this.waiting[0];
        if (!first || first.change.id !== message.refusal.id) return 'ok';
        this.inFlight = false;
        this.settle({ id: first.change.id, refused: message.refusal, skipped: first.skipped, overwrote: first.overwrote });
        this.recompute();
        return 'ok';
      }
      case 'snapshot': {
        // The server no longer keeps the changes since this copy's number: the project as it is
        // replaces confirmed, and the waiting changes go on top of it as of any change of others.
        const files = new Map<string, FileContent>();
        for (const file of message.files) files.set(file.path, 'text' in file ? textFile(file.path, file.text) : binaryFile(file.blob, file.size));
        this.confirmedFiles = files;
        this.headSeq = message.head;
        this.inFlight = false;
        if (this.waiting[0]) this.unprepare(this.waiting[0]);
        this.recompute();
        return 'ok';
      }
      default:
        return 'ok';
    }
  }

  // The connection dropped: what was in flight is sent again once connected (the server places a
  // change once, whatever the number of times it gets it). Rebased again on what came meanwhile.
  disconnected(): void {
    this.inFlight = false;
    if (this.waiting[0]) this.unprepare(this.waiting[0]);
  }

  // A prepared change goes back to how it was made: it is rebased again before it is sent.
  private unprepare(item: Waiting): void {
    item.sent = undefined;
    item.skipped = [];
    item.overwrote = [];
  }

  // Outcomes of the changes made here, oldest first, since the last call.
  takeOutcomes(): Outcome[] {
    return this.outcomes.splice(0);
  }

  private placed(change: Committed): 'ok' | 'gap' {
    if (change.seq <= this.headSeq) return 'ok';
    if (change.seq !== this.headSeq + 1) return 'gap';
    this.confirmedFiles = applyOps(this.confirmedFiles, change.ops);
    this.headSeq = change.seq;
    const first = this.waiting[0];
    if (first && first.change.id === change.id) {
      this.inFlight = false;
      this.settle({ id: change.id, placed: change, skipped: [...first.skipped, ...change.skipped], overwrote: change.overwrote });
    } else if (first?.sent && !this.inFlight) this.unprepare(first); // prepared on an older head
    this.recompute();
    return 'ok';
  }

  private settle(outcome: Outcome): void {
    this.waiting.shift();
    this.outcomes.push(outcome);
  }

  // The view, from confirmed and the waiting changes.
  private recompute(): void {
    let files = this.confirmedFiles;
    for (const item of this.waiting) {
      const change = item.sent ?? { ...item.change, inverse: item.inverse };
      files = rebase(files, { id: item.change.id, author: item.change.author, ops: change.ops, inverse: change.inverse }).files;
    }
    this.viewFiles = files;
  }
}
