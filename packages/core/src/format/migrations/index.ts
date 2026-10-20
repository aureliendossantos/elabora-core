import type { ProjectFiles, SourceFile } from '../../project/files.ts';
import { FORMAT, compareFormats, formatNumbers, projectFormat } from '../version.ts';
import type { FormatMigration, FormatStep, MigrationNote } from './types.ts';

// Format migrations (docs/architecture/operations.md, Identifiers and format version): pure functions from one
// format to the next on the raw files of a project. Loading an older project migrates it in memory
// (loadProject reports I_FORMAT_OUTDATED); `elabora migrate`, the engine on open and the library
// import write the result as one `system` change, after a backup. Every format change adds its step
// here, with a fixture of a course in the older format (test/fixtures/format-<version>/). elabora/0.1
// is the first format: the chain is empty, and the tests run the mechanism with a step of their own
// (the steps argument).

export type { FormatMigration, FormatStep, MigrationNote } from './types.ts';

// The chain, oldest first: each step goes from one format to the next.
export const FORMAT_STEPS: readonly FormatStep[] = [];

// What this Elabora makes of the format of a project:
//   current: read as it is; outdated: read once migrated (migration: the files and the notes);
//   newer: written by a newer Elabora, not read; unknown: no course.json format this Elabora knows
//   (missing, not a string, not elabora/<version>, or an older version without migration): the
//   project loads as it is and validation reports what is wrong.
export type FormatCheck =
  | { status: 'current'; format: string }
  | { status: 'outdated'; format: string; migration: FormatMigration }
  | { status: 'newer'; format: string }
  | { status: 'unknown'; format: string | null };

export function checkFormat(files: ProjectFiles, chain: readonly FormatStep[] = FORMAT_STEPS): FormatCheck {
  const format = projectFormat(files);
  if (format === null || formatNumbers(format) === null) return { status: 'unknown', format };
  const order = compareFormats(format, FORMAT);
  if (order === 0) return format === FORMAT ? { status: 'current', format } : { status: 'unknown', format };
  if (order > 0) return { status: 'newer', format };
  const steps: FormatStep[] = [];
  for (let at = format; at !== FORMAT; ) {
    const step = chain.find((candidate) => candidate.from === at);
    if (!step) return { status: 'unknown', format };
    steps.push(step);
    at = step.to;
  }
  return { status: 'outdated', format, migration: runSteps(files, format, steps) };
}

function runSteps(files: ProjectFiles, from: string, steps: readonly FormatStep[]): FormatMigration {
  let current: ProjectFiles = files;
  const notes: MigrationNote[] = [];
  for (const step of steps) {
    const result = step.migrate(current);
    const next = new Map<string, SourceFile>(current);
    for (const [file, content] of result.files) next.set(file, content);
    current = next;
    notes.push(...result.notes);
  }
  const changed = [...current.keys()].filter((file) => current.get(file) !== files.get(file)).sort();
  return {
    from, to: FORMAT, steps: steps.map(({ from: stepFrom, to, summary }) => ({ from: stepFrom, to, summary })),
    files: current, changed, notes: sortNotes(notes)
  };
}

// Notes by file (course.json first: it holds the format), then in the order the steps wrote them.
function sortNotes(notes: MigrationNote[]): MigrationNote[] {
  const rank = (file: string) => (file === 'course.json' ? '' : file);
  return notes.map((note, i) => ({ note, i, file: rank(note.file) }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.i - b.i)).map(({ note }) => note);
}

// The notes in a few lines: the same change in several files is said once, with its count.
export function summarizeNotes(notes: readonly MigrationNote[]): string[] {
  const groups = new Map<string, { kind: MigrationNote['kind']; message: string; files: string[] }>();
  for (const note of notes) {
    const key = `${note.kind}|${note.message}`;
    const group = groups.get(key) ?? { kind: note.kind, message: note.message, files: [] };
    if (!group.files.includes(note.file)) group.files.push(note.file);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ kind, message, files }) => `${kind === 'changed' ? '' : `${kind}: `}${message} (${files.length === 1 ? files[0] : `${files.length} files`})`);
}

// What I_FORMAT_OUTDATED says: the format, and what `elabora migrate` would change.
export function outdatedMessage(migration: FormatMigration): string {
  return `This course is in format ${migration.from}: Elabora reads it as ${migration.to}, migrated in memory. \`elabora migrate\` would change ${migration.changed.length} file(s): ${summarizeNotes(migration.notes).join('; ')}.`;
}

// What E_FORMAT_NEWER says.
export function newerMessage(format: string): string {
  return `This course is in format ${format}, newer than the one this version of Elabora reads (${FORMAT}): update Elabora to work on it.`;
}
