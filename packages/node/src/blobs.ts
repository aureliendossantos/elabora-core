import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { projectDataDir } from './data-dir.ts';

// Content-addressed store of file contents in <data dir>/blobs/sha256/<2 chars>/<hash> (data-dir.ts), shared by the
// journal (binary contents of write operations and of their inverses) and the backups. A blob is
// written once and never changed, so readers need no lock.

export const BLOBS_DIR = 'blobs';

export type BlobHash = `sha256:${string}`;

const HEX = /^sha256:([0-9a-f]{64})$/;

export function blobPath(projectDir: string, hash: BlobHash): string {
  const m = HEX.exec(hash);
  if (!m) throw new Error(`Not a blob hash: ${hash}`);
  return path.join(projectDataDir(projectDir), BLOBS_DIR, 'sha256', m[1].slice(0, 2), m[1]);
}

export function hashBytes(data: Uint8Array | string): BlobHash {
  return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
}

// Hash of a file read as a stream: media files are never loaded whole.
export async function hashFile(file: string): Promise<BlobHash> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return `sha256:${h.digest('hex')}`;
}

export function hasBlob(projectDir: string, hash: BlobHash): boolean {
  return fs.existsSync(blobPath(projectDir, hash));
}

export function putBytes(projectDir: string, data: Uint8Array | string): BlobHash {
  const hash = hashBytes(data);
  const target = blobPath(projectDir, hash);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  }
  return hash;
}

// Stores a file whose content is known not to change (a media master, a file under the project
// lock). Masters are cloned where the file system shares blocks (cloneFile), so keeping a 300 MB
// master in the store costs no disk space on APFS. Files that may be changing go through
// putFileSnapshot instead.
export async function putFile(projectDir: string, file: string, knownHash?: BlobHash): Promise<BlobHash> {
  const hash = knownHash ?? await hashFile(file);
  const target = blobPath(projectDir, hash);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    if (!(await cloneFile(file, tmp))) fs.copyFileSync(file, tmp);
    fs.renameSync(tmp, target);
  }
  return hash;
}

// Temporary files of the store, on the same volume as the blobs so that the final rename is atomic.
export const BLOBS_TMP_DIR = path.join(BLOBS_DIR, 'tmp');

const cloneSupport = new Map<string, boolean>();
const CLONE_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'ENOTTY']);
// Smallest file worth cloning on macOS, where a clone costs starting cp (about 1.5 ms).
const MAC_CLONE_MIN_BYTES = 256 << 10;
const execFileAsync = promisify(execFile);

// Makes `dst` (which must not exist) a clone of `src` that shares its disk blocks, when the platform
// can. libuv does not clone on macOS: in Node 24, COPYFILE_FICLONE makes a full copy there and
// COPYFILE_FICLONE_FORCE fails with ENOSYS. So macOS goes through cp -c (clonefile(2), which falls
// back to a copy on file systems without clones). Returns false, having written nothing, when no
// clone was made; the caller then copies, and its copy reports a real error (unreadable source).
export async function cloneFile(src: string, dst: string, size?: number): Promise<boolean> {
  if (process.platform === 'darwin') {
    if ((size ?? (await fs.promises.stat(src)).size) < MAC_CLONE_MIN_BYTES) return false;
    try {
      await execFileAsync('/bin/cp', ['-c', '--', src, dst]);
      return true;
    } catch {
      await fs.promises.rm(dst, { force: true });
      return false;
    }
  }
  const dir = path.dirname(dst);
  if (cloneSupport.get(dir) === false) return false;
  try {
    await fs.promises.copyFile(src, dst, fs.constants.COPYFILE_FICLONE_FORCE);
    cloneSupport.set(dir, true);
    return true;
  } catch (e) {
    await fs.promises.rm(dst, { force: true });
    if (!CLONE_UNSUPPORTED.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
    cloneSupport.set(dir, false);
    return false;
  }
}

// Stores a snapshot of a file that may be changing (backups of a project being edited). Unlike
// putFile, the copy is made first and the copy is hashed, so a file written during the backup cannot
// leave a blob whose content does not match its name. The copy is a clone where the file system
// allows it (APFS, Btrfs, XFS); elsewhere the file is read once, hashed while it is copied, and
// flushed to disk before it becomes a blob.
export async function putFileSnapshot(projectDir: string, file: string, options: { clone?: boolean } = {}): Promise<{ hash: BlobHash; size: number }> {
  const tmpDir = path.join(projectDataDir(projectDir), BLOBS_TMP_DIR);
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    let stored: { hash: BlobHash; size: number } | null = null;
    if (options.clone !== false && (await cloneFile(file, tmp))) stored = await hashCopy(tmp, null);
    stored ??= await hashCopy(file, tmp);
    const target = blobPath(projectDir, stored.hash);
    if (fs.existsSync(target)) {
      await fs.promises.rm(tmp, { force: true });
    } else {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.rename(tmp, target);
    }
    return stored;
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}

// Reads a file in large chunks and hashes it, copying it to `copyTo` on the way when given.
async function hashCopy(file: string, copyTo: string | null): Promise<{ hash: BlobHash; size: number }> {
  const h = crypto.createHash('sha256');
  let size = 0;
  const input = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (copyTo) {
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        h.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(input, hasher, fs.createWriteStream(copyTo, { flags: 'wx', flush: true }));
  } else {
    for await (const chunk of input) {
      h.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
  }
  return { hash: `sha256:${h.digest('hex')}`, size };
}

export function readBlob(projectDir: string, hash: BlobHash): Buffer {
  return fs.readFileSync(blobPath(projectDir, hash));
}

// Writes a blob's content to a project file (restore, undo of a binary write), as a clone when possible.
export async function copyBlobTo(projectDir: string, hash: BlobHash, file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  if (!(await cloneFile(blobPath(projectDir, hash), tmp))) fs.copyFileSync(blobPath(projectDir, hash), tmp);
  fs.renameSync(tmp, file);
}

export function listBlobs(projectDir: string): BlobHash[] {
  const root = path.join(projectDataDir(projectDir), BLOBS_DIR, 'sha256');
  if (!fs.existsSync(root)) return [];
  const out: BlobHash[] = [];
  for (const prefix of fs.readdirSync(root)) {
    for (const name of fs.readdirSync(path.join(root, prefix))) if (/^[0-9a-f]{64}$/.test(name)) out.push(`sha256:${name}`);
  }
  return out.sort();
}

export function removeBlob(projectDir: string, hash: BlobHash): void {
  fs.rmSync(blobPath(projectDir, hash), { force: true });
}
