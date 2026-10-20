// JSON values, and the narrowing used where data crosses a boundary (postMessage, storage, the LMS).

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

// A plain object (not null, not an array): the shape of every message and record read from outside.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A field of any value, read as JavaScript reads it (undefined on null and undefined): payloads
// sent by free objects are not checked when their event declares no payload schema.
export function fieldOf(value: unknown, name: string): unknown {
  return value === null || value === undefined ? undefined : (Object(value) as Record<string, unknown>)[name];
}

// The Error of a JSON-RPC error answer ({ code, message }).
export function rpcError(error: unknown): Error {
  const message = fieldOf(error, 'message');
  return new Error(message === undefined ? undefined : String(message));
}
