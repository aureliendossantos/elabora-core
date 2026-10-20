// Makes the voices of Pocket TTS (docs/decisions.md D25) from the recordings listed in
// packages/node/voices/pocket-tts/sources.json (kept by hand: each recording pinned by URL and
// SHA-256, its licence and the credit it needs): the recording, ended on a short pause as Kyutai
// does, goes through the model's voice encoder once, and its latents are written in float16 to
// <bundle>/<voice>.f16 next to voices.json (written here, never by hand). Network: the recordings
// and, the first time, the model and its encoder (into ~/.cache/elabora-dev/pocket-tts by default).
//
//   node scripts/pocket-voices.ts [--sources <file>] [--out <dir>] [--only <id,…>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUNDLES, ENCODERS, installBundle } from '../packages/node/src/voice/pocket/models.ts';
import { PocketModel, endOnPause } from '../packages/node/src/voice/pocket/runtime.ts';
import type { CatalogueVoice } from '../packages/node/src/voice/pocket/index.ts';

// The model and its encoder go into a cache of this tool, never into the computer's own models (the
// author's: D38), unless ELABORA_VOICE_MODELS_DIR names a folder.
process.env.ELABORA_VOICE_MODELS_DIR ??= path.join(os.homedir(), '.cache', 'elabora-dev', 'pocket-tts');

interface Source extends Omit<CatalogueVoice, 'file' | 'frames' | 'sha256'> {
  recording: { url: string; sha256: string };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const out = path.resolve(flag('out') ?? path.join(ROOT, 'packages/node/voices/pocket-tts'));
const sourcesFile = path.resolve(flag('sources') ?? path.join(ROOT, 'packages/node/voices/pocket-tts/sources.json'));
const only = flag('only')?.split(',');
const sources = (JSON.parse(fs.readFileSync(sourcesFile, 'utf8')) as { voices: Source[] }).voices.filter((voice) => !only || only.includes(voice.id));
const ffmpeg = process.env.ELABORA_FFMPEG || 'ffmpeg';
const cache = path.join(os.tmpdir(), 'elabora-voice-recordings');
fs.mkdirSync(cache, { recursive: true });

async function recording(source: Source): Promise<string> {
  const file = path.join(cache, `${source.recording.sha256}${path.extname(new URL(source.recording.url).pathname) || '.wav'}`);
  if (!fs.existsSync(file)) {
    const response = await fetch(source.recording.url);
    if (!response.ok) throw new Error(`${source.id}: ${response.status} for ${source.recording.url}`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash !== source.recording.sha256) { fs.rmSync(file); throw new Error(`${source.id}: the recording's SHA-256 is ${hash}, not ${source.recording.sha256}.`); }
  return file;
}

function samplesOf(file: string, rate: number): Float32Array {
  const bytes = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function float16(values: Float32Array): Buffer {
  const out = Buffer.alloc(values.length * 2);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < values.length; i++) {
    f32[0] = values[i];
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    const exponent = ((x >>> 23) & 0xff) - 127 + 15;
    let mantissa = x & 0x7fffff;
    let h: number;
    if (exponent <= 0) {
      // Subnormal half (or zero), rounded to nearest.
      if (exponent < -10) h = sign;
      else { mantissa |= 0x800000; const shift = 14 - exponent; h = sign | ((mantissa + (1 << (shift - 1))) >> shift); }
    } else if (exponent >= 31) {
      h = sign | 0x7c00 | (((x >>> 23) & 0xff) === 0xff && mantissa ? 0x200 : 0);
    } else {
      h = sign | (exponent << 10) | (mantissa >> 13);
      if (mantissa & 0x1000) h++; // round half up (carries into the exponent correctly)
    }
    out.writeUInt16LE(h & 0xffff, i * 2);
  }
  return out;
}

const voices: CatalogueVoice[] = fs.existsSync(path.join(out, 'voices.json')) && only ? (JSON.parse(fs.readFileSync(path.join(out, 'voices.json'), 'utf8')) as { voices: CatalogueVoice[] }).voices.filter((voice) => !only.includes(voice.id)) : [];
for (const bundle of BUNDLES) {
  const ofBundle = sources.filter((source) => source.bundle === bundle.id);
  if (!ofBundle.length) continue;
  console.log(`${bundle.id}: ${ofBundle.length} voice(s)`);
  const dir = await installBundle(bundle, { extra: [ENCODERS[bundle.id]], onProgress: (p) => process.stderr.write(`\r  model ${Math.floor((p.received / p.total) * 100)}%`) });
  process.stderr.write('\n');
  const model = await PocketModel.load(dir, { encoder: true });
  try {
    for (const source of ofBundle) {
      const samples = endOnPause(samplesOf(await recording(source), model.sampleRate), model.sampleRate);
      const latents = await model.encodeVoice(samples);
      const bytes = float16(latents);
      const file = `${bundle.id}/${source.id}.f16`;
      fs.mkdirSync(path.join(out, bundle.id), { recursive: true });
      fs.writeFileSync(path.join(out, file), bytes);
      const { recording: _recording, ...voice } = source;
      voices.push({ ...voice, file, frames: latents.length / model.meta.conditioning_dim, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      console.log(`  ${source.id}: ${(samples.length / model.sampleRate).toFixed(1)} s → ${latents.length / model.meta.conditioning_dim} frames, ${Math.round(bytes.length / 1024)} KB`);
    }
  } finally {
    await model.release();
  }
}
const order = (voice: CatalogueVoice) => `${voice.language}\0${voice.gender ?? ''}\0${voice.name}`;
voices.sort((a, b) => order(a).localeCompare(order(b)));
fs.writeFileSync(path.join(out, 'voices.json'), `${JSON.stringify({ provider: 'pocket-tts', note: 'Written by scripts/pocket-voices.ts from sources.json: never edit by hand.', voices }, null, 2)}\n`);
console.log(`✔ ${voices.length} voices in ${path.relative(ROOT, path.join(out, 'voices.json'))}`);
