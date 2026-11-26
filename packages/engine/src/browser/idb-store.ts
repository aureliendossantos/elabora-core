import type { FileContent, Files, JournalEntry } from '@elabora/core/ops/types';
import type { CopyLink } from '@elabora/core/sync/copy';
import { sha256OfBlob } from '@elabora/core/util/sha256';
import { madeFacts, sha256 } from './store.ts';
import type { BrowserStore } from './store.ts';

// A browser's copy kept for good (D103, D104): in IndexedDB its link, the files the room confirmed and
// its journal, one database a copy; in the origin's private file system (OPFS) the team's media by their
// hash, each taken when something needs it (medium). What it holds is read whole before the session opens (D100: the copy reads what was confirmed
// once, as it starts); an entry of the journal is written before anything shows it; the copy's state
// is saved in the order the copy saves it (IndexedDB runs transactions on the same stores in order).

// What reaches the team's media: the hosting's API, by the room's connection (absent offline).
export interface RemoteMedia {
  send(hashes: readonly string[], read: (hash: string) => Promise<Blob>): Promise<string | null>;
  commit(upload: string | null): Promise<void>;
  fetch(hash: string): Promise<Uint8Array>;
  // Bytes start to end (included) of a medium, by range (C103).
  fetchPart?(hash: string, start: number, end: number): Promise<Uint8Array>;
}

// Media the host holds by hash (the examples the app ships, D103): a Blob, or null when it has none.
export type MediaSource = (hash: string) => Promise<Blob | null>;

export interface IdbCopy extends BrowserStore {
  close(): void;
}

const DB_PREFIX = 'elabora-copy-';
const STORES = ['meta', 'confirmed', 'journal'] as const;

const done = (request: IDBRequest | IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  if ('oncomplete' in request) {
    request.oncomplete = () => resolve();
    request.onabort = request.onerror = () => reject(request.error ?? new Error('The browser\'s storage refused the write.'));
  } else {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }
});
const result = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// Opens the copy kept under key; seed: the copy as the room gives it, kept when there is none yet.
// Null: nothing kept, and no seed.
export async function openIdbCopy(key: string, { seed, remote, source, membership, onError }: { seed?: { link: CopyLink; confirmed: Files }; remote?: RemoteMedia; source?: MediaSource; membership?: () => Promise<'member' | 'removed' | 'deleted' | 'unknown'>; onError?: (error: unknown) => void } = {}): Promise<IdbCopy | null> {
  const open = indexedDB.open(DB_PREFIX + key, 1);
  open.onupgradeneeded = () => { for (const store of STORES) open.result.createObjectStore(store); };
  const db = await result(open);
  let link = await result(db.transaction('meta').objectStore('meta').get('link')) as CopyLink | undefined;
  if (!link) {
    if (!seed) { db.close(); return null; }
    const tx = db.transaction(['meta', 'confirmed'], 'readwrite');
    tx.objectStore('meta').put(seed.link, 'link');
    for (const [rel, file] of seed.confirmed) tx.objectStore('confirmed').put(file, rel);
    await done(tx);
    link = structuredClone(seed.link);
  }
  const confirmedTx = db.transaction(['confirmed', 'journal']);
  const [paths, files, entries] = await Promise.all([
    result(confirmedTx.objectStore('confirmed').getAllKeys()), result(confirmedTx.objectStore('confirmed').getAll()), result(confirmedTx.objectStore('journal').getAll())
  ]);
  let confirmed: Files = new Map(paths.map((rel, i) => [String(rel), files[i] as FileContent]));
  const journal = (entries as JournalEntry[]).sort((a, b) => a.seq - b.seq);
  const failed = (error: unknown) => (onError ?? ((reason) => { throw reason; }))(error);
  const media = await mediaFolder(key);
  const facts = madeFacts();
  const sizes = new Map<string, number>();

  const copy: IdbCopy = {
    link,
    confirmed: () => confirmed,
    save(copyLink, now, changed) {
      const tx = db.transaction(['meta', 'confirmed'], 'readwrite');
      tx.objectStore('meta').put(structuredClone({ ...copy.link, ...copyLink }), 'link');
      for (const [rel, file] of changed) tx.objectStore('confirmed').put(file, rel);
      for (const rel of confirmed.keys()) if (!now.has(rel)) tx.objectStore('confirmed').delete(rel);
      confirmed = now;
      done(tx).catch(failed);
    },
    unlink() {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').delete('link');
      done(tx).catch(failed);
    },
    journal: () => journal,
    async append(added) {
      const tx = db.transaction('journal', 'readwrite');
      for (const entry of added) tx.objectStore('journal').put(entry, entry.seq);
      await done(tx);
      journal.push(...added);
    },
    async keep(data, made) {
      const hash = await media.put(data);
      if (made) facts.set(hash, made);
      sizes.set(hash, data instanceof Blob ? data.size : data.byteLength);
      return hash;
    },
    // Facts of the media this copy made since it opened; the room keeps them once given (D126).
    mediaFacts: async (refs) => facts.get(refs, (hash) => sizes.get(hash) ?? null),
    async sendMedia(hashes) {
      if (!remote) throw new Error('The project\'s media cannot be sent: not connected.');
      // Kept here, else the host's (a module made from a template its host ships, D124), taken and kept.
      return remote.send(hashes, async (hash) => {
        const file = await media.file(hash) ?? (source ? await copy.medium(hash) : null);
        if (!file) throw new Error(`The medium ${hash.slice(7, 19)}… is not kept in this browser.`);
        return file;
      });
    },
    commitMedia: async (upload) => { await remote?.commit(upload); },
    // A copy in a browser takes a medium when something needs it (medium), not as a change brings it.
    async fetchMedium() {},
    // A part of a medium: a slice of the kept file, else of the host's, else the team's range. A part is
    // not checked against the hash of the whole, nor kept: the whole is, when something takes it.
    async mediumPart(hash, start, end) {
      const kept = await media.file(hash) ?? await source?.(hash) ?? null;
      if (kept) return kept.slice(start, end + 1);
      if (!remote?.fetchPart) return null;
      return new Blob([await remote.fetchPart(hash, start, end) as Uint8Array<ArrayBuffer>]);
    },
    // Kept in the origin's private file system, else the host's (source), else the team's; what is
    // taken is checked against its hash as it is written, then kept.
    async medium(hash) {
      const kept = await media.file(hash);
      if (kept) return kept;
      const given = await source?.(hash) ?? (remote ? new Blob([await remote.fetch(hash) as Uint8Array<ArrayBuffer>]) : null);
      if (!given) return null;
      try {
        await media.put(given, hash);
        const written = await media.file(hash);
        if (written) return written;
      } catch (error) {
        if (error instanceof Error && /does not match its hash/.test(error.message)) throw error;
        // A browser that cannot keep it still gives it now, checked, and says why.
        onError?.(error);
      }
      if (`sha256:${await sha256OfBlob(given)}` !== hash) throw new Error(`The medium ${hash.slice(7, 19)}… does not match its hash.`);
      return given;
    },
    membership: membership ?? (async () => 'unknown'),
    close: () => db.close()
  };
  return copy;
}

