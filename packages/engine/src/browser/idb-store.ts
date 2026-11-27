import type { FileContent, Files, JournalEntry } from '@elabora/core/ops/types';
import type { CopyLink } from '@elabora/core/sync/copy';
import { sha256OfBlob } from '@elabora/core/util/sha256';
import { madeFacts, sha256 } from './store.ts';
import type { BrowserStore } from './store.ts';

// A browser's copy kept for good (D103, D104): in IndexedDB its link, the files the room confirmed and
// its journal, one database a copy; in the origin's private file system (OPFS) the team's media by their
// hash, each taken when something needs it (medium), or in IndexedDB where the origin has no such file
// system (a private window of Safari). What it holds is read whole before the session opens (D100: the copy reads what was confirmed
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
const MEDIA_PREFIX = 'elabora-copy-media-';
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
// Null: nothing kept, and no seed. erased: what ends the copy's use when another page or Worker of the
// origin erases it (forgetCopies, as the person signs out); its database is let go once that ends, a
// few seconds at most, so that the erasing goes on.
export async function openIdbCopy(key: string, { seed, remote, source, membership, onError, erased }: { seed?: { link: CopyLink; confirmed: Files }; remote?: RemoteMedia; source?: MediaSource; membership?: () => Promise<'member' | 'removed' | 'deleted' | 'unknown'>; onError?: (error: unknown) => void; erased?: () => Promise<unknown> } = {}): Promise<IdbCopy | null> {
  const open = indexedDB.open(DB_PREFIX + key, 1);
  open.onupgradeneeded = () => { for (const store of STORES) open.result.createObjectStore(store); };
  const db = await result(open);
  let ending: Promise<void> | null = null;
  db.onversionchange = () => {
    ending ??= Promise.race([Promise.resolve().then(() => erased?.()), new Promise((resolve) => setTimeout(resolve, ERASED_WAIT_MS))]).catch(() => {}).then(() => { db.close(); });
  };
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
  const media = await keptMedia(key);
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
    // Kept here, else the host's (source), else the team's; what is
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
    close: () => { db.close(); media.close(); }
  };
  return copy;
}

// How long a copy in use is given to end when it is erased, before its database is let go all the same.
const ERASED_WAIT_MS = 3_000;
// How long an erasing waits for a database another page holds, before it says it was not erased.
const BLOCKED_WAIT_MS = 8_000;
// What the copies' work leaves in the private file system, erased with them: the takes of every copy
// (voices/takes.ts), the person's own recordings, and the media Worker's jobs (media/worker.ts).
const WORK = new Set(['elabora-takes', 'media-work']);

// Removes what a copy kept (its database and its media, wherever they are).
export async function forgetIdbCopy(key: string): Promise<void> {
  await done(indexedDB.deleteDatabase(DB_PREFIX + key));
  await done(indexedDB.deleteDatabase(MEDIA_PREFIX + key));
  const root = await navigator.storage.getDirectory().catch(() => null);
  await root?.removeEntry(`${DB_PREFIX}${key}`, { recursive: true }).catch(() => {});
}

// A copy this browser keeps, as read without opening it: its team and project, the account it was made
// for (« local » for an example kept on this device), and its changes the room has not placed yet (those
// waiting in its link, and those its journal holds that the link has not taken in yet). account and
// unsent are null for a copy whose link is gone (one the room unlinked: a project left or deleted).
export interface KeptCopy { key: string; team: string; project: string; account: string | null; unsent: number | null }

const names = async (dir: FileSystemDirectoryHandle): Promise<string[]> => {
  const out: string[] = [];
  for await (const name of (dir as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) out.push(name);
  return out;
};
const databases = async (): Promise<string[]> => {
  const listed = await (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases?.() ?? null;
  if (!listed) throw new Error('This browser does not list what it keeps: its copies cannot be read nor erased one by one.');
  return listed.map((each) => each.name ?? '').filter((name) => name.startsWith(DB_PREFIX));
};

// The copies this browser keeps (the window asks it before a sign-out: what would be lost).
export async function keptCopies(): Promise<KeptCopy[]> {
  const kept: KeptCopy[] = [];
  for (const name of (await databases()).filter((each) => !each.startsWith(MEDIA_PREFIX)).sort()) {
    const key = name.slice(DB_PREFIX.length);
    const db = await result(indexedDB.open(name));
    // An erasing meanwhile (forgetCopies) never waits for this reading.
    db.onversionchange = () => db.close();
    try {
      if (!STORES.every((store) => db.objectStoreNames.contains(store))) continue;
      const tx = db.transaction(['meta', 'confirmed', 'journal']);
      const [link, entries, files] = await Promise.all([result(tx.objectStore('meta').get('link')) as Promise<CopyLink | undefined>, result(tx.objectStore('journal').getAll()) as Promise<JournalEntry[]>, result(tx.objectStore('confirmed').count())]);
      // An empty database (an opening that found nothing kept, offline): no copy.
      if (!link && !files && !entries.length) continue;
      const [team = key, project = ''] = link ? [link.team, link.project] : key.split(/\.(.*)/s);
      kept.push({ key, team, project, account: link?.person.id ?? null, unsent: link ? link.waiting.length + entries.filter((entry) => entry.type !== 'mark' && entry.seq > link.journal).length : null });
    } finally {
      db.close();
    }
  }
  return kept;
}

// Erases every copy this browser keeps, of every team and account: their databases, their media, the
// takes recorded in them and the media jobs (the local models, which are no one's, stay). A copy open in another tab
// or Worker ends first (openIdbCopy's erased). What could not be erased (a database another page still
// holds after a few seconds, a file being written) is named in failed; the rest is gone.
export async function forgetCopies(): Promise<{ erased: string[]; failed: { name: string; message: string }[] }> {
  const erased: string[] = [];
  const failed: { name: string; message: string }[] = [];
  const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
  // All at once: a database another page still holds waits for it to let go (its erasing goes on past
  // the wait, once it does), and the whole waits BLOCKED_WAIT_MS at most.
  await Promise.all((await databases()).map(async (name) => {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        const timer = setTimeout(() => reject(new Error('Another page of this site still holds it.')), BLOCKED_WAIT_MS);
        request.onsuccess = () => { clearTimeout(timer); resolve(); };
        request.onerror = () => { clearTimeout(timer); reject(request.error ?? new Error('The browser\'s storage refused to erase it.')); };
      });
      erased.push(name);
    } catch (error) {
      failed.push({ name, message: said(error) });
    }
  }));
  const root = await navigator.storage.getDirectory().catch(() => null);
  if (root) {
    for (const name of (await names(root)).filter((each) => each.startsWith(DB_PREFIX) || WORK.has(each))) {
      try {
        await root.removeEntry(name, { recursive: true });
        erased.push(name);
      } catch (error) {
        failed.push({ name, message: said(error) });
      }
    }
  }
  return { erased, failed };
}

