import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TRANSCRIBER_MODELS } from '@elabora/node/transcribe/models';
import { copyExample, EXAMPLE, BILINGUAL, NETWORK_SAMPLE } from '../helpers.ts';
import type { ConformanceTarget, Sample } from '../conformance/engine.ts';

// The engine's protocol (test/conformance/engine.ts) played against the desktop's session: a folder
// opened as the app opens it, the messages carried as its message port carries them. Its services are
// the tests' stand-ins: Pocket TTS said with tones (ELABORA_VOICE_FAKE, as the app's try: scripts), a
// transcriber that hears what it is told, no ElevenLabs key.

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-conformance-'));
process.env.ELABORA_VOICE_FAKE = '1';
delete process.env.ELEVENLABS_API_KEY;
process.env.ELABORA_ELEVENLABS_KEY_FILE = path.join(temp, 'no-key');
// A made-up transcriber model, installed as a download leaves it, and what it hears.
{
  const body = Buffer.from('not a mod.');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const model = TRANSCRIBER_MODELS[0]!;
  fs.writeFileSync(path.join(temp, 'transcribers.json'), JSON.stringify({ [model.id]: [{ name: 'model.bin', url: 'x/model.bin', size: body.length, sha256 }] }));
  const dir = path.join(temp, 'transcribers', model.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.bin'), body);
  fs.writeFileSync(path.join(dir, 'verified.json'), JSON.stringify({ 'model.bin': sha256 }));
  fs.writeFileSync(path.join(temp, 'heard.json'), JSON.stringify({ '*': 'Regardez le schéma de gauche à droite.' }));
  process.env.ELABORA_TRANSCRIBER_MODELS_DIR = path.join(temp, 'transcribers');
  process.env.ELABORA_TRANSCRIBER_MODELS_MANIFEST = path.join(temp, 'transcribers.json');
  process.env.ELABORA_TRANSCRIBER_FAKE = path.join(temp, 'heard.json');
}

// The voices' providers are chosen when the engine is first imported.
const { openProject } = await import('@elabora/engine');
const { engineConformance } = await import('../conformance/engine.ts');

const SAMPLES: Record<Sample, string> = { network: NETWORK_SAMPLE, basic: EXAMPLE, bilingual: BILINGUAL };

const desktop: ConformanceTarget = {
  name: 'desktop',
  async open(sample) {
    const dir = copyExample(SAMPLES[sample]);
    const files = fs.mkdtempSync(path.join(temp, 'files-'));
    // As the app opens a module, without the schedules that run on their own clock.
    const session = await openProject(dir, { author: { kind: 'human' }, migrate: 'auto', backups: { onOpen: false, prune: false }, rescanIntervalMs: 0 });
    const listeners: ((message: never) => void)[] = [];
    session.subscribe((message) => { for (const listener of listeners) listener(structuredClone(message) as never); });
    return {
      send(message) {
        void session.handle(structuredClone(message)).then((response) => { for (const listener of listeners) listener(structuredClone(response) as never); });
      },
      receive(listener) { listeners.push(listener as (message: never) => void); },
      pick(name, from) {
        const file = path.join(fs.mkdtempSync(path.join(files, 'picked-')), name);
        fs.copyFileSync(path.join(dir, ...from.split('/')), file);
        return file;
      },
      saveAs: (name) => path.join(files, name),
      async dispose() {
        await session.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(files, { recursive: true, force: true });
      }
    };
  }
};

engineConformance(desktop);
after(() => fs.rmSync(temp, { recursive: true, force: true }));
