import { CommandError } from '@elabora/core/commands/index';
import { OpError } from '@elabora/core/ops/errors';
import type { CommandDiagnostic } from '@elabora/core/commands/index';
import type { ErrorKind, ProtocolError } from '../protocol.ts';

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

// Any error as the protocol reports it: refusals of commands and of operations keep their catalogue
// code (a host adds its own: the desktop's lock and journal, errors.ts).
export function protocolError(error: unknown): ProtocolError {
  if (error instanceof EngineError) return withDetails({ kind: error.kind, message: error.message }, error.code, error.diagnostics);
  if (error instanceof CommandError) return withDetails({ kind: 'refused', message: error.message }, error.code ?? error.diagnostics[0]?.code, error.diagnostics);
  if (error instanceof OpError) return { kind: 'refused', message: error.message, code: error.code };
  return { kind: 'internal', message: error instanceof Error ? error.message : String(error) };
}

function withDetails(error: ProtocolError, code: string | undefined, diagnostics: CommandDiagnostic[]): ProtocolError {
  if (code) error.code = code;
  if (diagnostics.length) error.diagnostics = diagnostics;
  return error;
}

// A voice tool's error, for the app: what cannot be done here now (a model missing, the service out of
// reach) is not-available, what was not found not-found, the rest refused, each with its code.
export function toolError(error: unknown): unknown {
  if (error instanceof EngineError || !(error instanceof Error) || !('code' in error) || typeof error.code !== 'string' || !/^E_(VOICE|ALIGN|TRANSCRIBE|NARRATION)_/.test(error.code)) return error;
  const kind = /^E_(VOICE|ALIGN|TRANSCRIBE)_(DOWNLOAD|RUNTIME|NOT_INSTALLED|LANGUAGE|OFFLINE)$/.test(error.code) ? 'not-available' : /^E_(VOICE|ALIGN|NARRATION)_(SCREEN|LINE)$/.test(error.code) || error.code === 'E_VOICE_UNKNOWN' ? 'not-found' : 'refused';
  return new EngineError(kind, error.message, { code: error.code });
}
