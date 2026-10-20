// A command whose promise nobody settles, under the guard of the command line (src/unsettled.ts).
import { guardUnsettled } from '../../packages/cli/src/unsettled.ts';

const over = guardUnsettled(['narration', 'transcribe', 'x.m4a']);
if (process.argv[2] === 'finishes') { over(); console.log('done'); } else await new Promise<void>(() => {});
