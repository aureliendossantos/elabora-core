import fs from 'node:fs';
import path from 'node:path';
import { FORMAT } from '@elabora/format';
import { FORMAT_STEPS, checkFormat, newerMessage, type FormatMigration, type FormatStep, type MigrationNote } from '@elabora/core/format/migrations/index';
import { JsonText } from '@elabora/core/format/migrations/json-text';
import { compareFormats, formatNumbers, projectFormat } from '@elabora/core/format/version';
import { CommandError, type CommandDiagnostic } from '@elabora/core/commands/index';
import { loadProject } from '@elabora/core/project/load';
import { readText, textFile, type ProjectFiles } from '@elabora/core/project/files';
import { validateProject } from '@elabora/core/validate/index';
import { GATES_FILE, objectFingerprint } from '../objects/gates-record.ts';
import { AGENTS_FILE, agentRulesState, agentsFile, currentRules } from '../agent-rules.ts';
import { runCommand, snapshotFor, type ChangeRef, type EditOptions, type EditResult, type Written } from './executor.ts';

// Format migrations written to a course folder (docs/architecture/operations.md, Identifiers and format
// version): the core computes the migrated files (@elabora/core format/migrations); they are written
// as one `system` change, after a backup version taken for the reason `migration`, so that
// `elabora undo` (or a restore) gives the course back as it was. `elabora migrate`, the engine when it
// opens a project, the library when it imports one, and the first edit of an outdated course
// through Elabora all come here.

// A migration is always written as a `system` change: it is never part of AI work. The executor's
// options apply as to any edit: an engine that holds the project in memory passes its files (the
// result then says what was written), and validate or autoVersion false.
export interface MigrateOptions extends Pick<EditOptions, 'lockTimeoutMs' | 'beforeWrite' | 'files' | 'validate' | 'autoVersion'> {
  dryRun?: boolean; // computes what would change, writes nothing
  steps?: readonly FormatStep[]; // the chain (FORMAT_STEPS); tests give one of their own
}

export interface MigrateResult extends EditResult {
  migrated: boolean; // a change was written
  dryRun: boolean;
  from: string; // the format the files were in
  to: string; // the format they are in now (or would be)
  notes: MigrationNote[]; // what changed, what was dropped, what was skipped, per file
}

export interface FormatMigrationRef {
  from: string;
  to: string;
  change: ChangeRef | null;
  written?: Written; // with the files option: what the migration wrote (EditResult.written)
}

const SYSTEM = { kind: 'system' } as const;

export function migrateProject(dir: string, options: MigrateOptions = {}): MigrateResult {
  const root = path.resolve(dir);
  const files = snapshotFor(root, options, []);
  const chain = options.steps ?? FORMAT_STEPS;
  const check = checkFormat(files, chain);
  if (check.status === 'newer') throw newerError(check.format);
  if (check.status === 'unknown') {
    if (!files.has('course.json')) throw new CommandError(`${root} is not an Elabora course (no course.json)`, [], 'E_FILE_MISSING');
    const message = check.format === null
      ? 'course.json has no format string (or does not parse): set "format" to the format the course was written in, then run elabora migrate again.'
      : `course.json declares the format "${check.format}", which this Elabora does not know (it reads ${FORMAT} and migrates older elabora/ versions).`;
    throw new CommandError(message, [{ code: 'E_SCHEMA', severity: 'error', file: 'course.json', path: '/format', message }], 'E_SCHEMA');
  }
  const base = { ok: true as const, op: 'migrate_format', undo: null, change: null, dryRun: !!options.dryRun };
  if (check.status === 'current') {
    return { ...base, migrated: false, from: check.format, to: check.format, files: [], notes: [], diagnostics: [], summary: null };
  }
  const { migration } = check;
  if (options.dryRun) {
    const planned = asWritten(root, migration, files);
    const validation = options.validate === false ? null : validateProject(loadProject(planned.files, { root }));
    return {
      ...base, migrated: false, from: migration.from, to: migration.to, files: planned.changed, notes: planned.notes,
      diagnostics: (validation?.diagnostics.filter((d) => d.severity === 'error') ?? []) as CommandDiagnostic[], summary: validation?.summary ?? null
    };
  }
  const args = { from: migration.from, to: migration.to };
  // The files are read again under the lock: another writer may have migrated them meanwhile.
  const written = runCommand(root, {
    name: 'migrate_format', args, migratesFormat: true, versionReason: 'migration',
    run: (context) => {
      const current = checkFormat(context.files, chain);
      if (current.status !== 'outdated') return { files: context.files, result: { notes: [] } };
      const { files: migrated, notes } = asWritten(root, current.migration, context.files);
      return { files: migrated, result: { notes } };
    }
  }, { lockTimeoutMs: options.lockTimeoutMs, beforeWrite: options.beforeWrite, files: options.files, validate: options.validate, autoVersion: options.autoVersion, author: SYSTEM });
  return { ...written, migrated: written.change !== null, dryRun: false, from: migration.from, to: migration.to };
}

