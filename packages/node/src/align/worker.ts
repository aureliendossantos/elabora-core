import { createRequire } from 'node:module';
import type * as Ort from 'onnxruntime-node';
import { loadWav2Vec2, wav2vec2Emissions } from './wav2vec2.ts';
import type { ModelEmissions, Wav2Vec2Model } from './wav2vec2.ts';
import { alignEmissions } from './align.ts';
import type { Alignment } from './align.ts';
import { ortLoadFailure } from '../voice/pocket/runtime.ts';
import { serveModel } from '../models/process.ts';
import type { ModelPort } from '../models/process.ts';

// What the word aligner's process runs (process.ts starts it): ONNX Runtime runs the model
// synchronously, half a second for a line of several seconds, so in the engine or the MCP server
// it would hold every other request that long, and a request it cannot fit in memory aborts the
// whole process. It keeps one model in memory, and the emissions of the last recording (a
// recording imported without its line is tried against each line of the screen).

export interface AlignJob {
  dir: string;              // the model's folder (model.onnx, vocab.json), downloaded and checked
  samples: Float32Array;    // 16 kHz mono
  text: string;
  language: string;
  startShift: number;
  endShift: number;
  cacheKey?: string;        // names the audio (its path, size and date): the same audio's emissions are kept
}

export type Port = ModelPort<AlignJob, Alignment>;

const require = createRequire(import.meta.url);

function loadOrt(): typeof Ort {
  try {
    return require('onnxruntime-node') as typeof Ort;
  } catch (error) {
    throw Object.assign(new Error(ortLoadFailure(error instanceof Error ? error.message : String(error), process.platform, process.arch, 'Word timing needs')), { code: 'E_ALIGN_RUNTIME' });
  }
}

export function serve(port: Port): void {
  let loaded: { dir: string; model: Wav2Vec2Model } | null = null;
  let last: { key: string; dir: string; emissions: ModelEmissions } | null = null;
  const release = async () => {
    const model = loaded?.model;
    loaded = null;
    last = null;
    await model?.session.release();
  };
  serveModel(port, {
    release,
    async run(job) {
      if (loaded?.dir !== job.dir) {
        await release();
        const ort = loadOrt();
        loaded = { dir: job.dir, model: await loadWav2Vec2(ort, `${job.dir}/model.onnx`, `${job.dir}/vocab.json`) };
      }
      const { model } = loaded;
      const emissions = job.cacheKey && last?.key === job.cacheKey && last.dir === job.dir ? last.emissions : await wav2vec2Emissions(model, job.samples);
      last = job.cacheKey ? { key: job.cacheKey, dir: job.dir, emissions } : null;
      const shifts = { startShift: job.startShift, endShift: job.endShift };
      return alignEmissions(emissions, job.text, job.language, model, shifts);
    }
  });
}
