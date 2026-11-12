import type { Author, Files, Op, TextFile } from '../ops/types.ts';
import { applyOps, invertOps, touchedFiles } from '../ops/apply.ts';
import { diffFiles } from '../ops/diff.ts';
import { documentOf, formatJson, isJsonPath } from '../ops/json.ts';
import type { ProjectFiles } from '../project/files.ts';
import { CommandError, commandContext, type CommandContext, type CommandOutput } from './context.ts';
import { schemaProblems } from './schemas.ts';
import { namedCommand } from './table.ts';
import { describeTarget, elementId } from '../ops/path.ts';
import { isRecord } from '../util/values.ts';

// A command run on files, without I/O (D76): files in, the change it makes out (its operations,
// their inverse on these files, the files after). @elabora/node's executor calls it under the
// project lock and writes what it returns; the room of a project in the cloud calls it on its head.

export interface ExecuteOptions {
  author?: Author;
  now?: Date;
  root?: string;
  // Numbers in [0, 1) for the suffixes of the ids it makes (D77); by default cryptographic.
  random?: () => number;
  // The format migration writes what the core's migrations computed, schema problems included.
  skipSchemaCheck?: boolean;
}

export interface Executed<Result> {
  ops: Op[];       // empty: the command changed nothing
  inverse: Op[];
  after: Files;
  result: Result;
}

export function executeCommand<Result>(files: ProjectFiles, name: string, run: (context: CommandContext) => CommandOutput<Result>, options: ExecuteOptions = {}): Executed<Result> {
  const output = run(commandContext(files, { root: options.root, now: options.now, author: options.author, random: options.random }));
  const ops = output.ops ?? opsBetween(files, output.files);
  if (!ops.length) return { ops, inverse: [], after: files, result: output.result };
  const after = applyOps(files, ops);
  const problems = options.skipSchemaCheck ? [] : schemaProblems(after, touchedFiles(ops));
  if (problems.length) throw new CommandError(`${name} refused: the result does not match the schema`, problems);
  return { ops, inverse: invertOps(files, ops), after, result: withRemoved(name, output.result, ops) };
}

// What a change took away that its command did not name (D89): a list, an object or a value given
// whole drops the entries and keys it left out, and the result says which (removed: their paths in
// the journal's writing, "course.json navigation.lockUntilComplete"). A key moved within its object
// is set again in the same change, so it is not taken away; a command made to remove (destructive)
// says nothing more; nor does one whose result already says removed (media files) or renamed (an id
// renamed is removed and inserted again under its new one).
function withRemoved<Result>(name: string, result: Result, ops: readonly Op[]): Result {
  if (namedCommand(name)?.destructive || !isRecord(result) || 'removed' in result || 'renamed' in result) return result;
  const at = (op: Op) => ('path' in op ? describeTarget(op.file, op.op === 'insert' ? [...op.path, { id: elementId(op.value) ?? '' }] : op.path) : op.file);
  const written = new Set(ops.filter((op) => op.op === 'set' || op.op === 'insert' || op.op === 'write').map(at));
  for (const op of ops) if (op.op === 'move') written.add(describeTarget(op.to.file, [...op.to.path, op.path.at(-1)!]));
  const removed = [...new Set(ops.filter((op) => (op.op === 'unset' || op.op === 'remove' || op.op === 'delete') && !written.has(at(op))).map(at))];
  return removed.length ? { ...result, removed } : result;
}

// Operations from the files a command computed. JSON files are compared by value, so the change
// says what changed; a JSON file the command was given as text in another formatting (an agent's
// write_object_file) is written as given, whole.
export function opsBetween(before: ProjectFiles, after: ProjectFiles): Op[] {
  const verbatim = new Set<string>();
  for (const [rel, file] of after) {
    if (file === before.get(rel) || file.kind !== 'text' || !isJsonPath(rel)) continue;
    const value = documentOf(rel, file);
    if (value !== undefined && formatJson(value) !== file.text) verbatim.add(rel);
  }
  if (!verbatim.size) return diffFiles(before, after);
  const others = (files: ProjectFiles): Files => new Map([...files].filter(([rel]) => !verbatim.has(rel)));
  return [...diffFiles(others(before), others(after)), ...[...verbatim].map((rel): Op => ({ op: 'write', file: rel, text: (after.get(rel) as TextFile).text }))];
}
