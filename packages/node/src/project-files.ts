import fs from 'node:fs';
import path from 'node:path';
import { isSourcePath, isTextPath } from '@elabora/core/project/files';
import type { SyncArtefact } from '@elabora/core/project/files';

// Which files of a course folder are the course. Shared by the file store (snapshots), the
// backups and the watcher, so that they all agree on what a project is.

export interface FileInfo {
  path: string; // project-relative, POSIX separators
  size: number;
  mtimeMs: number;
}

export type { SyncArtefact };

// Tool folders: never content. dist/ holds builds, .elabora/ the journal, caches and backups.
const IGNORED_DIRS = new Set(['.elabora', 'dist', 'node_modules', '.git', '.svn', '.hg']);
const IGNORED_FILES = /^(\.DS_Store|Thumbs\.db|desktop\.ini|Icon\r|\.~lock\..*#|~\$.*)$/;
const TEMP_FILES = /\.(tmp|swp|part|crdownload)$|~$/;

// sources/ at the top of the folder holds the author's sources (D49, sources/index.ts): not the
// course, so never in a snapshot, a backup, the journal or a package, and never written by a restore.

// Text files are loaded with their text in a snapshot; the core owns the list.
export const isTextFile = isTextPath;

// True when a project-relative POSIX path can never be course content: inside a tool folder, or an
// OS or temporary file. Writers that take paths from stored data (restore) check it.
export function isIgnoredPath(p: string): boolean {
  const segments = p.split('/');
  const name = segments[segments.length - 1];
  return segments.some((s) => IGNORED_DIRS.has(s)) || IGNORED_FILES.test(name) || TEMP_FILES.test(name) || isSourcePath(p);
}

export interface ListOptions {
  // Entries that are not listed: symbolic links (never followed, so nothing outside the project is
  // read) and entries that cannot be read. When given, an unreadable folder or file is reported here
  // instead of failing the whole listing.
  onSkipped?: (path: string, reason: 'symlink' | 'unreadable', error?: NodeJS.ErrnoException) => void;
}

// Every file of the course folder, sorted, with sync-service artefacts set apart.
export function listProjectFiles(dir: string, options: ListOptions = {}): { files: FileInfo[]; artefacts: SyncArtefact[] } {
  const root = path.resolve(dir);
  const found: FileInfo[] = [];
  const { onSkipped } = options;
  const walk = (abs: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if (!onSkipped || !rel) throw e;
      onSkipped(rel, 'unreadable', e as NodeJS.ErrnoException);
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !isSourcePath(childRel)) walk(path.join(abs, e.name), childRel);
      } else if (e.isFile() && !IGNORED_FILES.test(e.name) && !TEMP_FILES.test(e.name) && !isSourcePath(childRel)) {
        let st: fs.Stats;
        try {
          st = fs.statSync(path.join(abs, e.name));
        } catch (error) {
          if (!onSkipped) throw error;
          // Deleted since the folder was read: not a file of the project any more.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onSkipped(childRel, 'unreadable', error as NodeJS.ErrnoException);
          continue;
        }
        found.push({ path: childRel, size: st.size, mtimeMs: st.mtimeMs });
      } else if (onSkipped && e.isSymbolicLink() && !isSourcePath(childRel) && !IGNORED_DIRS.has(e.name) && !IGNORED_FILES.test(e.name) && !TEMP_FILES.test(e.name)) {
        onSkipped(childRel, 'symlink');
      }
    }
  };
  walk(root, '');
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = new Set(found.map((f) => f.path));
  const files: FileInfo[] = [];
  const artefacts: SyncArtefact[] = [];
  for (const f of found) {
    const a = syncArtefact(f.path, paths);
    if (a) artefacts.push(a);
    else files.push(f);
  }
  return { files, artefacts };
}

// Conflict copies made by sync services next to the file they duplicate:
//   Dropbox   "intro (conflicted copy 2026-10-06).json", localised ("copie en conflit", "Konflikt…")
//   OneDrive  "intro-DESKTOP-4F2K9.json" (the computer name, upper case)
//   iCloud    "intro 2.json"; Google Drive "intro (1).json"
// and iCloud placeholders of files not downloaded yet (".intro.json.icloud").
export function syncArtefact(p: string, existing: ReadonlySet<string>): SyncArtefact | null {
  const dir = path.posix.dirname(p);
  const base = path.posix.basename(p);
  const join = (name: string) => (dir === '.' ? name : `${dir}/${name}`);
  const icloud = /^\.(.+)\.icloud$/.exec(base);
  if (icloud) return { path: p, kind: 'cloud-placeholder', original: join(icloud[1]) };
  const ext = path.posix.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const suffixes = [/ \([^)]*(conflict|conflit|konflikt|conflicto|conflitto)[^)]*\)$/i, / \(\d+\)$/, / \d+$/, /-[A-Z0-9][A-Z0-9-]{2,}$/];
  for (const s of suffixes) {
    const m = s.exec(stem);
    if (!m) continue;
    const original = join(`${stem.slice(0, m.index)}${ext}`);
    if (original !== p && existing.has(original)) return { path: p, kind: 'conflict-copy', original };
  }
  return null;
}
