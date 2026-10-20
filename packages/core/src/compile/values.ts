import { isRecord } from '@elabora/player/json';
import type { JsonObject, JsonValue } from '@elabora/player/json';

// Reading the open values of the documents: block props, prop values of free objects, layout props.
// The format types them unknown (each component declares its own props), and a screen being
// written may not follow its schema yet, so they are narrowed where they are read.

export { isRecord };

export const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
export const recordsOf = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
export const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
export const optionalTextOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
export const isText = (value: unknown): value is string => typeof value === 'string';
export const isNumber = (value: unknown): value is number => typeof value === 'number';
// An optional field: absent, or passing the check.
export const isOptional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);

// `value || fallback` for a number (0 is not a value there: a weight, a number of attempts, a height).
export const numberOr = <T>(value: unknown, fallback: T): number | T => (typeof value === 'number' && value ? value : fallback);

// The documents are JSON files, so their open values are JSON; only a missing value (undefined) is
// not, and JSON.stringify leaves it out.
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

// The JSON entries of a record, in order: what JSON.stringify writes of it.
export function jsonObjectOf(record: Record<string, unknown>): JsonObject {
  const object: JsonObject = {};
  for (const [key, value] of Object.entries(record)) if (isJsonValue(value)) object[key] = value;
  return object;
}
