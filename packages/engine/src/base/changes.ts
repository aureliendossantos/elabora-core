import type { Author, JournalEntry } from '@elabora/core/ops/types';
import type { SourceFile } from '@elabora/core/project/files';
import type { ChangeSource, EngineEvent, ExternalNotes } from '../protocol.ts';

// Where a session's changes come from and where they go (docs/architecture/engine.md, Where changes
// come from, D101). The session above it is the same for every host: one write queue, the project in
// memory (ProjectState), the reads, the AI batches, the events. Below it, a desktop has a folder (the
// project's lock, its journal, other processes' changes, files that programs other than Elabora's
// tools write, its watchers: session-folder.ts); a browser will have a copy of the room's project (what
// the room confirmed, then the changes waiting, the room's journal), with no lock, no other writer
// and nothing to watch.
//
// Left open until a second realization is written: how a command and an undo run (on the desktop,
// @elabora/node's edits with the session's snapshot, which append to the folder's journal
// themselves; in a browser, the command on the view, then SyncClient.record, the undo computed from
// the room's journal and the changes waiting).

// New contents journaled as one change of their author: files already written (by a job, another
// program, the room), and files to write now (write: references rewritten).
export interface NewContents {
  updates: Map<string, SourceFile | null>;
  author: Author;
  command?: { name: string; args: unknown };
  source: ChangeSource;
  write?: ReadonlyMap<string, SourceFile>;
  batch?: string;
}

export interface SessionChanges {
  // One write of the session, in its queue: apart from every other writer, after what they did is
  // taken in, and followed by what it wrote taken in.
  write<T>(work: () => Promise<T>): Promise<T>;
  // What other writers did, taken in outside a write; final: everything, as the session closes.
  refresh(final?: boolean): Promise<void>;
  // Journals new contents as one change (inside a write): its number, null when nothing changed.
  journal(contents: NewContents): Promise<number | null>;
  // The number of the journal's last entry.
  readonly lastSeq: number;
  // What a change made by a program other than Elabora's tools left out or replaced (D75), by its id.
  externalNotes(change: string): ExternalNotes | undefined;
}

// What the changes give back to the session.
export interface ChangesHost {
  // Journal entries taken in, in order, the session's own and other writers': the session records them
  // (history, batches), gives them to the project's copy in the cloud and tells them (changed, with
  // where each came from).
  taken(entries: readonly JournalEntry[], source: (entry: JournalEntry) => ChangeSource): void;
  // After a change or a refresh: what changed is validated and told.
  afterChange(): Promise<void>;
  emit(event: EngineEvent): void;
}
