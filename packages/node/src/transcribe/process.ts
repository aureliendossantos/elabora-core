import { ModelProcess } from '../models/process.ts';
import type { TranscribeJob, TranscribeResult } from './worker.ts';

// The transcriber in a process of its own (worker.ts serves it; models/process.ts says why): the
// recording it was transcribing when ONNX Runtime aborts fails with E_TRANSCRIBE_CRASHED and the
// engine goes on.

const WORKER = new URL('./worker.ts', import.meta.url);

export class TranscriptionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
  }
}

export class TranscribeProcess extends ModelProcess<TranscribeJob, TranscribeResult> {
  constructor(module: string = WORKER.href) {
    super(module, { name: 'The transcriber', error: (code, message) => new TranscriptionError(code, message), crashed: 'E_TRANSCRIBE_CRASHED', failed: 'E_TRANSCRIBE_FAILED' });
  }

  transcribe(job: TranscribeJob): Promise<TranscribeResult> {
    return this.run(job);
  }
}
