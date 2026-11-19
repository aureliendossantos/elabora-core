import type { FileContent, Files } from '@elabora/core/ops/types';
import { binaryFile, textFile } from '@elabora/core/ops/json';
import type { CopyLink } from '@elabora/core/sync/copy';
import type { SnapshotFile } from '@elabora/core/sync/protocol';
import { readMediaFacts, type KnownMedium, type MediaMap } from '@elabora/core/sync/media';
import type { RoomSocket } from '../base/session-cloud.ts';
import type { RemoteMedia } from './idb-store.ts';

// A browser's way to a project's room and its team's media (elabora-cloud C101–C103): every call a
// fetch() with the web session's cookie, which the page never reads; the room's WebSocket opened with
// that cookie too (same site), no ticket and no token in the Worker.

export interface RoomAccess {
  api: string; // the hosting's API, its origin
  team: string;
  project: string;
}

export class RoomError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RoomError';
    this.status = status;
    this.code = code;
  }
}

const segment = (value: string): string => encodeURIComponent(value);
const hex = (hash: string): string => hash.replace(/^sha256:/, '');

async function call<T>(api: string, method: string, path: string, body?: unknown | Uint8Array): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${api}${path}`, {
      method, credentials: 'include', mode: 'cors', redirect: 'error',
      ...(body instanceof Uint8Array ? { body: body as Uint8Array<ArrayBuffer>, headers: { 'Content-Type': 'application/octet-stream' } } : body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {})
    });
  } catch (error) {
    throw new RoomError(0, 'E_CLOUD_NETWORK', `Elabora's hosting could not be reached: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new RoomError(response.status, typeof error?.code === 'string' ? error.code : `http-${response.status}`, typeof error?.message === 'string' ? error.message : `${response.status} ${response.statusText}`);
  }
  return parsed as T;
}

// The room's WebSocket, opened with the session's cookie (C102).
export const roomSocket = (url: string): RoomSocket => new WebSocket(url) as unknown as RoomSocket;

// The copy as the room gives it, for a copy the browser does not hold (a first opening, or what the
// browser erased): its files at the room's head, the person, a new copy's id. Media are not taken:
// each comes when something needs it (fetchMedium).
export async function roomSeed({ api, team, project }: RoomAccess): Promise<{ link: CopyLink; confirmed: Files }> {
  const [{ account }, remote] = await Promise.all([
    call<{ account: { id: string; handle: string | null; displayName: string | null } }>(api, 'GET', '/v1/account'),
    call<{ head: number; files: SnapshotFile[] }>(api, 'GET', `/v1/teams/${segment(team)}/projects/${segment(project)}/files`)
  ]);
  const client = `c${[...crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const confirmed = new Map<string, FileContent>();
  // What the room knows of each medium without its bytes (D125): its size, and its facts once a copy gave them.
  const media: MediaMap<KnownMedium> = {};
  for (const file of [...remote.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if ('text' in file) { confirmed.set(file.path, textFile(file.path, file.text)); continue; }
    confirmed.set(file.path, binaryFile(file.blob, file.size));
    const facts = file.facts === undefined ? null : readMediaFacts(file.facts, 'tolerant');
    if (Number.isSafeInteger(file.size)) media[file.blob] = { size: file.size!, ...(facts ? { facts } : {}) };
  }
  return {
    link: { team, project, client, person: { id: account.id, name: account.displayName ?? account.handle }, head: remote.head, epoch: null, waiting: [], journal: 0, media },
    confirmed
  };
}

// The team's media through the API (D88, C103): what a change writes announced, what the team lacks
// sent whole or in parts, the upload committed once the change is placed; a medium read by its hash.
export function roomMedia({ api, team }: RoomAccess): RemoteMedia {
  const uploads = `/v1/teams/${segment(team)}/uploads`;
  return {
    async send(hashes, read) {
      if (!hashes.length) return null;
      const media = await Promise.all(hashes.map(async (hash) => ({ sha256: hex(hash), size: (await read(hash)).byteLength })));
      const upload = await call<{ upload: string; missing: { sha256: string; size: number }[]; limits?: { singlePutMaxBytes?: number } }>(api, 'POST', uploads, { media });
      const at = `${uploads}/${segment(upload.upload)}`;
      const limit = upload.limits?.singlePutMaxBytes ?? 64 * 1024 * 1024;
      for (const blob of upload.missing) {
        const bytes = await read(`sha256:${blob.sha256}`);
        const target = `${at}/blobs/${blob.sha256}`;
        if (bytes.byteLength <= limit) { await call(api, 'PUT', target, bytes); continue; }
        const started = await call<{ present: boolean; multipart?: string; partBytes?: number; parts?: number }>(api, 'POST', `${target}/multipart`);
        if (started.present) continue;
        const multipart = `${target}/multipart/${segment(started.multipart ?? '')}`;
        const parts: { partNumber: number; etag: string }[] = [];
        for (let n = 1; n <= (started.parts ?? 0); n++) {
          const offset = (n - 1) * (started.partBytes ?? 0);
          parts.push(await call<{ partNumber: number; etag: string }>(api, 'PUT', `${multipart}/${n}`, bytes.subarray(offset, offset + (started.partBytes ?? 0))));
        }
        await call(api, 'POST', `${multipart}/complete`, { parts: parts.map(({ partNumber, etag }) => ({ partNumber, etag })) });
      }
      return upload.upload;
    },
    async commit(upload) {
      if (upload) await call(api, 'POST', `${uploads}/${segment(upload)}/commit`);
    },
    async fetchPart(hash, start, end) {
      let response: Response;
      try {
        response = await fetch(`${api}/v1/teams/${segment(team)}/blobs/${hex(hash)}`, { credentials: 'include', mode: 'cors', redirect: 'error', headers: { range: `bytes=${start}-${end}` } });
      } catch (error) {
        throw new RoomError(0, 'E_CLOUD_NETWORK', `The medium ${hex(hash).slice(0, 12)}… could not be read: ${error instanceof Error ? error.message : String(error)}.`);
      }
      if (response.status !== 206 && !response.ok) throw new RoomError(response.status, `http-${response.status}`, `The medium ${hex(hash).slice(0, 12)}… could not be read from the project.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // A server that gives the whole file for a range: its part is cut here.
      return response.status === 206 ? bytes : bytes.subarray(start, end + 1);
    },
    async fetch(hash) {
      let response: Response;
      try {
        response = await fetch(`${api}/v1/teams/${segment(team)}/blobs/${hex(hash)}`, { credentials: 'include', mode: 'cors', redirect: 'error' });
      } catch (error) {
        throw new RoomError(0, 'E_CLOUD_NETWORK', `The medium ${hex(hash).slice(0, 12)}… could not be read: ${error instanceof Error ? error.message : String(error)}.`);
      }
      if (!response.ok) throw new RoomError(response.status, `http-${response.status}`, `The medium ${hex(hash).slice(0, 12)}… could not be read from the project.`);
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}

// Whether the person still reaches the project (D91), asked when the room would not take the connection.
export function roomMembership({ api, team, project }: RoomAccess): () => Promise<'member' | 'removed' | 'deleted' | 'unknown'> {
  return async () => {
    try {
      const { projects } = await call<{ projects: { id: string }[] }>(api, 'GET', `/v1/teams/${segment(team)}/projects`);
      return projects.some((each) => each.id === project) ? 'member' : 'deleted';
    } catch (error) {
      return error instanceof RoomError && error.status === 404 && error.code === 'no-team' ? 'removed' : 'unknown';
    }
  };
}
