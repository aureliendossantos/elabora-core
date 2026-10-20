import { isRecord } from '@elabora/player/json';

// Projects are loaded even when their documents fail their schemas (the validator reports them,
// and the engine loads files an agent is still writing), so code that walks documents reads their
// lists through these guards instead of trusting the declared types.

export { isRecord };

// A list of the format: anything but an array reads as empty.
export function listOf<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

// The objects of a list of the format (blocks, layers, events, options…): other entries fail the
// schema and are skipped.
export function objectsIn<T>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? value.filter((item: T) => isRecord(item)) : [];
}
