import type { JournalEntry } from '@elabora/core/ops/types';
import { isAiAuthor } from '@elabora/core/ops/batch';
import type { BatchCloseReason, EngineEvent } from '../protocol.ts';

// The AI batches of a session and the turns of Elabora's chat (D79, D83): which batch is open, when
// it closes (5 idle minutes, a human change, a mark, the turn's end, the session closing), and the
// batchClosed event with its after-ai version. The journal says the batches; this keeps what is open.

// How far back an open turn of the chat is looked for when a session opens: no turn lasts a day.
const TURN_RESUME_MS = 24 * 60 * 60 * 1000;

export interface BatchesHost {
  idleMs: number;
  // Runs work in the session's write queue.
  run(work: () => Promise<void>): Promise<void>;
  // The after-ai version of a batch that closed (null: none taken).
  version(batch: string): Promise<string | null>;
  emit(event: EngineEvent): void;
  reportError(error: unknown, context: string): void;
}

export class Batches {
  readonly #host: BatchesHost;
  #open: { id: string; at: number } | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closures: { id: string; reason: BatchCloseReason }[] = [];
  // The turns of Elabora's chat not ended yet, by conversation: the mark's id is the turn's batch,
  // which neither a human change nor 5 idle minutes close, only the turn's end (endTurn) or the next mark.
  readonly #turns = new Map<string, string>();

  constructor(host: BatchesHost) {
    this.#host = host;
  }

  // The AI batch still open.
  get open(): string | null { return this.#open?.id ?? null; }

  // A turn of the chat ended (endTurn): its batch closes.
  endTurn(chat: string, turn: string): void {
    if (this.#turns.get(chat) === turn) this.#turns.delete(chat);
    if (this.#open?.id === turn) this.close('turn');
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  note(entry: JournalEntry): void {
    if (entry.type === 'mark') {
      this.close('mark');
      if (entry.chat) this.#turns.set(entry.chat, entry.id);
      return;
    }
    if (!isAiAuthor(entry.author)) {
      this.close('human');
      return;
    }
    if (this.#open && this.#open.id !== entry.batch) {
      // Another AI's work during a turn (a file no Elabora tool wrote, an agent outside the chat) is
      // left out of the open batch: the turn stays open until its end.
      if (this.#isTurn(this.#open.id)) return;
      this.close('idle');
    }
    this.#open = { id: entry.batch, at: Date.now() };
    if (this.#isTurn(entry.batch)) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
    } else this.#armBatchTimer(this.#host.idleMs);
  }

  #isTurn(batch: string | undefined): boolean {
    return batch !== undefined && [...this.#turns.values()].includes(batch);
  }

  // An AI batch still open when the session starts (an agent worked moments ago).
  // A turn of the chat begun before the session opened (the window reloaded while the agent worked)
  // is open again when its transcript has no turn-end since and it began less than a day ago.
  resume(entries: readonly JournalEntry[], ended: (chat: string, at: string) => boolean): void {
    const since = Date.now() - TURN_RESUME_MS;
    for (const entry of [...entries].reverse()) {
      if (Date.parse(entry.at) < since) break;
      if (entry.type !== 'mark' || !entry.chat || this.#turns.has(entry.chat)) continue;
      // The host writes turn-end in the transcript once a turn is over: one after the mark ended it.
      this.#turns.set(entry.chat, ended(entry.chat, entry.at) ? '' : entry.id);
    }
    for (const [chat, turn] of this.#turns) if (!turn) this.#turns.delete(chat);
    const last = entries[entries.length - 1];
    if (last && last.type !== 'mark' && this.#isTurn(last.batch)) {
      this.#open = { id: last.batch, at: Date.parse(last.at) };
      return;
    }
    if (!last || last.type === 'mark' || !isAiAuthor(last.author)) return;
    const idle = this.#host.idleMs;
    const age = Date.now() - Date.parse(last.at);
    if (!(age < idle)) return;
    this.#open = { id: last.batch, at: Date.now() - age };
    this.#armBatchTimer(idle - age);
  }

  #armBatchTimer(delay: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    const batch = this.#open?.id;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#host.run(async () => {
        if (!this.#open || this.#open.id !== batch) return;
        this.close('idle');
        await this.flush();
      }).catch((error) => this.#host.reportError(error, 'closing the AI batch'));
    }, Math.max(0, delay));
    (this.#timer as { unref?: () => void }).unref?.();
  }

  // A turn of the chat stays open while the author works (human) and the agent thinks (idle): only
  // its end, the next mark or the session closing close it.
  close(reason: BatchCloseReason): void {
    if (!this.#open) return;
    if ((reason === 'human' || reason === 'idle') && this.#isTurn(this.#open.id)) return;
    this.#closures.push({ id: this.#open.id, reason });
    this.#open = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  // The batches that ended, told with their after-ai version (outside the project lock: other writers go on).
  async flush(): Promise<void> {
    while (this.#closures.length) {
      const { id, reason } = this.#closures.shift() as { id: string; reason: BatchCloseReason };
      const version = await this.#host.version(id);
      this.#host.emit({ type: 'batchClosed', batch: id, reason, version });
    }
  }
}
