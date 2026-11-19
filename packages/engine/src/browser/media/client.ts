// The engine's Worker's side of the media Worker (D106): started at the first question, each question
// answered by its id, a question cancelled by its signal.

import type { MediaAnswer, MediaAsk, MediaMessage } from './worker.ts';

export interface MediaWorker {
  ask(ask: MediaAsk, signal?: AbortSignal): Promise<{ id: number; answer: MediaAnswer }>;
  // The master's file of that answer is no longer needed (its bytes are kept).
  forget(id: number): void;
  close(): void;
}

export function mediaWorker(url: string, { aacEncoder }: { aacEncoder?: string } = {}): MediaWorker {
  let worker: Worker | null = null;
  let next = 0;
  const waiting = new Map<number, (answer: MediaAnswer) => void>();
  const start = () => {
    if (worker) return worker;
    worker = new Worker(url, { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<{ id: number; answer: MediaAnswer }>) => { waiting.get(data.id)?.(data.answer); waiting.delete(data.id); };
    worker.onerror = (event) => { for (const [id, resolve] of waiting) { resolve({ error: event.message || 'The media Worker did not load.' }); waiting.delete(id); } };
    worker.postMessage({ kind: 'init', ...(aacEncoder ? { aacEncoder } : {}) } satisfies MediaMessage);
    return worker;
  };
  return {
    ask(ask, signal) {
      const id = ++next;
      const target = start();
      return new Promise<{ id: number; answer: MediaAnswer }>((resolve) => {
        waiting.set(id, (answer) => resolve({ id, answer }));
        signal?.addEventListener('abort', () => target.postMessage({ kind: 'cancel', id } satisfies MediaMessage), { once: true });
        target.postMessage({ kind: 'ask', id, ask } satisfies MediaMessage);
      });
    },
    forget(id) { worker?.postMessage({ kind: 'forget', id } satisfies MediaMessage); },
    close() { worker?.terminate(); worker = null; }
  };
}
