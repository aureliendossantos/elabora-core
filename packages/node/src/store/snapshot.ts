import crypto from 'node:crypto';
import { binaryFile, createProjectFiles, isTextPath, textFile } from '@elabora/core/project/files';
import type { FileHash, MediaStatus, ProjectFiles, SourceFile, SyncArtefact } from '@elabora/core/project/files';
import type { FileInfo, Store } from '@elabora/core/project/store';
import { syncArtefact } from '../project-files.ts';
import { FsStore } from './fs-store.ts';
import { isMediaAsset, mediaStatus, probeAssets } from './media.ts';
import type { MediaTools } from '../media/tools.ts';

// A files snapshot read from a Store, asynchronously: text files with their text, binary files with
// their size and hash (from the store's cache when it has one), sync-service artefacts set apart.
// For a folder (FsStore), media files of assets/ carry their probe and verdict, and the snapshot
// says what loadProject needs to know of media (MediaStatus).

export interface StoreSnapshot {
  files: ProjectFiles;
  artefacts: SyncArtefact[]; // reported as W_SYNC_CONFLICT_COPY, never loaded
  stats: Map<string, FileInfo>; // size and time of each file of the snapshot, as listed
  media: MediaStatus;
}

export interface ReadSnapshotOptions {
  concurrency?: number; // files read at once (16 by default)
  media?: boolean; // probe media files (default: for a folder)
  tools?: MediaTools; // ffprobe (found on first use otherwise)
}

export async function readSnapshot(store: Store, options: ReadSnapshotOptions = {}): Promise<StoreSnapshot> {
  const listed = await store.list();
  const paths = new Set(listed.map((info) => info.path));
  const artefacts: SyncArtefact[] = [];
  const content: FileInfo[] = [];
  for (const info of listed) {
    const artefact = syncArtefact(info.path, paths);
    if (artefact) artefacts.push(artefact);
    else content.push(info);
  }
  const read = new Map<string, SourceFile>();
  const stats = new Map<string, FileInfo>();
  await eachLimited(content, options.concurrency ?? 16, async (info) => {
    const file = await readSourceFile(store, info.path, info.size);
    if (!file) return; // deleted while listing
    read.set(info.path, file);
    stats.set(info.path, info);
  });
  const folder = store instanceof FsStore && options.media !== false;
  const probed = folder ? await probeAssets(store.id, [...read.keys()].filter(isMediaAsset), { tools: options.tools }) : { media: new Map(), unreadable: [], toolsMissing: false };
  for (const [rel, media] of probed.media) {
    const file = read.get(rel);
    if (file?.kind === 'binary') read.set(rel, binaryFile(file.size, { ...(file.hash ? { hash: file.hash } : {}), media }));
  }
  // Snapshot entries in path order, as the CLI's reader gives them.
  const files = createProjectFiles(content.filter((info) => read.has(info.path)).map((info) => [info.path, read.get(info.path) as SourceFile] as const));
  const media = folder ? mediaStatus(store.id, probed) : { processing: [], unreadable: [], toolsMissing: false };
  return { files, artefacts, stats, media };
}

// One file of a store as a snapshot entry; null when it does not exist (any more).
export async function readSourceFile(store: Store, rel: string, size?: number): Promise<SourceFile | null> {
  try {
    if (isTextPath(rel)) return textFile(await store.readText(rel));
    const hash = await hashOf(store, rel);
    const known = size ?? (await store.stat?.(rel))?.size ?? (await store.readBytes(rel)).byteLength;
    return binaryFile(known, { hash });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// A store without a hash of its own is read whole: fine for small remote stores, never used for
// folders (FsStore hashes as a stream, with a cache).
async function hashOf(store: Store, rel: string): Promise<FileHash> {
  if (store.hash) return store.hash(rel);
  return `sha256:${crypto.createHash('sha256').update(await store.readBytes(rel)).digest('hex')}`;
}

export async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
