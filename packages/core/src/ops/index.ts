// Operations, diffs, undo and batches: pure, no I/O (docs/architecture/operations.md).
export type {
  Json, JsonObject, Segment, Op, SetOp, UnsetOp, InsertOp, RemoveOp, MoveOp, WriteOp, WriteTextOp, WriteBlobOp, DeleteOp,
  TextFile, BinaryFile, FileContent, Files, Author, FileHash, Change, SkippedOp, ChangeEntry, UndoEntry, MarkEntry, ChangeLike, JournalEntry
} from './types.ts';
export { OpError, type OpErrorCode } from './errors.ts';
export { formatJson, textFile, jsonFile, binaryFile, makeFiles, documentOf, sameContent, isJsonPath, cloneJson, sameJson, equalJson } from './json.ts';
export { keyedKind, elementId, lookup, formatPath, describeTarget, type KeyedKind, type Lookup } from './path.ts';
export { applyOps, invertOps, touchedFiles } from './apply.ts';
export { diffFiles, diffDocuments } from './diff.ts';
export { undoChanges, type UndoResult, type UndoOptions } from './undo.ts';
export { BATCH_IDLE_MS, isAiAuthor, assignBatch, undoneChanges, changesToUndo, summarizeBatches, lastAiBatch, type BatchSummary } from './batch.ts';