// The migration as it is written: the core's files, and the gate records of free objects carried
// over. A record's fingerprint covers every file of the object, which a migration rewrites (its
// $schema); when the record matched the object before and the migration changed nothing else in it
// (nothing dropped or skipped there), the gates exercised the same object: the record keeps its
// result under the new fingerprint, instead of asking for a run of every gate again. The
// fingerprint hashes bytes (snapshots, assets), so this is done here, not in the core.
function asWritten(root: string, migration: FormatMigration, before?: ProjectFiles): { files: ProjectFiles; changed: string[]; notes: MigrationNote[] } {
  const files = new Map(migration.files);
  let notes = [...migration.notes];
  const changed = [...migration.changed];
  // AGENTS.md as an earlier Elabora wrote it, edited by nobody: the rules of this Elabora (D34), in
  // place of the lines the core's steps rewrite.
  const rules = before ? readText(before, AGENTS_FILE) : null;
  const state = agentRulesState(rules);
  if (state.status === 'outdated') {
    files.set(AGENTS_FILE, textFile(agentsFile(state.notes)));
    // What the core's steps said of the lines they rewrote: replaced by the whole rules.
    notes = notes.filter((note) => note.file !== AGENTS_FILE);
    if (!changed.includes(AGENTS_FILE)) changed.push(AGENTS_FILE);
    notes.push({ kind: 'changed', file: AGENTS_FILE, path: '', message: `the rules for agents of this Elabora (revision ${state.revision} → ${currentRules().revision})` });
  }
  for (const record of [...files.keys()].filter((file) => /^objects\/[^/]+\/[^/]+$/.test(file) && file.endsWith(`/${GATES_FILE}`)).sort()) {
    const folder = record.slice(0, -GATES_FILE.length);
    if (!migration.changed.some((file) => file.startsWith(folder))) continue;
    if (migration.notes.some((note) => note.file.startsWith(folder) && note.kind !== 'changed')) continue;
    const text = readText(files, record);
    let document: JsonText;
    try { document = new JsonText(text ?? ''); } catch { continue; }
    const value = document.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.fingerprint !== 'string') continue;
    const dir = path.join(root, ...folder.split('/'));
    if (value.fingerprint !== objectFingerprint(dir)) continue; // stale already: it stays so
    const fingerprint = objectFingerprint(dir, (file) => (migration.changed.includes(folder + file) ? readText(migration.files, folder + file) ?? undefined : undefined));
    document.set(['fingerprint'], fingerprint);
    files.set(record, textFile(document.toString()));
    changed.push(record);
    notes.push({ kind: 'changed', file: record, path: '/fingerprint', message: 'gate results carried over (the object changed by its format strings only)' });
  }
  return { files, changed: changed.sort(), notes };
}

// A course in an older format is migrated (null when it needed nothing: current, or a format this
// Elabora does not know, which validation reports); a course in a newer format is refused
// (E_FORMAT_NEWER). Reads course.json only (of the folder, or of the caller's files), so that
// current courses pay nothing. Edits through Elabora call it first, with their options: the
// migration is its own change, and the edit reads the migrated files. The engine calls it when it
// opens a project.
export function migrateIfOutdated(dir: string, options: MigrateOptions = {}): FormatMigrationRef | null {
  const root = path.resolve(dir);
  const format = options.files ? projectFormat(options.files([])) : courseFormat(root);
  if (format === null || formatNumbers(format) === null || format === FORMAT) return null;
  if (compareFormats(format, FORMAT) > 0) throw newerError(format);
  if (!(options.steps ?? FORMAT_STEPS).some((step) => step.from === format)) return null;
  const { dryRun, ...writing } = options;
  if (dryRun) return null;
  const result = migrateProject(root, writing);
  return result.migrated ? { from: result.from, to: result.to, change: result.change, ...(result.written ? { written: result.written } : {}) } : null;
}

function courseFormat(root: string): string | null {
  try {
    const course: unknown = JSON.parse(fs.readFileSync(path.join(root, 'course.json'), 'utf8'));
    const format = course && typeof course === 'object' ? Reflect.get(course, 'format') : undefined;
    return typeof format === 'string' ? format : null;
  } catch {
    return null; // missing or broken: the edit reports it
  }
}

function newerError(format: string): CommandError {
  const message = `${newerMessage(format)} Nothing was written.`;
  return new CommandError(message, [{ code: 'E_FORMAT_NEWER', severity: 'error', file: 'course.json', path: '/format', message }], 'E_FORMAT_NEWER');
}
