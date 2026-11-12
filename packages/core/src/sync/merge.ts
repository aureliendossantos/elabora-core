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
    if (kinds.every((kind) => kind === 'strings' || kind === 'empty') && kinds.some((kind) => kind === 'strings')) return mergeStrings(base as string[], head as string[], mine as string[]);
    if (kinds.every((kind) => kind === null || kind === 'empty')) {
      if (base.length === head.length && base.length === mine.length) {
        return base.map((element, i) => merge(element, head[i], mine[i], wins, [...path, String(i)], conflicts) ?? null);
      }
      const spliced = mergeSequence(base, head, mine);
      if (spliced) return spliced;
    }
  }
  conflicts.push({ path, head, mine });
  return copy(wins === 'mine' ? mine : head);
}

const copy = (value: Json | undefined): Json | undefined => (value === undefined ? undefined : cloneJson(value));

// An array without ids that each side changed in one stretch (elements added at its end, one
// removed, a few replaced): when the stretches do not overlap, both apply. Two additions at the
// same place both go in, head's first. null: they overlap.
function mergeSequence(base: Json[], head: Json[], mine: Json[]): Json[] | null {
  const h = stretch(base, head);
  const m = stretch(base, mine);
  const empty = (x: Stretch) => x.from === x.to;
  const inside = (p: number, x: Stretch) => x.from < p && p < x.to;
  if (!empty(h) && !empty(m) ? h.from < m.to && m.from < h.to : empty(h) && !empty(m) ? inside(h.from, m) : !empty(h) && empty(m) ? inside(m.from, h) : false) return null;
  const headFirst = h.from < m.from || (h.from === m.from && (empty(h) || !empty(m)));
  const [first, second] = headFirst ? [h, m] : [m, h];
  return [...base.slice(0, first.from), ...first.elements, ...base.slice(first.to, second.from), ...second.elements, ...base.slice(second.to)].map(cloneJson);
}

// A keyed array of strings (a section's screens) by value: what one side removed goes, what one
// side added goes after the string it follows on that side, in head's order.
function mergeStrings(base: string[], head: string[], mine: string[]): string[] {
  const removed = new Set([...base.filter((id) => !head.includes(id) || !mine.includes(id))]);
  const out = head.filter((id) => !removed.has(id));
  let previous: string | null = null;
  for (const id of mine) {
    if (!out.includes(id) && !removed.has(id)) out.splice(previous === null ? 0 : out.indexOf(previous) + 1, 0, id);
    if (out.includes(id)) previous = id;
  }
  return out;
}

interface Stretch { from: number; to: number; elements: Json[] }

// The stretch of base an array replaced: base[from, to) became elements.
function stretch(base: Json[], next: Json[]): Stretch {
  let start = 0;
  while (start < base.length && start < next.length && equalJson(base[start], next[start])) start++;
  let end = 0;
  while (end < base.length - start && end < next.length - start && equalJson(base[base.length - 1 - end], next[next.length - 1 - end])) end++;
  return { from: start, to: base.length - end, elements: next.slice(start, next.length - end) };
}

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

// Elements by id, in head's order. An element removed on one side and changed on the other is a
// conflict; a change of order on mine's side is not kept (moves are operations of their own).
function mergeKeyed(base: Json[], head: Json[], mine: Json[], wins: 'mine' | 'head', path: Segment[], conflicts: MergeConflict[]): Json[] {
  const byId = (array: Json[]) => new Map(array.map((element) => [elementId(element) as string, element]));
  const b = byId(base);
  const h = byId(head);
  const m = byId(mine);
  const order = head.map((element) => elementId(element) as string);
  let previous: string | null = null;
  // An element of mine head has not (added by mine, or removed by head: merge says whether mine's
  // edit keeps it) goes after the one it follows in mine.
  for (const element of mine) {
    const id = elementId(element) as string;
    if (!order.includes(id)) order.splice(previous === null ? 0 : order.indexOf(previous) + 1, 0, id);
    previous = id;
  }
  const out: Json[] = [];
  for (const id of order) {
    const value = merge(b.get(id), h.get(id), m.get(id), wins, [...path, { id }], conflicts);
    if (value !== undefined) out.push(value);
  }
  return out;
}