export { sha256 };

// The media of a copy by hash: in the origin's private file system, else in IndexedDB. Safari's private
// windows have no private file system (getDirectory() throws an UnknownError) and an IndexedDB that
// lasts as long as the window. Either way, writes of the same hash wait for one another, and a medium
// is checked against its hash before it is kept.
const SLICE = 4 * 1024 * 1024;
let parts = 0;

interface KeptMedia {
  close(): void;
  // A write that failed leaves nothing under the hash: read as not kept.
  file(hash: string): Promise<File | null>;
  // Writes a medium under its hash; expected: the hash it must have (refused, and nothing kept, if not).
  put(data: Blob | Uint8Array, expected?: string): Promise<string>;
}

async function keptMedia(key: string): Promise<KeptMedia> {
  const root = await navigator.storage.getDirectory().catch(() => null);
  return root ? mediaFolder(root, key) : mediaDatabase(key);
}

// Writes of the same hash one after the other; what write does once the one before it has ended.
function inTurn(): (expected: string | undefined, write: () => Promise<string>) => Promise<string> {
  const writing = new Map<string, Promise<unknown>>();
  return async (expected, run) => {
    const before = (expected && writing.get(expected)) || Promise.resolve();
    const write = before.catch(() => {}).then(run);
    if (expected) writing.set(expected, write);
    try { return await write; } finally { if (expected && writing.get(expected) === write) writing.delete(expected); }
  };
}

const mismatch = (expected: string) => new Error(`The medium ${expected.slice(7, 19)}… does not match its hash.`);

// One file a hash, in OPFS. A medium is written as it is read, slice by slice, its hash computed on the
// way (the core's Sha256): never held whole, whatever its size.
async function mediaFolder(root: FileSystemDirectoryHandle, key: string): Promise<KeptMedia> {
  const dir = await root.getDirectoryHandle(`${DB_PREFIX}${key}`, { create: true });
  const turn = inTurn();
  const name = (hash: string) => hash.replace(/^sha256:/, '');
  const exists = (hash: string) => dir.getFileHandle(name(hash)).then(() => true, () => false);
  return {
    close() {},
    async file(hash) {
      await turn(hash, async () => hash).catch(() => {});
      try { return await (await dir.getFileHandle(name(hash))).getFile(); } catch { return null; }
    },
    put(data, expected) {
      const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>]);
      return turn(expected, async () => {
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
          if (expected && hash !== expected) throw mismatch(expected);
          return hash;
        }
        // move(folder, name): WebKit takes no other form (Chromium and Firefox take this one too).
        await (temporary as FileSystemFileHandle & { move(folder: FileSystemDirectoryHandle, name: string): Promise<void> }).move(dir, name(hash));
        return hash;
      });
    }
  };
}

// A Blob a hash, in a database of its own. Its hash is read slice by slice before it is kept.
async function mediaDatabase(key: string): Promise<KeptMedia> {
  const open = indexedDB.open(MEDIA_PREFIX + key, 1);
  open.onupgradeneeded = () => { open.result.createObjectStore('media'); };
  const db = await result(open);
  // Let go as soon as another page erases it (forgetCopies): what it held is gone with it.
  db.onversionchange = () => db.close();
  const turn = inTurn();
  // A Blob, or its bytes where the browser refuses to keep a Blob (a private window of WebKit: « Error
  // preparing Blob/File data to be stored in object store »).
  const get = async (hash: string): Promise<Blob | undefined> => {
    const kept = await result(db.transaction('media').objectStore('media').get(hash)) as Blob | ArrayBuffer | undefined;
    return kept instanceof ArrayBuffer ? new Blob([kept]) : kept;
  };
  const keep = async (value: Blob | ArrayBuffer, hash: string) => {
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').put(value, hash);
    await done(tx);
  };
  return {
    close: () => db.close(),
    async file(hash) {
      await turn(hash, async () => hash).catch(() => {});
      const blob = await get(hash);
      return blob ? new File([blob], hash.replace(/^sha256:/, '')) : null;
    },
    put(data, expected) {
      const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>]);
      return turn(expected, async () => {
        if (expected && await get(expected)) return expected;
        const hash = `sha256:${await sha256OfBlob(blob, SLICE)}`;
        if (expected && hash !== expected) throw mismatch(expected);
        if (!(await get(hash))) await keep(blob, hash).catch(async () => keep(await blob.arrayBuffer(), hash));
        return hash;
      });
    }
  };
}
