import type { Author, Files, Op, TextFile } from '../ops/types.ts';
import { applyOps, invertOps, touchedFiles } from '../ops/apply.ts';
import { diffFiles } from '../ops/diff.ts';
import { documentOf, formatJson, isJsonPath } from '../ops/json.ts';
import type { ProjectFiles } from '../project/files.ts';
import { CommandError, commandContext, type CommandContext, type CommandOutput } from './context.ts';
import { schemaProblems } from './schemas.ts';

// A command run on files, without I/O (D76): files in, the change it makes out (its operations,
// their inverse on these files, the files after). @elabora/node's executor calls it under the
// project lock and writes what it returns; the room of a project in the cloud calls it on its head.

export interface ExecuteOptions {
  author?: Author;
  now?: Date;
  root?: string;
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
  const output = run(commandContext(files, { root: options.root, now: options.now, author: options.author }));
  const ops = output.ops ?? opsBetween(files, output.files);
  if (!ops.length) return { ops, inverse: [], after: files, result: output.result };
  const after = applyOps(files, ops);
  const problems = options.skipSchemaCheck ? [] : schemaProblems(after, touchedFiles(ops));
  if (problems.length) throw new CommandError(`${name} refused: the result does not match the schema`, problems);
  return { ops, inverse: invertOps(files, ops), after, result: output.result };
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
