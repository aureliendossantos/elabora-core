import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { projectDataDir } from '../data-dir.ts';

// The project lock (lock in the project's data folder, data-dir.ts). Every writer (engine, CLI, MCP) holds it while it checks
// preconditions, writes files and appends to the journal. It is a file created exclusively that
// records who holds it. A lock left by a process that is gone is broken: at once when the process
// ran on this computer (a CLI stopped with Ctrl-C must not block the next command), after 30 s
// when it ran on another one (ELABORA_DATA_DIR on a shared drive), since its process cannot be
// checked from here.

// Relative to the project's data folder.
export const LOCK_FILE = 'lock';
export const STALE_LOCK_MS = 30_000;
// Long enough for a lock from another computer to become stale and be broken while waiting.
export const DEFAULT_LOCK_TIMEOUT_MS = 40_000;
// A breaker (see breakStaleLock) is held for microseconds; one this old was left by a crash.
const STALE_BREAKER_MS = 10_000;

export interface LockHolder { pid: number; host: string; at: string; token: string }

export interface LockOptions {
  timeoutMs?: number;
}

export class LockError extends Error {
  readonly code = 'E_LOCKED';
  readonly holder: LockHolder | null;

  constructor(message: string, holder: LockHolder | null) {
    super(message);
    this.name = 'LockError';
    this.holder = holder;
  }
}

// Locks held by the current async context, so that nested calls (appending to the journal from
// inside a command) do not wait for themselves.
const heldHere = new AsyncLocalStorage<Set<string>>();
// Tokens of the locks this thread holds, to fail at once instead of deadlocking when a
// synchronous wait would block the async task that holds the lock.
const heldByProcess = new Set<string>();
const processStart = Date.now() - process.uptime() * 1000;

export function lockPath(dir: string): string {
  return path.join(projectDataDir(dir), LOCK_FILE);
}

// Who holds the lock, for messages; null when nobody does.
export function readLockHolder(dir: string): LockHolder | null {
  try {
    return parseHolder(fs.readFileSync(lockPath(dir), 'utf8'));
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    throw error;
  }
}

// Whether the current call already holds the project lock (nested in withProjectLock).
export function isProjectLockHeld(dir: string): boolean {
  return heldHere.getStore()?.has(lockPath(dir)) ?? false;
}

