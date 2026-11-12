import type { Author, FileContent, Files, Json, JsonObject, Op, SkippedOp } from '../ops/types.ts';
import { invertOps } from '../ops/apply.ts';
import { diffFiles } from '../ops/diff.ts';
import { documentOf, isObject, jsonFile, sameContent, setKey } from '../ops/json.ts';
import { rebase } from './rebase.ts';
import type { Overwrite } from './protocol.ts';

// A file edit no Elabora tool made (an agent's own tools), on one copy (D75). The program that wrote
// may have read the file long before: writing what it read, with its edit, would undo what was
// written meanwhile (by the author in the app, by others through the server) without anyone being
// told. So the edit is computed from the version it most likely read, not from the files as they
// are: among the recent versions of each written file, the one closest to what was written (the
// fewest operations between them). When several are as close, the edit rewrote what changed
// between them, and nothing tells whether it saw it: the oldest is taken, so that what someone
// wrote meanwhile is kept and the program told (an agent's edit lost and reported beats a person's
// lost in silence). Then it is rebased on the files as they are, as an agent's change: where the
// two differ, what is there now is kept, and the edit's operations left out are reported.

export interface ExternalEdit {
  ops: Op[];             // on current
  skipped: SkippedOp[];
  overwrote: Overwrite[];
  // Files of the edit whose content is not what was written, now that it is merged: the program
  // that wrote them should read them again.
  merged: string[];
}

// current: the files the copy shows; written: the files as the program left them (those it wrote,
// and the others as they are); versions: earlier versions of the copy's files, newest first.
export function externalEdit(current: Files, written: Files, versions: readonly Files[], author: Author = { kind: 'external' }, id = 'external'): ExternalEdit {
  const paths = [...new Set([...current.keys(), ...written.keys()])].filter((path) => !sameContent(current.get(path), written.get(path)));
  if (!paths.length) return { ops: [], skipped: [], overwrote: [], merged: [] };
  const base = new Map(current);
  for (const path of paths) {
    const read = closestVersion(path, written.get(path), [current, ...versions]);
    if (read) base.set(path, read);
    else base.delete(path);
  }
  const target = new Map(base);
  for (const path of paths) {
    const content = written.get(path);
    if (content) target.set(path, content);
    else target.delete(path);
  }
  const ops = diffFiles(base, target);
  const placed = rebase(current, { id, author, ops, inverse: invertOps(base, ops) });
  const merged = paths.filter((path) => !sameContent(placed.files.get(path), written.get(path)) && !sameText(placed.files.get(path), written.get(path)));
  return { ops: placed.ops, skipped: placed.skipped, overwrote: placed.overwrote, merged };
}

// The version of a file the program most likely read: the one fewest operations away from what it
// wrote, the oldest of those as close (versions: newest first). undefined: the file did not exist in it.
function closestVersion(path: string, written: FileContent | undefined, versions: readonly Files[]): FileContent | undefined {
  let best: { content: FileContent | undefined; cost: number } | null = null;
  const tried: (FileContent | undefined)[] = [];
  for (const files of versions) {
    const content = files.get(path);
    if (tried.some((other) => other === content || (other !== undefined && content !== undefined && sameContent(other, content)))) continue;
    tried.push(content);
    const cost = distance(path, content, written);
    if (!best || cost <= best.cost) best = { content, cost };
    if (cost === 0) break;
  }
  return best?.content;
}

// How far apart two versions are: the size of the operations between them, JSON compared by value
// (keys in one order: a program that rewrote a file with its keys in another order did not change them).
function distance(path: string, from: FileContent | undefined, to: FileContent | undefined): number {
  const pick = (content: FileContent | undefined) => {
    const doc = documentOf(path, content);
    return new Map(content ? [[path, doc === undefined ? content : jsonFile(sorted(doc))]] : []);
  };
  return JSON.stringify(diffFiles(pick(from), pick(to))).length;
}

function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) setKey(out, key, sorted(value[key]));
  return out;
}

// The same document in another formatting is the same file for the program that wrote it.
function sameText(a: FileContent | undefined, b: FileContent | undefined): boolean {
  if (!a || !b || a.kind !== 'text' || b.kind !== 'text') return false;
  try {
    return JSON.stringify(JSON.parse(a.text)) === JSON.stringify(JSON.parse(b.text));
  } catch {
    return false;
  }
}
