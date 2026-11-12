import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FileContent, Files, Op } from '@elabora/core/ops/types';
import { binaryFile, textFile } from '@elabora/core/ops/json';
import type { Committed, Refusal, SnapshotFile, Submission } from '@elabora/core/sync/protocol';
import { blobPath, copyBlobTo, hasBlob, putBytes, putFileSnapshot, readBlob, type BlobHash } from '../blobs.ts';
import { readProjectFiles } from '../project-reader.ts';
import { lastEntry } from '../journal/journal.ts';
import { CloudClient, CloudError, segment } from './client.ts';
import { requireCredential } from './credentials.ts';
import { sendBlobs } from './blob-upload.ts';
import { readLink, writeLink, type Person, type ProjectLink } from './link.ts';

export { readLink, writeLink, linkFile, stampAuthor, type Person, type ProjectLink } from './link.ts';

// Projects in the cloud (docs/architecture/sync.md, D73): a team's projects, each in a room that
// orders the changes of every copy. This is the copy's side over the hosting's API (protocol
// version 10): the projects' routes, the media, and the link a folder keeps to its project, with
// what the room confirmed and the changes made here that wait for it.

// A project's room is on staging only (D83): the address is given, never the default production API.
export function projectsApi(value: string | undefined = process.env.ELABORA_CLOUD_URL): string {
  const raw = value?.trim();
  if (!raw) throw new CloudError(0, 'E_CLOUD_URL', 'Projects in the cloud run on a test server for now: give its address (ELABORA_CLOUD_URL or --api).');
  let url: URL;
  try { url = new URL(raw); } catch { throw new CloudError(0, 'E_CLOUD_URL', `Not an address: ${raw}`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.hostname === 'api.elabora.studio') throw new CloudError(0, 'E_CLOUD_URL', 'Projects in the cloud are not open on Elabora\'s hosting yet: give a test server\'s address.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new CloudError(0, 'E_CLOUD_URL', `The API is reached over HTTPS (http only on this computer), not ${url.origin}.`);
  return url.origin;
}

export interface TeamView { id: string; name: string; role?: string }
export interface ProjectView { id: string; team: string; name: string }

export function projectsClient(api: string): CloudClient {
  return new CloudClient(api, requireCredential(api).token);
}

export async function whoAmI(client: CloudClient): Promise<Person> {
  const { account } = await client.request<{ account: { id: string; handle: string | null; displayName: string | null } }>('GET', '/v1/account');
  return { id: account.id, name: account.displayName ?? account.handle };
}

export async function listTeams(client: CloudClient): Promise<TeamView[]> {
  return (await client.request<{ teams: TeamView[] }>('GET', '/v1/teams')).teams;
}

export async function createProject(client: CloudClient, team: string, name: string): Promise<ProjectView> {
  return (await client.request<{ project: ProjectView }>('POST', `/v1/teams/${segment(team)}/projects`, { json: { name } })).project;
}

export async function projectFiles(client: CloudClient, team: string, project: string): Promise<{ head: number; files: SnapshotFile[] }> {
  return client.request('GET', `/v1/teams/${segment(team)}/projects/${segment(project)}/files`);
}

// One change over HTTP (a first upload, a command line without a room open): the room's ack, or
// its refusal.
export async function submitChange(client: CloudClient, team: string, project: string, change: Submission): Promise<{ ack: Committed } | { refused: Refusal }> {
  try {
    const answer = await client.request<{ type: 'ack'; change: Committed }>('POST', `/v1/teams/${segment(team)}/projects/${segment(project)}/changes`, { json: change, timeoutMs: 120_000 });
    return { ack: answer.change };
  } catch (error) {
    if (error instanceof CloudError && error.status >= 400 && error.status < 500 && error.code.startsWith('E_SYNC_')) {
      return { refused: { id: change.id, code: error.code as Refusal['code'], message: error.message } };
    }
    throw error;
  }
}

export const roomUrl = (api: string, team: string, project: string): string =>
  `${api.replace(/^http/, 'ws')}/v1/teams/${segment(team)}/projects/${segment(project)}/room`;

// ── media ────────────────────────────────────────────────────────────

const hex = (hash: string): string => hash.replace(/^sha256:/, '');

// The binary contents a change writes, by hash.
export function blobsOf(ops: readonly Op[]): string[] {
  return [...new Set(ops.flatMap((op) => (op.op === 'write' && 'blob' in op ? [op.blob] : [])))];
}

// Announces every medium a change writes (even those the team holds: the upload keeps them from
// the collection until the change is numbered) and sends those it lacks, a few at a time (D88);
// commit it once the change is placed.
export async function sendMedia(client: CloudClient, root: string, team: string, hashes: readonly string[], onProgress?: (sent: { sentBytes: number; totalBytes: number }) => void): Promise<string | null> {
  if (!hashes.length) return null;
  const media = hashes.map((hash) => ({ sha256: hex(hash), size: fs.statSync(blobPath(root, hash as BlobHash)).size }));
  const upload = await client.request<{ upload: string; missing: { sha256: string; size: number }[]; limits?: { singlePutMaxBytes: number } }>('POST', `/v1/teams/${segment(team)}/uploads`, { json: { media } });
  onProgress?.({ sentBytes: 0, totalBytes: upload.missing.reduce((sum, blob) => sum + blob.size, 0) });
  await sendBlobs({
    client, upload: `/v1/teams/${segment(team)}/uploads/${segment(upload.upload)}`, missing: upload.missing, limit: upload.limits?.singlePutMaxBytes,
    fileOf: (blob) => blobPath(root, `sha256:${blob.sha256}` as BlobHash), onProgress
  });
  return upload.upload;
}

export async function commitMedia(client: CloudClient, team: string, upload: string | null): Promise<void> {
  if (upload) await client.request('POST', `/v1/teams/${segment(team)}/uploads/${segment(upload)}/commit`);
}

// A medium of the project into this folder's blob store, checked against its hash.
export async function fetchMedium(client: CloudClient, root: string, team: string, hash: string): Promise<void> {
  if (hasBlob(root, hash as BlobHash)) return;
  const response = await fetch(`${client.api}/v1/teams/${segment(team)}/blobs/${hex(hash)}`, { headers: { Authorization: `Bearer ${requireCredential(client.api).token}` }, redirect: 'error' });
  if (!response.ok) throw new CloudError(response.status, `http-${response.status}`, `The medium ${hex(hash).slice(0, 12)}… could not be read from the project.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` !== hash) throw new CloudError(0, 'E_CLOUD_DIGEST', `The medium ${hex(hash).slice(0, 12)}… does not match its hash.`);
  putBytes(root, bytes);
}

export const newClientId = (): string => `c${crypto.randomBytes(6).toString('hex')}`;

// What the room confirmed, as hashes in the folder's blob store (texts kept there too): text:<hash>
// or blob:<hash> by path.
export function keepConfirmed(root: string, files: Files): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, file] of files) out[rel] = file.kind === 'text' ? `text:${putBytes(root, file.text)}` : `blob:${file.hash as string}`;
  return out;
}