// Removes what a copy kept (its database and its media).
export async function forgetIdbCopy(key: string): Promise<void> {
  await done(indexedDB.deleteDatabase(DB_PREFIX + key));
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(`${DB_PREFIX}${key}`, { recursive: true }).catch(() => {});
}

export { sha256 };

// The media of a copy, one file a hash, in OPFS. A medium is written as it is read, slice by slice,
// its hash computed on the way (the core's Sha256): never held whole, whatever its size. Writes of
// the same hash wait for one another.
const SLICE = 4 * 1024 * 1024;
let parts = 0;

async function mediaFolder(key: string) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(`${DB_PREFIX}${key}`, { create: true });
  const writing = new Map<string, Promise<unknown>>();
  const name = (hash: string) => hash.replace(/^sha256:/, '');
  const exists = (hash: string) => dir.getFileHandle(name(hash)).then(() => true, () => false);
  return {
    // A write that failed leaves nothing under the hash: read as not kept.
    async file(hash: string): Promise<File | null> {
      await writing.get(hash)?.catch(() => {});
      try { return await (await dir.getFileHandle(name(hash))).getFile(); } catch { return null; }
    },
    // Writes a medium under its hash; expected: the hash it must have (refused, and nothing kept, if not).
    async put(data: Blob | Uint8Array, expected?: string): Promise<string> {
      const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>]);
      const before = (expected && writing.get(expected)) || Promise.resolve();
      const write = before.catch(() => {}).then(async () => {
        if (expected && await exists(expected)) return expected;
        // Written under a temporary name, then moved: a file under its hash is whole.
        const partName = `part-${Date.now().toString(36)}-${++parts}`;
        const temporary = await dir.getFileHandle(partName, { create: true });
        const stream = await temporary.createWritable();
        let hash: string;
        try {
          hash = `sha256:${await sha256OfBlob(blob, SLICE, (bytes) => stream.write(bytes as Uint8Array<ArrayBuffer>))}`;
          await stream.close();
        } catch (error) {
          await stream.abort().catch(() => {});
          await dir.removeEntry(partName).catch(() => {});
          throw error;
        }
        if ((expected && hash !== expected) || await exists(hash)) {
          await dir.removeEntry(partName).catch(() => {});
          if (expected && hash !== expected) throw new Error(`The medium ${expected.slice(7, 19)}… does not match its hash.`);
          return hash;
        }
        // move(folder, name): WebKit takes no other form (Chromium and Firefox take this one too).
        await (temporary as FileSystemFileHandle & { move(folder: FileSystemDirectoryHandle, name: string): Promise<void> }).move(dir, name(hash));
        return hash;
      });
      if (expected) writing.set(expected, write);
      try { return await write; } finally { if (expected && writing.get(expected) === write) writing.delete(expected); }
    }
  };
}
