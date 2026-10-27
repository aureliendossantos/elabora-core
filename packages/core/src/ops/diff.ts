import type { Files, Json, JsonObject, Op, Segment, SetOp } from './types.ts';
import { applyOp, contentOp, openWorkspace, type Workspace } from './apply.ts';
import { cloneJson, documentOf, hasKey, isIndexKey, isObject, jsonFile, sameContent, sameJson, setKey } from './json.ts';
import { elementId, keyedKind, lookup } from './path.ts';

// Operations between two snapshots: how an agent's direct file edit becomes operations.
//   - keyed arrays are compared by id: removals, insertions after an anchor, and reorders as the
//     fewest moves (the elements outside a longest increasing subsequence);
//   - objects key by key (set, unset); keys whose order changed are unset and set again in place;
//   - other arrays and values whose type changed are replaced whole;
//   - an element removed from one keyed array and inserted into another (same file or not) with
//     the same id, under the same key name, becomes a move followed by the edits of its content;
//   - text and binary files are written whole; formatting alone is not a change.
// applyOps(before, diffFiles(before, after)) gives after: the same values with the same key order,
// so the same text when after is formatted the way Elabora writes JSON.

export function diffFiles(before: Files, after: Files): Op[] {
  const { ops, exact } = computeDiff(before, after);
  return exact ? ops : wholeFileDiff(before, after);
}

// Operations between two versions of one JSON document.
export function diffDocuments(before: Json, after: Json, file = ''): Op[] {
  return diffFiles(new Map([[file, jsonFile(before)]]), new Map([[file, jsonFile(after)]]));
}

// The fine-grained diff, and whether replaying it gave exactly the documents of after. diffFiles
// falls back to whole documents when it did not: a coarse change beats a wrong one.
export function computeDiff(before: Files, after: Files): { ops: Op[]; exact: boolean } {
  const context: Context = { removals: [], insertions: [] };
  const steps: Step[] = [];
  const documents: { file: string; before: Json; after: Json }[] = [];
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(file);
    const now = after.get(file);
    if (sameContent(was, now)) continue;
    if (!now) steps.push({ kind: 'op', op: { op: 'delete', file } });
    else if (!was) steps.push({ kind: 'op', op: contentOp(file, now) });
    else {
      const wasDoc = documentOf(file, was);
      const nowDoc = documentOf(file, now);
      if (wasDoc === undefined || nowDoc === undefined) steps.push({ kind: 'op', op: contentOp(file, now) });
      else {
        documents.push({ file, before: wasDoc, after: nowDoc });
        const root = { file, path: [] };
        collect(wasDoc, nowDoc, root, root, steps, context);
      }
    }
  }
  pairMoves(context);

  // Replay on working copies that remember which before array each array comes from: a moved
  // element's source is found there even when its parents moved first.
  const workspace = openWorkspace(before);
  const origins = new Map<Json[], Json[]>();
  for (const { file, before: doc } of documents) workspace.docs.set(file, cloneTracked(doc, origins));
  const ops: Op[] = [];
  try {
    emit(steps, { workspace, origins, ops });
  } catch {
    return { ops, exact: false };
  }
  const exact = documents.every(({ file, after: doc }) => sameJson(workspace.docs.get(file) as Json, doc));
  return { ops, exact };
}


interface Location { file: string; path: Segment[] }

// An element that left a keyed array (beforeArray in the before tree, afterArray where that
// array is in the after tree), or joined one.
interface Removal { pairKey: string; id: string; value: Json; array: Json[]; beforeArray: Location; afterArray: Location; paired: boolean }
interface Insertion { pairKey: string; id: string; value: Json; afterArray: Location; after: string | null; source: Removal | null; content: Step[] }

type Step = { kind: 'op'; op: Op } | { kind: 'remove'; removal: Removal } | { kind: 'insert'; insertion: Insertion };

interface Context { removals: Removal[]; insertions: Insertion[] }

const child = (location: Location, segment: Segment): Location => ({ file: location.file, path: [...location.path, segment] });

// Steps that turn b into a: b sits at before (in the before tree), a at after (in the after
// tree). Operation paths use after: when they apply, every parent is already in its new place.
function collect(b: Json, a: Json, before: Location, after: Location, steps: Step[], context: Context): void {
  if (isObject(b) && isObject(a)) return collectObject(b, a, before, after, steps, context);
  if (Array.isArray(b) && Array.isArray(a)) {
    const bKind = keyedKind(b);
    const aKind = keyedKind(a);
    if (bKind !== null && aKind !== null) {
      const kind = bKind === 'empty' ? aKind : aKind === 'empty' || aKind === bKind ? bKind : null;
      if (kind === 'empty') return;
      if (kind !== null) return collectKeyed(b, a, kind, before, after, steps, context);
    }
  }
  if (!sameJson(b, a)) steps.push({ kind: 'op', op: { op: 'set', file: after.file, path: [...after.path], value: cloneJson(a) } });
}

