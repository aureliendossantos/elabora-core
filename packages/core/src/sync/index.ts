// Projects in the cloud (docs/architecture/sync.md): the protocol elabora-sync/1, rebase, the
// server's placing of a change and a copy's model. Pure, no I/O.
export {
  SYNC_PROTOCOL, type Submission, type Committed, type Refusal, type Overwrite, type Actor, type Presence,
  type ClientMessage, type ServerMessage, type SnapshotFile
} from './protocol.ts';
export { mergeJson, type MergeResult, type MergeConflict } from './merge.ts';
export { rebase, type RebaseInput, type RebaseResult } from './rebase.ts';
export { acceptChange, type RoomState, type AcceptOptions, type Accepted } from './server.ts';
export { SyncClient, type LocalChange, type Outcome } from './client.ts';
