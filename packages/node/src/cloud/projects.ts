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
import { linkFile, readLink, writeLink, type Person, type ProjectLink } from './link.ts';
import { ensureLibrary, stagingFolder } from '../library/location.ts';
import { getProject, readCourseInfo, type LibraryProject } from '../library/projects.ts';
import { dataLocation } from '../data-dir.ts';
import { newProjectId, removeTree, renameWithRetries, writeProjectId } from '../library/files.ts';

export { readLink, writeLink, unlinkFolder, linkFile, stampAuthor, type Person, type ProjectLink } from './link.ts';

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

export type { CoverType, InvitationToMe, ProjectCover, ProjectView, TeamDetails, TeamInvitation, TeamMember, TeamRole, TeamView } from './types.ts';
import type { CoverType, InvitationToMe, ProjectCover, ProjectView, TeamDetails, TeamInvitation, TeamMember, TeamRole, TeamView } from './types.ts';

export function projectsClient(api: string): CloudClient {
  return new CloudClient(api, requireCredential(api).token);
}

export async function whoAmI(client: CloudClient): Promise<Person> {
  const { account } = await client.request<{ account: { id: string; handle: string | null; displayName: string | null } }>('GET', '/v1/account');
  return { id: account.id, name: account.displayName ?? account.handle ?? null };
}

export async function listTeams(client: CloudClient): Promise<TeamView[]> {
  return (await teamsAndInvitations(client)).teams;
}

// The account's teams, and the invitations waiting for its address.
export async function teamsAndInvitations(client: CloudClient): Promise<{ teams: TeamView[]; invitations: InvitationToMe[] }> {
  const answer = await client.request<{ teams: TeamView[]; invitations?: InvitationToMe[] }>('GET', '/v1/teams');
  return { teams: answer.teams, invitations: answer.invitations ?? [] };
}

const teamPath = (team: string): string => `/v1/teams/${segment(team)}`;

// A team, its members (by name, never an address) and, for an owner, its pending invitations.
export async function teamDetails(client: CloudClient, team: string): Promise<TeamDetails> {
  return client.request<TeamDetails>('GET', teamPath(team));
}

export async function renameTeam(client: CloudClient, team: string, name: string): Promise<TeamView> {
  return (await client.request<{ team: TeamView }>('PATCH', teamPath(team), { json: { name } })).team;
}

// Every project of the team with it, for all its members (an owner's, C40).
export async function deleteTeam(client: CloudClient, team: string): Promise<void> {
  await client.request('DELETE', teamPath(team), { json: { confirm: team } });
}

// No e-mail is sent; the server keeps only the address's HMAC (C36). An owner's.
export async function inviteMember(client: CloudClient, team: string, email: string, role: TeamRole): Promise<TeamInvitation> {
  return (await client.request<{ invitation: TeamInvitation }>('POST', `${teamPath(team)}/invitations`, { json: { email, role } })).invitation;
}

// Revoked by an owner, or declined by the invited account.
export async function dropInvitation(client: CloudClient, team: string, invitation: string): Promise<void> {
  await client.request('DELETE', `${teamPath(team)}/invitations/${segment(invitation)}`);
}

export async function acceptInvitation(client: CloudClient, team: string, invitation: string): Promise<TeamView> {
  return (await client.request<{ team: TeamView }>('POST', `${teamPath(team)}/invitations/${segment(invitation)}/accept`)).team;
}

export async function setMemberRole(client: CloudClient, team: string, account: string, role: TeamRole): Promise<TeamMember> {
  return (await client.request<{ member: TeamMember }>('PATCH', `${teamPath(team)}/members/${segment(account)}`, { json: { role } })).member;
}

// By an owner, or by the member themself (leaving the team).
export async function removeMember(client: CloudClient, team: string, account: string): Promise<void> {
  await client.request('DELETE', `${teamPath(team)}/members/${segment(account)}`);
}

// A project renamed (elabora-cloud C78): its name is its module's title, so with a course.json the room
// places update_course { title } in the person's name, in the journal, undoable (change: its number;
// none when the title was that already); without one, the name given at its making changes. An editor's
// or an owner's.
export async function renameProject(client: CloudClient, team: string, project: string, name: string): Promise<{ project: ProjectView; change?: number }> {
  return client.request<{ project: ProjectView; change?: number }>('PATCH', `${teamPath(team)}/projects/${segment(project)}`, { json: { name } });
}

export async function listProjects(client: CloudClient, team: string): Promise<ProjectView[]> {
  return (await client.request<{ projects: ProjectView[] }>('GET', `${teamPath(team)}/projects`)).projects;
}

// Whether a copy's person still reaches its project (D91), asked when the room would not take its
// connection: removed from the team (or the team gone), the project deleted, or unknown (offline, or
// any other answer: the copy keeps trying).
export async function projectMembership(client: CloudClient, team: string, project: string): Promise<'member' | 'removed' | 'deleted' | 'unknown'> {
  try {
    return (await listProjects(client, team)).some((each) => each.id === project) ? 'member' : 'deleted';
  } catch (error) {
    return error instanceof CloudError && error.status === 404 && error.code === 'no-team' ? 'removed' : 'unknown';
  }
}

