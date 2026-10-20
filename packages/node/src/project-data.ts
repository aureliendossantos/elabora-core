import { pruneJournal, journalBlobReferences } from './journal/index.ts';
import { prune } from './backups/index.ts';
import type { PruneResult } from './backups/index.ts';
import { pruneRenditions } from './media/renditions.ts';

// Prunes what a project's machine-local data keeps over time: the journal (30 days), the backups
// (retention, then garbage collection of the blob store) and the renditions no package can use. The journal goes first and its
// blobs are passed to the collection, so that undo never loses the contents it restores: one
// helper, so that no caller forgets them. Takes the project lock (journal), then the backups lock.
export async function pruneProjectData(dir: string, options: { now?: Date } = {}): Promise<{ journal: { removed: number }; backups: PruneResult; renditions: { removed: number; bytesFreed: number } }> {
  const journal = pruneJournal(dir, { now: options.now });
  const backups = await prune(dir, { now: options.now, extraReferences: () => journalBlobReferences(dir) });
  const renditions = await pruneRenditions(dir, { now: options.now });
  return { journal, backups, renditions };
}
