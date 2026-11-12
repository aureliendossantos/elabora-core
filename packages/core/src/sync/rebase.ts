import type { Author, Files, Json, Op, Segment, SkippedOp } from '../ops/types.ts';
import { OpError } from '../ops/errors.ts';
import { applyOp, closeWorkspace, currentContent, openWorkspace, readDocument, type Workspace } from '../ops/apply.ts';
import { cloneJson, documentOf, equalJson, textFile } from '../ops/json.ts';
import { describeTarget, formatPath, lookup, startsWith } from '../ops/path.ts';
import { isAiAuthor } from '../ops/batch.ts';
import { check, reanchor } from '../ops/undo.ts';
import { mergeJson } from './merge.ts';
import type { Committed, Overwrite, Refusal } from './protocol.ts';

// Rebase (D74): places a change computed on older files onto the files as they are now (head). It
// replays the operations forward on head, one by one, and compares the value each one replaces
// (read from its inverse) with what head holds there:
//   - the same: the operation applies;
//   - different, written by a person: their value wins (the last written), what it replaced is
//     reported in overwrote; values that are objects or arrays merge three ways first, so only the
//     places both sides changed are decided this way;
//   - different, written by an agent or by a file edit no Elabora tool made: head is kept and the
//     operation (or the part of it in conflict) is reported in skipped;
//   - structure: an insertion whose anchor is gone goes last; removing or moving an element that is
//     gone is skipped; inserting an id another change took is refused, the whole change with it
//     (its other operations may address the element by that id).
// Text files (CSS, JS) follow the rule of values, whole; JSON files written as text merge as values.
// Pure: the room (elabora-cloud) and every copy run it alike.

export interface RebaseInput {
  id: string;
  author: Author;
  ops: readonly Op[];
  inverse: readonly Op[];
}

export interface RebaseResult {
  ops: Op[];               // the operations kept, in the order they apply to head
  skipped: SkippedOp[];
  overwrote: Overwrite[];
  files: Files;            // head with ops applied
  refusal?: Omit<Refusal, 'id'>; // set: nothing applies (ops is empty, files is head)
}

// since: the changes placed after the change's base, newest last; only used to say who wrote a
// value that was overwritten.
export function rebase(head: Files, change: RebaseInput, since: readonly Committed[] = []): RebaseResult {
  if (change.inverse.length !== change.ops.length) {
    return { ops: [], skipped: [], overwrote: [], files: head, refusal: { code: 'E_SYNC_MALFORMED', message: `Change ${change.id}: its inverse does not match its operations` } };
  }
  const run: Run = { workspace: openWorkspace(head), change, ai: isAiAuthor(change.author), since, ops: [], skipped: [], overwrote: [] };
  const n = change.ops.length;
  for (let k = 0; k < n; k++) {
    const outcome = place(run, change.ops[k], change.inverse[n - 1 - k]);
    if (outcome) return { ops: [], skipped: [], overwrote: [], files: head, refusal: outcome };
  }
  return { ops: run.ops, skipped: run.skipped, overwrote: run.overwrote, files: closeWorkspace(run.workspace) };
}

interface Run {
  workspace: Workspace;
  change: RebaseInput;
  ai: boolean;
  since: readonly Committed[];
  ops: Op[];
  skipped: SkippedOp[];
  overwrote: Overwrite[];
}

// Places one operation; returns a refusal of the whole change, or nothing.
function place(run: Run, op: Op, inverse: Op): Omit<Refusal, 'id'> | void {
  const problem = check(run.workspace, inverse);
  if (!problem) return apply(run, op.op === 'insert' || op.op === 'move' ? reanchor(run.workspace, op) : op);
  switch (op.op) {
    case 'set': return placeSet(run, op, inverse);
    case 'unset':
      // Already absent: nothing to do. Changed since: a person's removal wins.
      if (problem.reason === 'missing') return;
      return run.ai ? skip(run, op, problem.message) : overwrite(run, op, op.file, op.path, valueAt(run, op.file, op.path) ?? null);
    case 'insert': {
      if (problem.reason === 'missing') return skip(run, op, problem.message, 'missing');
      // The id is taken. The same element already there (a change sent twice): nothing to do.
      const found = lookup(readDocument(run.workspace, op.file), [...op.path, { id: idOf(inverse) }]);
      if (found.found && equalJson(found.value, op.value)) return;
      return { code: 'E_SYNC_ID_TAKEN', message: `${describeTarget(op.file, [...op.path, { id: idOf(inverse) }])} was added by another change meanwhile: the id is taken` };
    }
    case 'remove':
      if (problem.reason === 'missing') return skip(run, op, problem.message, 'missing');
      return run.ai ? skip(run, op, problem.message) : overwrite(run, op, op.file, op.path, valueAt(run, op.file, op.path) ?? null);
    case 'move':
      return skip(run, op, problem.message, 'missing');
    case 'write': return placeWrite(run, op, inverse, problem.reason);
    case 'delete':
      if (problem.reason === 'missing') return;
      return run.ai ? skip(run, op, problem.message) : overwrite(run, op, op.file, [], fileValue(run, op.file));
  }
}