export async function createProject(client: CloudClient, team: string, name: string): Promise<ProjectView> {
  return (await client.request<{ project: ProjectView }>('POST', `${teamPath(team)}/projects`, { json: { name } })).project;
}

// For every member, with its media and history: an owner's (C40).
export async function deleteProject(client: CloudClient, team: string, project: string): Promise<void> {
  await client.request('DELETE', `${teamPath(team)}/projects/${segment(project)}`, { json: { confirm: project } });
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

// The picture of the project's card the server keeps (C77 of elabora-cloud): the app's render, sent at
// the head it was rendered at, by an editor or an owner. A newer head replaces it, the same head too; an
// older one is refused (409 cover-older).
export async function putCover(client: CloudClient, team: string, project: string, head: number, image: Uint8Array, type: CoverType): Promise<ProjectCover> {
  return (await client.request<{ cover: ProjectCover }>('PUT', `${teamPath(team)}/projects/${segment(project)}/cover?head=${head}`, { bytes: image, contentType: type })).cover;
}

// The cover's picture and its version (its ETag); null while the project has none.
export async function readCover(client: CloudClient, team: string, project: string): Promise<{ bytes: Uint8Array; type: string; version: string | null } | null> {
  let response: Response;
  try {
    response = await fetch(`${client.api}${teamPath(team)}/projects/${segment(project)}/cover`, { headers: { Authorization: `Bearer ${requireCredential(client.api).token}` }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new CloudError(0, 'E_CLOUD_NETWORK', `The cover of the project could not be read: ${(error as Error).message}.`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new CloudError(response.status, `http-${response.status}`, 'The cover of the project could not be read.');
  return { bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get('content-type') ?? 'image/jpeg', version: response.headers.get('etag')?.replace(/^W\/|"/g, '') ?? null };
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

// A project of the cloud into a new folder, linked to it: its media four at a time (D88), reported
// by bytes as they arrive.
export async function cloneProject(dir: string, options: { api: string; team: string; project: string }, { onProgress }: { onProgress?: (progress: { receivedBytes: number; totalBytes: number }) => void } = {}): Promise<ProjectLink> {
  const root = path.resolve(dir);
  // Its .elabora/ only (the library's id, written first so that the link goes with it).
  if (fs.existsSync(root) && fs.readdirSync(root).some((entry) => entry !== '.elabora')) throw new CloudError(0, 'E_CLOUD_NOT_EMPTY', `${root} is not empty: clone into a new folder.`);
  const client = projectsClient(options.api);
  const [person, remote] = await Promise.all([whoAmI(client), projectFiles(client, options.team, options.project)]);
  fs.mkdirSync(root, { recursive: true });
  const media = remote.files.filter((file): file is Extract<SnapshotFile, { blob: string }> => 'blob' in file);
  const totalBytes = media.reduce((sum, file) => sum + (file.size ?? 0), 0);
  let receivedBytes = 0;
  onProgress?.({ receivedBytes, totalBytes });
  const queue = [...new Map(media.map((file) => [file.blob, file])).values()];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await fetchMedium(client, root, options.team, next.blob);
      receivedBytes += next.size ?? 0;
      onProgress?.({ receivedBytes, totalBytes });
    }
  }));
  for (const file of remote.files) {
    const target = path.join(root, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if ('text' in file) fs.writeFileSync(target, file.text);
    else await copyBlobTo(root, file.blob as BlobHash, target);
  }
  return newLink(root, options, person, remote.head, snapshotToFiles(remote.files), lastEntry(root)?.seq ?? 0);
}

// A project of the cloud as a module of the library (app, Lin 54): made in a staging folder under a
// new library id, then moved in by one rename; nothing is left of it when the download fails, or when
// its module does not read (E_PROJECT_UNREADABLE). A copy that keeps no link (« Dupliquer dans Mes
// modules ») drops it once in.
export async function cloneToLibrary(options: { api: string; team: string; project: string }, { linked = true, onProgress }: { linked?: boolean; onProgress?: (progress: { receivedBytes: number; totalBytes: number }) => void } = {}): Promise<LibraryProject> {
  const root = ensureLibrary();
  const staging = stagingFolder(root);
  try {
    const dir = path.join(staging, 'project');
    const id = newProjectId(root);
    writeProjectId(dir, id);
    await cloneProject(dir, options, { onProgress });
    // A project whose module does not read (its course.json missing or broken) does not enter the
    // library: it would open as an empty module. Nothing of it stays here, its data neither.
    const course = readCourseInfo(dir);
    if (course.error) {
      const data = dataLocation(dir);
      if (!data.inProject) await removeTree(data.dir);
      throw new CloudError(0, 'E_PROJECT_UNREADABLE', `The project's module cannot be read: ${course.error}`);
    }
    if (!linked) fs.rmSync(linkFile(dir), { force: true });
    await renameWithRetries(dir, path.join(root, id));
    return getProject(id);
  } finally {
    await removeTree(staging);
  }
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
