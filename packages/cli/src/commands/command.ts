import { formatDiagnostic } from '@elabora/core/diagnostics/index';
import type { Diagnostic } from '@elabora/core/diagnostics/index';
import { parseArguments } from '../arguments.ts';
import type { FlagSpecs, ParsedArguments } from '../arguments.ts';
import type { FormatMigrationRef } from '@elabora/node/edit';

// A command of the elabora command line ("validate", or a subcommand: "component new"), with the
// flags it accepts. Commands return their exit code, or null when they keep running (mcp).
export type ExitCode = number | null;

export interface Command {
  readonly name: string;
  run(argv: readonly string[]): Promise<ExitCode>;
}

export interface CommandDefinition<Specs extends FlagSpecs> {
  name: string;
  flags: Specs;
  run(input: ParsedArguments<Specs>): ExitCode | Promise<ExitCode>;
}

export function defineCommand<const Specs extends FlagSpecs>(definition: CommandDefinition<Specs>): Command {
  return {
    name: definition.name,
    async run(argv) { return definition.run(parseArguments(argv, definition.flags)); }
  };
}

// A section of the help (its title and lines, as printed) and the commands it documents.
// subcommandUsage: what a command with subcommands prints when the subcommand is unknown.
export interface CommandGroup {
  title: string;
  help: string;
  commands: Command[];
  subcommandUsage?: Record<string, string>;
}

export const printJson = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

// Human output: --json prints nothing here (the command prints its JSON), and info findings stay quiet.
export function printDiagnostics(diagnostics: readonly Diagnostic[], { json = false, quietInfo = true }: { json?: boolean; quietInfo?: boolean } = {}): void {
  if (json) return;
  // Findings the author ignored (D31) are counted by the summary, not listed.
  for (const d of diagnostics) if (!(quietInfo && d.severity === 'info') && !d.ignored) console.log(formatDiagnostic(d));
}

// An edit of a course in an older format migrated it first, as its own change.
export function printFormatMigration(migration: FormatMigrationRef | undefined): void {
  if (migration) console.log(`✔ Migrated the course from ${migration.from} to ${migration.to} first (change ${migration.change?.seq ?? '?'}; elabora undo --change ${migration.change?.seq ?? '<seq>'} reverts it).`);
}

// Messages of errors thrown by node services, which are not always Error instances.
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Errors in the validation summary an edit returns (typed unknown until core/validate is typed).
export function summaryErrors(summary: unknown): number {
  return typeof summary === 'object' && summary !== null && 'errors' in summary && typeof summary.errors === 'number' ? summary.errors : 0;
}

// The findings an edit was refused for (EditError), if any.
export function errorDiagnostics(error: unknown): Diagnostic[] {
  const diagnostics = error instanceof Error && 'diagnostics' in error ? error.diagnostics : undefined;
  return Array.isArray(diagnostics) ? diagnostics : [];
}

// Runs a command whose failures are expected (refused edits, missing files): the message and the
// findings, then exit code 1.
export async function reportingFailures(run: () => ExitCode | Promise<ExitCode>, { json = false }: { json?: boolean } = {}): Promise<ExitCode> {
  try {
    return await run();
  } catch (error) {
    if (json) { printJson({ ok: false, error: errorMessage(error), diagnostics: errorDiagnostics(error) }); return 1; }
    console.error(`✘ ${errorMessage(error)}`);
    printDiagnostics(errorDiagnostics(error));
    return 1;
  }
}
