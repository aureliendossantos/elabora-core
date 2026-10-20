import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// Model files downloaded once per computer on first use (never in a course or a repository): the
// local voices' (voice/pocket/models.ts) and the word aligner's (align/models.ts). Every file is
// pinned to a revision and checked against its SHA-256; an interrupted download resumes; one
// download per folder at a time across processes (the app, a CLI, an MCP server).

export interface ModelFile {
  name: string;
  url: string;   // path on the host, from the repository name
  size: number;
  sha256: string;
}

export interface DownloadProgress {
  bundle: string;
  file: string;
  received: number;   // bytes of the whole bundle on disk
  total: number;
}

// What the messages call the files and why they are needed: « the voice model », « Local voices ».
export interface DownloadWording {
  what: string;
  needs: string;
  fail: (message: string) => Error;
  busy: (message: string) => Error;   // refused while it is downloaded or used (removeFiles)
  using: string;                       // what uses it: « a generation is saying lines with it »
}

// Files checked once are listed in <folder>/verified.json (name → sha256), so that loading does not
// hash 300 MB each time; a file whose size changed is checked again.
const VERIFIED = 'verified.json';

function verifiedHashes(dir: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(dir, VERIFIED), 'utf8')) as Record<string, string>; } catch { return {}; }
}

export function filesInstalled(dir: string, files: readonly ModelFile[]): boolean {
  const verified = verifiedHashes(dir);
  return files.every((file) => verified[file.name] === file.sha256 && fs.statSync(path.join(dir, file.name), { throwIfNoEntry: false })?.size === file.size);
}

export const filesSize = (files: readonly ModelFile[]): number => files.reduce((n, file) => n + file.size, 0);

export async function sha256Of(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// One lock per folder, beside it (<folder>.lock, so that removing the folder leaves it), holding the
// process id, what it does (« download » for a download, « hold » or « remove » for a moment) and a
// token of its own. It is made whole at once (a file of its own linked to the name, so that nobody
// reads it half written), and released only by its owner. A lock left by a process that is gone, or
// written before the computer last started (its process id may be another's now), is taken over: by
// renaming it away and checking that it is still the one found dead, so that two processes taking it
// over at once cannot both have it. The same goes for the holds' files (.in-use).
type LockPurpose = 'download' | 'hold' | 'remove';
const lockFile = (dir: string) => `${dir}.lock`;

const alive = (pid: number): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

// Written by a live process since the computer started.
function live(file: string, pid: number): boolean {
  const written = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  return written !== undefined && written >= Date.now() - os.uptime() * 1000 && alive(pid);
}

function readLock(dir: string): { text: string; pid: number; purpose: LockPurpose } | null {
  let text: string;
  try { text = fs.readFileSync(lockFile(dir), 'utf8'); } catch { return null; }
  const [pid, purpose] = text.trim().split(/\s+/);
  return { text, pid: Number(pid), purpose: (purpose as LockPurpose) || 'download' };
}

// The live process holding a folder's lock, and what for (null: none).
export function lockHolder(dir: string): { pid: number; purpose: LockPurpose } | null {
  const found = readLock(dir);
  return found && live(lockFile(dir), found.pid) ? { pid: found.pid, purpose: found.purpose } : null;
}

// A file that may not be made now: it exists, or (Windows) a file of that name is being deleted.
const taken = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
};

// Takes the lock, waiting for its holder (or giving up after wait ms: null); its token.
async function takeLock(dir: string, purpose: LockPurpose, { signal, wait = Infinity }: { signal?: AbortSignal; wait?: number } = {}): Promise<string | null> {
  const lock = lockFile(dir);
  const until = Date.now() + wait;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    const token = crypto.randomUUID();
    const mine = `${lock}.${token}`;
    fs.writeFileSync(mine, `${process.pid} ${purpose} ${token}`);
    try {
      fs.linkSync(mine, lock);
      return token;
    } catch (error) {
      if (!taken(error)) throw error;
    } finally {
      fs.rmSync(mine, { force: true });
    }
    const found = readLock(dir);
    if (found && !live(lock, found.pid)) { takeOver(lock, found.text); continue; }
    if (!found) continue;
    signal?.throwIfAborted();
    if (Date.now() >= until) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(10, until - Date.now()))));
  }
}

