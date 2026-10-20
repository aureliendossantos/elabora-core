import type { ProjectFiles, SourceFile } from '../../project/files.ts';

// What a format migration did to one file. dropped: a value the new format no longer has (the
// message says why nothing is lost); skipped: a file the migration could not read and left as it is.
export interface MigrationNote {
  kind: 'changed' | 'dropped' | 'skipped';
  file: string;
  path?: string; // JSON pointer of the value in the file
  message: string;
}

// One step of the chain, from a format to the next. It reads the raw files of a project (whatever
// their state: files that do not parse are left as they are, with a note) and returns the files it
// changed, never the others.
export interface FormatStep {
  from: string;
  to: string;
  summary: string; // what the step changes, in one sentence
  migrate(files: ProjectFiles): { files: ReadonlyMap<string, SourceFile>; notes: MigrationNote[] };
}

// A project brought to the current format by the steps it needed.
export interface FormatMigration {
  from: string;
  to: string;
  steps: { from: string; to: string; summary: string }[];
  files: ProjectFiles; // the whole project once migrated
  changed: string[]; // the files whose content changed, sorted
  notes: MigrationNote[];
}
