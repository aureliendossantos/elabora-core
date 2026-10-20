// Narrowing of values that cross a boundary untyped: JSON read from disk or posted by a page,
// results of page.evaluate, modules imported at run time.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// value[key] when value is an object, else undefined: reads nested JSON without casts.
export function fieldOf(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
