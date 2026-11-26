import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The files of onnxruntime-web (MIT) that a host serves to a browser's models Worker, for the word
// aligners and the local voices (D113, D114): the runtime's module (the open message's ort) and its
// threaded wasm with the module that loads it (ortWasm: mjs and wasm). The Worker loads the runtime by
// address; the page must be isolated (COOP and COEP) for its threads.

const DIST = path.dirname(fileURLToPath(import.meta.resolve('onnxruntime-web')));

export function onnxRuntimeWebFiles(): { ort: { name: string; file: string }; mjs: { name: string; file: string }; wasm: { name: string; file: string } } {
  const of = (name: string) => ({ name, file: path.join(DIST, name) });
  return { ort: of('ort.wasm.min.mjs'), mjs: of('ort-wasm-simd-threaded.mjs'), wasm: of('ort-wasm-simd-threaded.wasm') };
}
