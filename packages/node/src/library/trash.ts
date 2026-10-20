import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataLocation } from '../data-dir.ts';
import { LibraryError } from './errors.ts';
import {
  compactTime, folderSize, heldLock, isEmptyShell, isProjectId, newProjectId, parseCompactTime, readProjectId, removeMovedLock, removeStaleLocks, removeTree,
  renameWithRetries, writeProjectId
} from './files.ts';
import { TRASH_DIR, ensureLibrary, libraryEntries, libraryRoot } from './location.ts';
import { getProject, libraryProjectDir, readCourseInfo, withLibraryLock, type LibraryProject } from './projects.ts';

// The library's trash: deleting a project moves its folder, history included, to
// <library>/.trash/<time>-<project id>, with a small record beside it. Nothing is deleted outright
// except by deleteFromTrash (one entry) and emptyTrash (many).

export type TrashReason = 'trashed' | 'replaced';

// How long a project stays in the trash before the app deletes it for good (emptyTrash with
// olderThanDays). Entries say when that is (expiresAt), so that no screen has to know the number.
export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface TrashEntry {
  entry: string; // folder name in the trash: what restoreFromTrash takes
  id: string; // project id it had
  path: string;
  trashedAt: string;
  expiresAt: string; // trashedAt + TRASH_RETENTION_DAYS: from then on emptyTrash({ olderThanDays: TRASH_RETENTION_DAYS }) deletes it
  reason: TrashReason; // replaced: the project was replaced by an imported archive
  courseId: string | null;
  title: string | null;
  size: number; // bytes, history included
}

interface TrashRecord {
  format: 'elabora-trash/1';
  id: string;
  trashedAt: string;
  reason: TrashReason;
  from: string;
}

const ENTRY = /^(\d{8}T\d{9}Z)-([0-9a-f-]{36})(?:-[0-9a-f]+)?$/;
const recordPath = (trash: string, entry: string) => path.join(trash, `${entry}.json`);

// Moves a project folder (whose lock the caller holds) into the trash and returns the entry name.
export async function moveToTrash(dir: string, reason: TrashReason, options: { root?: string; now?: Date } = {}): Promise<string> {
  const root = options.root ?? libraryRoot();
  const trash = path.join(ensureLibrary(root), TRASH_DIR);
  const id = path.basename(dir);
  const now = options.now ?? new Date();
  let entry = `${compactTime(now)}-${id}`;
  if (fs.existsSync(path.join(trash, entry))) entry += `-${crypto.randomBytes(2).toString('hex')}`;
  const holder = heldLock(dir);
  await renameWithRetries(dir, path.join(trash, entry));
  removeMovedLock(path.join(trash, entry), holder);
  const record: TrashRecord = { format: 'elabora-trash/1', id, trashedAt: now.toISOString(), reason, from: dir };
  fs.writeFileSync(recordPath(trash, entry), `${JSON.stringify(record, null, 2)}\n`);
  return entry;
}

export async function trashProject(id: string): Promise<TrashEntry> {
  const dir = libraryProjectDir(id);
  const entry = await withLibraryLock(dir, () => moveToTrash(dir, 'trashed'));
  return describeEntry(path.join(libraryRoot(), TRASH_DIR), entry);
}

export function listTrash(): TrashEntry[] {
  const trash = path.join(libraryRoot(), TRASH_DIR);
  const entries = libraryEntries(trash).map((entry) => describeEntry(trash, entry));
  return entries.sort((a, b) => Date.parse(b.trashedAt) - Date.parse(a.trashedAt));
}

function readRecord(trash: string, entry: string): TrashRecord | null {
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(trash, entry), 'utf8')) as TrashRecord;
    return record.format === 'elabora-trash/1' && isProjectId(record.id) ? record : null;
  } catch {
    return null;
  }
}

function describeEntry(trash: string, entry: string): TrashEntry {
  const dir = path.join(trash, entry);
  const record = readRecord(trash, entry);
  // Without its record (a crash just after the move), the name tells the time and the id.
  const match = ENTRY.exec(entry);
  const id = record?.id ?? readProjectId(dir) ?? match?.[2] ?? entry;
  const trashedAt = record?.trashedAt ?? (match && parseCompactTime(match[1])?.toISOString()) ?? new Date(fs.statSync(dir).mtimeMs).toISOString();
  const course = readCourseInfo(dir);
  let size = folderSize(dir).bytes;
  if (isProjectId(id) && !dataLocation(dir).inProject) size += folderSize(dataLocation(dir).dir).bytes;
  const expiresAt = new Date(Date.parse(trashedAt) + TRASH_RETENTION_DAYS * DAY_MS).toISOString();
  return { entry, id, path: dir, trashedAt, expiresAt, reason: record?.reason ?? 'trashed', courseId: course.courseId, title: course.title, size };
}

