import { createRequire } from 'node:module';
import type * as Ort from 'onnxruntime-node';
import { loadParakeet, parakeetTokens, releaseParakeet, SAMPLE_RATE } from './parakeet.ts';
import type { ParakeetModel } from './parakeet.ts';
import { textOfPieces, wordsOfPieces } from './text.ts';
import { ortLoadFailure } from '../voice/pocket/runtime.ts';
import { serveModel } from '../models/process.ts';
import type { ModelPort } from '../models/process.ts';

// What the transcriber's process runs (process.ts starts it), for the same reasons as the word
// aligner's (align/worker.ts): ONNX Runtime runs the model synchronously, and a request it cannot
// fit in memory aborts the whole process. It keeps one model in memory.

export interface TranscribeJob {
  dir: string;              // the model's folder, downloaded and checked
  samples: Float32Array;    // 16 kHz mono
  language: string;         // how the text is written (French spaces); the model hears the language itself
}

export interface TranscribeResult {
  text: string;
  words: { text: string; start: number; end: number; score?: number }[];
  duration: number;
}

export type Port = ModelPort<TranscribeJob, TranscribeResult>;

const require = createRequire(import.meta.url);

function loadOrt(): typeof Ort {
  try {
    return require('onnxruntime-node') as typeof Ort;
  } catch (error) {
    throw Object.assign(new Error(ortLoadFailure(error instanceof Error ? error.message : String(error), process.platform, process.arch, 'Transcription needs')), { code: 'E_TRANSCRIBE_RUNTIME' });
  }
}

export function serve(port: Port): void {
  let loaded: { dir: string; model: ParakeetModel } | null = null;
  const release = async () => {
    const model = loaded?.model;
    loaded = null;
    if (model) await releaseParakeet(model);
  };
  serveModel(port, {
    release,
    async run(job) {
      if (loaded?.dir !== job.dir) {
        await release();
        loaded = { dir: job.dir, model: await loadParakeet(loadOrt(), job.dir) };
      }
      const pieces = await parakeetTokens(loaded.model, job.samples);
      const duration = Math.round(job.samples.length / SAMPLE_RATE * 1000) / 1000;
      return { text: textOfPieces(pieces, job.language), words: wordsOfPieces(pieces, duration), duration };
    }
  });
}