// Runs fn while holding the project lock. fn must be synchronous: use withProjectLock otherwise.
export function withProjectLockSync<T>(dir: string, fn: () => T, options: LockOptions = {}): T {
  const file = lockPath(dir);
  const held = heldHere.getStore();
  if (held?.has(file)) return fn();
  const mine = acquire(file, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const nested = new Set(held);
  nested.add(file);
  try {
    return heldHere.run(nested, fn);
  } finally {
    nested.delete(file);
    release(file, mine);
  }
}

export async function withProjectLock<T>(dir: string, fn: () => T | Promise<T>, options: LockOptions = {}): Promise<T> {
  const file = lockPath(dir);
  const held = heldHere.getStore();
  if (held?.has(file)) return await fn();
  const mine = await acquireAsync(file, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const nested = new Set(held);
  nested.add(file);
  try {
    return await heldHere.run(nested, fn);
  } finally {
    nested.delete(file);
    release(file, mine);
  }
}

// ── acquisition ──────────────────────────────────────────────────────

type Attempt = { acquired: LockHolder } | { acquired: null; holder: LockHolder | null; raw: string | null; stale: boolean };

function attempt(file: string): Attempt {
  const mine: LockHolder = { pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token: crypto.randomUUID() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify(mine)}\n`, { flag: 'wx' });
    heldByProcess.add(mine.token);
    return { acquired: mine };
  } catch (error) {
    if (isReleasing(error)) return { acquired: null, holder: null, raw: null, stale: false };
    if (!isCode(error, 'EEXIST')) throw error;
  }
  let raw: string;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (error) {
    // Released meanwhile (on Windows, a file being deleted refuses to open until it is gone).
    if (isCode(error, 'ENOENT') || isReleasing(error)) return { acquired: null, holder: null, raw: null, stale: false };
    throw error;
  }
  const holder = parseHolder(raw);
  return { acquired: null, holder, raw, stale: isStale(holder, mtimeMs) };
}

// One step of the wait loop: the lock, or how long to wait before trying again.
function step(file: string, deadline: number, delay: number, sync: boolean): LockHolder | number {
  const result = attempt(file);
  if (result.acquired) return result.acquired;
  if (result.raw === null) return 0;
  if (result.stale && breakStaleLock(file, result.raw)) return 0;
  if (sync && result.holder?.pid === process.pid && result.holder.host === os.hostname() && heldByProcess.has(result.holder.token)) {
    throw new LockError('The project lock is held by another task of this process: waiting synchronously would never end (use withProjectLock).', result.holder);
  }
  if (Date.now() >= deadline) throw lockedError(file, result.holder);
  return delay;
}

function acquire(file: string, timeoutMs: number): LockHolder {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
    const result = step(file, deadline, delay, true);
    if (typeof result !== 'number') return result;
    if (result) sleepSync(jitter(result));
  }
}

async function acquireAsync(file: string, timeoutMs: number): Promise<LockHolder> {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
    const result = step(file, deadline, delay, false);
    if (typeof result !== 'number') return result;
    if (result) await new Promise((resolve) => setTimeout(resolve, jitter(result)));
  }
}

function isStale(holder: LockHolder | null, mtimeMs: number): boolean {
  // Unreadable: a holder that died between creating the file and writing it, or a damaged file.
  if (!holder) return Date.now() - mtimeMs > STALE_LOCK_MS;
  if (holder.host === os.hostname()) {
    // Our own pid: another thread of this process holds it, unless it predates this process (left
    // by a crashed process whose pid we reuse).
    if (holder.pid === process.pid) return Date.parse(holder.at) < processStart - 1000;
    return !processAlive(holder.pid);
  }
  const at = Date.parse(holder.at);
  return Date.now() - (Number.isFinite(at) ? at : mtimeMs) > STALE_LOCK_MS;
}

// Removes a stale lock, unless it changed since it was judged stale. Waiters that all judged it
// stale take turns through a breaker file, so none of them removes a lock another one just took.
function breakStaleLock(file: string, raw: string): boolean {
  const breaker = `${file}.break`;
  try {
    fs.writeFileSync(breaker, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (isReleasing(error)) return false;
    if (!isCode(error, 'EEXIST')) throw error;
    try {
      if (Date.now() - fs.statSync(breaker).mtimeMs > STALE_BREAKER_MS) fs.rmSync(breaker, { force: true });
    } catch (statError) {
      if (!isCode(statError, 'ENOENT')) throw statError;
    }
    return false;
  }
  try {
    let current: string | null = null;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (!isCode(error, 'ENOENT') && !isReleasing(error)) throw error;
    }
    if (current === raw) fs.rmSync(file, { force: true });
    return true;
  } finally {
    fs.rmSync(breaker, { force: true });
  }
}

function release(file: string, mine: LockHolder): void {
  heldByProcess.delete(mine.token);
  for (let attempt = 0; ; attempt++) {
    try {
      // Only our own lock: if it was broken and taken by another writer, it is theirs now.
      if (parseHolder(fs.readFileSync(file, 'utf8'))?.token === mine.token) fs.rmSync(file, { force: true });
      return;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return;
      if (!isReleasing(error) || attempt >= 20) throw error;
      sleepSync(jitter(5));
    }
  }
}

function lockedError(file: string, holder: LockHolder | null): LockError {
  const who = holder ? `process ${holder.pid} on ${holder.host === os.hostname() ? 'this computer' : holder.host} since ${holder.at}` : 'another process';
  return new LockError(`The project is locked by ${who}. If no Elabora tool is running, delete ${file}.`, holder);
}

// ── helpers ──────────────────────────────────────────────────────────

function parseHolder(raw: string): LockHolder | null {
  try {
    const value = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof value.pid === 'number' && typeof value.host === 'string' && typeof value.at === 'string' && typeof value.token === 'string') return value as LockHolder;
  } catch {
    // An empty or partial file: the holder is still writing it, or died doing so.
  }
  return null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, 'EPERM'); // exists, owned by another user
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

const jitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));

// Windows: a file another process is deleting cannot be opened or created (EPERM, or EACCES) until
// the deletion is done, a matter of milliseconds; EBUSY is a sharing violation, as brief.
function isReleasing(error: unknown): boolean {
  return isCode(error, 'EBUSY') || (process.platform === 'win32' && (isCode(error, 'EPERM') || isCode(error, 'EACCES')));
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}
