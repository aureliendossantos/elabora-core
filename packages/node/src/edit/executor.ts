import path from 'node:path';
import type { Author, ChangeLike, FileHash, Files, Op, TextFile } from '@elabora/core/ops/types';
import { applyOps, invertOps, touchedFiles } from '@elabora/core/ops/apply';
import { diffFiles } from '@elabora/core/ops/diff';
import { documentOf, formatJson, isJsonPath, sameContent } from '@elabora/core/ops/json';
import { OpError } from '@elabora/core/ops/errors';
import { CommandError, commandContext, schemaProblems, type CommandContext, type CommandDiagnostic, type CommandOutput } from '@elabora/core/commands/index';
import { textFile, type ProjectFiles } from '@elabora/core/project/files';
import { validateProject } from '@elabora/core/validate/index';
import { readProjectFiles, loadProjectFromDir } from '../project-reader.ts';
import {
  withProjectLockSync, isProjectLockHeld, LockError, JournalError, appendChange, storeChangeBlobsSync, changeFileHashes, detectAuthor
} from '../journal/index.ts';
import { changedOnDisk, keepOriginalTexts, writeFiles } from './disk.ts';
import { takeAutoVersion, pruneAfterVersion, type AutoVersion } from './auto-version.ts';
import type { VersionReason } from '../backups/index.ts';
import { migrateIfOutdated, type FormatMigrationRef } from './migrate.ts';

// Runs a command as a change (docs/architecture/operations.md): under the
// project lock, reads the snapshot, runs the command, turns its output into operations, refuses a
// result that does not match the schemas, checks that the files it touches did not change on disk
// meanwhile, keeps what undo needs, writes the files and journals the change. Then validates.
// A course in an older format is migrated first, as its own change (migrate.ts); one in a newer
// format is refused (E_FORMAT_NEWER).

export { CommandError as EditError };

export interface EditOptions {
  // Who writes. By default detectAuthor(): ELABORA_AUTHOR, Claude Code, a terminal or not. The MCP
  // server passes { kind: 'agent', name: <client name> }.
  author?: Author;
  // How long to wait for the project lock (another writer) before failing with E_LOCKED; 40 s by default.
  lockTimeoutMs?: number;
  // Called after the change is computed and before the files on disk are checked: lets tests play
  // another program writing meanwhile.
  beforeWrite?: (attempt: number) => void;
  // The files to compute the change from, instead of reading the folder: an engine holds the
  // project in memory. Called at each attempt; stale lists the touched files that the previous
  // attempt found changed on disk (empty at first), so that the caller takes them in (journals them
  // as an external change) before the change is computed again. The result then says what was
  // written (written), so the caller updates its snapshot without reading the folder.
  files?: (stale: readonly string[]) => ProjectFiles;
  // false: no validation of the whole project after the edit (an engine validates incrementally);
  // the result's diagnostics are then empty and its summary null.
  validate?: boolean;
  // false: no automatic version before writing (an engine schedules its versions itself).
  autoVersion?: boolean;
}

export interface CommandSpec<Result> {
  name: string;   // journaled command name (create_screen…)
  args: unknown;  // journaled arguments
  run: (context: CommandContext) => CommandOutput<Result>;
  // Contents of binary files the command brings in from outside the project, by hash: file paths,
  // or the bytes when they are not files (read from an archive).
  sources?: ReadonlyMap<string, Uint8Array | string>;
  // The format migration itself: it reads files in an older format and writes what the core's
  // migrations computed, schema problems the files already had included (they are reported).
  migratesFormat?: boolean;
  // A backup version taken before writing for this reason, whenever the command writes (an
  // automatic version, at most every 5 minutes, otherwise).
  versionReason?: VersionReason;
}

export interface ChangeRef { id: string; seq: number; batch: string }

export interface EditResult {
  ok: true;
  op: string;
  undo: number | null; // the journal sequence number of the change (elabora undo --seq)
  change: ChangeRef | null; // null: the command changed nothing
  files: string[];
  diagnostics: CommandDiagnostic[];
  summary: unknown;
  backup?: AutoVersion;
  // With the files option: the snapshot the change was computed from and the files after it (only
  // the touched files differ; after is before when nothing changed).
  written?: Written;
  formatMigration?: FormatMigrationRef; // the course was in an older format: migrated first, by its own change
}

export interface Written {
  before: ProjectFiles;
  after: Files;
}

// A change that is computed again when a file it touches changed on disk meanwhile.
const ATTEMPTS = 3;

