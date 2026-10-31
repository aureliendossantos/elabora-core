import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cloneFile, type BlobHash } from '../blobs.ts';
import { dataLocation, toolDir, TOOL_DIR } from '../data-dir.ts';
import { lockPath, readLockHolder, type LockHolder } from '../journal/lock.ts';
import { LibraryError } from './errors.ts';

// File helpers of the library: moves that survive Windows' sharing violations, copies checked by
// hash, sizes, and the project id file.

const CHUNK = 1024 * 1024;

export const ELABORA_VERSION: string = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version;

// Same rule as data-dir.ts: a project id is a UUID.
export const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_FILE = 'project-id';

export const isProjectId = (value: string): boolean => PROJECT_ID.test(value);

// The id in .elabora/project-id, without creating one (projectId() in data-dir.ts creates it).
export function readProjectId(projectDir: string): string | null {
  try {
    const id = fs.readFileSync(path.join(toolDir(projectDir), ID_FILE), 'utf8').trim();
    return isProjectId(id) ? id : null;
  } catch {
    return null;
  }
}

// The id file always sits in the project's own .elabora/ folder, even when ELABORA_DATA_DIR moves its
// data elsewhere: that is how the data is found again (data-dir.ts).
export function writeProjectId(projectDir: string, id: string): void {
  const file = path.join(toolDir(projectDir), ID_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${id}\n`);
}

export const newProjectId = (): string => crypto.randomUUID();

// 20261006T093012345Z: sorts in time order and is a valid file name on Windows (no colons).
export const compactTime = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace('.', '');

export function parseCompactTime(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows refuses to rename or delete what another program has open (antivirus, sync client,
// search indexer, an editor): wait a little and try again.
export async function withRetries<T>(action: () => Promise<T>, attempts = 7): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EBUSY' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
      if (!transient || attempt >= attempts - 1) throw error;
      await sleep(50 * 2 ** attempt);
    }
  }
}

export const renameWithRetries = (from: string, to: string): Promise<void> => withRetries(() => fs.promises.rename(from, to));

export async function removeTree(target: string): Promise<void> {
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}

// Moves a file, copying it when the target is on another volume.
export async function moveFile(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await renameWithRetries(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fs.promises.rm(from, { force: true });
  }
}

export interface FileDigest {
  hash: BlobHash;
  crc: number;
  size: number;
}

// SHA-256, CRC-32 and size in one read: what an archive's manifest and its ZIP entry need.
export async function digestFile(file: string, onBytes?: (bytes: number) => void): Promise<FileDigest> {
  const hash = crypto.createHash('sha256');
  let crc = 0;
  let size = 0;
  const handle = await fs.promises.open(file, 'r');
  try {
    // Tiny assets must not each leave a megabyte waiting for garbage collection.
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, (await handle.stat()).size)));
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      crc = zlib.crc32(chunk, crc);
      size += bytesRead;
      onBytes?.(bytesRead);
    }
  } finally {
    await handle.close();
  }
  return { hash: `sha256:${hash.digest('hex')}`, crc, size };
}

export const digestBytes = (data: Uint8Array): FileDigest => ({
  hash: `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`,
  crc: zlib.crc32(data),
  size: data.length,
});

// Copies a file as a clone where the file system shares blocks (APFS, Btrfs, XFS), else as a copy,
// keeping its modification time (hash caches are keyed by size and time), and checks that the
// source did not change meanwhile.
export async function copyProjectFile(from: string, to: string): Promise<void> {
  const before = await fs.promises.stat(from);
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  if (!(await cloneFile(from, to, before.size))) await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  const after = await fs.promises.stat(from);
  const copied = await fs.promises.stat(to);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || copied.size !== after.size) {
    throw new Error(`${from} changed while it was copied: try again.`);
  }
  await keepTimes(to, after);
}

// Seconds as floats keep the time to the microsecond; Date objects would round it to the
// millisecond, and caches keyed by modification time would miss.
export const keepTimes = (file: string, stat: fs.Stats): Promise<void> => fs.promises.utimes(file, stat.atimeMs / 1000, stat.mtimeMs / 1000);

// Copies a file to another volume reading it once, with its hash, into one reused buffer (a 300 MB
// video leaves no garbage behind); then reads the copy back and compares (a library moved to an
// external disk must arrive whole before the original is removed).
export async function copyFileVerified(from: string, to: string, onBytes?: (bytes: number) => void): Promise<number> {
  const stat = await fs.promises.stat(from);
  const source = crypto.createHash('sha256');
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  const input = await fs.promises.open(from, 'r');
  const output = await fs.promises.open(to, 'wx');
  const buffer = Buffer.allocUnsafe(CHUNK);
  try {
    for (let position = 0; ;) {
      const { bytesRead } = await input.read(buffer, 0, CHUNK, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      source.update(chunk);
      for (let offset = 0; offset < bytesRead;) offset += (await output.write(chunk, offset, bytesRead - offset)).bytesWritten;
      position += bytesRead;
      onBytes?.(bytesRead);
    }
    await output.sync();
  } finally {
    await input.close();
    await output.close();
  }
  const copy = await digestFile(to);
  if (copy.hash !== `sha256:${source.digest('hex')}`) throw new Error(`The copy of ${from} differs from the original.`);
  await keepTimes(to, stat);
  return copy.size;
}

// Logical size of a folder (symbolic links are not followed). Clones on APFS share blocks, so the
// space really used can be smaller.
export function folderSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files++;
        } catch {
          // removed meanwhile
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

// The lock of a project this call holds, read inside withProjectLock: moving a project folder moves
// its lock file with it when the lock lives in the project (.elabora/lock), and the copy left behind
// must be removed, or other writers would wait for a holder that is still alive.
export function heldLock(projectDir: string): LockHolder | null {
  return dataLocation(projectDir).inProject ? readLockHolder(projectDir) : null;
}

export function removeMovedLock(movedDir: string, holder: LockHolder | null): void {
  if (!holder || !dataLocation(movedDir).inProject) return;
  const file = lockPath(movedDir);
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: string };
    if (current.token === holder.token) fs.rmSync(file, { force: true });
  } catch {
    // no lock there, or not ours
  }
}

// Removes lock files left in a folder that comes back into use (restored from the trash): no
// process holds a lock on a path that did not exist.
export function removeStaleLocks(projectDir: string): void {
  if (!dataLocation(projectDir).inProject) return;
  const file = lockPath(projectDir);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.break`, { force: true });
}

