// Project lock, journal and author detection (docs/architecture/operations.md, "Journal and lock").
export { LOCK_FILE, STALE_LOCK_MS, DEFAULT_LOCK_TIMEOUT_MS, LockError, lockPath, readLockHolder, isProjectLockHeld, withProjectLock, withProjectLockSync, type LockHolder, type LockOptions } from './lock.ts';
export {
  JOURNAL_DIR, JOURNAL_RETENTION_DAYS, JournalError, appendChange, appendUndo, appendMark, pruneJournal, readJournal, lastEntry, lastChanges,
  batchChanges, storeChangeBlobs, storeChangeBlobsSync, journalBlobReferences, contentHash, changeFileHashes, type NewChange, type NewUndo, type AppendOptions
} from './journal.ts';
export { detectAuthor } from './author.ts';
