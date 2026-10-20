import type { MessagePort } from 'node:worker_threads';
import { PocketModel, readEmbeddings } from './runtime.ts';
import type { TextRules } from './text.ts';

// The thread Pocket TTS speaks in (thread.ts starts it): ONNX Runtime runs each step of the model
// synchronously, a tenth of a second or more, and the model loads in most of a second, so a voice
// said on the thread of the engine or of the MCP server would hold every other request that long.
// The thread keeps one model in memory and one voice's state, as the provider did before; the
// provider frees them after two idle minutes (release).

export type Rules = Omit<TextRules, 'removeSemicolons' | 'padWithSpacesForShortInputs'>;

export interface ThreadJob {
  id: number;
  dir: string;           // the bundle's folder (downloaded and checked by the provider)
  voice: string;         // the voice's id, which state is kept
  voiceFile: string;     // its embeddings
  text: string;
  temperature: number;
  seed: number;
  rules: Rules;          // the characters to replace, before the model's own rules
}

export type ToThread =
  | { kind: 'synthesize'; job: ThreadJob }
  | { kind: 'abort'; id: number }
  | { kind: 'release' };

export type FromThread =
  | { kind: 'progress'; id: number; fraction: number }
  | { kind: 'done'; id: number; samples: Float32Array; sampleRate: number; retries: number }
  | { kind: 'failed'; id: number; error: { message: string; name: string; code?: string } }
  | { kind: 'released' };

export function serve(port: MessagePort): void {
  let loaded: { dir: string; model: PocketModel; voice: string | null; state: Awaited<ReturnType<PocketModel['voiceState']>> | null } | null = null;
  const running = new Map<number, AbortController>();
  // One job at a time, in the order they came (the provider sends one at a time too).
  let queue: Promise<unknown> = Promise.resolve();
  const send = (message: FromThread, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer);

  const release = async () => {
    const model = loaded?.model;
    loaded = null;
    await model?.release();
  };

  const synthesize = async (job: ThreadJob) => {
    const controller = running.get(job.id);
    try {
      controller?.signal.throwIfAborted();
      if (loaded?.dir !== job.dir) {
        await release();
        loaded = { dir: job.dir, model: await PocketModel.load(job.dir), voice: null, state: null };
      }
      const current = loaded;
      // One voice's state kept (200 MB in French): a dialogue computes the other's again (a second).
      if (current.voice !== job.voice || !current.state) {
        current.state = null;
        current.state = await current.model.voiceState(readEmbeddings(job.voiceFile));
        current.voice = job.voice;
      }
      const rules: TextRules = { ...job.rules, removeSemicolons: current.model.meta.remove_semicolons, padWithSpacesForShortInputs: current.model.meta.pad_with_spaces_for_short_inputs };
      const { samples, retries } = await current.model.synthesizeWithReport(job.text, current.state, {
        temperature: job.temperature, seed: job.seed, rules, signal: controller?.signal,
        onProgress: (fraction) => send({ kind: 'progress', id: job.id, fraction })
      });
      send({ kind: 'done', id: job.id, samples, sampleRate: current.model.sampleRate, retries }, [samples.buffer as ArrayBuffer]);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const code = (failure as Error & { code?: unknown }).code;
      send({ kind: 'failed', id: job.id, error: { message: failure.message, name: failure.name, ...(typeof code === 'string' ? { code } : {}) } });
    } finally {
      running.delete(job.id);
    }
  };

  port.on('message', (message: ToThread) => {
    if (message.kind === 'synthesize') {
      running.set(message.job.id, new AbortController());
      queue = queue.then(() => synthesize(message.job));
    } else if (message.kind === 'abort') {
      running.get(message.id)?.abort();
    } else if (message.kind === 'release') {
      queue = queue.then(release).then(() => send({ kind: 'released' }), () => send({ kind: 'released' }));
    }
  });
}
