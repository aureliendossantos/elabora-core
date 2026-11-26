import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Alignment } from '@elabora/core/align/align';

// The desktop's word aligner and local voice, as references for the browser's, run in a child
// process: ONNX Runtime 1.23 aborts a process that ran a session and ends with process.exit()
// (packages/node/src/voice/pocket/runtime.ts), as the test runner ends a file (--test-force-exit).

const run = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);

type Ask =
  | { op: 'align'; models: string; samples: string; text: string; language: string; startShift: number; endShift: number }
  | { op: 'say'; models: string; embeddings: string; text: string; seed: number };

async function ask<T>(question: Ask): Promise<T> {
  const child = run(process.execPath, [SELF], { maxBuffer: 1 << 28 });
  child.child.stdin!.end(JSON.stringify(question));
  return JSON.parse((await child).stdout) as T;
}

const base64 = (samples: Float32Array) => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');

// The desktop's words for 16 kHz mono samples, and the time its aligner took (its model loaded before).
export const desktopAlignment = (models: string, samples: Float32Array, text: string, language: string, shifts: { startShift: number; endShift: number }) =>
  ask<{ alignment: Alignment; ms: number }>({ op: 'align', models, samples: base64(samples), text, language, startShift: shifts.startShift, endShift: shifts.endShift });

// The desktop's take of a line by Pocket TTS, as a WAV file, and the time it took (its model and voice loaded before).
export const desktopTake = async (models: string, embeddings: string, text: string, seed: number) => {
  const { wav, ms } = await ask<{ wav: string; ms: number }>({ op: 'say', models, embeddings, text, seed });
  return { wav: new Uint8Array(Buffer.from(wav, 'base64')), ms };
};

if (import.meta.main) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const question = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Ask;
  const { loadOrt, PocketModel, readEmbeddings } = await import('@elabora/node/voice/pocket/runtime');
  if (question.op === 'align') {
    const { loadWav2Vec2 } = await import('@elabora/node/align/wav2vec2');
    const { wav2vec2Emissions } = await import('@elabora/core/align/wav2vec2');
    const { alignEmissions } = await import('@elabora/core/align/align');
    const model = await loadWav2Vec2(await loadOrt(), path.join(question.models, 'model.onnx'), path.join(question.models, 'vocab.json'));
    const bytes = Buffer.from(question.samples, 'base64');
    const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4).slice();
    const started = performance.now();
    const alignment = alignEmissions(await wav2vec2Emissions(model, samples), question.text, question.language, model, { startShift: question.startShift, endShift: question.endShift });
    process.stdout.write(JSON.stringify({ alignment, ms: Math.round(performance.now() - started) }));
  } else {
    const { DEFAULT_TEMPERATURE } = await import('@elabora/core/voice/pocket/models');
    const { withoutDirections } = await import('@elabora/core/narration/directions');
    const { wavBytes } = await import('@elabora/core/voice/wav');
    const model = await PocketModel.load(question.models);
    const voice = await model.voiceState(readEmbeddings(question.embeddings));
    const started = performance.now();
    const said = await model.synthesize(withoutDirections(question.text), voice, { temperature: DEFAULT_TEMPERATURE, seed: question.seed, rules: { replaceCharacters: {}, removeSemicolons: model.meta.remove_semicolons, padWithSpacesForShortInputs: model.meta.pad_with_spaces_for_short_inputs } });
    const ms = Math.round(performance.now() - started);
    await model.release();
    process.stdout.write(JSON.stringify({ wav: Buffer.from(wavBytes(said, model.sampleRate)).toString('base64'), ms }));
  }
  // Ends on its own, without process.exit().
}
