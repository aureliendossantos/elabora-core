import { namedCommand, type CommandArgs, type CommandName, type CommandNeed, type CommandResult } from '@elabora/core/commands/table';
import type { CommandOutput } from '@elabora/core/commands/index';
import type { HostNeed } from '@elabora/core/commands/host';
import { componentHash, BUILTINS } from '@elabora/core/components/registry';
import { runCommand, type EditResult } from './executor.ts';
import { PROVIDERS, type AsyncNeed, type HostOptions, type Provider } from './host.ts';

// Edits of a course folder: the commands of @elabora/core's table (commands/table.ts) run as
// journaled, undoable changes under the project lock (executor.ts). A command that needs its host is
// given what it expects by this computer first (host.ts). The CLI, the MCP server, the desktop's
// engine and tests call run; it returns { ok, op, undo, change, files, diagnostics, summary,
// …what the command reports }.

export { EditError, runCommand, commandResult, type EditOptions, type EditResult, type ChangeRef, type Written } from './executor.ts';
export { history, historyBatches, undo, redo, undoBatch, appendMark, type HistoryEntry, type UndoResult } from './history.ts';
export { migrateProject, migrateIfOutdated, type MigrateOptions, type MigrateResult, type FormatMigrationRef } from './migrate.ts';
export { COMPONENT_FILES } from '@elabora/core/commands/index';
export type { HostOptions } from './host.ts';
export { componentHash, BUILTINS };

type Edited<Name extends CommandName> = EditResult & CommandResult<Name>;

// What run answers: at once, or once its host prepared what the command needs.
export type Ran<Name extends CommandName> = CommandNeed<Name> extends AsyncNeed ? Promise<Edited<Name>> : Edited<Name>;

// Runs a command of the table by name on a course folder, as a journaled change: what it needs of
// its host given first, the journal recording what the table says of it.
export function run<Name extends CommandName>(dir: string, name: Name, args: CommandArgs[Name], options: HostOptions = {}): Ran<Name> {
  const command = namedCommand(name);
  if (!command) throw new Error(`No command ${String(name)}`);
  const execute = (given?: { bytes?: ReadonlyMap<string, Uint8Array | string> }) => {
    const journaled = command.journal(args, given);
    return runCommand(dir, { name: journaled.name, args: journaled.args, run: (context) => command.run(context, args, given) as CommandOutput<object>, ...(given?.bytes ? { sources: given.bytes } : {}) }, options);
  };
  if (!command.needs) return execute() as Ran<Name>;
  return (PROVIDERS[command.needs] as Provider<HostNeed>)(dir, args as never, options, execute) as Ran<Name>;
}
