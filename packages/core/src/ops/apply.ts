import type { FileContent, Files, Json, JsonObject, MoveOp, Op, Segment, SetOp } from './types.ts';
import { OpError } from './errors.ts';
import { binaryFile, cloneJson, documentOf, hasKey, isIndexKey, isObject, jsonFile, setKey, textFile } from './json.ts';
import { childOf, describeTarget, elementId, fitsKind, indexOfId, keyedKind, startsWith, type KeyedKind } from './path.ts';

// Operations apply to a workspace: the files, plus working copies of the JSON documents being
// edited. A document is cloned before its first change and formatted again once, when the
// workspace is closed, so the files given in are never mutated.
export interface Workspace {
  files: Map<string, FileContent>;
  docs: Map<string, Json>;
  dirty: Set<string>;
}

export function openWorkspace(files: Files): Workspace {
  return { files: new Map(files), docs: new Map(), dirty: new Set() };
}

export function closeWorkspace(workspace: Workspace): Map<string, FileContent> {
  for (const file of workspace.dirty) workspace.files.set(file, jsonFile(workspace.docs.get(file) as Json));
  workspace.dirty.clear();
  workspace.docs.clear();
  return workspace.files;
}

// The current value of a JSON document (read only), or undefined when the file is not one.
export function readDocument(workspace: Workspace, file: string): Json | undefined {
  return workspace.docs.has(file) ? workspace.docs.get(file) : documentOf(file, workspace.files.get(file));
}

export function currentContent(workspace: Workspace, file: string): FileContent | undefined {
  return workspace.dirty.has(file) ? jsonFile(workspace.docs.get(file) as Json) : workspace.files.get(file);
}

export function applyOps(files: Files, ops: readonly Op[]): Files {
  const workspace = openWorkspace(files);
  for (const op of ops) applyOp(workspace, op);
  return closeWorkspace(workspace);
}

// The files operations read or write, in order of first appearance.
export function touchedFiles(ops: readonly Op[]): string[] {
  const files = new Set<string>();
  for (const op of ops) {
    files.add(op.file);
    if (op.op === 'move') files.add(op.to.file);
  }
  return [...files];
}

// The operations that undo ops on these files, in the order they apply. inverse[k] undoes
// ops[ops.length - 1 - k]: undo relies on it to know what each operation wrote.
export function invertOps(before: Files, ops: readonly Op[]): Op[] {
  const workspace = openWorkspace(before);
  const inverse: Op[] = [];
  for (const op of ops) {
    checkShape(op);
    inverse.push(inverseOf(workspace, op));
    applyOp(workspace, op);
  }
  return inverse.reverse();
}

// Applies one operation. Everything is checked before anything changes, so a failed operation
// leaves the workspace as it was (undo skips it and goes on).
export function applyOp(workspace: Workspace, op: Op): void {
  checkShape(op);
  switch (op.op) {
    case 'set': return applySet(workspace, op);
    case 'unset': {
      const last = lastKey(op);
      checkIdKey(op, op.file, op.path, undefined);
      const parent = nodeAt(editDocument(workspace, op.file, op), op.path.slice(0, -1), op, op.file);
      if (!isObject(parent) || !hasKey(parent, last)) throw missing(op, op.file, op.path);
      delete parent[last];
      workspace.dirty.add(op.file);
      return;
    }
    case 'insert': {
      const { array, kind } = keyedArrayAt(editDocument(workspace, op.file, op), op.path, op, op.file);
      const id = elementId(op.value);
      if (id === undefined || !fitsKind(kind, op.value)) throw wrongKind(op, op.file, op.path, kind);
      if (indexOfId(array, id) >= 0) throw new OpError('E_OP_DUPLICATE', `${describeTarget(op.file, op.path)} already has "${id}"`, op);
      array.splice(anchorIndex(array, op.after, op, op.file, op.path), 0, cloneJson(op.value));
      workspace.dirty.add(op.file);
      return;
    }
    case 'remove': {
      const id = lastId(op);
      const { array } = keyedArrayAt(editDocument(workspace, op.file, op), op.path.slice(0, -1), op, op.file);
      const index = indexOfId(array, id);
      if (index < 0) throw missing(op, op.file, op.path);
      array.splice(index, 1);
      workspace.dirty.add(op.file);
      return;
    }
    case 'move': return applyMove(workspace, op);
    case 'write':
      workspace.docs.delete(op.file);
      workspace.dirty.delete(op.file);
      workspace.files.set(op.file, 'text' in op ? textFile(op.file, op.text) : binaryFile(op.blob));
      return;
    case 'delete':
      if (!workspace.files.has(op.file)) throw missing(op, op.file, []);
      workspace.docs.delete(op.file);
      workspace.dirty.delete(op.file);
      workspace.files.delete(op.file);
      return;
  }
}

