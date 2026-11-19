import type { FileContent, Files, JournalEntry } from '@elabora/core/ops/types';
import type { CopyLink } from '@elabora/core/sync/copy';
import { madeFacts, sha256 } from './store.ts';
import type { BrowserStore } from './store.ts';

// A browser's copy kept for good (D103, D104): in IndexedDB its link, the files the room confirmed and
// its journal, one database a copy; in the origin's private file system (OPFS) the team's media by their
// hash, each taken when something needs it (medium). What it holds is read whole before the session opens (D100: the copy reads what was confirmed
// once, as it starts); an entry of the journal is written before anything shows it; the copy's state
// is saved in the order the copy saves it (IndexedDB runs transactions on the same stores in order).

// What reaches the team's media: the hosting's API, by the room's connection (absent offline).
export interface RemoteMedia {
  send(hashes: readonly string[], read: (hash: string) => Promise<Uint8Array>): Promise<string | null>;
  commit(upload: string | null): Promise<void>;
  fetch(hash: string): Promise<Uint8Array>;
}

// Media the host holds by hash (the examples the app ships, D103): a Blob, or null when it has none.
export type MediaSource = (hash: string) => Promise<Blob | null>;

export interface IdbCopy extends BrowserStore {
  readMedium(hash: string): Promise<Uint8Array | null>;
  putMedium(bytes: Uint8Array): Promise<string>;
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
    readMedium: (hash) => media.read(hash),
    putMedium: (bytes) => media.put(bytes),
    async keep(bytes, made) {
      const hash = await media.put(bytes);
      if (made) facts.set(hash, made);
      sizes.set(hash, bytes.byteLength);
      return hash;
    },
    // Facts of the media this copy made since it opened; the room keeps them once given (D126).
    mediaFacts: async (refs) => facts.get(refs, (hash) => sizes.get(hash) ?? null),
    async sendMedia(hashes) {
      if (!remote) throw new Error('The project\'s media cannot be sent: not connected.');
      return remote.send(hashes, async (hash) => {
        const bytes = await media.read(hash);
        if (!bytes) throw new Error(`The medium ${hash.slice(7, 19)}… is not kept in this browser.`);
        return bytes;
      });
    },
    commitMedia: async (upload) => { await remote?.commit(upload); },
    // A copy in a browser takes a medium when something needs it (medium), not as a change brings it.
    async fetchMedium() {},
    // Kept in the origin's private file system, else the host's (source), else the team's; what is
    // taken is checked against its hash, then kept.
    async medium(hash) {
      const kept = await media.read(hash);
      if (kept) return kept;
      const given = await source?.(hash);
      const bytes = given ? new Uint8Array(await given.arrayBuffer()) : remote ? await remote.fetch(hash) : null;
      if (!bytes) return null;
      if (await sha256(bytes) !== hash) throw new Error(`The medium ${hash.slice(7, 19)}… does not match its hash.`);
      await media.put(bytes);
      return bytes;
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

// The media of a copy, one file a hash, in OPFS. Writes of the same hash wait for one another.
async function mediaFolder(key: string) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(`${DB_PREFIX}${key}`, { create: true });
  const writing = new Map<string, Promise<void>>();
  const name = (hash: string) => hash.replace(/^sha256:/, '');
  return {
    async read(hash: string): Promise<Uint8Array | null> {
      await writing.get(hash);
      try {
        const file = await (await dir.getFileHandle(name(hash))).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch { return null; }
    },
    async put(bytes: Uint8Array): Promise<string> {
      const hash = await sha256(bytes);
      const before = writing.get(hash) ?? Promise.resolve();
      const write = before.then(async () => {
        if (await dir.getFileHandle(name(hash)).then(() => true, () => false)) return;
        // Written under a temporary name, then moved: a file under its hash is whole.
        const temporary = await dir.getFileHandle(`${name(hash)}.part`, { create: true });
        const stream = await temporary.createWritable();
        await stream.write(bytes as Uint8Array<ArrayBuffer>);
        await stream.close();
        await (temporary as FileSystemFileHandle & { move(name: string): Promise<void> }).move(name(hash));
      });
      writing.set(hash, write);
      try { await write; } finally { if (writing.get(hash) === write) writing.delete(hash); }
      return hash;
    }
  };
}
