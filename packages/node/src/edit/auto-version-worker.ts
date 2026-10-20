import { createVersion } from '../backups/index.ts';
import { newestVersion } from '../backups/store.ts';
import { pruneProjectData } from '../project-data.ts';
import type { AutoVersion, WorkerTask } from './auto-version.ts';

// The task of a worker thread for auto-version.ts. The thread's bootstrap (there) imports this
// module, runs the task and wakes the waiting thread with the outcome or the error.
export async function runTask(task: WorkerTask): Promise<AutoVersion> {
  if (task.kind === 'version') {
    const version = await createVersion(task.dir, { reason: task.reason, author: task.author, skip: task.skip });
    // Nothing changed since the newest version: for a version asked for a reason, that one holds the files.
    return { version: version?.id ?? (task.reason === 'auto' ? null : newestVersion(task.dir)?.id ?? null) };
  }
  await pruneProjectData(task.dir);
  return { version: null };
}
