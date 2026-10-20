import { CommandError } from '@elabora/core/commands/index';
import { LockError } from '@elabora/node/journal/lock';
import { JournalError } from '@elabora/node/journal/journal';
import { OpError } from '@elabora/core/ops/errors';
import type { CommandDiagnostic } from '@elabora/core/commands/index';
import type { ErrorKind, ProtocolError } from './protocol.ts';

// Errors of the engine's API, with the kind the protocol reports.
export class EngineError extends Error {
  readonly kind: ErrorKind;
  readonly code: string | undefined;
  readonly diagnostics: CommandDiagnostic[];

  constructor(kind: ErrorKind, message: string, options: { code?: string; diagnostics?: CommandDiagnostic[] } = {}) {
    super(message);
    this.name = 'EngineError';
    this.kind = kind;
    this.code = options.code;
    this.diagnostics = options.diagnostics ?? [];
  }
}

// Any error as the protocol reports it: refusals of commands, of the lock and of operations keep
// their catalogue code.
export function protocolError(error: unknown): ProtocolError {
  if (error instanceof EngineError) return withDetails({ kind: error.kind, message: error.message }, error.code, error.diagnostics);
  if (error instanceof CommandError) return withDetails({ kind: 'refused', message: error.message }, error.code ?? error.diagnostics[0]?.code, error.diagnostics);
  if (error instanceof LockError || error instanceof JournalError || error instanceof OpError) return { kind: 'refused', message: error.message, code: error.code };
  return { kind: 'internal', message: error instanceof Error ? error.message : String(error) };
}

function withDetails(error: ProtocolError, code: string | undefined, diagnostics: CommandDiagnostic[]): ProtocolError {
  if (code) error.code = code;
  if (diagnostics.length) error.diagnostics = diagnostics;
  return error;
}
