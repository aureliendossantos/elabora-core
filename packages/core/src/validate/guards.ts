// Checks run on projects whose documents fail their schemas too (the schema check reports them), so
// they read documents through these guards instead of trusting the declared types: a list that is
// not an array reads as empty, a record that is not an object has no fields.

import { isRecord } from '../util/values.ts';

export { isRecord };

// The fields of a value read from a document (none when it is not an object).
export const fieldsOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

// A list the format requires (typed) or a prop value (unknown): anything but an array is empty.
export function list<T>(value: readonly T[] | null | undefined): readonly T[];
export function list(value: unknown): readonly unknown[];
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

// A string prop value; anything else reads as no text.
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

// Length of a string or a list, NaN otherwise: comparisons with it are false, as with the
// undefined length of other values.
export const lengthOf = (value: unknown): number => (typeof value === 'string' || Array.isArray(value) ? value.length : NaN);

// Looks up an id read from a document. Ids are strings once the schema passes; before that the key
// is whatever the document holds, and only an equal key matches.
export function byId<V>(map: ReadonlyMap<string, V>, id: unknown): V | undefined {
  const anyKey: ReadonlyMap<unknown, V> = map;
  return anyKey.get(id);
}
export function hasId<K>(collection: ReadonlyMap<K, unknown> | ReadonlySet<K>, id: unknown): boolean {
  const anyKey: ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> = collection;
  return anyKey.has(id);
}

// Object.entries of a document value as JavaScript gives them (a string gives its characters).
export function entriesOf(value: unknown): [string, unknown][] {
  return value === null || value === undefined ? [] : Object.entries(value);
}

// A value read from a document, named as the target of a finding: ids are strings once the schema
// passes; other values are written as text.
export const targetOf = (value: unknown): string | undefined => (value === undefined || typeof value === 'string' ? value : String(value));
