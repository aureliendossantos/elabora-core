import fs from 'node:fs';
import path from 'node:path';
import type { Author } from '@elabora/core/ops/types';
import type { LocalChange } from '@elabora/core/sync/client';
import { projectDataDir } from '../data-dir.ts';
import { readJSONFile, writeJSONFile } from '../util/fs.ts';
import { CloudError } from './client.ts';

// A folder linked to a project in the cloud (D83): which project, who works here, what the room
// confirmed and the changes made here that wait for it. In the project's data folder, never sent.

export interface Person { id: string; name: string | null }

// ── the link of a folder to its project ──────────────────────────────

export interface ProjectLink {
  format: 'elabora-cloud-project/1';
  api: string;
  team: string;
  project: string;
  client: string;          // this copy, unique: prefixes the ids of the changes it sends
  person: Person;          // who works in this folder: the journal names them (D78)
  head: number;            // the room's number of the last change confirmed here
  confirmed: Record<string, string>; // path → text:<hash> or blob:<hash> in the blob store, at head
  waiting: LocalChange[];  // changes made here the room has not placed yet, oldest first
  journal: number;         // the last journal entry the copy took in
}

export const linkFile = (root: string): string => path.join(projectDataDir(root), 'cloud-project.json');

export function readLink(root: string): ProjectLink | null {
  const file = linkFile(root);
  if (!fs.existsSync(file)) return null;
  const read = readJSONFile(file);
  const value = read.value as ProjectLink | undefined;
  if (read.error !== undefined || value?.format !== 'elabora-cloud-project/1') throw new CloudError(0, 'E_CLOUD_LINK', `${file} is not a project link: link the folder again.`);
  return value;
}

export function writeLink(root: string, link: ProjectLink): void {
  fs.mkdirSync(path.dirname(linkFile(root)), { recursive: true });
  writeJSONFile(linkFile(root), link);
}

// The folder no longer a copy of the project (its person left the team, or the project went, D91): a
// module of this computer, holding what the copy held, its changes not sent included.
export function unlinkFolder(root: string): void {
  fs.rmSync(linkFile(root), { force: true });
}


// The author a linked folder's journal writes (D78): the folder's person, and as the one who
// launched them, for agents and files edited by their own tools.
export function stampAuthor(author: Author, person: Person | null | undefined): Author {
  if (!person) return author;
  if (author.kind === 'human' || author.kind === 'system') return author.id ? author : { ...author, id: person.id, ...(author.kind === 'human' && !author.name && person.name ? { name: person.name } : {}) };
  return author.by ? author : { ...author, by: person.id };
}

