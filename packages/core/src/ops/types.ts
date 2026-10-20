// Operations, changes and journal entries: the one language every change to a project is written
// in (docs/architecture/operations.md). Plain data, safe to serialise as JSON.

export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

// An object key, or { id } selecting the element of a keyed array: an array of objects that all
// have a distinct string id, or an array of distinct strings, matched by value.
export type Segment = string | { id: string };

// path [] replaces the whole document. after: for a key the object does not have yet, the key it
// follows (null: first); without it the key is appended. Existing keys keep their place.
export interface SetOp { op: 'set'; file: string; path: Segment[]; value: Json; after?: string | null }
export interface UnsetOp { op: 'unset'; file: string; path: Segment[] }
// path: the keyed array. after: the id of the element it follows, or null for first.
export interface InsertOp { op: 'insert'; file: string; path: Segment[]; value: Json; after: string | null }
// path ends with { id }.
export interface RemoveOp { op: 'remove'; file: string; path: Segment[] }
// path ends with { id }; to.path is the keyed array that receives the element, in the same file or another.
export interface MoveOp { op: 'move'; file: string; path: Segment[]; to: { file: string; path: Segment[] }; after: string | null }
// A non-JSON text file, a new JSON file, or a JSON file whose text does not parse.
export interface WriteTextOp { op: 'write'; file: string; text: string }
// A binary file, by the hash of its content in .elabora/blobs.
export interface WriteBlobOp { op: 'write'; file: string; blob: string }
export interface DeleteOp { op: 'delete'; file: string }

export type WriteOp = WriteTextOp | WriteBlobOp;
export type Op = SetOp | UnsetOp | InsertOp | RemoveOp | MoveOp | WriteTextOp | WriteBlobOp | DeleteOp;

// A file as operations see it; the project snapshot (project/files.ts) is one. Text files carry
// their text (and may carry the parsed value of a .json file), binary files the hash of their
// bytes. A snapshot may compute hashes on demand: operations only read the hashes of the binary
// files they write or compare.
export interface TextFile { readonly kind: 'text'; readonly text: string; readonly json?: Json }
export interface BinaryFile { readonly kind: 'binary'; readonly hash?: string; readonly size?: number }
export type FileContent = TextFile | BinaryFile;
// Project-relative POSIX path → content. Operations never mutate it: they return a new map.
export type Files = ReadonlyMap<string, FileContent>;

export interface Author { kind: 'human' | 'agent' | 'external' | 'system'; name?: string }

// Hashes (sha256:…) of a touched file before and after a change; null when it did not exist.
export interface FileHash { path: string; before: string | null; after: string | null }

// One applied command. inverse[k] undoes ops[ops.length - 1 - k].
export interface Change {
  seq: number;
  id: string;
  at: string;
  author: Author;
  batch: string;
  command?: { name: string; args: unknown };
  ops: Op[];
  inverse: Op[];
  files: FileHash[];
  // Hashes (sha256:…) of previous contents the change could not keep: a binary file another program
  // overwrote or deleted before any version or change stored it. The inverse writes naming them are
  // recorded but cannot be undone (undo skips them as unavailable).
  unavailable?: string[];
}

// An inverse operation that undo left out, so that what was written after the change is kept.
//   changed      its target was edited since the change
//   missing      its target is gone
//   conflict     it no longer applies (a duplicate id…)
//   unavailable  the previous content of a binary file was not kept
export interface SkippedOp {
  change: string;
  op: Op;
  reason: 'changed' | 'missing' | 'conflict' | 'unavailable';
  message: string;
}

// Journal lines (.elabora/journal/<yyyy-mm>.jsonl).
export interface ChangeEntry extends Change { type: 'change' }
// An undo is itself a change (it can be undone) that also records what it undid and what it kept.
export interface UndoEntry extends Change {
  type: 'undo';
  undoes: { batch?: string; changes: string[] };
  skipped: SkippedOp[];
}
// Written when the user asks the AI for something: closes the batch and labels the next one.
export interface MarkEntry { type: 'mark'; seq: number; id: string; at: string; author: Author; request: string }

export type ChangeLike = ChangeEntry | UndoEntry;
export type JournalEntry = ChangeEntry | UndoEntry | MarkEntry;
