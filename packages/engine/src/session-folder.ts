import fs from 'node:fs';
import path from 'node:path';
import type { Author, ChangeLike, JournalEntry } from '@elabora/core/ops/types';
import { diffFiles } from '@elabora/core/ops/diff';
import { applyOps, invertOps } from '@elabora/core/ops/apply';
import { externalEdit, recentVersions } from '@elabora/core/sync/external';
import { isJsonPath, sameContent } from '@elabora/core/ops/json';
import type { ProjectFiles, SourceFile } from '@elabora/core/project/files';
import type { FileInfo } from '@elabora/core/project/store';
import { parseJSON } from '@elabora/core/util/json';
import { keepOriginalTexts } from '@elabora/node/edit/disk';
import { withProjectLock } from '@elabora/node/journal/lock';
import { JournalError, appendChange, changeFileHashes, lastChanges, storeChangeBlobs, storeChangeBlobsSync } from '@elabora/node/journal/journal';
import { writeFileAtomic } from '@elabora/node/util/fs';
import { syncArtefact } from '@elabora/node/project-files';
import { hasBlob } from '@elabora/node/blobs';
import type { BlobHash } from '@elabora/node/blobs';
import type { ProjectState } from './base/project-state.ts';
import type { ChangesHost, NewContents, SessionChanges } from './base/changes.ts';
import type { JournalTail } from './journal-tail.ts';
import type { SessionMonitor } from './session-monitor.ts';
import { readDisk, readDiskSync, hashOf, toSourceFile, withUpdates, tryApply, pathsInside } from './disk.ts';
import type { DiskRead, SessionStore } from './disk.ts';
import type { ChangeSource, ExternalNotes } from './protocol.ts';

// Where the desktop's changes come from and go (SessionChanges, base/changes.ts): the project's
// folder. A write runs under the project's lock, after the journal's new entries (other processes':
// the CLI, the MCP server) and the files that changed on disk without one (programs other than
// Elabora's tools, journaled as one external change, computed as in D75) are taken in; what the
// watchers report is taken in between writes.

// A binary file written this recently is still being written (copied, downloaded).
const SETTLE_MS = 400;
const MAX_SETTLE_MS = 2000;
const EXTERNAL: Author = { kind: 'external' };
// How many recent changes give the versions an external edit may have been read from (D75).
const RECENT_VERSIONS = 64;

export const fileOf = (disk: DiskRead): SourceFile | null => (disk.kind === 'file' ? disk.file : null);

export interface FolderHost extends ChangesHost {
  // A file a media job will write or replace: the job's to journal.
  owns(rel: string): boolean;
  // The folder was listed again.
  rescanned(): void;
}

export interface FolderInit {
  root: string;
  store: SessionStore;
  state: ProjectState;
  tail: JournalTail;
  monitor: SessionMonitor;
  stats: Map<string, FileInfo>; // size and time of each file when last read, for rescans
  lockTimeoutMs: number | undefined;
  host: FolderHost;
}

export class FolderChanges implements SessionChanges {
  readonly #root: string;
  readonly #store: SessionStore;
  readonly #state: ProjectState;
  readonly #tail: JournalTail;
  readonly #monitor: SessionMonitor;
  readonly #stats: Map<string, FileInfo>;
  readonly #lockTimeoutMs: number | undefined;
  readonly #host: FolderHost;
  readonly #externalNotes = new Map<string, ExternalNotes>(); // D75, by change id
  readonly #sources = new Map<number, ChangeSource>(); // journal entries the session appended, by sequence number
  #gone = false;
  #settlingSince: number | null = null;

  constructor(init: FolderInit) {
    this.#root = init.root;
    this.#store = init.store;
    this.#state = init.state;
    this.#tail = init.tail;
    this.#monitor = init.monitor;
    this.#stats = init.stats;
    this.#lockTimeoutMs = init.lockTimeoutMs;
    this.#host = init.host;
  }

