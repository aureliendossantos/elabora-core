import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AAC_ENCODER, aacEncoderLicenceFiles } from '@elabora/engine/aac-encoder';

// What a host serves beside the AAC encoder in wasm (D135): the package installed is the one whose
// provenance the core states, so that an upgrade of Mediabunny states the new one, and every file
// its licence asks for is there to serve.
test('the AAC encoder in wasm: its provenance as its package says it, and the files its licence asks for', () => {
  const files = aacEncoderLicenceFiles();
  for (const { name, file } of files) assert.ok(fs.statSync(file).size > 0, `${name}: ${file}`);
  const readme = fs.readFileSync(files.find((f) => f.name === 'README.md')!.file, 'utf8');
  for (const fact of [AAC_ENCODER.ffmpeg.commit, AAC_ENCODER.ffmpeg.describe, `Emscripten ${AAC_ENCODER.emscripten}`, AAC_ENCODER.wasmSha256, 'LGPL v2.1 or later']) assert.ok(readme.includes(fact), `the README says ${fact}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(files.find((f) => f.name === 'README.md')!.file), 'package.json'), 'utf8')) as { version: string };
  assert.equal(manifest.version, AAC_ENCODER.version);
  assert.match(fs.readFileSync(files.find((f) => f.name === 'COPYING.LGPLv2.1')!.file, 'utf8'), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/);
});