export function confirmedFiles(root: string, confirmed: Record<string, string>): Files {
  const files = new Map<string, FileContent>();
  for (const rel of Object.keys(confirmed).sort()) {
    const [kind, hash] = [confirmed[rel].slice(0, 5), confirmed[rel].slice(5)];
    files.set(rel, kind === 'blob:' ? binaryFile(hash) : textFile(rel, readBlob(root, hash as BlobHash).toString('utf8')));
  }
  return files;
}

export function snapshotToFiles(files: readonly SnapshotFile[]): Files {
  const out = new Map<string, FileContent>();
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) out.set(file.path, 'text' in file ? textFile(file.path, file.text) : binaryFile(file.blob, file.size));
  return out;
}

// ── create, push, clone ──────────────────────────────────────────────

// The room takes a text of at most 1 MiB whole, a change of at most 4 MiB: the first upload sends
// the media first, then the files in changes of at most 3 MiB, course.json last (its screens are
// there by then, so no change adds an error the room would refuse).
const TEXT_LIMIT = 1024 * 1024;
const CHANGE_BYTES = 3 * 1024 * 1024;
const CHANGE_OPS = 900;

export interface Pushed { link: ProjectLink; changes: number; files: number; media: number }

// What a first upload sends: the folder's files, every binary file and long text in the folder's blob
// store, and the journal's last entry at that moment. Taken under the project's lock by an open
// session (Session.cloudSnapshot), so that what is done in the module while the upload runs is in the
// journal after it, and goes as the changes of its authors once the folder is linked (D88).
export interface PushSource { files: Files; journal: number }

export async function folderSnapshot(dir: string): Promise<PushSource> {
  const root = path.resolve(dir);
  const { files } = readProjectFiles(root);
  const out = new Map<string, FileContent>();
  for (const [rel, file] of files) {
    if (rel.normalize('NFC') !== rel) throw new CloudError(0, 'E_CLOUD_PATH', `${rel}: its name is not in Unicode NFC; rename it before the upload.`);
    if (file.kind === 'text') out.set(rel, file);
    else {
      const stored = await putFileSnapshot(root, path.join(root, rel));
      out.set(rel, binaryFile(stored.hash, stored.size));
    }
  }
  return { files: out, journal: lastEntry(root)?.seq ?? 0 };
}

// How far a first upload is: its media by bytes, then its files by change.
export type PushProgress =
  | { phase: 'media'; sentBytes: number; totalBytes: number }
  | { phase: 'files'; sent: number; total: number };