function placeSet(run: Run, op: Extract<Op, { op: 'set' }>, inverse: Op): void {
  const parent = op.path.length ? lookup(readDocument(run.workspace, op.file), op.path.slice(0, -1)) : { found: readDocument(run.workspace, op.file) !== undefined };
  if (!parent.found) return skip(run, op, `${describeTarget(op.file, op.path.slice(0, -1))}: no longer there`, 'missing');
  const base = inverse.op === 'set' ? inverse.value : undefined;
  const now = valueAt(run, op.file, op.path);
  mergeInto(run, op, op.file, op.path, base, now, op.value, (value) => ({ ...op, value }));
}

function placeWrite(run: Run, op: Extract<Op, { op: 'write' }>, inverse: Op, reason: SkippedOp['reason']): void {
  const current = currentContent(run.workspace, op.file);
  // A JSON file written as text merges as a value with what is there (a document a person or an
  // agent rewrote whole keeps what others changed elsewhere in it).
  const mine = 'text' in op ? textFile(op.file, op.text).json : undefined;
  const now = documentOf(op.file, current);
  const base = inverse.op === 'write' && 'text' in inverse ? textFile(op.file, inverse.text).json : inverse.op === 'delete' ? undefined : null;
  if (mine !== undefined && now !== undefined && base !== null) {
    return mergeInto(run, op, op.file, [], base, now, mine, (value) => ({ op: 'set', file: op.file, path: [], value }));
  }
  if (run.ai) return skip(run, op, reason === 'missing' ? `${op.file}: deleted since` : `${op.file}: changed since`, reason);
  overwrite(run, op, op.file, [], current ? fileValue(run, op.file) : null);
}

// Merges a value three ways and applies what comes out: mine wins for a person, head for an agent.
function mergeInto(run: Run, op: Op, file: string, path: Segment[], base: Json | undefined, now: Json | undefined, mine: Json, make: (value: Json) => Op): void {
  const merged = mergeJson(base, now, mine, run.ai ? 'head' : 'mine');
  const changes = merged.value === undefined ? now !== undefined : now === undefined || !equalJson(merged.value, now);
  if (changes) {
    const next: Op = merged.value === undefined ? { op: 'unset', file, path: [...path] } : make(merged.value);
    // A merged value is no longer the one the change wrote: the key it was placed after may be gone.
    apply(run, next.op === 'set' && next.after !== undefined ? reanchor(run.workspace, next) : next);
  }
  if (!merged.conflicts.length) return;
  const places = merged.conflicts.map((conflict) => [...path, ...conflict.path]);
  if (run.ai) {
    run.skipped.push({ change: run.change.id, op, reason: 'changed', message: `${places.map((p) => describeTarget(file, p)).join(', ')}: changed since` });
    return;
  }
  merged.conflicts.forEach((conflict, i) => run.overwrote.push(overwritten(run, file, places[i], conflict.head ?? null)));
}

function apply(run: Run, op: Op): void {
  try {
    applyOp(run.workspace, op);
    run.ops.push(op);
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    run.skipped.push({ change: run.change.id, op, reason: error.code === 'E_OP_TARGET_MISSING' ? 'missing' : 'conflict', message: error.message });
  }
}

function skip(run: Run, op: Op, message: string, reason: SkippedOp['reason'] = 'changed'): void {
  run.skipped.push({ change: run.change.id, op, reason, message });
}

// A person's operation applied over a value they had not seen.
function overwrite(run: Run, op: Op, file: string, path: readonly Segment[], was: Json | string | null): void {
  const before = run.ops.length;
  apply(run, op);
  if (run.ops.length > before) run.overwrote.push(overwritten(run, file, path, was));
}

function overwritten(run: Run, file: string, path: readonly Segment[], was: Json | string | null): Overwrite {
  const by = lastWriter(run.since, file, path);
  return { file, path: formatPath(path), was: was === null ? null : typeof was === 'string' ? was : cloneJson(was), ...(by ? { by } : {}) };
}

function valueAt(run: Run, file: string, path: readonly Segment[]): Json | undefined {
  const found = lookup(readDocument(run.workspace, file), path);
  return found.found ? found.value : undefined;
}

// What a file holds, for overwrote: its document, its text, or the hash of a binary file.
function fileValue(run: Run, file: string): Json | string | null {
  const doc = readDocument(run.workspace, file);
  if (doc !== undefined) return doc;
  const content = currentContent(run.workspace, file);
  if (!content) return null;
  return content.kind === 'text' ? content.text : content.hash ?? null;
}

const idOf = (inverse: Op): string => {
  const last = 'path' in inverse ? inverse.path[inverse.path.length - 1] : undefined;
  return typeof last === 'object' ? last.id : '';
};

// The newest change since the base that wrote this place, its parents or its children.
function lastWriter(since: readonly Committed[], file: string, path: readonly Segment[]): string | undefined {
  for (let i = since.length - 1; i >= 0; i--) {
    for (const op of since[i].ops) {
      const targets: [string, readonly Segment[]][] = [[op.file, 'path' in op ? op.path : []]];
      if (op.op === 'move') targets.push([op.to.file, op.to.path]);
      if (targets.some(([f, p]) => f === file && (startsWith(p, path) || startsWith(path, p)))) return since[i].id;
    }
  }
  return undefined;
}
