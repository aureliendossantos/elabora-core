import type { Op } from './types.ts';

// Why an operation cannot apply. Callers branch on code; messages name the file and path. The codes
// are in the diagnostics catalogue (diagnostics/codes.ts), with a fix for agents.
//   E_OP_TARGET_MISSING  the file, key, element or anchor is not there
//   E_OP_DUPLICATE       the element to insert or move is already in the target array
//   E_OP_NOT_KEYED       { id } or insert on an array that is not keyed, or an element of the wrong kind
//   E_OP_NOT_JSON        a path operation on a file that is not a parsed JSON document
//   E_OP_INVALID         a malformed operation (unset of an element, move into itself, id changed…)
export type OpErrorCode = 'E_OP_TARGET_MISSING' | 'E_OP_DUPLICATE' | 'E_OP_NOT_KEYED' | 'E_OP_NOT_JSON' | 'E_OP_INVALID';

export class OpError extends Error {
  readonly code: OpErrorCode;
  readonly op: Op | undefined;

  constructor(code: OpErrorCode, message: string, op?: Op) {
    super(message);
    this.name = 'OpError';
    this.code = code;
    this.op = op;
  }
}
