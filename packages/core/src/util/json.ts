import { sha256 } from './sha256.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Canonical JSON: sorted keys, no whitespace. Used for hashes so that formatting never changes them.
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(record[k])}`).join(',')}}`;
}

export { sha256 };

export type ParsedJSON = { value: unknown; error?: undefined } | { value?: undefined; error: string };

// Parses JSON and reports errors with line and column, which agents can act on.
export function parseJSON(text: string): ParsedJSON {
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const m = /position (\d+)/.exec(message);
    let where = '';
    if (m) {
      const pos = Number(m[1]);
      const before = text.slice(0, pos);
      const line = before.split('\n').length;
      const col = pos - before.lastIndexOf('\n');
      where = ` (line ${line}, column ${col})`;
    }
    return { error: `${message}${where}` };
  }
}

// Stable formatting for every file Elabora writes: 2-space indentation, final newline.
export function stringifyJSON(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

// JSON Pointer helpers (RFC 6901)
export function pointer(...parts: (string | number)[]): string {
  return parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

export function getAtPointer(obj: unknown, ptr: string): unknown {
  if (!ptr) return obj;
  return ptr.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')).reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}
