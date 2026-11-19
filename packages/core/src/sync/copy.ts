import type { Author, Files, Op } from '../ops/types.ts';
import type { LocalChange } from './client.ts';

// A copy of a project in the cloud as its host keeps it (docs/architecture/sync.md, D100): what the
// copy itself remembers between two openings, and what it asks of its host to keep what the room
// confirmed and to move the team's media. A desktop's host keeps them in the module's folder (its
// link, cloud-project.json, and its blob store) and reaches the hosting's API; a browser's will keep
// them in its own storage. The copy's machine (the engine's session-cloud) is written against this
// alone.

export interface Person { id: string; name: string | null }

// What the copy remembers of itself, besides what the room confirmed.
export interface CopyLink {
  team: string;
  project: string;
  client: string;          // this copy, unique: prefixes the ids of the changes it sends
  person: Person;          // who works in this copy: the journal names them (D78)
  head: number;            // the room's number of the last change confirmed here
  // The room's history that number belongs to (elabora-cloud C84): null in a new link (clone, push), the
  // first welcome's then; absent in a link made before it, which counts as "0".
  epoch?: string | null;
  waiting: LocalChange[];  // changes made here the room has not placed yet, oldest first
  journal: number;         // the last journal entry the copy took in
}

// What the host gives the copy. Media are named by their hash (sha256:…): the host keeps their bytes.
export interface CopyStore {
  // The files the room confirmed at link.head, as the store last kept them.
  confirmed(): Files;
  // Keeps the copy as it is now: its link, the files the room confirmed, and of those the ones that
  // changed since the last save (only those are stored again).
  save(link: Readonly<CopyLink>, confirmed: Files, changed: Files): void;
  // The copy ended (D91): what links it to the project goes; what it held stays the module's.
  unlink(): void;
  // Announces every medium a change writes and sends those the team lacks (D88): the upload to
  // commit once the change is placed, null when the change writes none.
  sendMedia(hashes: readonly string[]): Promise<string | null>;
  commitMedia(upload: string | null): Promise<void>;
  // A medium of the team kept here, checked against its hash, before a change that writes it is.
  fetchMedium(hash: string): Promise<void>;
  // Whether the copy's person still reaches the project (D91), asked when the room would not take the
  // connection: removed from the team (or the team gone), the project deleted, or unknown (offline,
  // any other answer: the copy keeps trying).
  membership(): Promise<'member' | 'removed' | 'deleted' | 'unknown'>;
}

// The room of a project, on the hosting's API (its origin).
export const roomUrl = (api: string, team: string, project: string): string =>
  `${api.replace(/^http/, 'ws')}/v1/teams/${encodeURIComponent(team)}/projects/${encodeURIComponent(project)}/room`;

// The binary contents a change writes, by hash.
export function blobsOf(ops: readonly Op[]): string[] {
  return [...new Set(ops.flatMap((op) => (op.op === 'write' && 'blob' in op ? [op.blob] : [])))];
}

// The author a copy's journal writes (D78): the folder's person, and as the one who
// launched them, for agents and files edited by their own tools.
export function stampAuthor(author: Author, person: Person | null | undefined): Author {
  if (!person) return author;
  if (author.kind === 'human' || author.kind === 'system') return author.id ? author : { ...author, id: person.id, ...(author.kind === 'human' && !author.name && person.name ? { name: person.name } : {}) };
  return author.by ? author : { ...author, by: person.id };
}

