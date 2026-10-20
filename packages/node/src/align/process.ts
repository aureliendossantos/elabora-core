import { ModelProcess } from '../models/process.ts';
import { AlignmentError } from './ctc.ts';
import type { Alignment } from './align.ts';
import type { AlignJob } from './worker.ts';

// The word aligner in a process of its own (worker.ts serves it; models/process.ts says why): the
// line it was aligning when ONNX Runtime aborts fails with E_ALIGN_CRASHED and the engine goes on.

const WORKER = new URL('./worker.ts', import.meta.url);

export class AlignProcess extends ModelProcess<AlignJob, Alignment> {
  // module: what the process serves (tests give a stand-in; worker.ts by default).
  constructor(module: string = WORKER.href) {
    super(module, { name: 'The word aligner', error: (code, message) => new AlignmentError(code, message), crashed: 'E_ALIGN_CRASHED', failed: 'E_ALIGN_FAILED' });
  }

  align(job: AlignJob): Promise<Alignment> {
    return this.run(job);
  }
}
