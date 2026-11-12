import type { Json, JsonObject, Segment } from '../ops/types.ts';
import { cloneJson, equalJson, hasKey, isObject, setKey } from '../ops/json.ts';
import { elementId, keyedKind } from '../ops/path.ts';

// Three-way merge of JSON values: base, what is there now (head), and what a change wants (mine).
// What only one side changed is taken from that side; where both changed the same value
// differently, the side named by `wins` is kept and the place is reported. Objects merge key by
// key, keyed arrays element by element (by id), other arrays of one length position by position.
// That is how a change written as a whole value (an array without ids, a document a diff could not
// split, a JSON file written as text) keeps what others wrote beside it (D74).

export interface MergeConflict {
  path: Segment[];       // relative to the merged value; positions in arrays without ids are keys "0", "1"…
  head: Json | undefined; // undefined: absent
  mine: Json | undefined;
}

export interface MergeResult {
  value: Json | undefined; // undefined: absent (mine or head removed it)
  conflicts: MergeConflict[];
}

export function mergeJson(base: Json | undefined, head: Json | undefined, mine: Json | undefined, wins: 'mine' | 'head'): MergeResult {
  const conflicts: MergeConflict[] = [];
  const value = merge(base, head, mine, wins, [], conflicts);
  return { value, conflicts };
}

const same = (a: Json | undefined, b: Json | undefined): boolean => (a === undefined || b === undefined ? a === b : equalJson(a, b));

function merge(base: Json | undefined, head: Json | undefined, mine: Json | undefined, wins: 'mine' | 'head', path: Segment[], conflicts: MergeConflict[]): Json | undefined {
  if (same(head, base) || same(mine, head)) return copy(mine);
  if (same(mine, base)) return copy(head);
  if (isObject(base) && isObject(head) && isObject(mine)) return mergeObjects(base, head, mine, wins, path, conflicts);
  if (Array.isArray(base) && Array.isArray(head) && Array.isArray(mine)) {
    const kinds = [keyedKind(base), keyedKind(head), keyedKind(mine)];
    if (kinds.every((kind) => kind === 'objects' || kind === 'empty') && kinds.some((kind) => kind === 'objects')) return mergeKeyed(base, head, mine, wins, path, conflicts);
    if (kinds.every((kind) => kind === null) && base.length === head.length && base.length === mine.length) {
      return base.map((element, i) => merge(element, head[i], mine[i], wins, [...path, String(i)], conflicts) ?? null);
    }
  }
  conflicts.push({ path, head, mine });
  return copy(wins === 'mine' ? mine : head);
}

const copy = (value: Json | undefined): Json | undefined => (value === undefined ? undefined : cloneJson(value));

// Keys in head's order; a key only mine added goes after the key it follows in mine.
function mergeObjects(base: JsonObject, head: JsonObject, mine: JsonObject, wins: 'mine' | 'head', path: Segment[], conflicts: MergeConflict[]): JsonObject {
  const order = [...Object.keys(head)];
  let previous: string | null = null;
  for (const key of Object.keys(mine)) {
    if (!order.includes(key)) order.splice(previous === null ? 0 : order.indexOf(previous) + 1, 0, key);
    previous = key;
  }
  for (const key of Object.keys(base)) if (!order.includes(key)) order.push(key);
  const out: JsonObject = {};
  for (const key of order) {
    const value = merge(at(base, key), at(head, key), at(mine, key), wins, [...path, key], conflicts);
    if (value !== undefined) setKey(out, key, value);
  }
  return out;
}

const at = (object: JsonObject, key: string): Json | undefined => (hasKey(object, key) ? object[key] : undefined);

// Elements by id, in head's order; an element only mine added goes after the one it follows in
// mine. An element removed on one side and changed on the other is a conflict.
function mergeKeyed(base: Json[], head: Json[], mine: Json[], wins: 'mine' | 'head', path: Segment[], conflicts: MergeConflict[]): Json[] {
  const byId = (array: Json[]) => new Map(array.map((element) => [elementId(element) as string, element]));
  const b = byId(base);
  const h = byId(head);
  const m = byId(mine);
  const order = head.map((element) => elementId(element) as string);
  let previous: string | null = null;
  for (const element of mine) {
    const id = elementId(element) as string;
    if (!order.includes(id) && !b.has(id)) order.splice(previous === null ? 0 : order.indexOf(previous) + 1, 0, id);
    if (order.includes(id)) previous = id;
  }
  for (const element of base) {
    const id = elementId(element) as string;
    if (!order.includes(id) && m.has(id)) order.push(id); // head removed it: merge says whether mine's edit keeps it
  }
  const out: Json[] = [];
  for (const id of order) {
    const value = merge(b.get(id), h.get(id), m.get(id), wins, [...path, { id }], conflicts);
    if (value !== undefined) out.push(value);
  }
  return out;
}