export function runCommand<Result extends object>(dir: string, spec: CommandSpec<Result>, options: EditOptions = {}): EditResult & Result {
  const root = path.resolve(dir);
  const formatMigration = spec.migratesFormat ? null : migrateIfOutdated(root, options);
  // The caller's snapshot may not hold the migration yet: its files are read as migrated.
  if (formatMigration?.written && options.files) options = { ...options, files: withWritten(options.files, formatMigration.written) };
  const author = options.author ?? detectAuthor();
  let backup: AutoVersion | null = null;
  const { entry, ops, result, written } = translateErrors(() => withProjectLockSync(root, () => {
    let stale: string[] = [];
    for (let attempt = 1; ; attempt++) {
      const before = snapshotFor(root, options, stale);
      const output = spec.run(commandContext(before, { root, author }));
      const ops = output.ops ?? opsBetween(before, output.files);
      if (!ops.length) return { entry: null, ops, result: output.result, written: { before, after: before } };
      const after = applyOps(before, ops);
      const problems = spec.migratesFormat ? [] : schemaProblems(after, touchedFiles(ops));
      if (problems.length) throw new CommandError(`${spec.name} refused: the result does not match the schema`, problems);
      if (attempt === 1 && options.autoVersion !== false) backup = takeAutoVersion(root, author, before, spec.versionReason);
      options.beforeWrite?.(attempt);
      const changed = changedOnDisk(root, before, touchedFiles(ops));
      if (changed.length) {
        if (attempt < ATTEMPTS) { stale = changed; continue; }
        throw conflict(changed);
      }
      const inverse = invertOps(before, ops);
      const entry = commit(root, { before, after, ops, inverse, sources: spec.sources }, (files) =>
        appendChange(root, { author, command: { name: spec.name, args: spec.args }, ops, inverse, files }));
      return { entry, ops, result: output.result, written: { before, after } };
    }
  }, { timeoutMs: options.lockTimeoutMs }));
  pruneAfter(root, backup);
  return { ...editResult(root, spec.name, entry, ops, backup, options, written), ...(formatMigration ? { formatMigration } : {}), ...result };
}

// The files an attempt computes from: the caller's, or the folder as it is.
export function snapshotFor(root: string, options: EditOptions, stale: readonly string[]): ProjectFiles {
  return options.files ? options.files(stale) : readProjectFiles(root).files;
}

// A caller's snapshot with what a change wrote: each file the change touched that the snapshot
// still holds as it was before is read as the change left it.
function withWritten(files: NonNullable<EditOptions['files']>, written: Written): NonNullable<EditOptions['files']> {
  const touched = [...new Set([...written.before.keys(), ...written.after.keys()])].filter((file) => !sameContent(written.before.get(file), written.after.get(file)));
  return (stale) => {
    const snapshot = files(stale);
    const out = new Map(snapshot);
    for (const file of touched) {
      if (!sameContent(snapshot.get(file), written.before.get(file))) continue;
      const after = written.after.get(file);
      if (!after) out.delete(file);
      else if (after.kind === 'text') out.set(file, textFile(after.text)); // migrations write text files only
    }
    return out;
  };
}

// Writes a computed change and journals it. Before writing: the binary contents the change and its
// inverse name go to the blob store, and the original text of hand-formatted JSON files is kept.
export function commit<Entry extends ChangeLike>(root: string, change: { before: Files; after: Files; ops: Op[]; inverse: Op[]; sources?: ReadonlyMap<string, Uint8Array | string> }, record: (files: FileHash[]) => Entry): Entry {
  storeChangeBlobsSync(root, { ops: change.ops, inverse: change.inverse }, change.sources);
  keepOriginalTexts(root, change.before, change.ops);
  writeFiles(root, change.before, change.after, change.ops);
  return record(changeFileHashes(change.before, change.after, change.ops));
}

export function editResult(root: string, op: string, entry: ChangeLike | null, ops: readonly Op[], backup: AutoVersion | null, options: EditOptions = {}, written?: Written): EditResult {
  const files = touchedFiles(ops);
  const touched = new Set(files);
  const validation = options.validate === false ? null : validateProject(loadProjectFromDir(root));
  return {
    ok: true, op, undo: entry?.seq ?? null, change: entry ? { id: entry.id, seq: entry.seq, batch: entry.batch } : null, files,
    diagnostics: validation ? (validation.diagnostics as CommandDiagnostic[]).filter((d) => touched.has(d.file as string) || d.severity === 'error') : [],
    summary: validation?.summary ?? null,
    ...(backup ? { backup } : {}),
    ...(options.files && written ? { written } : {})
  };
}

// After an automatic version, the project's data is pruned, once the lock is released (pruning the
// journal takes it). A nested edit leaves it to the outer one.
export function pruneAfter(root: string, backup: AutoVersion | null): void {
  if (backup && !isProjectLockHeld(root)) pruneAfterVersion(root);
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

export function conflict(paths: readonly string[]): CommandError {
  const message = `${paths.join(', ')} changed on disk while the edit was computed (another program is writing): run it again.`;
  return new CommandError(message, paths.map((file) => ({ code: 'E_CONFLICT', severity: 'error', file, message })), 'E_CONFLICT');
}

// Errors of operations, of the lock and of the journal reach the CLI and the MCP server as edit
// errors with their catalogue code.
export function translateErrors<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    const code = error instanceof OpError || error instanceof LockError || error instanceof JournalError ? error.code : null;
    if (!code) throw error;
    const message = (error as Error).message;
    throw new CommandError(message, [{ code, severity: 'error', message }], code);
  }
}
