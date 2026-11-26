import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The local voices' catalogue that a browser's host serves beside the engine (D127): voices.json and
// each voice's embeddings, at the paths voices.json names (<bundle>/<voice>.f16). A host copies them at
// its build under the address it gives the session (the open message's voices); the models themselves
// come from the models' origin.

const DIR = fileURLToPath(new URL('../../../voices/pocket-tts/', import.meta.url));

export function pocketCatalogueFiles(): { name: string; file: string }[] {
  const { voices } = JSON.parse(fs.readFileSync(path.join(DIR, 'voices.json'), 'utf8')) as { voices: { file: string }[] };
  return ['voices.json', ...voices.map((voice) => voice.file)].map((name) => ({ name, file: path.join(DIR, name) }));
}
