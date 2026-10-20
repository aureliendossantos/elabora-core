import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Where Elabora keeps a project's machine-local data: the journal and lock, the blob store and
// backups, media jobs and renditions, caches and previews.
//
// By default it is the project's own .elabora/ folder. Projects edited in the app live in the Elabora
// library (library/), a local folder that no sync service touches, so the data simply sits next to
// the project. ELABORA_DATA_DIR=<folder> puts every project's data under that folder instead (tests,
// servers), keyed by an id kept in the project (.elabora/project-id), so renaming or moving the
// folder keeps its history.

const ID_FILE = 'project-id';

export interface DataLocation {
  dir: string; // absolute folder holding the project's machine-local data
  inProject: boolean;
}

const cache = new Map<string, DataLocation>();

export function projectDataDir(projectDir: string): string {
  return dataLocation(projectDir).dir;
}

export function dataLocation(projectDir: string): DataLocation {
  const root = path.resolve(projectDir);
  const cached = cache.get(root);
  if (cached) return cached;
  const base = process.env.ELABORA_DATA_DIR;
  const location: DataLocation = base
    ? { dir: path.join(path.resolve(base), 'projects', projectId(root)), inProject: false }
    : { dir: toolDir(root), inProject: true };
  cache.set(root, location);
  return location;
}

// The project's id: created once in .elabora/project-id. The library keys its index by it, and data
// kept outside the project (ELABORA_DATA_DIR) is found by it.
export function projectId(projectDir: string): string {
  const file = path.join(toolDir(projectDir), ID_FILE);
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(id)) return id;
  } catch { /* not created yet */ }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${id}\n`, { flag: 'w' });
  return id;
}

// The project's tool folder.
export const TOOL_DIR = '.elabora';
export const toolDir = (projectDir: string): string => path.join(path.resolve(projectDir), TOOL_DIR);

// The user's local application data for Elabora: never roamed or synced by the operating system.
// ELABORA_LOCAL_DATA_DIR puts it elsewhere: the test suites and the app's test launches give one of
// their own, so that no run creates, reads or writes the author's.
export function localDataRoot(): string {
  if (process.env.ELABORA_LOCAL_DATA_DIR) return path.resolve(process.env.ELABORA_LOCAL_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Elabora');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Elabora');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'elabora');
}