function collectObject(b: JsonObject, a: JsonObject, before: Location, after: Location, steps: Step[], context: Context): void {
  const bKeys = Object.keys(b);
  const aKeys = Object.keys(a);
  for (const key of bKeys) if (!hasKey(a, key)) steps.push({ kind: 'op', op: { op: 'unset', file: after.file, path: [...after.path, key] } });
  // The id of an element selects it: it never moves, the other keys move around it.
  const isElement = typeof after.path[after.path.length - 1] === 'object';
  const staying = stayingKeys(b, a, bKeys, aKeys, isElement ? 'id' : null);
  // A key placed after the last staying key gets there by being appended: no anchor needed.
  let lastStaying = -1;
  aKeys.forEach((key, i) => { if (staying.has(key)) lastStaying = i; });
  let previous: string | null = null;
  aKeys.forEach((key, i) => {
    const indexKey = isIndexKey(key);
    if (hasKey(b, key) && (indexKey || staying.has(key))) collect(b[key], a[key], child(before, key), child(after, key), steps, context);
    else {
      if (hasKey(b, key)) steps.push({ kind: 'op', op: { op: 'unset', file: after.file, path: [...after.path, key] } });
      const set: SetOp = { op: 'set', file: after.file, path: [...after.path, key], value: cloneJson(a[key]) };
      if (!indexKey && i < lastStaying) set.after = previous;
      steps.push({ kind: 'op', op: set });
    }
    if (!indexKey) previous = key;
  });
}

// Common keys that keep their place. When the order changed, the heaviest set of keys already in
// order stays and the others move, so that a reordered file moves small values, not big ones.
function stayingKeys(b: JsonObject, a: JsonObject, bKeys: string[], aKeys: string[], pinned: string | null): Set<string> {
  const inB = bKeys.filter((key) => !isIndexKey(key) && hasKey(a, key));
  const inA = aKeys.filter((key) => !isIndexKey(key) && hasKey(b, key));
  if (inB.every((key, i) => key === inA[i])) return new Set(inB);
  const position = new Map(inA.map((key, i) => [key, i]));
  const weights = inB.map((key) => (key === pinned ? 1e15 : JSON.stringify(b[key]).length + JSON.stringify(a[key]).length));
  return new Set(heaviestIncreasing(inB.map((key) => position.get(key) as number), weights).map((i) => inB[i]));
}

function collectKeyed(b: Json[], a: Json[], kind: 'objects' | 'strings', before: Location, after: Location, steps: Step[], context: Context): void {
  const bIds = b.map((element) => elementId(element) as string);
  const aIds = a.map((element) => elementId(element) as string);
  const bIndex = new Map(bIds.map((id, i) => [id, i]));
  const aIndex = new Map(aIds.map((id, i) => [id, i]));
  const tag = `${kind === 'strings' ? 's' : 'o'}|${lastKeyOf(after.path)}|`;
  bIds.forEach((id, i) => {
    if (aIndex.has(id)) return;
    const removal: Removal = { pairKey: tag + id, id, value: b[i], array: b, beforeArray: before, afterArray: after, paired: false };
    context.removals.push(removal);
    steps.push({ kind: 'remove', removal });
  });
  const common = bIds.filter((id) => aIndex.has(id));
  const staying = new Set(longestIncreasing(common.map((id) => aIndex.get(id) as number)).map((i) => common[i]));
  aIds.forEach((id, i) => {
    const anchor = i ? aIds[i - 1] : null;
    if (!bIndex.has(id)) {
      const insertion: Insertion = { pairKey: tag + id, id, value: a[i], afterArray: after, after: anchor, source: null, content: [] };
      context.insertions.push(insertion);
      steps.push({ kind: 'insert', insertion });
    } else if (!staying.has(id)) {
      steps.push({ kind: 'op', op: { op: 'move', file: after.file, path: [...after.path, { id }], to: { file: after.file, path: [...after.path] }, after: anchor } });
    }
  });
  if (kind === 'objects') {
    aIds.forEach((id, i) => {
      const j = bIndex.get(id);
      if (j !== undefined) collect(b[j], a[i], child(before, { id }), child(after, { id }), steps, context);
    });
  }
}

// Pairs each insertion with an earlier-unpaired removal of the same id under the same key name.
// A pair's content is compared in turn, which can reveal more removals and insertions.
function pairMoves(context: Context): void {
  const pool = new Map<string, Removal[]>();
  let removalsSeen = 0;
  let insertionsSeen = 0;
  let waiting: Insertion[] = [];
  for (;;) {
    for (; removalsSeen < context.removals.length; removalsSeen++) {
      const removal = context.removals[removalsSeen];
      const list = pool.get(removal.pairKey);
      if (list) list.push(removal);
      else pool.set(removal.pairKey, [removal]);
    }
    for (; insertionsSeen < context.insertions.length; insertionsSeen++) waiting.push(context.insertions[insertionsSeen]);
    const paired: Insertion[] = [];
    for (const insertion of waiting) {
      const removal = pool.get(insertion.pairKey)?.find((candidate) => !candidate.paired);
      if (!removal) continue;
      removal.paired = true;
      insertion.source = removal;
      paired.push(insertion);
    }
    if (!paired.length) return;
    waiting = waiting.filter((insertion) => !insertion.source);
    for (const insertion of paired) {
      const removal = insertion.source as Removal;
      collect(removal.value, insertion.value, child(removal.beforeArray, { id: removal.id }), child(insertion.afterArray, { id: insertion.id }), insertion.content, context);
    }
  }
}