  get lastSeq(): number { return this.#tail.lastSeq; }

  // Under the lock, after the folder's changes are taken in; what the work appended is taken in after it.
  write<T>(work: () => Promise<T>): Promise<T> {
    return this.locked(async () => {
      await this.sync();
      try {
        return await work();
      } finally {
        await this.takeNew();
      }
    });
  }

  // A journal entry the session appended itself (an edit of @elabora/node, a mark): told as the engine's.
  own(seq: number, source: ChangeSource): void {
    this.#sources.set(seq, source);
  }

  // Whether the journal has entries the session has not taken in.
  hasNew(): Promise<boolean> {
    return this.#tail.hasNew();
  }

  // The journal read again from its start (after pruning, under the lock).
  async reread(): Promise<JournalEntry[]> {
    this.#tail.reset();
    return this.#tail.read();
  }

  locked<T>(work: () => Promise<T>): Promise<T> {
    return withProjectLock(this.#root, work, { timeoutMs: this.#lockTimeoutMs });
  }

  // Under the lock: the journal's new entries first (other processes' changes), then the files
  // that changed on disk without a journal entry.
  async sync(): Promise<void> {
    const entries = await this.#tail.read();
    if (entries.length) await this.#absorb(entries);
    if (this.#monitor.needsRescan) await this.#rescan();
    await this.#reconcileDirty();
  }

  // Entries the session appended are recorded; the others are applied to the snapshot. Then the
  // session takes them all in, in order.
  async #absorb(entries: JournalEntry[]): Promise<void> {
    const foreign = entries.filter((entry) => !this.#sources.has(entry.seq));
    if (foreign.length) await this.#applyForeign(foreign);
    this.#host.taken(entries, (entry) => this.#sources.get(entry.seq) ?? 'journal');
    for (const entry of entries) this.#sources.delete(entry.seq);
  }

  // Reads the journal's new entries: what the session itself just appended, and other processes'.
  async takeNew(): Promise<void> {
    const entries = await this.#tail.read();
    if (entries.length) await this.#absorb(entries);
  }

  // Changes of other processes: each touched file is read back when it holds what the journal says
  // it holds after them (its exact text). A file written again since (by a program that is not a
  // Elabora tool) gets the journal's version, and the difference is reconciled as an external change.
  async #applyForeign(entries: JournalEntry[]): Promise<void> {
    const changes = entries.filter((entry): entry is ChangeLike => entry.type !== 'mark');
    const expected = new Map<string, string | null>();
    for (const change of changes) for (const file of change.files) expected.set(file.path, file.after);
    const updates = new Map<string, SourceFile | null>();
    let applied: ReturnType<typeof tryApply> | undefined;
    for (const [rel, hash] of expected) {
      const disk = await this.readDisk(rel);
      if (disk.kind !== 'unstable' && hashOf(fileOf(disk)) === hash) {
        updates.set(rel, fileOf(disk));
        continue;
      }
      applied ??= tryApply(this.#state.files, changes.flatMap((change) => change.ops));
      // When the operations do not apply, the snapshot was behind the journal: the disk is taken as it is.
      updates.set(rel, applied ? toSourceFile(this.#root, rel, applied.get(rel)) : fileOf(disk));
      this.#monitor.observe(rel);
    }
    this.#state.update(updates);
    for (const [rel, file] of updates) if (file) this.#state.setBroken(rel, null);
  }

  // Under the lock: files that changed on disk and that no journal entry explains, journaled as one
  // external change. A JSON file that does not parse is left as the snapshot has it (reported).
  async #reconcileDirty(): Promise<void> {
    const paths = this.#monitor.takePending((rel) => this.#host.owns(rel));
    if (!paths.length) return;
    // Read everything first: a folder removed brings its files, and while a binary file is still
    // being written the whole burst waits for it (an agent copying a video and editing the screen
    // that shows it makes one change), up to MAX_SETTLE_MS.
    const reads = new Map<string, DiskRead>();
    for (let index = 0; index < paths.length; index++) {
      const rel = paths[index];
      const disk = await this.readDisk(rel, true);
      reads.set(rel, disk);
      // A folder reported (removed, or on Windows any folder whose files change) brings its files,
      // except those a media job will write or replace: they are the job's to journal.
      if (disk.kind === 'missing' && !this.#state.files.has(rel)) {
        for (const child of pathsInside(this.#state.files, rel)) if (!paths.includes(child) && !this.#host.owns(child)) paths.push(child);
      }
    }
    const settling = [...reads.values()].some((disk) => disk.kind === 'unstable');
    if (settling && Date.now() - (this.#settlingSince ??= Date.now()) < MAX_SETTLE_MS) {
      for (const rel of paths) this.#monitor.observe(rel);
      this.#monitor.scheduleRetry();
      return;
    }
    this.#settlingSince = null;
    const updates = new Map<string, SourceFile | null>();
    let artefacts = [...this.#state.artefacts];
    const known = new Set(this.#state.files.keys());
    for (const [rel, disk] of reads) {
      if (disk.kind === 'unstable') {
        this.#monitor.observe(rel);
        continue;
      }
      const current = this.#state.files.get(rel);
      if (disk.kind === 'missing') {
        artefacts = artefacts.filter((artefact) => artefact.path !== rel);
        this.#state.setBroken(rel, null);
        if (current) updates.set(rel, null);
        // A new folder: its files are listed.
        else if (!pathsInside(this.#state.files, rel).length) this.#monitor.requestRescan();
        continue;
      }
      if (!current) {
        const artefact = syncArtefact(rel, new Set([...known, rel]));
        if (artefact) {
          if (!artefacts.some((existing) => existing.path === rel)) artefacts.push(artefact);
          continue;
        }
      }
      if (sameContent(current, disk.file)) {
        this.#state.setBroken(rel, null);
        continue;
      }
      if (isJsonPath(rel) && disk.file.kind === 'text') {
        const parsed = parseJSON(disk.file.text);
        if (parsed.error !== undefined) {
          // Being written (or broken): the last valid content stays; a new file waits outside the
          // snapshot until it parses (its creation is then one change). A file broken since the
          // session opened has no valid content to keep: its new text is taken without a journal entry.
          if (current && !(current.kind === 'text' && parseJSON(current.text).error === undefined)) this.#state.update([[rel, disk.file]]);
          else this.#state.setBroken(rel, parsed.error);
          continue;
        }
      }
      this.#state.setBroken(rel, null);
      updates.set(rel, disk.file);
    }
    this.#state.setArtefacts(artefacts);
    if (this.#monitor.pending().some((rel) => !this.#host.owns(rel))) this.#monitor.scheduleRetry();
    if (!updates.size) return;
    try {
      await this.journal({ updates, author: EXTERNAL, source: 'watcher' });
    } catch (error) {
      // A file changed again while its content was stored: everything is read again shortly.
      if (!(error instanceof JournalError)) throw error;
      for (const rel of updates.keys()) this.#monitor.observe(rel);
      this.#monitor.scheduleRetry();
      return;
    }
    await this.takeNew();
  }

  // The same for the files an edit finds changed on disk while it runs (synchronously, from inside
  // the edit): journaled as an external change before the edit is computed again.
  reconcileSync(paths: readonly string[]): void {
    const updates = new Map<string, SourceFile | null>();
    for (const rel of paths) {
      const disk = readDiskSync(this.#root, rel);
      if (disk.kind === 'unstable') continue;
      const file = fileOf(disk);
      const current = this.#state.files.get(rel);
      if (file === null ? current === undefined : sameContent(current, file)) continue;
      // Mid-write: the edit tries again, and fails with E_CONFLICT if the file stays broken.
      if (file?.kind === 'text' && isJsonPath(rel) && parseJSON(file.text).error !== undefined) continue;
      updates.set(rel, file);
      if (disk.kind === 'file') this.#stats.set(rel, disk.info);
    }
    if (!updates.size) return;
    const { before, after, ops, inverse, unavailable, merged, settled, notes } = this.#prepareChange(updates, true);
    if (ops.length) {
      storeChangeBlobsSync(this.#root, { ops, inverse, unavailable });
      keepOriginalTexts(this.#root, before, ops);
      const entry = appendChange(this.#root, { author: EXTERNAL, ops, inverse, files: changeFileHashes(before, after, ops), unavailable });
      this.#sources.set(entry.seq, 'watcher');
      this.#noteExternal(entry.id, notes);
    }
    for (const rel of merged) this.#writeMergedSync(rel, after.get(rel));
    this.#state.update(settled);
    for (const rel of updates.keys()) this.#state.setBroken(rel, null);
  }

  // A file whose external edit was merged with what was written meanwhile (D75): the disk gets the
  // merged content, the session's own write.
  #writeMergedSync(rel: string, file: SourceFile | undefined): void {
    const target = path.join(this.#root, rel);
    if (!file) fs.rmSync(target, { force: true });
    else if (file.kind === 'text') writeFileAtomic(target, file.text);
    else return;
    this.recordStat(rel);
  }

  // The change a set of new contents makes. A binary file another program overwrote or deleted
  // before any version or change kept its content cannot come back: the change says so
  // (unavailable), and undo will skip that part.
  // A file edit no Elabora tool made (external) is computed from the version its program most likely
  // read (D75): what was written meanwhile and the edit did not touch is kept; merged lists the
  // files whose content is no longer what was written, which the session writes again.
  #prepareChange(updates: ReadonlyMap<string, SourceFile | null>, external = false) {
    const before = this.#state.files;
    let after: ProjectFiles = withUpdates(before, updates);
    let ops = diffFiles(before, after);
    let merged: string[] = [];
    let notes: ExternalNotes | null = null;
    if (external && ops.length) {
      const paths = [...updates.keys()];
      const edit = externalEdit(before, after, recentVersions(before, lastChanges(this.#root, RECENT_VERSIONS), paths), EXTERNAL);
      ops = edit.ops;
      merged = edit.merged;
      if (edit.merged.length || edit.skipped.length || edit.overwrote.length) notes = { files: edit.merged, skipped: edit.skipped, overwrote: edit.overwrote };
      // A file the edit gives as it was written keeps that text (its formatting); a merged one is
      // the merge's.
      const applied = applyOps(before, ops) as ProjectFiles;
      after = withUpdates(applied, new Map([...updates].filter(([rel]) => !merged.includes(rel))));
    }
    const inverse = invertOps(before, ops);
    const written = new Set(ops.flatMap((op) => (op.op === 'write' && 'blob' in op ? [op.blob] : [])));
    const unavailable = [...new Set(inverse.flatMap((op) => (op.op === 'write' && 'blob' in op && !written.has(op.blob) && !hasBlob(this.#root, op.blob as BlobHash) ? [op.blob] : [])))];
    // What the state takes: the files as they are after the change (merged ones included).
    const settled = new Map<string, SourceFile | null>([...updates.keys()].map((rel) => [rel, (after.get(rel) as SourceFile | undefined) ?? null]));
    return { before, after, ops, inverse, unavailable, merged, settled, notes };
  }

  // What a file edit no Elabora tool made left out or replaced (D75), kept by its change and told.
  #noteExternal(change: string, notes: ExternalNotes | null): void {
    if (!notes) return;
    this.#externalNotes.set(change, notes);
    if (this.#externalNotes.size > 200) this.#externalNotes.delete(this.#externalNotes.keys().next().value as string);
    this.#host.emit({ type: 'merged', change, ...notes });
  }

  // What an external change left out or replaced, by its id (a project in the cloud tells the others).
  externalNotes(change: string): ExternalNotes | undefined {
    return this.#externalNotes.get(change);
  }

  // Journals new contents as one change: files already on disk (what another program or a job
  // wrote), and files the session writes now (write: references rewritten).
  async journal(spec: NewContents): Promise<number | null> {
    const { before, after, ops, inverse, unavailable, merged, settled, notes } = this.#prepareChange(spec.updates, spec.author.kind === 'external' && spec.source !== 'cloud');
    let seq: number | null = null;
    if (ops.length) {
      await storeChangeBlobs(this.#root, { ops, inverse, unavailable });
      keepOriginalTexts(this.#root, before, ops);
      for (const [rel, file] of spec.write ?? []) {
        if (file.kind === 'text') await this.#store.write(rel, file.text);
        await this.readDisk(rel);
      }
      const entry = appendChange(this.#root, { author: spec.author, ...(spec.command ? { command: spec.command } : {}), ...(spec.batch ? { batch: spec.batch } : {}), ops, inverse, files: changeFileHashes(before, after, ops), unavailable });
      this.#sources.set(entry.seq, spec.source);
      seq = entry.seq;
      this.#noteExternal(entry.id, notes);
    }
    for (const rel of merged) this.#writeMergedSync(rel, after.get(rel));
    this.#state.update(settled);
    for (const rel of spec.updates.keys()) this.#state.setBroken(rel, null);
    return seq;
  }

  // What the watchers reported. The lock is taken only when something is new: the session's own
  // writes come back from the watchers as files that hold what the snapshot holds.
  async refresh(final = false): Promise<void> {
    // A project folder moved or deleted while open is not a deletion of every file: nothing is
    // journaled, and the app is told (it closes the session).
    if (!fs.existsSync(this.#root)) {
      this.#monitor.forgetAll();
      if (!this.#gone) this.#host.emit({ type: 'error', context: 'watching the project', message: `The project folder ${this.#root} is gone (moved or deleted).` });
      this.#gone = true;
      return;
    }
    this.#gone = false;
    let needLock = false;
    if (this.#monitor.consumeJournal() || final) {
      needLock = await this.#tail.hasNew();
    }
    if (this.#monitor.needsRescan || final) await this.#rescan();
    if (!needLock) needLock = await this.#dirtyChanged();
    if (needLock) await this.locked(() => this.sync());
    await this.#host.afterChange();
  }

  // Whether a reported file differs from the snapshot; the ones that do not are settled here.
  async #dirtyChanged(): Promise<boolean> {
    for (const rel of this.#monitor.pending()) {
      if (this.#host.owns(rel)) continue;
      const disk = await this.readDisk(rel, true);
      if (disk.kind === 'unstable') return true;
      const current = this.#state.files.get(rel);
      if (disk.kind === 'missing') {
        if (current || pathsInside(this.#state.files, rel).length || this.#state.artefacts.some((artefact) => artefact.path === rel)) return true;
        this.#monitor.forget(rel);
        continue;
      }
      if (!sameContent(current, disk.file)) return true;
      this.#monitor.forget(rel);
      this.#state.setBroken(rel, null);
    }
    return false;
  }

  // Lists the folder: files whose size or time changed since they were read, new and gone files.
  async #rescan(): Promise<void> {
    this.#monitor.finishRescan();
    this.#host.rescanned(); // jobs of other processes are seen through their job files
    const listed = await this.#store.list();
    const seen = new Set<string>();
    for (const info of listed) {
      seen.add(info.path);
      const known = this.#stats.get(info.path);
      if (!known || known.size !== info.size || known.mtimeMs !== info.mtimeMs) this.#monitor.observe(info.path);
    }
    for (const rel of this.#state.files.keys()) if (!seen.has(rel)) this.#monitor.observe(rel);
    for (const artefact of this.#state.artefacts) if (!seen.has(artefact.path)) this.#monitor.observe(artefact.path);
  }

  async readDisk(rel: string, settle = false): Promise<DiskRead> {
    const disk = await readDisk(this.#store, rel, { settleMs: settle ? SETTLE_MS : 0 });
    if (disk.kind === 'file') this.#stats.set(rel, disk.info);
    else if (disk.kind === 'missing') this.#stats.delete(rel);
    return disk;
  }

  recordStat(rel: string): void {
    try {
      const stat = fs.statSync(path.join(this.#root, ...rel.split('/')));
      this.#stats.set(rel, { path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      this.#stats.delete(rel);
    }
  }
}
