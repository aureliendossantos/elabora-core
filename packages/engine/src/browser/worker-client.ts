// The engine's Worker's side of a Worker it starts for heavy work (D106: the media; D114: the models):
// started at the first question, sent its init then, each question answered by its id, cancelled by
// its signal, an answer's file forgotten once its bytes are kept. idleMs: stopped once that long has
// passed with no question waiting, all its memory given back (a WebAssembly memory never shrinks);
// the next question starts it again.

import type { MediaAnswer, MediaAsk, MediaInit } from './media/worker.ts';

export interface WorkerClient<Ask, Answer> {
  // onProgress: what the Worker says of the work as it goes (a fraction), before its answer.
  ask(ask: Ask, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<{ id: number; answer: Answer }>;
  forget(id: number): void;
  close(): void;
}

// What such a Worker reads: its init (once), a question by id, a cancel, a forget.
export type WorkerMessage<Init, Ask> = { kind: 'init'; init: Init } | { kind: 'ask'; id: number; ask: Ask } | { kind: 'cancel'; id: number } | { kind: 'forget'; id: number };

export function workerClient<Init, Ask, Answer extends object>(url: string, init: Init, failed: (message: string) => Answer, { idleMs }: { idleMs?: number } = {}): WorkerClient<Ask, Answer> {
  let worker: Worker | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const rest = () => {
    if (!idleMs || waiting.size || !worker) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { idle = null; if (!waiting.size) { worker?.terminate(); worker = null; } }, idleMs);
  };
  let next = 0;
  const waiting = new Map<number, (answer: Answer) => void>();
  const progress = new Map<number, (fraction: number) => void>();
  const post = (message: WorkerMessage<Init, Ask>) => worker?.postMessage(message);
  const start = () => {
    if (worker) return;
    worker = new Worker(url, { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<{ id: number; answer: Answer } | { id: number; progress: number }>) => {
      if ('progress' in data) { progress.get(data.id)?.(data.progress); return; }
      waiting.get(data.id)?.(data.answer);
      waiting.delete(data.id);
      progress.delete(data.id);
      rest();
    };
    worker.onerror = (event) => { for (const [id, resolve] of waiting) { resolve(failed(event.message || 'The Worker did not load.')); waiting.delete(id); } };
    post({ kind: 'init', init });
  };
  return {
    ask(ask, signal, onProgress) {
      const id = ++next;
      if (idle) { clearTimeout(idle); idle = null; }
      start();
      if (onProgress) progress.set(id, onProgress);
      return new Promise((resolve) => {
        waiting.set(id, (answer) => resolve({ id, answer }));
        signal?.addEventListener('abort', () => post({ kind: 'cancel', id }), { once: true });
        post({ kind: 'ask', id, ask });
      });
    },
    forget(id) { post({ kind: 'forget', id }); },
    close() { if (idle) { clearTimeout(idle); idle = null; } worker?.terminate(); worker = null; }
  };
}


export type MediaWorker = WorkerClient<MediaAsk, MediaAnswer>;

export const mediaWorker = (url: string, init: MediaInit = {}): MediaWorker => workerClient<MediaInit, MediaAsk, MediaAnswer>(url, init, (error) => ({ error }));
