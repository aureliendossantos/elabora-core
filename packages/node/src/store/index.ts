// The asynchronous Store of a course folder and snapshots read from any Store
// (docs/architecture.md, Store). The interface itself is in @elabora/core/project/store.
export { FsStore, watchFolders, type FsStoreOptions } from './fs-store.ts';
export { readSnapshot, readSourceFile, eachLimited, type StoreSnapshot, type ReadSnapshotOptions } from './snapshot.ts';
export { probeAssets, mediaStatus, isMediaAsset, type ProbedMedia } from './media.ts';
export type { Store, FileInfo } from '@elabora/core/project/store';
