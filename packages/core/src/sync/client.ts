import type { Author, FileContent, Files, Op, SkippedOp } from '../ops/types.ts';
import { applyOps, invertOps } from '../ops/apply.ts';
import { isAiAuthor } from '../ops/batch.ts';
import { binaryFile, textFile } from '../ops/json.ts';
import { rebase } from './rebase.ts';
import type { Committed, Overwrite, Refusal, ServerMessage, Submission, Undoes } from './protocol.ts';
import { leftByRebase } from './undo-log.ts';

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
  // An undo: what it undoes and what it left out (D87).
  undoes?: Undoes;
  // What it replaced that its author may not have seen (an agent's file edit, D75): told to whoever wrote it.
  overwrote?: Overwrite[];
  // Its inverse on the view, when the caller has it (a journal's): what the change replaced.
  inverse?: Op[];
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
  // The submission last made of it (kept after a disconnection: its acknowledgement may come in a
  // catchup), and how many waiting changes it holds, this one first (an agent's run, D83).
  sentId?: string;
  group: number;
  // Times the room could not find a medium it writes (E_SYNC_BLOB_MISSING): sent again after it.
  mediaTries?: number;
  // How many of the others' changes the client had taken in when it was made: those after it are
  // what it was not made on, and its rebase names their authors in what it leaves out (D90).
  seen: number;
}

// An agent's run of changes in one batch goes as one submission (D83): one round trip for many
// small changes. Bounded by what the room takes in a change.
const GROUP_CHANGES = 100;
const GROUP_OPS = 600;
const GROUP_BYTES = 2 * 1024 * 1024;
// A change whose medium the room could not find goes again this many times, its media sent first.
const MEDIA_TRIES = 3;

const sameAuthor = (a: Author, b: Author): boolean => a.kind === b.kind && a.name === b.name && a.by === b.by && a.id === b.id;

