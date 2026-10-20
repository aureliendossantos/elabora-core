// A command that is still waiting for something when nothing is left to wait for (a promise no one
// settles, a process not held) must not end as a success without a word: Node ends the process
// when its event loop is empty, exit code 0, and `elabora narration transcribe` printed nothing that
// way (13 October 2026). That is an error, with a code (70, EX_SOFTWARE) and the words to report
// it. Call the returned function when the command is over, whatever it returned.
export const UNSETTLED_EXIT_CODE = 70;

export function guardUnsettled(argv: readonly string[]): () => void {
  let finished = false;
  process.once('beforeExit', () => {
    if (finished) return;
    console.error(`✘ E_COMMAND_UNSETTLED: elabora ${argv.join(' ')} stopped before it finished, because something it was waiting for never answered. Nothing was lost; run it again, and report it if it happens again.`);
    process.exitCode = UNSETTLED_EXIT_CODE;
  });
  return () => { finished = true; };
}
