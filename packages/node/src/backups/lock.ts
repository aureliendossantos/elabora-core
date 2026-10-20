import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectDataDir } from '../data-dir.ts';

// The backups lock serialises version creation, restore and pruning across processes (the app's
// engine, the CLI, the MCP server). It is a file created exclusively; its holder refreshes its time
// while working, so a lock older than 60 s was left by a process that died. A lock left on this
// computer by a process that no longer exists is broken at once.

export const LOCK_FILE = path.join('backups', 'lock');
const STALE_MS = 60_000;
const HEARTBEAT_MS = 10_000;

export class BackupsLockedError extends Error {
  readonly code = 'BACKUPS_LOCKED';
}

interface Holder {
  token?: string;
  pid?: number;
  host?: string;
  purpose?: string;
  time?: string;
  mtimeMs: number;
}

function readHolder(file: string): Holder | null {
  let mtimeMs: number;
  let text: string;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return { ...(JSON.parse(text) as Omit<Holder, 'mtimeMs'>), mtimeMs };
  } catch {
    return { mtimeMs }; // being written by its creator
  }
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function isStale(holder: Holder): boolean {
  if (Date.now() - holder.mtimeMs > STALE_MS) return true;
  return holder.host === os.hostname() && typeof holder.pid === 'number' && holder.pid !== process.pid && processGone(holder.pid);
}

// Removes a stale lock unless another process replaced it in the meantime.
function breakLock(file: string, seen: Holder): void {
  const now = readHolder(file);
  if (!now || now.token !== seen.token || now.mtimeMs !== seen.mtimeMs) return;
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withBackupsLock<T>(projectDir: string, purpose: string, run: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const file = path.join(projectDataDir(projectDir), LOCK_FILE);
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + (options.waitMs ?? 120_000);
  // A mistyped project path must fail, not grow a .elabora folder.
  if (!fs.statSync(projectDir).isDirectory()) throw new Error(`Not a folder: ${projectDir}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ token, pid: process.pid, host: os.hostname(), purpose, time: new Date().toISOString() }), { flag: 'wx' });
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EPERM: on Windows, a lock file being deleted cannot be created again yet.
      if (code !== 'EEXIST' && !(code === 'EPERM' && process.platform === 'win32')) throw e;
    }
    const holder = readHolder(file);
    if (holder && isStale(holder)) {
      breakLock(file, holder);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new BackupsLockedError(`Backups are busy (${holder?.purpose ?? 'another process'}${holder?.pid ? `, process ${holder.pid}` : ''}); try again in a moment.`);
    }
    await sleep(Math.min(20 * 2 ** attempt, 250) + Math.random() * 20);
  }
  const heartbeat = setInterval(() => {
    try {
      if (readHolder(file)?.token === token) {
        const now = new Date();
        fs.utimesSync(file, now, now);
      }
    } catch {
      // the next beat tries again
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    try {
      if (readHolder(file)?.token === token) fs.unlinkSync(file);
    } catch {
      // already gone
    }
  }
}
