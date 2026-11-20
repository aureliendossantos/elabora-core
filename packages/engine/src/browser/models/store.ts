// The models a browser downloads once (the word aligners, the local voices: D113), in the origin's
// private file system, usable with or without a session: « Éléments téléchargés » lists, installs,
// removes and keeps them from Réglages with no module open, and a session's requests call the same
// functions. Each file is pinned by size and SHA-256 (the core's lists), downloaded from the models'
// origin the host names, resumed where a stopped download left it, hashed as it is written, and moved
// under its name once whole and checked. Two contexts never write the same model at once (Web Locks,
// one a model); a model in use is never removed under it.

import { Sha256 } from '@elabora/core/util/sha256';
import type { ModelFile } from '@elabora/core/util/model-files';

export interface StoredModel {
  readonly id: string;
  readonly version: string;
  readonly files: readonly ModelFile[];
}

export interface ModelProgress { received: number; total: number }

const ROOT = 'elabora-models';
const SLICE = 4 * 1024 * 1024;
const PART = 16 * 1024 * 1024;
const writing = (model: StoredModel) => `elabora-model:${model.id}`;
const using = (model: StoredModel) => `elabora-model-use:${model.id}`;

// A model's files that cannot be fetched, or do not match their pins.
export class ModelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Move = FileSystemFileHandle & { move(folder: FileSystemDirectoryHandle, name: string): Promise<void> };

async function folderOf(model: StoredModel, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create });
    return await root.getDirectoryHandle(`${model.id}@${model.version}`, { create });
  } catch {
    return null;
  }
}

const fileIn = async (folder: FileSystemDirectoryHandle, name: string): Promise<File | null> => {
  try { return await (await folder.getFileHandle(name)).getFile(); } catch { return null; }
};

// Every file there at its size: what a session may use. A file the browser erased reads as missing.
export async function modelInstalled(model: StoredModel): Promise<boolean> {
  const folder = await folderOf(model, false);
  if (!folder) return false;
  for (const file of model.files) if ((await fileIn(folder, file.name))?.size !== file.size) return false;
  return true;
}

// Bytes the model takes here, whole files and parts of a stopped download.
export async function modelBytes(model: StoredModel): Promise<number> {
  const folder = await folderOf(model, false);
  if (!folder) return 0;
  let bytes = 0;
  for (const file of model.files) bytes += ((await fileIn(folder, file.name)) ?? (await fileIn(folder, `${file.name}.part`)))?.size ?? 0;
  return bytes;
}

export const modelSize = (model: StoredModel): number => model.files.reduce((sum, file) => sum + file.size, 0);

// Downloads what is missing from base (the models' origin: https://…, its files at the core's paths).
export async function installModel(model: StoredModel, base: string, { onProgress, signal }: { onProgress?: (progress: ModelProgress) => void; signal?: AbortSignal } = {}): Promise<void> {
  await navigator.locks.request(writing(model), { signal }, async () => {
    const folder = await folderOf(model, true);
    if (!folder) throw new ModelError('E_LOCAL_AI_STORAGE', 'This browser keeps no files for this site (a private window?): the models cannot be downloaded.');
    const total = modelSize(model);
    let done = 0;
    for (const file of model.files) {
      if ((await fileIn(folder, file.name))?.size === file.size) { done += file.size; onProgress?.({ received: done, total }); continue; }
      await downloadFile(folder, file, base, (received) => onProgress?.({ received: done + received, total }), signal);
      done += file.size;
    }
  });
}

async function downloadFile(folder: FileSystemDirectoryHandle, file: ModelFile, base: string, progress: (received: number) => void, signal?: AbortSignal): Promise<void> {
  const partName = `${file.name}.part`;
  const part = await folder.getFileHandle(partName, { create: true });
  let kept = (await part.getFile()).size;
  if (kept > file.size) kept = 0;
  // What a stopped download left is hashed again first, then the rest as it comes.
  const hash = new Sha256();
  const earlier = await part.getFile();
  for (let at = 0; at < kept; at += SLICE) hash.update(new Uint8Array(await earlier.slice(at, Math.min(kept, at + SLICE)).arrayBuffer()));
  const stream = await part.createWritable({ keepExistingData: true });
  try {
    await stream.truncate(kept);
    await stream.seek(kept);
    // In parts of PART bytes, each a range: a part lost is asked again, not the whole file.
    while (kept < file.size) {
      const url = `${base.replace(/\/+$/, '')}/${file.url}`;
      const end = Math.min(file.size, kept + PART) - 1;
      let response: Response;
      try {
        response = await fetch(url, { signal, headers: { range: `bytes=${kept}-${end}` }, credentials: 'omit' });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ModelError('E_MODEL_DOWNLOAD', `${file.name} could not be downloaded: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok || !response.body) throw new ModelError('E_MODEL_DOWNLOAD', `${file.name} could not be downloaded (${response.status}).`);
      // A server that ignores ranges sends the whole file: taken from its start.
      if (response.status !== 206 && kept) { kept = 0; await stream.truncate(0); await stream.seek(0); hash.reset(); }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await stream.write(value);
        kept += value.length;
        progress(kept);
        if (kept > file.size) break;
      }
      if (kept > file.size) break;
    }
    await stream.close();
  } catch (error) {
    await stream.close().catch(() => {});
    throw error;
  }
  if (kept !== file.size || hash.hex() !== file.sha256) {
    await folder.removeEntry(partName).catch(() => {});
    throw new ModelError('E_MODEL_INTEGRITY', `${file.name} is not the file it should be (${kept} bytes for ${file.size}): it was set aside, and will be downloaded again.`);
  }
  await (part as Move).move(folder, file.name);
}

// Runs with the model's files at hand, held in use the while: never removed under it. A file the
// browser erased meanwhile is null.
export async function useModel<T>(model: StoredModel, run: (file: (name: string) => Promise<File | null>) => Promise<T>): Promise<T> {
  return navigator.locks.request(using(model), { mode: 'shared' }, async () => {
    const folder = await folderOf(model, false);
    return run(async (name) => (folder ? fileIn(folder, name) : null));
  });
}

// Removed, unless it is in use (a session aligning or speaking with it) or being downloaded.
export async function removeModel(model: StoredModel): Promise<boolean> {
  return navigator.locks.request(using(model), { ifAvailable: true }, async (held) => {
    if (!held) throw new ModelError('E_MODEL_IN_USE', 'It is in use: it can be removed once the words are placed or the line said.');
    return navigator.locks.request(writing(model), { ifAvailable: true }, async (free) => {
      if (!free) throw new ModelError('E_MODEL_IN_USE', 'It is being downloaded.');
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
      let removed = false;
      for await (const name of (root as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) {
        if (name === model.id || name.startsWith(`${model.id}@`)) { await root.removeEntry(name, { recursive: true }); removed = true; }
      }
      return removed;
    });
  });
}

// What the browser lets this site keep, and whether it keeps it for good (persist).
export async function storageState(): Promise<{ used: number; quota: number; persisted: boolean }> {
  const estimate = await navigator.storage.estimate();
  return { used: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted: await navigator.storage.persisted() };
}

export async function keepStorage(): Promise<boolean> {
  return navigator.storage.persist();
}
