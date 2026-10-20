// A stand-in for the word aligner's process (packages/node/src/align/worker.ts) for tests: a job
// whose text is "crash" aborts the process as ONNX Runtime does when it cannot allocate; any other
// answers with one word.
import type { Port } from '@elabora/node/align/worker';

export function serve(port: Port): void {
  port.on('message', (message) => {
    if (message.kind !== 'run') return;
    if (message.job.text === 'crash') process.abort();
    port.postMessage({ kind: 'done', id: message.id, result: { duration: message.job.samples.length / 16000, words: [{ text: message.job.text ?? '', start: 0, end: 0.1, said: 'x' }] } });
  });
}
