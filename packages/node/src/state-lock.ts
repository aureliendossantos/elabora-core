import path from 'node:path';
import { LOCK_FILE } from '@elabora/core/compile/state-model';
import type { StateLock } from '@elabora/core/compile/state-model';
import { writeJSONFile } from './util/fs.ts';

// elabora.lock.json is computed by the core (assignKeys, syncComponentVersions) and written here.
export function writeLock(dir: string, lock: StateLock): void {
  writeJSONFile(path.join(dir, LOCK_FILE), lock);
}
