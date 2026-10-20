import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// Smallest file worth cloning on macOS, where a clone costs starting cp (as in blobs.ts).
const MAC_CLONE_MIN_BYTES = 256 << 10;

// Copies a file synchronously into `target` (which must not exist), as a clone that shares its disk
// blocks where the file system allows it: the synchronous counterpart of cloneFile in blobs.ts, for
// writers that run synchronously (the CLI's edits). Node 24 does not clone on macOS, so large files
// go through cp -c there.
export function copyFileCloneSync(source: string, target: string): void {
  if (process.platform === 'darwin' && fs.statSync(source).size >= MAC_CLONE_MIN_BYTES) {
    try {
      execFileSync('/bin/cp', ['-c', '--', source, target], { stdio: 'ignore' });
      return;
    } catch {
      fs.rmSync(target, { force: true });
    }
  }
  fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
}