// A folder's files into an empty project of the cloud, then the folder linked to it.
export async function pushFolder(dir: string, options: { api: string; team: string; project: string }, { source, onProgress }: { source?: PushSource; onProgress?: (progress: PushProgress) => void } = {}): Promise<Pushed> {
  const root = path.resolve(dir);
  if (readLink(root)) throw new CloudError(0, 'E_CLOUD_LINKED', `${root} is already linked to a project: elabora cloud project sync.`);
  const client = projectsClient(options.api);
  const [person, remote] = await Promise.all([whoAmI(client), projectFiles(client, options.team, options.project)]);
  if (remote.head !== 0 || remote.files.length) throw new CloudError(0, 'E_CLOUD_NOT_EMPTY', 'This project already has files: clone it instead (elabora cloud project clone).');
  const { files, journal } = source ?? await folderSnapshot(root);
  const ops: Op[] = [];
  const media: string[] = [];
  for (const [rel, file] of files) {
    if (file.kind === 'text' && Buffer.byteLength(file.text) <= TEXT_LIMIT) ops.push({ op: 'write', file: rel, text: file.text });
    else {
      const hash = file.kind === 'text' ? putBytes(root, file.text) : file.hash as string;
      media.push(hash);
      ops.push({ op: 'write', file: rel, blob: hash });
    }
  }
  ops.sort((a, b) => (a.file === 'course.json' ? 1 : b.file === 'course.json' ? -1 : a.file < b.file ? -1 : 1));
  const upload = await sendMedia(client, root, options.team, media, onProgress && ((sent) => onProgress({ phase: 'media', ...sent })));
  // The changes, cut where the room's limits say (course.json alone, last).
  const chunks: Op[][] = [];
  let size = 0;
  for (const op of ops) {
    const bytes = 'text' in op ? Buffer.byteLength(op.text) : 100;
    const chunk = chunks.at(-1);
    if (!chunk || size + bytes > CHANGE_BYTES || chunk.length >= CHANGE_OPS || op.file === 'course.json') { chunks.push([op]); size = bytes; }
    else { chunk.push(op); size += bytes; }
  }
  let head = 0;
  onProgress?.({ phase: 'files', sent: 0, total: chunks.length });
  for (const [n, chunk] of chunks.entries()) {
    const id = `push-${crypto.randomBytes(6).toString('hex')}`;
    const inverse: Op[] = chunk.map((op): Op => ({ op: 'delete', file: op.file })).reverse();
    const answer = await submitChange(client, options.team, options.project, { id, base: head, at: new Date().toISOString(), author: { kind: 'human' }, command: { name: 'push', args: null }, ops: chunk, inverse });
    if ('refused' in answer) throw new CloudError(0, answer.refused.code, `The project refused the upload: ${answer.refused.message}`);
    head = answer.ack.seq;
    onProgress?.({ phase: 'files', sent: n + 1, total: chunks.length });
  }
  await commitMedia(client, options.team, upload);
  const link = newLink(root, options, person, head, files, journal);
  return { link, changes: chunks.length, files: files.size, media: media.length };
}

// A project of the cloud into a new folder, linked to it.
export async function cloneProject(dir: string, options: { api: string; team: string; project: string }): Promise<ProjectLink> {
  const root = path.resolve(dir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new CloudError(0, 'E_CLOUD_NOT_EMPTY', `${root} is not empty: clone into a new folder.`);
  const client = projectsClient(options.api);
  const person = await whoAmI(client);
  const remote = await projectFiles(client, options.team, options.project);
  fs.mkdirSync(root, { recursive: true });
  for (const file of remote.files) {
    const target = path.join(root, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if ('text' in file) fs.writeFileSync(target, file.text);
    else {
      await fetchMedium(client, root, options.team, file.blob);
      await copyBlobTo(root, file.blob as BlobHash, target);
    }
  }
  return newLink(root, options, person, remote.head, snapshotToFiles(remote.files), lastEntry(root)?.seq ?? 0);
}

function newLink(root: string, options: { api: string; team: string; project: string }, person: Person, head: number, files: Files, journal: number): ProjectLink {
  const link: ProjectLink = {
    format: 'elabora-cloud-project/1', api: options.api, team: options.team, project: options.project, client: newClientId(), person,
    head, confirmed: keepConfirmed(root, files), waiting: [], journal
  };
  writeLink(root, link);
  return link;
}

// What a session needs to sync a linked folder (the engine's OpenOptions.cloud).
export function cloudSessionOptions(dir: string): { api: string; client: CloudClient; token: string; link: ProjectLink } | null {
  const link = readLink(path.resolve(dir));
  if (!link) return null;
  const api = projectsApi(link.api);
  const token = requireCredential(api).token;
  return { api, client: new CloudClient(api, token), token, link };
}
