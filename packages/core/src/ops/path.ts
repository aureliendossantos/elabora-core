import type { Json, Segment } from './types.ts';
import { hasKey, isObject } from './json.ts';

// The keyed-array rule. An array is keyed when all its elements are objects with distinct string
// ids, or all are distinct strings (matched by value). An empty array can become either. Other
// arrays are values: operations replace them whole.
export type KeyedKind = 'objects' | 'strings' | 'empty';

export function keyedKind(array: readonly Json[]): KeyedKind | null {
  if (!array.length) return 'empty';
  const seen = new Set<string>();
  if (typeof array[0] === 'string') {
    for (const element of array) {
      if (typeof element !== 'string' || seen.has(element)) return null;
      seen.add(element);
    }
    return 'strings';
  }
  for (const element of array) {
    if (!isObject(element) || typeof element.id !== 'string' || seen.has(element.id)) return null;
    seen.add(element.id);
  }
  return 'objects';
}

// The id of an element of a keyed array: an object's id, or the string itself.
export function elementId(element: Json | undefined): string | undefined {
  if (typeof element === 'string') return element;
  if (isObject(element) && typeof element.id === 'string') return element.id;
  return undefined;
}

export function indexOfId(array: readonly Json[], id: string): number {
  for (let i = 0; i < array.length; i++) if (elementId(array[i]) === id) return i;
  return -1;
}

// Whether an element can join a keyed array of this kind.
export function fitsKind(kind: KeyedKind, element: Json): boolean {
  if (kind === 'strings') return typeof element === 'string';
  if (kind === 'objects') return isObject(element) && typeof element.id === 'string';
  return elementId(element) !== undefined;
}

export function sameSegment(a: Segment, b: Segment): boolean {
  return typeof a === 'string' ? a === b : typeof b !== 'string' && a.id === b.id;
}

export function startsWith(path: readonly Segment[], prefix: readonly Segment[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => sameSegment(segment, path[i]));
}

// The child a segment selects, or undefined (also when { id } meets an array that is not keyed).
export function childOf(node: Json, segment: Segment): Json | undefined {
  if (typeof segment === 'string') return isObject(node) && hasKey(node, segment) ? node[segment] : undefined;
  if (!Array.isArray(node) || keyedKind(node) === null) return undefined;
  const index = indexOfId(node, segment.id);
  return index < 0 ? undefined : node[index];
}

export type Lookup = { found: true; value: Json } | { found: false; parentFound: boolean };

// The value at a path, without throwing: undo compares what is there with what a change wrote.
export function lookup(doc: Json | undefined, path: readonly Segment[]): Lookup {
  if (doc === undefined) return { found: false, parentFound: false };
  let node: Json = doc;
  for (let i = 0; i < path.length; i++) {
    const child = childOf(node, path[i]);
    if (child === undefined) return { found: false, parentFound: i === path.length - 1 };
    node = child;
  }
  return { found: true, value: node };
}

// For messages: blocks[intro-hook].props.title
export function formatPath(path: readonly Segment[]): string {
  let out = '';
  for (const segment of path) out += typeof segment === 'string' ? (out ? `.${segment}` : segment) : `[${segment.id}]`;
  return out;
}

export function describeTarget(file: string, path: readonly Segment[]): string {
  return path.length ? `${file} ${formatPath(path)}` : file;
}