function applySet(workspace: Workspace, op: SetOp): void {
  const doc = editDocument(workspace, op.file, op);
  if (!op.path.length) {
    workspace.docs.set(op.file, cloneJson(op.value));
    workspace.dirty.add(op.file);
    return;
  }
  const parent = nodeAt(doc, op.path.slice(0, -1), op, op.file);
  const last = op.path[op.path.length - 1];
  if (typeof last === 'string') {
    checkIdKey(op, op.file, op.path, op.value);
    if (!isObject(parent)) throw missing(op, op.file, op.path.slice(0, -1), 'is not an object');
    if (hasKey(parent, last) || op.after === undefined || isIndexKey(last)) setKey(parent, last, cloneJson(op.value));
    else {
      if (op.after !== null && !hasKey(parent, op.after)) throw missing(op, op.file, [...op.path.slice(0, -1), op.after]);
      placeKey(parent, last, cloneJson(op.value), op.after);
    }
  } else {
    const { array, kind } = asKeyedArray(parent, op, op.file, op.path.slice(0, -1));
    const index = indexOfId(array, last.id);
    if (index < 0) throw missing(op, op.file, op.path);
    if (elementId(op.value) !== last.id || !fitsKind(kind, op.value)) {
      throw new OpError('E_OP_INVALID', `${describeTarget(op.file, op.path)}: the new element must keep the id "${last.id}"`, op);
    }
    array[index] = cloneJson(op.value);
  }
  workspace.dirty.add(op.file);
}

function applyMove(workspace: Workspace, op: MoveOp): void {
  const id = lastId(op);
  if (op.to.file === op.file && startsWith(op.to.path, op.path)) {
    throw new OpError('E_OP_INVALID', `${describeTarget(op.file, op.path)} cannot move into itself`, op);
  }
  if (op.after === id) throw new OpError('E_OP_INVALID', `${describeTarget(op.file, op.path)} cannot follow itself`, op);
  const { array: source } = keyedArrayAt(editDocument(workspace, op.file, op), op.path.slice(0, -1), op, op.file);
  const index = indexOfId(source, id);
  if (index < 0) throw missing(op, op.file, op.path);
  const element = source[index];
  const { array: target, kind } = keyedArrayAt(editDocument(workspace, op.to.file, op), op.to.path, op, op.to.file);
  if (!fitsKind(kind, element)) throw wrongKind(op, op.to.file, op.to.path, kind);
  if (target !== source && indexOfId(target, id) >= 0) {
    throw new OpError('E_OP_DUPLICATE', `${describeTarget(op.to.file, op.to.path)} already has "${id}"`, op);
  }
  anchorIndex(target, op.after, op, op.to.file, op.to.path);
  source.splice(index, 1);
  target.splice(anchorIndex(target, op.after, op, op.to.file, op.to.path), 0, element);
  workspace.dirty.add(op.file);
  workspace.dirty.add(op.to.file);
}

