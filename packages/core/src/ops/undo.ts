import type { Change, Files, Op, SkippedOp } from './types.ts';
import { OpError } from './errors.ts';
import { applyOp, closeWorkspace, currentContent, openWorkspace, readDocument, type Workspace } from './apply.ts';
import { documentOf, equalJson, hasKey, isObject, textFile } from './json.ts';
import { childOf, describeTarget, elementId, indexOfId, lookup } from './path.ts';

export interface UndoResult {
  ops: Op[];            // the inverse operations kept, in the order they apply
  skipped: SkippedOp[]; // the ones left out, with why
  files: Files;         // the files once ops are applied
}

type Problem = Pick<SkippedOp, 'reason' | 'message'>;

export interface UndoOptions {
  // Whether the content a binary write restores is kept (in the blob store): the previous content
  // of a binary file that an agent overwrote with its own tools may not be. Without it, assumed kept.
  canRestore?: (hash: string) => boolean;
}

// Undoes changes (newest first) on the current files. Each inverse operation applies only if its
// target still holds what the change wrote; otherwise it is skipped and reported, so what a human
// wrote after the change is kept. Skipping cascades safely: an element the change inserted and a
// human edited since is not removed, because it no longer equals what was inserted.
export function undoChanges(files: Files, changes: readonly Pick<Change, 'id' | 'ops' | 'inverse' | 'unavailable'>[], options: UndoOptions = {}): UndoResult {
  const workspace = openWorkspace(files);
  const ops: Op[] = [];
  const skipped: SkippedOp[] = [];
  for (const change of changes) {
    if (change.inverse.length !== change.ops.length) {
      throw new OpError('E_OP_INVALID', `Change ${change.id}: its inverse does not match its operations`);
    }
    for (let k = 0; k < change.inverse.length; k++) {
      const inverse = change.inverse[k];
      const problem = check(workspace, change.ops[change.ops.length - 1 - k]) ?? restorable(inverse, change.unavailable, options);
      if (problem) {
        skipped.push({ change: change.id, op: inverse, ...problem });
        continue;
      }
      const op = reanchor(workspace, inverse);
      try {
        applyOp(workspace, op);
        ops.push(op);
      } catch (error) {
        if (!(error instanceof OpError)) throw error;
        skipped.push({ change: change.id, op: inverse, reason: error.code === 'E_OP_TARGET_MISSING' ? 'missing' : 'conflict', message: error.message });
      }
    }
  }
  return { ops, skipped, files: closeWorkspace(workspace) };
}

// A binary content comes back only when it was kept: not when the change recorded it as unavailable,
// nor when the store no longer holds it.
function restorable(op: Op, unavailable: readonly string[] | undefined, options: UndoOptions): Problem | null {
  if (op.op !== 'write' || !('blob' in op)) return null;
  if (!unavailable?.includes(op.blob) && (!options.canRestore || options.canRestore(op.blob))) return null;
  return { reason: 'unavailable', message: `${op.file}: its previous content was not kept` };
}

const changed = (message: string): Problem => ({ reason: 'changed', message });
const missing = (message: string): Problem => ({ reason: 'missing', message });

// Whether the target of a forward operation still holds what it wrote: undo works backwards, so
// the later operations of the change are already undone when this one is checked.
function check(workspace: Workspace, op: Op): Problem | null {
  switch (op.op) {
    case 'set': {
      const found = lookup(readDocument(workspace, op.file), op.path);
      const target = describeTarget(op.file, op.path);
      if (!found.found) return missing(`${target}: no longer there`);
      return equalJson(found.value, op.value) ? null : changed(`${target}: changed since`);
    }
    case 'unset': {
      const found = lookup(readDocument(workspace, op.file), op.path);
      if (found.found) return changed(`${describeTarget(op.file, op.path)}: set again since`);
      return found.parentFound ? null : missing(`${describeTarget(op.file, op.path.slice(0, -1))}: no longer there`);
    }
    case 'insert': {
      const id = elementId(op.value);
      const array = lookup(readDocument(workspace, op.file), op.path);
      const target = describeTarget(op.file, [...op.path, { id: id ?? '?' }]);
      const element = array.found && id !== undefined ? childOf(array.value, { id }) : undefined;
      if (element === undefined) return missing(`${target}: removed or moved since`);
      return equalJson(element, op.value) ? null : changed(`${target}: changed since`);
    }
    case 'remove': {
      const array = lookup(readDocument(workspace, op.file), op.path.slice(0, -1));
      if (!array.found) return missing(`${describeTarget(op.file, op.path.slice(0, -1))}: no longer there`);
      return childOf(array.value, op.path[op.path.length - 1]) === undefined ? null : changed(`${describeTarget(op.file, op.path)}: added again since`);
    }
    case 'move': {
      const last = op.path[op.path.length - 1];
      const array = lookup(readDocument(workspace, op.to.file), op.to.path);
      if (!array.found || childOf(array.value, last) === undefined) {
        return missing(`${describeTarget(op.to.file, [...op.to.path, last])}: removed or moved since`);
      }
      return null;
    }
    case 'write': {
      const current = currentContent(workspace, op.file);
      if (!current) return missing(`${op.file}: deleted since`);
      let same: boolean;
      if ('text' in op) {
        const now = documentOf(op.file, current);
        const written = textFile(op.file, op.text).json;
        same = now !== undefined && written !== undefined ? equalJson(now, written) : current.kind === 'text' && current.text === op.text;
      } else same = current.kind === 'binary' && current.hash === op.blob;
      return same ? null : changed(`${op.file}: changed since`);
    }
    case 'delete':
      return currentContent(workspace, op.file) ? changed(`${op.file}: created again since`) : null;
  }
}

// An anchor removed since cannot place an element: it goes last instead. A key anchor removed
// since is dropped: the key is appended.
function reanchor(workspace: Workspace, op: Op): Op {
  if ((op.op === 'insert' || op.op === 'move') && op.after !== null) {
    const file = op.op === 'insert' ? op.file : op.to.file;
    const path = op.op === 'insert' ? op.path : op.to.path;
    const array = lookup(readDocument(workspace, file), path);
    if (!array.found || !Array.isArray(array.value) || indexOfId(array.value, op.after) >= 0) return op;
    const moving = op.op === 'move' ? op.path[op.path.length - 1] : undefined;
    const ids = array.value.map((element) => elementId(element)).filter((id) => id !== undefined && (typeof moving !== 'object' || id !== moving.id));
    return { ...op, after: ids.length ? (ids[ids.length - 1] as string) : null };
  }
  if (op.op === 'set' && typeof op.after === 'string') {
    const parent = lookup(readDocument(workspace, op.file), op.path.slice(0, -1));
    if (parent.found && isObject(parent.value) && !hasKey(parent.value, op.after)) {
      const { after: _dropped, ...rest } = op;
      return rest;
    }
  }
  return op;
}
