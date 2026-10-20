import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The tests' global setup (npm test, test:e2e, test:matrix): the local data of the computer and
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
}

export async function globalTeardown(): Promise<void> {
  if (made) fs.rmSync(made, { recursive: true, force: true });
}