function inverseOf(workspace: Workspace, op: Op): Op {
  switch (op.op) {
    case 'set': {
      const doc = requireDocument(workspace, op.file, op);
      if (!op.path.length) return { op: 'set', file: op.file, path: [], value: cloneJson(doc) };
      const parent = nodeAt(doc, op.path.slice(0, -1), op, op.file);
      const old = childOf(parent, op.path[op.path.length - 1]);
      if (old !== undefined) return { op: 'set', file: op.file, path: [...op.path], value: cloneJson(old) };
      return { op: 'unset', file: op.file, path: [...op.path] };
    }
    case 'unset': {
      const last = lastKey(op);
      const parent = nodeAt(requireDocument(workspace, op.file, op), op.path.slice(0, -1), op, op.file);
      if (!isObject(parent) || !hasKey(parent, last)) throw missing(op, op.file, op.path);
      const inverse: SetOp = { op: 'set', file: op.file, path: [...op.path], value: cloneJson(parent[last]) };
      // Put the key back where it was, so that the text comes back exactly.
      if (!isIndexKey(last)) inverse.after = previousKey(parent, last);
      return inverse;
    }
    case 'insert': {
      const id = elementId(op.value);
      if (id === undefined) throw wrongKind(op, op.file, op.path, 'empty');
      return { op: 'remove', file: op.file, path: [...op.path, { id }] };
    }
    case 'remove': {
      const id = lastId(op);
      const { array } = keyedArrayAt(requireDocument(workspace, op.file, op), op.path.slice(0, -1), op, op.file);
      const index = indexOfId(array, id);
      if (index < 0) throw missing(op, op.file, op.path);
      return { op: 'insert', file: op.file, path: op.path.slice(0, -1), value: cloneJson(array[index]), after: index ? (elementId(array[index - 1]) as string) : null };
    }
    case 'move': {
      const id = lastId(op);
      const { array } = keyedArrayAt(requireDocument(workspace, op.file, op), op.path.slice(0, -1), op, op.file);
      const index = indexOfId(array, id);
      if (index < 0) throw missing(op, op.file, op.path);
      return {
        op: 'move', file: op.to.file, path: [...op.to.path, { id }],
        to: { file: op.file, path: op.path.slice(0, -1) },
        after: index ? (elementId(array[index - 1]) as string) : null
      };
    }
    case 'write':
    case 'delete': {
      const current = currentContent(workspace, op.file);
      if (!current) {
        if (op.op === 'delete') throw missing(op, op.file, []);
        return { op: 'delete', file: op.file };
      }
      return contentOp(op.file, current, op);
    }
  }
}


// The write operation that gives a file this content.
export function contentOp(file: string, content: FileContent, op?: Op): Op {
  if (content.kind === 'text') return { op: 'write', file, text: content.text };
  const hash = content.hash;
  if (hash === undefined) throw new OpError('E_OP_INVALID', `${file}: the hash of this binary file is unknown`, op);
  return { op: 'write', file, blob: hash };
}

// Operations come from agents and from the journal: check their shape before trusting it.
function checkShape(op: Op): void {
  const invalid = (why: string) => new OpError('E_OP_INVALID', `Invalid operation: ${why}`, op);
  if (!op || typeof op !== 'object') throw invalid('not an object');
  if (typeof op.file !== 'string' || !op.file) throw invalid('file must be a project path');
  const isPath = (path: unknown) => Array.isArray(path) && path.every((s) => typeof s === 'string' || (isObject(s) && typeof s.id === 'string'));
  switch (op.op) {
    case 'set': case 'insert':
      if (op.value === undefined) throw invalid(`${op.op} needs a value`);
      if (op.op === 'insert' && op.after !== null && typeof op.after !== 'string') throw invalid('after must be an id or null');
      if (op.op === 'set' && op.after !== undefined && op.after !== null && typeof op.after !== 'string') throw invalid('after must be a key or null');
      if (!isPath(op.path)) throw invalid('path must list keys and { id } selectors');
      return;
    case 'unset': case 'remove':
      if (!isPath(op.path)) throw invalid('path must list keys and { id } selectors');
      return;
    case 'move':
      if (!isPath(op.path) || !op.to || typeof op.to.file !== 'string' || !op.to.file || !isPath(op.to.path)) throw invalid('move needs path, to.file and to.path');
      if (op.after !== null && typeof op.after !== 'string') throw invalid('after must be an id or null');
      return;
    case 'write':
      if (!('text' in op ? typeof op.text === 'string' : typeof (op as { blob?: unknown }).blob === 'string')) throw invalid('write needs text or blob');
      return;
    case 'delete':
      return;
    default:
      throw invalid(`unknown operation "${String((op as { op?: unknown }).op)}"`);
  }
}

// Ids are permanent: the id of an element of a keyed array never changes through its key, or
// paths (and inverses) that select it would break. Changing it is a removal and an insertion.
function checkIdKey(op: Op, file: string, path: readonly Segment[], value: Json | undefined): void {
  const parent = path[path.length - 2];
  if (path[path.length - 1] !== 'id' || parent === undefined || typeof parent === 'string' || value === parent.id) return;
  throw new OpError('E_OP_INVALID', `${describeTarget(file, path)}: the id of an element cannot change (remove it and insert it with the new id)`, op);
}

