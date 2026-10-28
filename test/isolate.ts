import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The tests' global setup (pnpm test, test:e2e, test:matrix): the local data of the computer and
// every model folder in it are replaced by folders of this run, so that no test reads, writes,
// downloads into or removes the author's own (the settings and library, the local voices', the word
// aligners', the transcriber's; D38, D46), unless the one who runs them names them (to try the real
// models). Every test process and the commands they start inherit it.
let made: string | null = null;

export async function globalSetup(): Promise<void> {
  made = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-test-data-'));
  process.env.ELABORA_LOCAL_DATA_DIR ??= path.join(made, 'local');
  process.env.ELABORA_VOICE_MODELS_DIR ??= path.join(made, 'voices');
  process.env.ELABORA_ALIGNER_MODELS_DIR ??= path.join(made, 'aligners');
  process.env.ELABORA_TRANSCRIBER_MODELS_DIR ??= path.join(made, 'transcribers');
  // Node's compile cache, kept between runs: the test processes and the many commands they start
  // read the stripped and compiled TypeScript instead of doing it again (half of a command's start).
  process.env.NODE_COMPILE_CACHE ??= path.join(os.tmpdir(), 'elabora-test-compile-cache');
  // Probe caches of the copied examples, shared by every test process of the run (test/helpers.ts).
  process.env.ELABORA_TEST_PROBES ??= path.join(made, 'probes');
}

export async function globalTeardown(): Promise<void> {
  if (made) fs.rmSync(made, { recursive: true, force: true });
}
