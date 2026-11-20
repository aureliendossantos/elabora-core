import type { JournalEntry, Op } from '@elabora/core/ops/types';
import { diffFiles } from '@elabora/core/ops/diff';
import { invertOps, touchedFiles } from '@elabora/core/ops/apply';
import type { ProjectFiles, SourceFile } from '@elabora/core/project/files';
import type { ProjectState } from '../base/project-state.ts';
import type { ChangesHost, NewContents, SessionChanges } from '../base/changes.ts';
import type { ChangeSource } from '../protocol.ts';
import type { BrowserStore } from './store.ts';

// Where a browser copy's changes come from and go (SessionChanges, D101, D104): its own journal. A
// change made here, an undo, the room's change taken in: each is an entry of the journal, numbered as
// it enters, kept in the browser's storage, then handed to the session in order. Nothing else
// writes: no lock, no other writer, nothing to watch.

type Unnumbered<Entry> = Entry extends JournalEntry ? Omit<Entry, 'seq'> : never;

export class CopyChanges implements SessionChanges {
  readonly #state: ProjectState;
  readonly #store: BrowserStore;
  readonly #host: ChangesHost;
  #seq: number;
  // Entries kept and not yet handed to the session, with where each came from.
  #fresh: { entry: JournalEntry; source: ChangeSource }[] = [];

  constructor({ state, store, host }: { state: ProjectState; store: BrowserStore; host: ChangesHost }) {
    this.#state = state;
    this.#store = store;
    this.#host = host;
    this.#seq = store.journal().at(-1)?.seq ?? 0;
  }

  get lastSeq(): number { return this.#seq; }

  async write<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      this.#hand();
    }
  }

  // Nothing else writes in a copy.
  async refresh(): Promise<void> {
    this.#hand();
  }

  // An entry numbered and kept for good; handed to the session once the write is done.
  async append<Entry extends Unnumbered<JournalEntry>>(entry: Entry, source: ChangeSource = 'engine'): Promise<JournalEntry> {
    const numbered = { ...entry, seq: this.#seq + 1 } as JournalEntry;
    await this.#store.append([numbered]);
    this.#seq = numbered.seq;
    this.#fresh.push({ entry: numbered, source });
    return numbered;
  }

  async journal(contents: NewContents): Promise<number | null> {
    const before = this.#state.files;
    const after = withUpdates(before, contents.updates);
    const ops = diffFiles(before, after);
    if (!ops.length) return null;
    const id = newId();
    const entry = await this.append({
      type: 'change', id, at: new Date().toISOString(), author: contents.author, batch: contents.batch ?? id,
      ...(contents.command ? { command: contents.command } : {}), ops, inverse: invertOps(before, ops), files: touched(ops)
    }, contents.source);
    this.#state.update(contents.updates);
    return entry.seq;
  }

  externalNotes(): undefined {
    return undefined;
  }

  #hand(): void {
    if (!this.#fresh.length) return;
    const fresh = this.#fresh.splice(0);
    const sources = new Map(fresh.map(({ entry, source }) => [entry.seq, source]));
    this.#host.taken(fresh.map(({ entry }) => entry), (entry) => sources.get(entry.seq) ?? 'engine');
  }
}

// The files a change touches, as a journal names them: a copy keeps no hashes of their contents.
export const touched = (ops: readonly Op[]): { path: string; before: null; after: null }[] => touchedFiles(ops).map((path) => ({ path, before: null, after: null }));

export const newId = (): string => [...crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export function withUpdates(files: ProjectFiles, updates: ReadonlyMap<string, SourceFile | null>): Map<string, SourceFile> {
  const next = new Map(files);
  for (const [rel, file] of updates) {
    if (file) next.set(rel, file);
    else next.delete(rel);
  }
  return next;
}