// Removes a lock found dead, if it is still that one (another process may have taken it over and
// made its own meanwhile: that one is put back).
function takeOver(lock: string, dead: string): void {
  const away = `${lock}.${crypto.randomUUID()}.stale`;
  try { fs.renameSync(lock, away); } catch { return; }
  let text = '';
  try { text = fs.readFileSync(away, 'utf8'); } catch { /* gone */ }
  if (text !== dead) { try { fs.linkSync(away, lock); } catch { /* a third one has it */ } }
  fs.rmSync(away, { force: true });
}

function releaseLock(dir: string, token: string): void {
  if (readLock(dir)?.text.trim().endsWith(token)) fs.rmSync(lockFile(dir), { force: true });
}

export async function withLock<T>(dir: string, purpose: LockPurpose, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const token = (await takeLock(dir, purpose, { signal }))!;
  try { return await run(); } finally { releaseLock(dir, token); }
}

// What is on disk in a folder, in bytes (its files, partial downloads included).
export function bytesOnDisk(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += bytesOnDisk(full);
    else if (entry.isFile()) total += fs.statSync(full, { throwIfNoEntry: false })?.size ?? 0;
  }
  return total;
}

// A download under way in any process (the app, a command, an MCP server): what it received so far.
export function downloading(dir: string, files: readonly ModelFile[]): { received: number; total: number } | null {
  if (lockHolder(dir)?.purpose !== 'download') return null;
  const onDisk = (name: string) => fs.statSync(path.join(dir, name), { throwIfNoEntry: false })?.size ?? fs.statSync(path.join(dir, `${name}.part`), { throwIfNoEntry: false })?.size ?? 0;
  return { received: files.reduce((n, file) => n + Math.min(file.size, onDisk(file.name)), 0), total: filesSize(files) };
}

// Whoever uses a folder's files holds them (a generation, from its first line to its last): one
// file per hold in <folder>/.in-use/, named by its process, so that removeFiles, in this process or
// another, refuses while they are used. Taken under the folder's lock, as a removal is: either the
// hold comes first and the removal is refused, or it comes after and finds the folder gone (its
// files are then downloaded again, as on first use).
const IN_USE = '.in-use';
let holds = 0;

export async function holdFiles(dir: string, signal?: AbortSignal): Promise<() => void> {
  const marker = path.join(dir, IN_USE, `${process.pid}-${++holds}`);
  await withLock(dir, 'hold', async () => {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
  }, signal);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.rmSync(marker, { force: true });
  };
}

// The processes holding a folder's files now (this one included).
export function holders(dir: string): number[] {
  let names: string[];
  try { names = fs.readdirSync(path.join(dir, IN_USE)); } catch { return []; }
  return [...new Set(names.filter((name) => live(path.join(dir, IN_USE, name), Number(name.split('-')[0]))).map((name) => Number(name.split('-')[0])))];
}