interface Replay { workspace: Workspace; origins: Map<Json[], Json[]>; ops: Op[] }

function emit(steps: Step[], replay: Replay): void {
  const apply = (op: Op) => {
    applyOp(replay.workspace, op);
    replay.ops.push(op);
  };
  for (const step of steps) {
    if (step.kind === 'op') apply(step.op);
    else if (step.kind === 'remove') {
      const { removal } = step;
      if (!removal.paired) apply({ op: 'remove', file: removal.afterArray.file, path: [...removal.afterArray.path, { id: removal.id }] });
    } else {
      const { insertion } = step;
      const to = { file: insertion.afterArray.file, path: [...insertion.afterArray.path] };
      if (!insertion.source) {
        apply({ op: 'insert', file: to.file, path: to.path, value: cloneJson(insertion.value), after: insertion.after });
        continue;
      }
      const from = locate(replay, insertion.source);
      apply({ op: 'move', file: from.file, path: [...from.path, { id: insertion.id }], to, after: insertion.after });
      emit(insertion.content, replay);
    }
  }
}

// Where the array a moved element comes from is now: where it was, unless a parent moved first.
function locate(replay: Replay, removal: Removal): Location {
  const target = replay.origins.get(removal.array);
  if (!target) throw new Error('diff: unknown source array');
  const hint = lookup(replay.workspace.docs.get(removal.beforeArray.file), removal.beforeArray.path);
  if (hint.found && hint.value === target) return removal.beforeArray;
  for (const [file, doc] of replay.workspace.docs) {
    const path = pathTo(doc, target, []);
    if (path) return { file, path };
  }
  throw new Error('diff: source array not found');
}

function pathTo(node: Json, target: Json[], path: Segment[]): Segment[] | null {
  if (node === target) return [...path];
  if (Array.isArray(node)) {
    if (keyedKind(node) !== 'objects') return null;
    for (const element of node) {
      path.push({ id: elementId(element) as string });
      const found = pathTo(element, target, path);
      path.pop();
      if (found) return found;
    }
  } else if (isObject(node)) {
    for (const key of Object.keys(node)) {
      path.push(key);
      const found = pathTo(node[key], target, path);
      path.pop();
      if (found) return found;
    }
  }
  return null;
}

function cloneTracked(value: Json, origins: Map<Json[], Json[]>): Json {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const copy = value.map((element) => cloneTracked(element, origins));
    origins.set(value, copy);
    return copy;
  }
  const out: JsonObject = {};
  for (const key of Object.keys(value)) setKey(out, key, cloneTracked(value[key], origins));
  return out;
}


function wholeFileDiff(before: Files, after: Files): Op[] {
  const ops: Op[] = [];
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(file);
    const now = after.get(file);
    if (sameContent(was, now)) continue;
    if (!now) ops.push({ op: 'delete', file });
    else {
      const wasDoc = documentOf(file, was);
      const nowDoc = documentOf(file, now);
      if (was && wasDoc !== undefined && nowDoc !== undefined) {
        if (!sameJson(wasDoc, nowDoc)) ops.push({ op: 'set', file, path: [], value: cloneJson(nowDoc) });
      } else ops.push(contentOp(file, now));
    }
  }
  return ops;
}


function lastKeyOf(path: readonly Segment[]): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const segment = path[i];
    if (typeof segment === 'string') return segment;
  }
  return '';
}

// Indexes of a longest strictly increasing subsequence (patience sorting, O(n log n)).
function longestIncreasing(sequence: readonly number[]): number[] {
  const tails: number[] = [];
  const previous = new Array<number>(sequence.length).fill(-1);
  for (let i = 0; i < sequence.length; i++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sequence[tails[middle]] < sequence[i]) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[i] = tails[low - 1];
    tails[low] = i;
  }
  const out: number[] = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) out.push(i);
  return out.reverse();
}

// Indexes of the increasing subsequence with the largest total weight (O(n²); objects have few keys).
function heaviestIncreasing(sequence: readonly number[], weights: readonly number[]): number[] {
  const best: number[] = [];
  const previous: number[] = [];
  let top = -1;
  for (let i = 0; i < sequence.length; i++) {
    best[i] = weights[i];
    previous[i] = -1;
    for (let j = 0; j < i; j++) {
      if (sequence[j] < sequence[i] && best[j] + weights[i] > best[i]) {
        best[i] = best[j] + weights[i];
        previous[i] = j;
      }
    }
    if (top < 0 || best[i] > best[top]) top = i;
  }
  const out: number[] = [];
  for (let i = top; i >= 0; i = previous[i]) out.push(i);
  return out.reverse();
}
