import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { localDataRoot, TOOL_DIR } from '../data-dir.ts';
import { withProjectLock } from '../journal/lock.ts';
import { LibraryError } from './errors.ts';
import { assertSpace, copyFileVerified, folderSize, heldLock, isInside, isProjectId, removeMovedLock, removeTree, renameWithRetries } from './files.ts';
import type { LockHolder } from '../journal/lock.ts';

// Where the library lives (docs/architecture/storage.md, Project library and archives): ELABORA_LIBRARY when
// set (tests, servers, a developer's own setup), else the path the user chose, kept in the user's
// Elabora settings (<local data>/settings.json, key libraryPath), else <local data>/Library. The local
// data folder is never roamed or synced by the operating system (data-dir.ts).

export const SETTINGS_FILE = 'settings.json';
export const DEFAULT_LIBRARY_NAME = 'Library';
// Marks a folder as an Elabora library, so that a library on an external disk is recognised and an
// interrupted move knows which copy is complete.
export const LIBRARY_MARKER = '.elabora-library.json';
export const TRASH_DIR = '.trash';
export const STAGING_DIR = '.staging';
const MOVING_DIR = '.moving';
const STALE_STAGING_MS = 24 * 3_600_000;
// Files the operating system drops in any folder: a folder holding only these is empty.
const OS_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);

type Settings = Record<string, unknown>;
interface MoveRecord { from: string; to: string }

export const settingsPath = (): string => path.join(localDataRoot(), SETTINGS_FILE);

// Lenient: a missing or damaged settings file means the default location.
function readSettings(): Settings {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Settings) : {};
  } catch {
    return {};
  }
}

// Strict: the app keeps other settings in the same file, so a file that cannot be read is never
// overwritten.
function updateSettings(change: (settings: Settings) => void): void {
  const file = settingsPath();
  let settings: Settings = {};
  if (fs.existsSync(file)) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      settings = value as Settings;
    } catch (error) {
      throw new LibraryError('E_SETTINGS', `${file} cannot be read (${(error as Error).message}): fix it or delete it.`);
    }
  }
  change(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const isMoveRecord = (value: unknown): value is MoveRecord =>
  !!value && typeof value === 'object' && typeof (value as MoveRecord).from === 'string' && typeof (value as MoveRecord).to === 'string';

export function libraryRoot(): string {
  const fromEnvironment = process.env.ELABORA_LIBRARY;
  if (fromEnvironment) return path.resolve(fromEnvironment);
  const settings = readSettings();
  // A move interrupted by a crash: the destination is the library once its marker is there (it
  // arrives with the last step of the move), the origin until then.
  if (isMoveRecord(settings.libraryMove)) {
    const { from, to } = settings.libraryMove;
    return fs.existsSync(path.join(to, LIBRARY_MARKER)) ? to : from;
  }
  if (typeof settings.libraryPath === 'string' && path.isAbsolute(settings.libraryPath)) return settings.libraryPath;
  return path.join(localDataRoot(), DEFAULT_LIBRARY_NAME);
}

// Creates the library folders when needed, and clears staging folders left by a process that died
// in the middle of an import (their content came from an archive or a folder that still exists).
export function ensureLibrary(root: string = libraryRoot()): string {
  fs.mkdirSync(path.join(root, TRASH_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, STAGING_DIR), { recursive: true });
  const marker = path.join(root, LIBRARY_MARKER);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, `${JSON.stringify({ format: 'elabora-library/1', createdAt: new Date().toISOString() }, null, 2)}\n`);
  const now = Date.now();
  for (const name of fs.readdirSync(path.join(root, STAGING_DIR))) {
    const full = path.join(root, STAGING_DIR, name);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (stat && now - stat.mtimeMs > STALE_STAGING_MS) fs.rmSync(full, { recursive: true, force: true });
  }
  return root;
}

// A fresh folder for work in progress, on the library's volume so that the final step is a rename.
export function stagingFolder(root: string = libraryRoot()): string {
  ensureLibrary(root);
  const dir = path.join(root, STAGING_DIR, crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir);
  return dir;
}

// Project folders: every folder of the library whose name does not start with a dot.
export function libraryEntries(root: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.sort();
}

function meaningfulEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => !OS_FILES.has(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export interface LibraryMoveResult {
  from: string;
  to: string;
  method: 'none' | 'setting' | 'rename' | 'copy';
  projects: number; // project folders moved
  bytes: number; // bytes copied (copy) or held by the moved folders (rename)
}

export interface SetLibraryRootOptions {
  // Move the projects (and the trash) to the new location. Without it, the setting changes and the
  // projects stay where they are: use it to point at an existing library (an external disk).
  move?: boolean;
  // Copy and check instead of renaming, even on the same volume: what a move to another disk does.
  copy?: boolean;
  onProgress?: (progress: { done: number; total: number }) => void; // bytes, when copying
}

// Changes where the library lives. A move on the same volume renames the library folder (atomic).
// Across volumes, everything is copied into the destination and checked by hash while every project
// is locked; the settings switch to the destination only when all of it is there; the originals
// are removed last. A crash leaves one complete library, which libraryRoot() finds.
// The app should close its projects first: their lock is taken for the whole move.
export async function setLibraryRoot(target: string, options: SetLibraryRootOptions = {}): Promise<LibraryMoveResult> {
  if (process.env.ELABORA_LIBRARY) throw new LibraryError('E_LIBRARY_LOCATION', 'ELABORA_LIBRARY is set: the library location comes from it. Unset it to change the location in the settings.');
  const from = path.resolve(libraryRoot());
  const to = path.resolve(target);
  const result: LibraryMoveResult = { from, to, method: 'none', projects: 0, bytes: 0 };
  if (from === to) return result;
  if (isInside(to, from)) throw new LibraryError('E_LIBRARY_LOCATION', `${to} is inside the library ${from}.`);
  if (isInside(from, to)) throw new LibraryError('E_LIBRARY_LOCATION', `${to} contains the library ${from}: choose a folder of its own.`);
  if (fs.existsSync(to) && !fs.statSync(to).isDirectory()) throw new LibraryError('E_LIBRARY_LOCATION', `${to} is a file.`);
  // A copy interrupted before it was complete: only what this module puts there.
  const leftover = path.join(to, MOVING_DIR);
  if (options.move && meaningfulEntries(leftover).every((name) => isProjectId(name) || name === TRASH_DIR)) await removeTree(leftover);
  const occupied = meaningfulEntries(to);
  const isLibrary = occupied.includes(LIBRARY_MARKER);

  const projects = libraryEntries(from);
  const hasContent = projects.length > 0 || meaningfulEntries(path.join(from, TRASH_DIR)).length > 0;
  if (!options.move || !hasContent) {
    if (occupied.length && !isLibrary) throw new LibraryError('E_LIBRARY_LOCATION', `${to} is not empty and is not an Elabora library: choose an empty folder.`);
    updateSettings((settings) => {
      settings.libraryPath = to;
      delete settings.libraryMove;
    });
    return { ...result, method: 'setting' };
  }
  if (occupied.length) throw new LibraryError('E_LIBRARY_LOCATION', `${to} is not empty: choose an empty folder to move the library into.`);

  ensureLibrary(from);
  await removeTree(path.join(from, STAGING_DIR));
  const dirs = projects.map((name) => path.join(from, name));
  return withLocks(dirs, async (holders) => {
    updateSettings((settings) => {
      settings.libraryMove = { from, to };
    });
    let method: 'rename' | 'copy';
    try {
      method = await moveRoot(from, to, options);
    } catch (error) {
      updateSettings((settings) => {
        delete settings.libraryMove;
      });
      throw error;
    }
    updateSettings((settings) => {
      settings.libraryPath = to;
      delete settings.libraryMove;
    });
    for (let i = 0; i < projects.length; i++) removeMovedLock(path.join(to, projects[i]), holders[i]);
    return { ...result, method, projects: projects.length, bytes: folderSize(to).bytes };
  });
}

async function moveRoot(from: string, to: string, options: SetLibraryRootOptions): Promise<'rename' | 'copy'> {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // rename() replaces an empty folder on macOS and Linux, not on Windows: remove it first.
  if (fs.existsSync(to)) {
    for (const name of fs.readdirSync(to)) fs.rmSync(path.join(to, name), { force: true });
    fs.rmdirSync(to);
  }
  if (!options.copy) {
    try {
      await renameWithRetries(from, to);
      return 'rename';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }
  }
  const moving = path.join(to, MOVING_DIR);
  const names = fs.readdirSync(from).filter((name) => name !== STAGING_DIR && name !== LIBRARY_MARKER && !OS_FILES.has(name));
  const total = folderSize(from).bytes;
  await assertSpace(to, total, 'Moving the library');
  let done = 0;
  try {
    for (const name of names) {
      await copyTree(path.join(from, name), path.join(moving, name), (bytes) => {
        done += bytes;
        options.onProgress?.({ done, total });
      });
    }
    for (const name of names) await renameWithRetries(path.join(moving, name), path.join(to, name));
    fs.rmdirSync(moving);
    // Last: from now on the destination is the library (libraryRoot() reads the marker).
    fs.copyFileSync(path.join(from, LIBRARY_MARKER), path.join(to, LIBRARY_MARKER));
  } catch (error) {
    await removeTree(moving);
    for (const name of names) if (fs.existsSync(path.join(from, name))) await removeTree(path.join(to, name));
    throw error;
  }
  for (const name of [...names, STAGING_DIR, LIBRARY_MARKER]) await removeTree(path.join(from, name));
  if (!meaningfulEntries(from).length) await removeTree(from);
  return 'copy';
}

// Copies a folder to another volume, file by file, each checked by hash. Lock files are left out:
// the locks belong to this move, on the original paths.
async function copyTree(from: string, to: string, onBytes: (bytes: number) => void): Promise<void> {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target, onBytes);
    else if (entry.isFile() && !(path.basename(from) === TOOL_DIR && (entry.name === 'lock' || entry.name === 'lock.break'))) await copyFileVerified(source, target, onBytes);
  }
  const stat = fs.statSync(from);
  fs.utimesSync(to, stat.atimeMs / 1000, stat.mtimeMs / 1000);
}

// Holds the project lock of every folder while run() works; returns each holder (for the lock files
// that move with their folder).
async function withLocks<T>(dirs: string[], run: (holders: (LockHolder | null)[]) => Promise<T>, holders: (LockHolder | null)[] = []): Promise<T> {
  if (holders.length === dirs.length) return run(holders);
  return withProjectLock(dirs[holders.length], () => withLocks(dirs, run, [...holders, heldLock(dirs[holders.length])]));
}