export class SyncClient {
  private confirmedFiles: Files;
  private headSeq: number;
  private readonly waiting: Waiting[] = [];
  private inFlight = false;
  private viewFiles: Files;
  private readonly outcomes: Outcome[] = [];
  // The others' changes taken in while changes of this copy wait (D90); emptied when none waits.
  private others: Committed[] = [];

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
    const inverse = change.inverse ?? invertOps(this.viewFiles, change.ops);
    this.waiting.push({ change, inverse, skipped: [], overwrote: [], group: 1, seen: this.others.length });
    this.viewFiles = applyOps(this.viewFiles, change.ops);
  }

  // The next submission to send, or null (one in flight already, or nothing waiting). The first
  // waiting change is rebased on confirmed; when nothing of it is left, it ends here. The changes
  // that follow it in the same AI batch, by the same author, go with it, rebased one after the other.
  next(): Submission | null {
    while (!this.inFlight && this.waiting.length) {
      const first = this.waiting[0];
      if (!first.sent) {
        let files = this.confirmedFiles;
        const ops: Op[] = [];
        let count = 0;
        let bytes = 0;
        let firstLeft: ReturnType<typeof rebase>['left'] = [];
        for (const item of this.waiting) {
          if (count && (!isAiAuthor(first.change.author) || !first.change.batch || first.change.undoes || item.change.batch !== first.change.batch || !sameAuthor(item.change.author, first.change.author)
            || item.change.undoes || count >= GROUP_CHANGES || ops.length + item.change.ops.length > GROUP_OPS || bytes + JSON.stringify(item.change.ops).length > GROUP_BYTES)) break;
          const placed = rebase(files, { id: item.change.id, author: item.change.author, ops: item.change.ops, inverse: item.inverse }, this.others.slice(item.seen));
          if (placed.refusal) {
            if (count) break; // it goes on its own, after the run
            this.settle({ id: item.change.id, refused: { id: item.change.id, ...placed.refusal }, skipped: placed.skipped, overwrote: placed.overwrote });
            this.recompute();
            break;
          }
          if (!count) firstLeft = placed.left;
          item.skipped = placed.skipped;
          item.overwrote = [...(item.change.overwrote ?? []), ...placed.overwrote];
          files = placed.files;
          ops.push(...placed.ops);
          bytes += JSON.stringify(item.change.ops).length;
          count++;
        }
        if (!count) continue;
        const run = this.waiting.slice(0, count);
        const { at, author, batch, command, undoes } = first.change;
        const overwrote = run.flatMap((item) => item.overwrote);
        first.group = count;
        first.sentId = count > 1 ? `${first.change.id}+${count - 1}` : first.change.id;
        first.sent = {
          id: first.sentId, base: this.headSeq, at, author, ops, inverse: invertOps(this.confirmedFiles, ops),
          ...(batch ? { batch } : {}),
          ...(count > 1 ? { command: { name: 'changes', args: { ids: run.map((item) => item.change.id), commands: run.map((item) => item.change.command?.name ?? null) } } } : command ? { command } : {}),
          // An undo goes alone: what this rebase left out of it is added to what it left out.
          ...(undoes ? { undoes: leftByRebase(undoes, first.change.id, first.change.ops, firstLeft) } : {}),
          ...(overwrote.length ? { overwrote } : {})
        };
      }
      this.inFlight = true;
      return first.sent;
    }
    return null;
  }

  // A message of the server. Returns 'gap' when a change is missing before this one: ask for a
  // catchup from head; 'media' when the room could not find a medium the change in flight writes:
  // send its media again, then next() gives the same submission (D85). A snapshot (the server no
  // longer keeps that far back) replaces confirmed.
  receive(message: ServerMessage): 'ok' | 'gap' | 'media' {
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
        if (!first || (first.change.id !== message.refusal.id && first.sentId !== message.refusal.id)) return 'ok';
        this.inFlight = false;
        if (message.refusal.code === 'E_SYNC_BLOB_MISSING' && (first.mediaTries ?? 0) < MEDIA_TRIES) {
          first.mediaTries = (first.mediaTries ?? 0) + 1;
          return 'media';
        }
        for (let i = 0, count = first.group; i < count && this.waiting.length; i++) {
          const item = this.waiting[0];
          this.settle({ id: item.change.id, refused: { ...message.refusal, id: item.change.id }, skipped: item.skipped, overwrote: item.overwrote });
        }
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

  // A prepared change is rebased again before it is sent. What its last rebase left out stays
  // until then: its acknowledgement may come first (in a catchup), for the submission already sent.
  private unprepare(item: Waiting): void {
    item.sent = undefined;
  }


  // The changes waiting, oldest first, each with its inverse: what a copy keeps to go on after a
  // restart (a new client from confirmed and head, then record each again).
  waitingChanges(): LocalChange[] {
    return this.waiting.map(({ change, inverse }) => ({ ...change, inverse }));
  }

  // Outcomes of the changes made here, oldest first, since the last call.
  takeOutcomes(): Outcome[] {
    return this.outcomes.splice(0);
  }

  private placed(change: Committed): 'ok' | 'gap' {
    const first = this.waiting[0];
    const own = first !== undefined && (change.id === first.change.id || change.id === first.sentId);
    if (change.seq <= this.headSeq) {
      // Its own change, acknowledged again (sent twice, or already in a snapshot): it ends here.
      if (own) {
        this.inFlight = false;
        this.settleRun(change);
        this.recompute();
      }
      return 'ok';
    }
    if (change.seq !== this.headSeq + 1) return 'gap';
    this.confirmedFiles = applyOps(this.confirmedFiles, change.ops);
    this.headSeq = change.seq;
    if (own) {
      this.inFlight = false;
      this.settleRun(change);
    } else {
      if (this.waiting.length) this.others.push(change);
      if (first?.sent && !this.inFlight) this.unprepare(first); // prepared on an older head
    }
    this.recompute();
    return 'ok';
  }

  // The waiting changes a placed submission held: what the room left out or overwrote is the first's.
  private settleRun(change: Committed): void {
    // A run sent under its own id holds its group; the first change alone, under its id, only itself.
    const first = this.waiting[0];
    const count = change.id === first.sentId ? first.group : 1;
    if (count !== first.group) this.unprepare(first);
    for (let i = 0; i < count && this.waiting.length; i++) {
      const item = this.waiting[0];
      this.settle({ id: item.change.id, placed: change, skipped: i ? item.skipped : [...item.skipped, ...change.skipped], overwrote: i ? [] : change.overwrote });
    }
  }

  private settle(outcome: Outcome): void {
    this.waiting.shift();
    this.outcomes.push(outcome);
    if (!this.waiting.length) this.others = [];
  }

  // The view, from confirmed and the waiting changes.
  private recompute(): void {
    let files = this.confirmedFiles;
    for (let i = 0; i < this.waiting.length; i++) {
      const item = this.waiting[i];
      const change = item.sent ?? { ...item.change, inverse: item.inverse };
      files = rebase(files, { id: item.change.id, author: item.change.author, ops: change.ops, inverse: change.inverse }).files;
      if (item.sent) i += item.group - 1; // the run it holds
    }
    this.viewFiles = files;
  }
}