// A folder holding nothing but a .elabora/ folder with lock files (or a fresh id): what a writer that
// waited for the lock of a project trashed meanwhile leaves behind, since taking a lock creates its
// folder. Not a project; safe to remove.
export function isEmptyShell(dir: string): boolean {
  const entries = (folder: string) => fs.readdirSync(folder).filter((name) => !['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(name));
  try {
    const top = entries(dir);
    if (top.some((name) => name !== TOOL_DIR)) return false;
    return !top.length || entries(path.join(dir, TOOL_DIR)).every((name) => name === 'lock' || name === 'lock.break' || name === ID_FILE);
  } catch {
    return false;
  }
}

// Free bytes on the volume holding `dir` (or its nearest existing parent); null when unknown.
export async function freeSpace(dir: string): Promise<number | null> {
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  try {
    const stats = await fs.promises.statfs(current);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export async function assertSpace(dir: string, bytes: number, what: string): Promise<void> {
  const free = await freeSpace(dir);
  // A margin for the file system's own needs and for the history written after.
  if (free !== null && free < bytes + 64 * 1024 * 1024) {
    throw new LibraryError('E_NOT_ENOUGH_SPACE', `${what} needs ${formatBytes(bytes)} and ${dir} has ${formatBytes(free)} free.`, { needed: bytes, free });
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// Names that Windows cannot hold: archives travel between Windows and macOS.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
export function windowsNameProblem(relative: string): string | null {
  for (const segment of relative.split('/')) {
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) return `${relative}: Windows does not allow the characters < > : " | ? * in file names`;
    if (/[. ]$/.test(segment)) return `${relative}: Windows does not allow a name ending with a dot or a space`;
    if (WINDOWS_RESERVED.test(segment)) return `${relative}: ${segment} is a reserved name on Windows`;
  }
  return null;
}
