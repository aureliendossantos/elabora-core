import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { blobPath, cloneFile, hashFile, hasBlob, type BlobHash } from '../blobs.ts';
import { listProjectFiles } from '../project-files.ts';
import { takeVersion } from './create.ts';
import { skipPredicate, type SkipOption } from './capture.ts';
import { withBackupsLock } from './lock.ts';
import { readVersion } from './store.ts';
import type { Author, RestoreResult } from './types.ts';

export interface RestoreOptions {
  // Files, folders or glob patterns (project-relative). A partial restore writes the matching files
  // of the version and never deletes anything.
  paths?: string[];
  skip?: SkipOption; // as for createVersion, for the version taken before restoring
  now?: Date | number;
  author?: Author | null;
  batch?: string | null;
  clone?: boolean;
}

const isGlob = (p: string): boolean => /[*?[\]{}]/.test(p);

function selector(patterns: string[]) {
  const normalized = patterns.map((p) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''));
  const used = new Set<string>();
  const match = (p: string): boolean => {
    let any = false;
    for (const pattern of normalized) {
      if (pattern === '' || pattern === '.' || p === pattern || p.startsWith(`${pattern}/`) || (isGlob(pattern) && path.posix.matchesGlob(p, pattern))) {
        used.add(pattern);
        any = true;
      }
    }
    return any;
  };
  return { match, unmatched: () => normalized.filter((p) => !used.has(p)) };
}

// Windows refuses to replace or delete a file another program has open (antivirus, sync client,
// preview): wait a little and try again.
async function retrying<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const transient = code === 'EBUSY' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
      if (!transient || attempt >= 6) throw e;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

// Whether a folder on the way to a project file is a symbolic link: writing through it would write
// outside the project.
function throughSymlink(projectDir: string, rel: string): boolean {
  let current = projectDir;
  for (const segment of rel.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    const st = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

// Writes a blob to a project file atomically (temporary file in the same folder, then rename), as a
// clone when possible, after checking that the copy still has the recorded content.
async function writeFromBlob(projectDir: string, rel: string, hash: BlobHash, clone: boolean): Promise<'written' | 'damaged'> {
  const abs = path.join(projectDir, ...rel.split('/'));
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const blob = blobPath(projectDir, hash);
    if (!(clone && (await cloneFile(blob, tmp)))) await fs.promises.copyFile(blob, tmp);
    if ((await hashFile(tmp)) !== hash) {
      await fs.promises.rm(tmp, { force: true });
      return 'damaged';
    }
    // A clone keeps the time of the original file; a restored file is a new change for editors,
    // sync services and the hash cache.
    const now = new Date();
    await fs.promises.utimes(tmp, now, now);
    await retrying(() => fs.promises.rename(tmp, abs));
    return 'written';
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}

// Removes the folders a full restore emptied, up to the project folder.
function removeEmptyFolders(projectDir: string, deleted: string[]): void {
  const folders = new Set<string>();
  for (const p of deleted) {
    const segments = p.split('/');
    for (let i = segments.length - 1; i > 0; i--) folders.add(segments.slice(0, i).join('/'));
  }
  for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(path.join(projectDir, ...folder.split('/')));
    } catch {
      // not empty, or already gone
    }
  }
}

// Restores a version. A version of the current state is taken first (reason `restore`), so a
// restore can always be undone by restoring that version. A full restore makes the project match
// the version: it writes the files that differ and deletes the project files the version does not
// have (never anything in .elabora/, dist/ or other tool folders, nor files the version lists as
// skipped: they existed then). Returns what changed per file, for the journal.
export async function restore(projectDir: string, ref: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  return withBackupsLock(projectDir, 'restore', async () => {
    const target = readVersion(projectDir, ref);
    const selection = options.paths ? selector(options.paths) : null;
    const clone = options.clone !== false;
    const recorded = { ...target.trimmed, ...target.files };
    const selected = Object.keys(recorded).filter((p) => !selection || selection.match(p)).sort();

    let toDelete: string[] = [];
    if (!selection) {
      const presentThen = new Set(target.skipped.filter((s) => s.reason !== 'conflict-copy').map((s) => s.path));
      const { files } = listProjectFiles(projectDir, { onSkipped: () => {} });
      toDelete = files.map((f) => f.path).filter((p) => !(p in recorded) && !presentThen.has(p));
    }

    // Files about to be overwritten or deleted are saved even when the caller skips them.
    const touched = new Set([...selected, ...toDelete]);
    const skip = skipPredicate(options.skip);
    const { version: saved, previous, capture } = await takeVersion(projectDir, {
      reason: 'restore',
      skip: (p) => skip(p) && !touched.has(p),
      now: options.now,
      author: options.author,
      batch: options.batch,
      clone,
    });

    const result: RestoreResult = {
      version: target.id,
      before: saved?.id ?? previous?.id ?? null,
      changes: [],
      unavailable: [],
      kept: [],
      failed: [],
      unmatched: selection ? selection.unmatched() : [],
    };
    const skippedReason = (p: string) => capture.skipped.find((s) => s.path === p)?.reason ?? 'unreadable';

    // Deletions first: a path that was a file in the version may be a folder now, or the reverse.
    const deleted: string[] = [];
    for (const p of toDelete) {
      if (!capture.current.has(p)) {
        if (capture.present.has(p)) result.kept.push({ path: p, reason: skippedReason(p) });
        continue;
      }
      try {
        await retrying(() => fs.promises.unlink(path.join(projectDir, ...p.split('/'))));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') result.failed.push({ path: p, error: code ?? (e as Error).message });
        continue;
      }
      deleted.push(p);
      result.changes.push({ path: p, before: capture.files.get(p)!.hash, after: null });
    }
    removeEmptyFolders(projectDir, deleted);

    for (const p of selected) {
      const entry = recorded[p];
      const current = capture.current.has(p) ? capture.files.get(p)!.hash : null;
      if (current === entry.hash) continue;
      if (capture.present.has(p) && current === null) {
        result.kept.push({ path: p, reason: skippedReason(p) });
        continue;
      }
      if (throughSymlink(projectDir, p)) {
        result.kept.push({ path: p, reason: 'symlink' });
        continue;
      }
      if (!hasBlob(projectDir, entry.hash)) {
        result.unavailable.push({ path: p, reason: p in target.trimmed ? 'trimmed' : 'missing' });
        continue;
      }
      try {
        if ((await writeFromBlob(projectDir, p, entry.hash, clone)) === 'damaged') {
          result.unavailable.push({ path: p, reason: 'damaged' });
          continue;
        }
      } catch (e) {
        result.failed.push({ path: p, error: (e as NodeJS.ErrnoException).code ?? (e as Error).message });
        continue;
      }
      result.changes.push({ path: p, before: current, after: entry.hash });
    }
    result.changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return result;
  });
}
