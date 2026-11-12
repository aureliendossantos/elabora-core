import type { Author, FileContent, Files, Json, JsonObject, Op, SkippedOp } from '../ops/types.ts';
import { invertOps, openWorkspace, readDocument } from '../ops/apply.ts';
import { diffFiles } from '../ops/diff.ts';
import { cloneJson, documentOf, isObject, jsonFile, sameContent, sameJson, setKey } from '../ops/json.ts';
import { formatPath, lookup } from '../ops/path.ts';
import { isAiAuthor } from '../ops/batch.ts';
import { rebase } from './rebase.ts';
import type { Overwrite } from './protocol.ts';

// A file edit no Elabora tool made (an agent's own tools), on one copy (D75). The program that wrote
// may have read the file long before: writing what it read, with its edit, would undo what was
// written meanwhile (by the author in the app, by others through the server) without anyone being
// told. So the edit is computed from the version it most likely read, not from the files as they
// are: among the recent versions of each written file, the one closest to what was written (the
// least between them: JSON by value whatever the order of keys, text by lines). When several are
// as close, the edit rewrote what changed between them, and nothing tells whether it saw it: the
// newest is taken (an author who just wrote a text and asks an agent to rework it gets the
// rework), and when a person changed the file between them, what the edit replaces of theirs is
// reported as overwritten, unsure, so that they are told. Then the edit is rebased on the files as
// they are, as an agent's change: where they clash, what is there now is kept, and the operations
// left out are reported.

// A version a copy held, and who made the change that came after it.
export interface Version { files: Files; then: Author }

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
export function externalEdit(current: Files, written: Files, versions: readonly Version[], author: Author = { kind: 'external' }, id = 'external'): ExternalEdit {
  const paths = [...new Set([...current.keys(), ...written.keys()])].filter((path) => !sameContent(current.get(path), written.get(path)));
  if (!paths.length) return { ops: [], skipped: [], overwrote: [], merged: [] };
  const base = new Map(current);
  const unseen = new Map(current); // with the version before a person's edit where the read is unsure
  let unsure = false;
  for (const path of paths) {
    const read = closestVersion(path, written.get(path), current, versions);
    put(base, path, read.chosen);
    put(unseen, path, read.unsure ? read.before : read.chosen);
    unsure ||= read.unsure;
  }
  const edit = (from: Files) => {
    const target = new Map(from);
    for (const path of paths) put(target, path, written.get(path));
    const ops = diffFiles(from, target);
    return rebase(current, { id, author, ops, inverse: invertOps(from, ops) });
  };
  const placed = edit(base);
  const overwrote = [...placed.overwrote];
  if (unsure) {
    // What the edit replaces that a person wrote between the versions as close: had the program
    // read before it, those operations would be left out. They apply, and the person is told.
    const left = new Set(placed.skipped.map((skipped) => targetOf(skipped.op)));
    for (const skipped of edit(unseen).skipped) {
      if (skipped.reason !== 'changed' || left.has(targetOf(skipped.op))) continue;
      const path = 'path' in skipped.op ? skipped.op.path : [];
      const found = lookup(readDocument(openWorkspace(current), skipped.op.file), path);
      const content = current.get(skipped.op.file);
      overwrote.push({ file: skipped.op.file, path: formatPath(path), was: found.found ? cloneJson(found.value) : content?.kind === 'text' ? content.text : null, unsure: true });
    }
  }
  const merged = paths.filter((path) => !sameContent(placed.files.get(path), written.get(path)) && !sameText(path, placed.files.get(path), written.get(path)));
  return { ops: placed.ops, skipped: placed.skipped, overwrote, merged };
}

const put = (files: Map<string, FileContent>, path: string, content: FileContent | undefined) => {
  if (content) files.set(path, content);
  else files.delete(path);
};

const targetOf = (op: Op): string => `${op.file} ${'path' in op ? formatPath(op.path) : ''}`;

// The version of a file the program most likely read (versions: newest first; undefined: the file
// did not exist in it): the closest to what it wrote, the newest of those as close. unsure: a
// person changed the file between the versions as close, so the program may not have seen it;
// before is the version before that person's newest change.
function closestVersion(path: string, written: FileContent | undefined, current: Files, versions: readonly Version[]): { chosen: FileContent | undefined; unsure: boolean; before?: FileContent } {
  const contents = [current.get(path), ...versions.map((version) => version.files.get(path))];
  const costs: number[] = [];
  const known: { content: FileContent | undefined; cost: number }[] = [];
  for (const content of contents) {
    let entry = known.find((other) => same(other.content, content));
    if (!entry) known.push(entry = { content, cost: distance(path, content, written) });
    costs.push(entry.cost);
  }
  const least = Math.min(...costs);
  const tied = costs.flatMap((cost, i) => (cost === least ? [i] : []));
  // Candidate i + 1 became candidate i by a change of versions[i].then.
  for (let i = tied[0]; i < tied[tied.length - 1]; i++) {
    if (!isAiAuthor(versions[i].then) && !same(contents[i], contents[i + 1])) {
      return { chosen: contents[tied[0]], unsure: true, before: contents[tied.find((t) => t > i) as number] };
    }
  }
  return { chosen: contents[tied[0]], unsure: false };
}

const same = (a: FileContent | undefined, b: FileContent | undefined): boolean => a === b || (a !== undefined && b !== undefined && sameContent(a, b));

// How far apart two versions are: the size of the operations between them, JSON compared by value
// (keys in one order: a program that rewrote a file with its keys in another order did not change them).
function distance(path: string, from: FileContent | undefined, to: FileContent | undefined): number {
  if (from?.kind === 'text' && to?.kind === 'text' && documentOf(path, from) === undefined) return lineDistance(from.text, to.text);
  const pick = (content: FileContent | undefined) => {
    const doc = documentOf(path, content);
    return new Map(content ? [[path, doc === undefined ? content : jsonFile(sorted(doc))]] : []);
  };
  return JSON.stringify(diffFiles(pick(from), pick(to))).length;
}

// The length of the lines one text has and the other has not (counted with their repeats).
function lineDistance(a: string, b: string): number {
  const counts = new Map<string, number>();
  for (const line of a.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  let cost = 0;
  for (const line of b.split('\n')) {
    const left = counts.get(line) ?? 0;
    if (left) counts.set(line, left - 1);
    else cost += line.length + 1;
  }
  for (const [line, left] of counts) cost += (line.length + 1) * left;
  return cost;
}

function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) setKey(out, key, sorted(value[key]));
  return out;
}

// The same document in another formatting is the same file for the program that wrote it.
function sameText(path: string, a: FileContent | undefined, b: FileContent | undefined): boolean {
  const x = documentOf(path, a);
  const y = documentOf(path, b);
  return x !== undefined && y !== undefined && sameJson(x, y);
}
