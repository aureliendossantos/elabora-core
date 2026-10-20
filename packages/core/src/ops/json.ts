import type { BinaryFile, FileContent, Json, JsonObject, TextFile } from './types.ts';

export function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasKey(object: JsonObject, key: string): boolean {
  return Object.hasOwn(object, key);
}

// Assigning "__proto__" would change the prototype instead of adding a key.
export function setKey(object: JsonObject, key: string, value: Json): void {
  if (key === '__proto__') Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
  else object[key] = value;
}

// JavaScript enumerates keys that look like array indexes first, whatever the insertion order, so
// placing such a key is meaningless.
export function isIndexKey(key: string): boolean {
  return /^(0|[1-9]\d{0,9})$/.test(key) && Number(key) < 4294967295;
}

export function cloneJson(value: Json): Json {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const out: JsonObject = {};
  for (const key of Object.keys(value)) setKey(out, key, cloneJson(value[key]));
  return out;
}

// Equal values with the same key order: the same text once formatted.
export function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i] || !sameJson(a[aKeys[i]], b[bKeys[i]])) return false;
  }
  return true;
}

// Equal values, whatever the key order: what undo compares, since key order means nothing.
export function equalJson(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equalJson(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) if (!hasKey(b, key) || !equalJson(a[key], b[key])) return false;
  return true;
}

// How Elabora writes every JSON file: 2-space indentation, key order kept, final newline.
export function formatJson(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function isJsonPath(path: string): boolean {
  return /\.json$/i.test(path);
}

// A text file; a .json file that parses also carries its value.
export function textFile(path: string, text: string): TextFile {
  if (!isJsonPath(path)) return { kind: 'text', text };
  try {
    return { kind: 'text', text, json: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Json };
  } catch {
    return { kind: 'text', text };
  }
}

export function jsonFile(value: Json): TextFile {
  return { kind: 'text', text: formatJson(value), json: value };
}

export function binaryFile(hash: string, size?: number): BinaryFile {
  return size === undefined ? { kind: 'binary', hash } : { kind: 'binary', hash, size };
}

// Parsed documents of snapshot files that do not carry their value: parsed once per file object.
// Values handed out are shared, so nothing may change them (operations clone before editing).
const parsed = new WeakMap<object, { value: Json | undefined }>();

// The parsed document of a JSON file, or undefined when the file is missing, binary or does not parse.
export function documentOf(path: string, file: FileContent | undefined): Json | undefined {
  if (!file || file.kind !== 'text') return undefined;
  if (file.json !== undefined) return file.json;
  if (!isJsonPath(path)) return undefined;
  let entry = parsed.get(file);
  if (!entry) {
    entry = { value: textFile(path, file.text).json };
    parsed.set(file, entry);
  }
  return entry.value;
}

export function sameContent(a: FileContent | undefined, b: FileContent | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind === 'text') return b.kind === 'text' && a.text === b.text;
  if (b.kind !== 'binary') return false;
  const hash = a.hash;
  return hash !== undefined && hash === b.hash;
}

// Files from plain text (JSON files are parsed) or ready-made contents, for callers and tests.
export function makeFiles(entries: Record<string, string | FileContent>): Map<string, FileContent> {
  const files = new Map<string, FileContent>();
  for (const path of Object.keys(entries).sort()) {
    const entry = entries[path];
    files.set(path, typeof entry === 'string' ? textFile(path, entry) : entry);
  }
  return files;
}