export class ModelsBusyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Removes a folder of model files, as if they had never been downloaded: refused while a download
// of it runs or while its files are held, in any process. The folder is first renamed away (at once,
// and refused whole on a system that keeps files open), then deleted; what was left by a removal that
// stopped midway is deleted the next time. How many bytes it freed (0: nothing was there).
// partial: only what a stopped download left, the files kept when they are all there once the lock
// is taken (another process may have finished downloading them meanwhile).
export async function removeFiles(dir: string, wording: DownloadWording, { partial }: { partial?: readonly ModelFile[] } = {}): Promise<number> {
  sweepRemovals(dir);
  if (!fs.existsSync(dir)) return 0;
  // A hold or another removal takes the lock for a moment: wait for it, not for a download.
  const token = await takeLock(dir, 'remove', { wait: 2000 });
  if (!token) {
    const holder = lockHolder(dir);
    throw wording.busy(holder?.purpose === 'download'
      ? `The ${wording.what} is being downloaded${holder.pid === process.pid ? '' : ` by another Elabora process (${holder.pid})`}: stop the download, or remove it once it is done.`
      : `The ${wording.what} is busy: try again in a moment.`);
  }
  let away: string;
  try {
    const using = holders(dir);
    if (using.length) throw wording.busy(`The ${wording.what} is in use${using.some((pid) => pid !== process.pid) ? ` by another Elabora process (${using.filter((pid) => pid !== process.pid).join(', ')})` : ''}: ${wording.using}. Remove it once it is done.`);
    if (partial && filesInstalled(dir, partial)) return 0;
    const size = bytesOnDisk(dir);
    away = `${dir}.removing-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(dir, away);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw wording.busy(`The ${wording.what} is still open in another Elabora process: close it, or try again in two minutes.`);
      throw error;
    }
    fs.rmSync(away, { recursive: true, force: true });
    return size;
  } finally {
    releaseLock(dir, token);
  }
}

// What removals that stopped midway left beside a folder.
function sweepRemovals(dir: string): void {
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.removing-`;
  let names: string[];
  try { names = fs.readdirSync(parent); } catch { return; }
  // A lock's own file or a dead lock taken over, left by a process stopped in that moment.
  for (const name of names.filter((candidate) => candidate.startsWith(`${path.basename(dir)}.lock.`))) {
    const file = path.join(parent, name);
    if ((fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Infinity) < Date.now() - 60_000) fs.rmSync(file, { force: true });
  }
  for (const name of names) {
    const pid = Number(name.slice(prefix.length).split('-')[0]);
    if (!name.startsWith(prefix) || (pid !== process.pid && alive(pid))) continue;
    fs.rmSync(path.join(parent, name), { recursive: true, force: true });
  }
}

// Downloads the files missing from dir (or damaged) from host, checking each.
export async function installFiles(id: string, dir: string, files: readonly ModelFile[], host: string, wording: DownloadWording, { onProgress, signal, prepare }: { onProgress?: (progress: DownloadProgress) => void; signal?: AbortSignal; prepare?: (dir: string) => void } = {}): Promise<string> {
  if (filesInstalled(dir, files)) return dir;
  return withLock(dir, 'download', async () => {
    if (filesInstalled(dir, files)) return dir;
    // Made under the lock: a removal that held it may have taken the folder away meanwhile.
    fs.mkdirSync(dir, { recursive: true });
    prepare?.(dir);
    const base = host.replace(/\/+$/, '');
    const total = filesSize(files);
    const verified = verifiedHashes(dir);
    const sizeOnDisk = (name: string) => fs.statSync(path.join(dir, name), { throwIfNoEntry: false })?.size ?? fs.statSync(path.join(dir, `${name}.part`), { throwIfNoEntry: false })?.size ?? 0;
    const received = () => files.reduce((n, file) => n + Math.min(file.size, sizeOnDisk(file.name)), 0);
    for (const file of files) {
      const target = path.join(dir, file.name);
      if (verified[file.name] === file.sha256 && fs.statSync(target, { throwIfNoEntry: false })?.size === file.size) continue;
      if (fs.statSync(target, { throwIfNoEntry: false })?.size === file.size && await sha256Of(target) === file.sha256) {
        verified[file.name] = file.sha256;
        fs.writeFileSync(path.join(dir, VERIFIED), JSON.stringify(verified, null, 2));
        continue;
      }
      const part = `${target}.part`;
      let have = fs.statSync(part, { throwIfNoEntry: false })?.size ?? 0;
      if (have > file.size) { fs.rmSync(part); have = 0; }
      if (have < file.size) {
        let response: Response;
        try {
          response = await fetch(`${base}/${file.url}`, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: 'follow', signal });
        } catch (error) {
          if (signal?.aborted) throw error;
          throw wording.fail(`The ${wording.what} could not be downloaded from ${base} (${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)}). ${wording.needs} it once: ${Math.round(total / 1e6)} MB.`);
        }
        if (have && response.status !== 206) have = 0; // no resume: start again
        if (!response.ok || !response.body) throw wording.fail(`The ${wording.what} could not be downloaded: ${response.status} ${response.statusText} for ${file.url}.`);
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        const start = received() - Math.min(file.size, have);
        let got = have;
        const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
        body.on('data', (chunk: Buffer) => {
          got += chunk.length;
          onProgress?.({ bundle: id, file: file.name, received: start + Math.min(got, file.size), total });
        });
        try {
          await pipeline(body, out, { signal });
        } catch (error) {
          if (signal?.aborted) throw error;
          const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
          throw wording.fail(`The download of the ${wording.what} was interrupted (${cause}): run it again, it goes on where it stopped.`);
        }
      }
      if (await sha256Of(part) !== file.sha256) {
        fs.rmSync(part, { force: true });
        throw wording.fail(`${file.name} of the ${wording.what} is damaged (its SHA-256 does not match): download it again.`);
      }
      fs.renameSync(part, target);
      verified[file.name] = file.sha256;
      fs.writeFileSync(path.join(dir, VERIFIED), JSON.stringify(verified, null, 2));
      onProgress?.({ bundle: id, file: file.name, received: received(), total });
    }
    return dir;
  }, signal);
}
