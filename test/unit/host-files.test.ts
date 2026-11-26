import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pocketCatalogueFiles } from '@elabora/node/voice/pocket/catalogue-files';
import { onnxRuntimeWebFiles } from '@elabora/engine/onnx-runtime-web';

// What a browser's host copies at its build beside the engine: the local voices' catalogue and
// onnxruntime-web's runtime and wasm.

test('a browser host\'s files: the voices\' catalogue, each voice\'s embeddings, and the runtime of the models Worker, all there', () => {
  const catalogue = pocketCatalogueFiles();
  const voices = (JSON.parse(fs.readFileSync(catalogue[0]!.file, 'utf8')) as { voices: { file: string }[] }).voices;
  assert.deepEqual(catalogue.map((one) => one.name), ['voices.json', ...voices.map((voice) => voice.file)]);
  assert.ok(catalogue.every((one) => fs.existsSync(one.file)));
  const runtime = onnxRuntimeWebFiles();
  assert.deepEqual([runtime.ort.name, runtime.mjs.name, runtime.wasm.name], ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']);
  assert.ok(Object.values(runtime).every((one) => fs.existsSync(one.file)));
});
