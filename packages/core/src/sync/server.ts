import type { Files, Op } from '../ops/types.ts';
import { invertOps, touchedFiles } from '../ops/apply.ts';
import { OpError } from '../ops/errors.ts';
import { rebase } from './rebase.ts';
import type { Committed, Refusal, Submission } from './protocol.ts';

// What the server of a project does with a submitted change (D73), pure: the room (elabora-cloud)
// keeps the files, the head and the log, and calls this for each submission in the order they come.

export interface RoomState {
  head: number;              // the number of the last placed change (0: none yet)
  files: Files;              // the project at head
  log: readonly Committed[]; // placed changes, oldest first: at least those after the oldest base it accepts
}

export interface AcceptOptions {
  now?: () => string;
  // The project validation of the room: a message when the files after the change must be refused
  // (an error the project did not have). Without it, nothing is validated.
  validate?: (after: Files, context: { before: Files; touched: string[]; concurrent: boolean }) => string | null;
}

export type Accepted =
  | { committed: Committed; files: Files; duplicate: boolean }
  | { refusal: Refusal };

export function acceptChange(state: RoomState, submission: Submission, options: AcceptOptions = {}): Accepted {
  const refuse = (code: Refusal['code'], message: string): Accepted => ({ refusal: { id: String(submission?.id), code, message } });
  const malformed = malformedReason(submission);
  if (malformed) return refuse('E_SYNC_MALFORMED', malformed);
  // A change sent again (its acknowledgement was lost): placed once, acknowledged again.
  const placed = state.log.find((change) => change.id === submission.id);
  if (placed) return { committed: placed, files: state.files, duplicate: true };
  const oldest = state.log.length ? state.log[0].seq - 1 : state.head;
  if (submission.base > state.head || submission.base < oldest) {
    return refuse('E_SYNC_BASE', `Change ${submission.id} was computed on ${submission.base}; the server is at ${state.head} and keeps changes from ${oldest}`);
  }
  const since = state.log.filter((change) => change.seq > submission.base);
  let result;
  try {
    result = rebase(state.files, submission, since);
  } catch (error) {
    if (error instanceof OpError) return refuse('E_SYNC_MALFORMED', error.message);
    throw error;
  }
  if (result.refusal) return refuse(result.refusal.code, result.refusal.message);
  const touched = touchedFiles(result.ops);
  const problem = options.validate && result.ops.length ? options.validate(result.files, { before: state.files, touched, concurrent: since.length > 0 }) : null;
  if (problem) return refuse('E_SYNC_INVALID', problem);
  const committed: Committed = {
    seq: state.head + 1,
    id: submission.id,
    base: submission.base,
    at: options.now?.() ?? submission.at,
    author: submission.author,
    batch: submission.batch ?? submission.id,
    ...(submission.command ? { command: submission.command } : {}),
    ops: result.ops,
    inverse: invertOps(state.files, result.ops),
    skipped: result.skipped,
    overwrote: [...(Array.isArray(submission.overwrote) ? submission.overwrote : []), ...result.overwrote],
    ...(submission.undoes ? { undoes: submission.undoes } : {})
  };
  return { committed, files: result.files, duplicate: false };
}

// Submissions come from the network: their shape is checked before anything reads them. The
// operations themselves are checked as they apply (applyOp refuses a malformed one).
function malformedReason(submission: Submission): string | null {
  if (!submission || typeof submission !== 'object') return 'not a change';
  if (typeof submission.id !== 'string' || !submission.id || submission.id.length > 128) return 'id must be a string of at most 128 characters';
  if (!Number.isInteger(submission.base) || submission.base < 0) return 'base must be a change number';
  if (typeof submission.at !== 'string') return 'at must be a date';
  const author = submission.author as unknown;
  if (!author || typeof author !== 'object' || !['human', 'agent', 'external', 'system'].includes((author as { kind?: string }).kind as string)) return 'author must have a kind';
  if (submission.batch !== undefined && typeof submission.batch !== 'string') return 'batch must be a string';
  const isOps = (ops: unknown): ops is Op[] => Array.isArray(ops) && ops.every((op) => op && typeof op === 'object' && typeof (op as Op).file === 'string');
  if (!isOps(submission.ops) || !isOps(submission.inverse)) return 'ops and inverse must be lists of operations';
  if (submission.ops.length !== submission.inverse.length) return 'its inverse does not match its operations';
  return null;
}
