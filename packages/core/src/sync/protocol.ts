// The protocol of a project in the cloud, elabora-sync/1 (docs/architecture/sync.md, D73): a server
// per project orders the changes of every copy. Plain data, safe to serialise as JSON; the room
// (elabora-cloud) and the clients (desktop, CLI) import these types and the functions of this folder.
import type { Author, Op, SkippedOp } from '../ops/types.ts';
import type { Json } from '../ops/types.ts';

export const SYNC_PROTOCOL = 'elabora-sync/1';

// A change a copy submits: computed on the files confirmed at base (the server's number of the last
// change it had), with the inverse of its operations on those files. The inverse is what rebase
// reads the values of before from: the server recomputes its own once the change is placed.
export interface Submission {
  id: string;            // chosen by the copy, unique: a submission sent twice is placed once
  base: number;          // the server's number the change was computed on
  at: string;
  author: Author;
  batch?: string;        // AI work: the batch it joins, chosen by the copy that ran the agent
  command?: { name: string; args: unknown };
  ops: Op[];
  inverse: Op[];         // inverse[k] undoes ops[ops.length - 1 - k], on the files at base
  // An undo: the changes it undoes, and what of them it left out (D87).
  undoes?: Undoes;
  // What the copy's own rebase of the change overwrote (it was made before the copy got changes of
  // others): passed on with the change, so that whoever wrote those values is told.
  overwrote?: Overwrite[];
}

// An operation that rebase applied over a value written by a change its author had not seen (a
// person's edit wins: the last written). was: what it replaced, so that the one who wrote it is told.
export interface Overwrite {
  file: string;
  path: string;          // formatPath of the target, for messages
  was: Json | string | null; // the value, the text of a file, or null when it was absent
  by?: string;           // the change that had written it, when known
  // A file written by an agent's own tools, from a version that may or may not have held the value
  // (D75): told all the same.
  unsure?: true;
}

// A change as the server placed it: its number, the operations it kept, their inverse on the head
// they applied to, and what it left out or overwrote.
export interface Committed {
  seq: number;
  id: string;
  base: number;
  at: string;
  author: Author;
  batch: string;
  command?: { name: string; args: unknown };
  ops: Op[];
  inverse: Op[];
  skipped: SkippedOp[];  // operations of the submission left out (an agent's value over a person's…)
  overwrote: Overwrite[];
  undoes?: Undoes;
}

// What an undo undid (D79, D87): the changes it targets, and the inverse operations of theirs it
// left out, so that they stay in force and a later undo tries them again. A left-out operation names
// the change it is the inverse of and is that change's inverse operation as the log holds it, or
// (left out by a rebase as the undo was placed) names the undo itself and is the operation it did
// not place; journalOf and undoState read both. The copy that computed the undo sends what it left
// out; each rebase on the way (the copy's, the server's) adds what it left out.
export interface Undoes {
  batch?: string;
  changes: string[];
  skipped?: SkippedOp[];
}

// A change the server did not place: nothing of it applies. acceptChange's codes:
//   E_SYNC_ID_TAKEN        it inserts an id another change took meanwhile
//   E_SYNC_INVALID         the project would not validate
//   E_SYNC_BASE            its base is older than what the server keeps, or newer than its head
//   E_SYNC_MALFORMED       it is not a change
// The room's, for what it checks before acceptChange (D85; acceptChange never returns them):
//   E_SYNC_READ_ONLY       its author may read the project, not change it
//   E_SYNC_PATH            it names a file the project may not hold (a path that is not relative,
//                          under .elabora/, not in Unicode NFC, or another file's in another case)
//   E_SYNC_TOO_LARGE       over the room's limits: operations in a change, a text written whole
//   E_SYNC_TOO_MANY_FILES  the project would hold more files than the room allows
//   E_SYNC_BLOB_MISSING    it writes a medium the room cannot find: send the medium, then the same
//                          change again (the copy does, a few times)
//   E_SYNC_ID_USED         another author's change has its id
export type RefusalCode =
  | 'E_SYNC_ID_TAKEN' | 'E_SYNC_INVALID' | 'E_SYNC_BASE' | 'E_SYNC_MALFORMED'
  | 'E_SYNC_READ_ONLY' | 'E_SYNC_PATH' | 'E_SYNC_TOO_LARGE' | 'E_SYNC_TOO_MANY_FILES' | 'E_SYNC_BLOB_MISSING' | 'E_SYNC_ID_USED';

export const REFUSAL_CODES: readonly RefusalCode[] = Object.freeze([
  'E_SYNC_ID_TAKEN', 'E_SYNC_INVALID', 'E_SYNC_BASE', 'E_SYNC_MALFORMED',
  'E_SYNC_READ_ONLY', 'E_SYNC_PATH', 'E_SYNC_TOO_LARGE', 'E_SYNC_TOO_MANY_FILES', 'E_SYNC_BLOB_MISSING', 'E_SYNC_ID_USED'
]);

export interface Refusal {
  id: string;
  code: RefusalCode;
  message: string;
  // E_SYNC_INVALID: the errors the change would have added, whole (D90), so that the copy can say why
  // in its author's words and where to look. A room may leave them out.
  diagnostics?: RefusalDiagnostic[];
}

export interface RefusalDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  file?: string;
  path?: string;
  message: string;
  fix?: string;
}

// Who is there, and where: a person, or an agent with the person who launched it.
export interface Actor {
  id: string;            // stable: a person's account, or an agent's id under that person
  name: string;
  kind: 'human' | 'agent';
  by?: string;           // an agent: the id of the person who launched it
}

export interface Presence {
  actor: Actor;
  client: string;        // one copy of the project (a desktop app, a CLI, a connector session)
  screen?: string;
  selection?: string[];  // ids of the selected blocks
  view?: string;         // the view a person works in (« plan », « diapositive »…), said apart from a screen (D91)
  at: string;
}

// ── messages ─────────────────────────────────────────────────────────

// From a copy. hello opens a connection: since is the number of the last change the copy has, and
// the server answers with what came after (catchup), or with the whole project when it no longer
// keeps that far back (snapshot).
export type ClientMessage =
  | { type: 'hello'; protocol: typeof SYNC_PROTOCOL; client: string; actor: Actor; since: number }
  | { type: 'submit'; change: Submission }
  | { type: 'catchup'; since: number }
  | { type: 'presence'; presence: Omit<Presence, 'actor' | 'client' | 'at'> };

// A member's role in the project's team (elabora-cloud C36): an owner, an editor writes, a viewer reads.
export type RoomRole = 'owner' | 'editor' | 'viewer';

// From the server. ack answers the copy that submitted (with the change as placed); change is the
// same change sent to the others. role: the person's role changed while connected (D93); a copy that
// does not know a type ignores it. welcome's role: the person's role at the connection (D94), taken
// before anything waiting is sent; a room before it leaves it out.
export type ServerMessage =
  | { type: 'welcome'; protocol: typeof SYNC_PROTOCOL; head: number; peers: Presence[]; role?: RoomRole }
  | { type: 'ack'; change: Committed }
  | { type: 'refused'; refusal: Refusal; head: number }
  | { type: 'change'; change: Committed }
  | { type: 'catchup'; changes: Committed[]; head: number }
  | { type: 'snapshot'; head: number; files: SnapshotFile[] }
  | { type: 'presence'; peers: Presence[] }
  | { type: 'role'; role: RoomRole }
  | { type: 'error'; code: string; message: string };

// A file of a snapshot: text whole, binary by the hash of its content (sent apart, as a blob).
export type SnapshotFile = { path: string; text: string } | { path: string; blob: string; size?: number };
