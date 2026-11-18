import { LockError } from '@elabora/node/journal/lock';
import { JournalError } from '@elabora/node/journal/journal';
import { protocolError as baseError } from './base/errors.ts';
import type { ProtocolError } from './protocol.ts';

export { EngineError } from './base/errors.ts';

// Any error as the desktop's session reports it: the base's (base/errors.ts), and the refusals of the
// project's lock and journal with their catalogue code.
export function protocolError(error: unknown): ProtocolError {
  if (error instanceof LockError || error instanceof JournalError) return { kind: 'refused', message: error.message, code: error.code };
  return baseError(error);
}