function requireDocument(workspace: Workspace, file: string, op: Op): Json {
  const doc = readDocument(workspace, file);
  if (doc !== undefined) return doc;
  if (!workspace.files.has(file)) throw missing(op, file, []);
  throw new OpError('E_OP_NOT_JSON', `${file} is not a JSON document`, op);
}

// The working copy of a document, cloned before its first change.
function editDocument(workspace: Workspace, file: string, op: Op): Json {
  if (workspace.docs.has(file)) return workspace.docs.get(file) as Json;
  const doc = cloneJson(requireDocument(workspace, file, op));
  workspace.docs.set(file, doc);
  return doc;
}

function nodeAt(doc: Json, path: readonly Segment[], op: Op, file: string): Json {
  let node = doc;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (typeof segment !== 'string') asKeyedArray(node, op, file, path.slice(0, i));
    const child = childOf(node, segment);
    if (child === undefined) throw missing(op, file, path.slice(0, i + 1));
    node = child;
  }
  return node;
}

function asKeyedArray(node: Json, op: Op, file: string, path: readonly Segment[]): { array: Json[]; kind: KeyedKind } {
  if (!Array.isArray(node)) throw new OpError('E_OP_NOT_KEYED', `${describeTarget(file, path)} is not an array`, op);
  const kind = keyedKind(node);
  if (kind === null) throw new OpError('E_OP_NOT_KEYED', `${describeTarget(file, path)} is not a keyed array (objects with distinct ids, or distinct strings)`, op);
  return { array: node, kind };
}

function keyedArrayAt(doc: Json, path: readonly Segment[], op: Op, file: string): { array: Json[]; kind: KeyedKind } {
  return asKeyedArray(nodeAt(doc, path, op, file), op, file, path);
}

function anchorIndex(array: readonly Json[], after: string | null, op: Op, file: string, path: readonly Segment[]): number {
  if (after === null) return 0;
  const index = indexOfId(array, after);
  if (index < 0) throw missing(op, file, [...path, { id: after }]);
  return index + 1;
}

function lastKey(op: Op & { path: Segment[] }): string {
  const last = op.path[op.path.length - 1];
  if (typeof last !== 'string') throw new OpError('E_OP_INVALID', `${op.op} takes a path ending with a key (remove takes elements)`, op);
  return last;
}

function lastId(op: Op & { path: Segment[] }): string {
  const last = op.path[op.path.length - 1];
  if (last === undefined || typeof last === 'string') throw new OpError('E_OP_INVALID', `${op.op} takes a path ending with { id }`, op);
  return last.id;
}

// The key before this one, ignoring index-like keys (always enumerated first); null when first.
function previousKey(object: JsonObject, key: string): string | null {
  let previous: string | null = null;
  for (const k of Object.keys(object)) {
    if (k === key) return previous;
    if (!isIndexKey(k)) previous = k;
  }
  return previous;
}

// Adds a key after another (null: first). JavaScript keeps insertion order, so the keys that
// follow are taken out and put back.
function placeKey(object: JsonObject, key: string, value: Json, after: string | null): void {
  const keys = Object.keys(object);
  const following = keys.slice(after === null ? 0 : keys.indexOf(after) + 1).filter((k) => !isIndexKey(k));
  const values = following.map((k) => object[k]);
  for (const k of following) delete object[k];
  setKey(object, key, value);
  following.forEach((k, i) => setKey(object, k, values[i]));
}

function missing(op: Op, file: string, path: readonly Segment[], what = 'not found'): OpError {
  return new OpError('E_OP_TARGET_MISSING', `${describeTarget(file, path)}: ${what}`, op);
}

function wrongKind(op: Op, file: string, path: readonly Segment[], kind: KeyedKind): OpError {
  const expected = kind === 'strings' ? 'a string' : kind === 'objects' ? 'an object with a string id' : 'a string or an object with a string id';
  return new OpError('E_OP_NOT_KEYED', `${describeTarget(file, path)} takes ${expected}`, op);
}
