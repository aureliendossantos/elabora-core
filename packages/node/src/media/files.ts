import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// File helpers of the media pipeline: atomic writes and renames that survive the sharing
// violations of Windows and sync services, names fit for packages.

export function writeFileAtomic(file: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, content);
  try {
    renameSyncWithRetry(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 5 || !RETRYABLE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      sleepSync(50 * (attempt + 1));
    }
  }
}

// Moves a finished output into place: one rename, so readers never see a partial file.
export async function moveIntoPlace(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EXDEV') {
        // Another volume (a temporary folder elsewhere): copy next to the target, then rename.
        const near = `${to}.${process.pid}.tmp`;
        await fs.promises.copyFile(from, near);
        await fs.promises.rm(from, { force: true });
        return moveIntoPlace(near, to);
      }
      if (attempt >= 5 || !RETRYABLE.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

// "Présentation du Réseau (v2).MOV" → "presentation-du-reseau-v2": portable in every LMS.
export function slugify(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || 'media';
}

export function toPosix(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

// A project-relative POSIX path that stays inside the project.
export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || relPath.includes('\\')) return false;
  return !path.posix.normalize(relPath).split('/').includes('..');
}