function trashEntryDir(entry: string): { trash: string; dir: string } {
  const trash = path.join(libraryRoot(), TRASH_DIR);
  if (!entry || entry.startsWith('.') || entry !== path.basename(entry) || !fs.existsSync(path.join(trash, entry))) {
    throw new LibraryError('E_TRASH_ENTRY', `No entry ${JSON.stringify(entry)} in the trash.`);
  }
  return { trash, dir: path.join(trash, entry) };
}

// Puts a project back in the library. When its id is taken (it was replaced by an import, or an
// archive made it again), the restored project gets a new id and sits beside the one that has the
// old: it keeps its history, which a data folder kept outside the project (ELABORA_DATA_DIR) has
// under the old id, so it is copied under the new one. Compare the returned id with the entry's to
// know which happened.
export async function restoreFromTrash(entry: string): Promise<LibraryProject> {
  const { trash, dir } = trashEntryDir(entry);
  const root = ensureLibrary();
  let id = describeEntry(trash, entry).id;
  if (isProjectId(id) && isEmptyShell(path.join(root, id))) await removeTree(path.join(root, id));
  let outsideData: string | null = null;
  if (!isProjectId(id) || fs.existsSync(path.join(root, id))) {
    if (isProjectId(id) && !dataLocation(dir).inProject) outsideData = dataLocation(dir).dir;
    id = newProjectId();
    writeProjectId(dir, id);
  }
  removeStaleLocks(dir);
  await renameWithRetries(dir, path.join(root, id));
  if (outsideData && fs.existsSync(outsideData)) await fs.promises.cp(outsideData, dataLocation(path.join(root, id)).dir, { recursive: true });
  fs.rmSync(recordPath(trash, entry), { force: true });
  return getProject(id);
}

// Deletes one entry for good: its folder with the history, the record beside it, and the data kept
// outside the project (ELABORA_DATA_DIR) unless a project of the library, or another entry, has the
// same id and so the same data.
async function removeEntry(entry: TrashEntry, others: readonly TrashEntry[], liveIds: ReadonlySet<string>): Promise<void> {
  const location = dataLocation(entry.path);
  const sharedId = liveIds.has(entry.id) || others.some((other) => other.entry !== entry.entry && other.id === entry.id);
  await removeTree(entry.path);
  if (!location.inProject && !sharedId) await removeTree(location.dir);
  fs.rmSync(recordPath(path.join(libraryRoot(), TRASH_DIR), entry.entry), { force: true });
}

// Deletes one entry for good, whatever its age. The entry name is what listTrash gives
// (E_TRASH_ENTRY when there is none, or when it is gone already).
export async function deleteFromTrash(entry: string): Promise<TrashEntry> {
  const { trash } = trashEntryDir(entry);
  const removed = describeEntry(trash, entry);
  await removeEntry(removed, listTrash(), new Set(libraryEntries(libraryRoot())));
  return removed;
}

export interface EmptyTrashResult {
  removed: TrashEntry[];
  bytes: number;
}

// Deletes trash entries for good: all of them, or those trashed more than olderThanDays days ago.
export async function emptyTrash(options: { olderThanDays?: number; now?: Date } = {}): Promise<EmptyTrashResult> {
  const now = (options.now ?? new Date()).getTime();
  const cutoff = options.olderThanDays === undefined ? Infinity : now - options.olderThanDays * DAY_MS;
  const result: EmptyTrashResult = { removed: [], bytes: 0 };
  const liveIds = new Set(libraryEntries(libraryRoot()));
  let remaining = listTrash();
  for (const entry of remaining) {
    if (options.olderThanDays !== undefined && Date.parse(entry.trashedAt) > cutoff) continue;
    remaining = remaining.filter((other) => other !== entry);
    await removeEntry(entry, remaining, liveIds);
    result.removed.push(entry);
    result.bytes += entry.size;
  }
  return result;
}
