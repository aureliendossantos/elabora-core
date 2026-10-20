// Backups: versions of a project in .elabora/backups/, contents in the shared blob store
// (docs/architecture/storage.md, Backups). The user never sees git; they see versions.
export { createVersion, shouldTakeVersion, type CreateVersionOptions } from './create.ts';
export { restore, type RestoreOptions } from './restore.ts';
export { prune, collectGarbage, deleteVersion, nameVersion, type PruneOptions, type ExtraReferences } from './prune.ts';
export { listVersions, readVersion, findVersion, diffVersions, status, BACKUPS_DIR, VERSIONS_DIR } from './store.ts';
export { retentionPlan, type RetentionInput, type RetentionPlan } from './retention.ts';
export { withBackupsLock, BackupsLockedError, LOCK_FILE } from './lock.ts';
export { HashCache, HASH_CACHE_FILE } from './hash-cache.ts';
export type { SkipOption } from './capture.ts';
export type * from './types.ts';
export { VERSION_REASONS } from './types.ts';
