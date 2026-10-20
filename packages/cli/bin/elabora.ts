#!/usr/bin/env node
import { errorDiagnostics } from '../src/commands/command.ts';
import { ArgumentError } from '../src/arguments.ts';
import { guardUnsettled } from '../src/unsettled.ts';
import type { ExitCode } from '../src/commands/command.ts';

// elabora look runs after every edit while agents design: it starts without loading the rest of the
// command line (a tenth of a second instead of half a second). Its argument errors go through main,
// which prints them with the help.
async function run(argv: readonly string[]): Promise<ExitCode> {
  if (argv[0] === 'look' && !argv.includes('--help')) {
    const { look } = await import('../src/commands/look.ts');
    try {
      return await look.run(argv.slice(1));
    } catch (error) {
      if (!(error instanceof ArgumentError)) throw error;
    }
  }
  const { main } = await import('../src/main.ts');
  return main(argv);
}

// A command that never settles ends as an error, not as a silent success (src/unsettled.ts).
const over = guardUnsettled(process.argv.slice(2));

run(process.argv.slice(2)).then((code) => {
  over();
  if (code !== null) process.exitCode = code;
}).catch(async (error: unknown) => {
  over();
  const { EditError } = await import('@elabora/node/edit');
  if (error instanceof EditError) {
    console.error(`✘ ${error.message}`);
    for (const d of errorDiagnostics(error)) console.error(`  ${d.code} ${d.file || ''} ${d.message}`);
    process.exitCode = 1;
  } else {
    console.error((error instanceof Error && error.stack) || String(error));
    process.exitCode = 2;
  }
});
