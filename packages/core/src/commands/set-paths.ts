import type { Json, Segment } from '../ops/types.ts';
import { formatPath, indexOfId, keyedKind, elementId, parsePath } from '../ops/path.ts';
import { isRecord } from '../util/values.ts';
import { CommandError } from './context.ts';

// A field or an entry of a list changed by its path (docs/decisions.md D89): update_block,
// update_screen and update_course take set, a list of { path, value } applied in order to the
// element as it is when the change is written, so that the rest stays as it is (two people changing
// two answers of one quiz both keep theirs). The path is written as the journal writes it: keys
// between dots, an entry of a keyed list by its id in brackets (props.options[b].text). value
// replaces what is there, an entry the list does not have yet joins its end, null removes.

export interface PathEdit {
  path: string;
  value: unknown;
}

export const SET = {
  type: 'array',
  minItems: 1,
  description: 'Fields or entries changed one by one, in order, on the element as it is; the rest stays. path: keys between dots, an entry of a list by its id in brackets (props.options[b].text, props.rows[usb].at, props.nodes[n2].options[a].next, narration.lines[l2].text, navigation.lockUntilComplete). value replaces what is there (an entry the list does not have yet joins its end), null removes it. A list without ids is given whole; an id changes with elabora_rename.',
  items: {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1 }, value: { description: 'Any JSON value; null removes.' } },
    required: ['path', 'value'],
    additionalProperties: false
  }
} as const;

export interface SetRules {
  // What the command changes (« block "intro" »), for messages.
  what: string;
  // The first keys a path may start with: the fields the command changes.
  fields: readonly string[];
  // Why a path is refused (null: it is not).
  refuse?: (path: readonly Segment[], value: unknown) => string | null;
}

export function applySet(target: Record<string, unknown>, edits: readonly PathEdit[] | undefined, { what, fields, refuse }: SetRules): void {
  for (const edit of edits ?? []) {
    const text = isRecord(edit) && typeof edit.path === 'string' ? edit.path : '';
    const path = parsePath(text);
    if (!path) throw new CommandError(`set: "${text}" is not a path: keys between dots, an entry of a list by its id in brackets (props.options[b].text).`);
    if (!isRecord(edit) || edit.value === undefined) throw new CommandError(`set: "${text}" has no value (null removes).`);
    const [first] = path;
    if (typeof first !== 'string' || !fields.includes(first)) throw new CommandError(`set: "${text}" starts with "${String(first)}", which set does not change on ${what} (${fields.join(', ')}).`);
    if (path.some((segment, index) => segment === 'id' && typeof path[index - 1] === 'object')) throw new CommandError(`set: "${text}" changes an id; ids are permanent: elabora_rename renames one, and what names it follows.`);
    const refusal = refuse?.(path, edit.value);
    if (refusal) throw new CommandError(`set: "${text}": ${refusal}`);
    setAt(target, path, structuredClone(edit.value), text);
  }
}

function setAt(root: Record<string, unknown>, path: readonly Segment[], value: unknown, text: string): void {
  const where = (end: number) => formatPath(path.slice(0, end));
  let node: unknown = root;
  for (let at = 0; at < path.length;) {
    const segment = path[at]!;
    if (typeof segment === 'string') {
      if (!isRecord(node)) throw new CommandError(`set: "${text}": ${where(at)} is not an object.`);
      // A key holding dots (a theme token: color.accent) is the longest run of keys the object has.
      let next = at + 1;
      let key = segment;
      for (let end = path.length; end > at + 1; end--) {
        const run = path.slice(at, end);
        if (run.every((each) => typeof each === 'string') && Object.hasOwn(node, run.join('.'))) { key = run.join('.'); next = end; break; }
      }
      if (next === path.length) {
        if (value === null) delete node[key];
        else node[key] = isRecord(node[key]) && isRecord(value) ? inPlaceOf(node[key], value) : value;
        return;
      }
      if (node[key] === undefined || node[key] === null) {
        if (value === null) return;
        node[key] = typeof path[next] === 'string' ? {} : [];
      }
      node = node[key];
      at = next;
      continue;
    }
    if (!Array.isArray(node)) throw new CommandError(`set: "${text}": ${where(at)} is not a list.`);
    const list = node as Json[];
    const kind = keyedKind(list);
    if (kind === null) throw new CommandError(`set: "${text}": ${where(at)} is a list without ids: give it whole.`);
    const index = indexOfId(list, segment.id);
    const missing = () => new CommandError(`set: "${text}": no entry "${segment.id}" in ${where(at)} (entries: ${list.map((entry) => elementId(entry)).join(', ') || 'none'}).`);
    if (at + 1 < path.length) {
      if (index < 0) throw missing();
      node = list[index];
      at++;
      continue;
    }
    if (value === null) {
      if (index < 0) throw missing();
      list.splice(index, 1);
    } else if (kind === 'strings' || (kind === 'empty' && typeof value === 'string')) {
      if (value !== segment.id) throw new CommandError(`set: "${text}": an entry of a list of strings is its own id (value "${segment.id}", or null to remove it).`);
      if (index < 0) list.push(value);
    } else {
      if (!isRecord(value)) throw new CommandError(`set: "${text}": an entry is an object, its fields (its id is the one in brackets).`);
      if (value.id !== undefined && value.id !== segment.id) throw new CommandError(`set: "${text}" changes an id; ids are permanent: elabora_rename renames one, and what names it follows.`);
      const entry = { id: segment.id, ...value } as Record<string, Json>;
      if (index < 0) list.push(entry);
      else list[index] = inPlaceOf(list[index], entry) as Record<string, Json>;
    }
    return;
  }
}

// An object written where one was: the keys it keeps stay in their place (a change records only what
// changed, never a key moved), new keys follow.
export function inPlaceOf(was: unknown, next: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(was)) return next;
  const kept = Object.keys(was).filter((key) => Object.hasOwn(next, key));
  return Object.fromEntries([...kept, ...Object.keys(next).filter((key) => !Object.hasOwn(was, key))].map((key) => [key, next[key]]));
}
