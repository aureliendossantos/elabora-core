// The session's write queue: jobs that change the project (commands, undo, reconciling what other
// programs wrote, media results, versions) run one at a time, in order. Reads never go through it:
// they answer from the state in memory.

export class WriteQueue {
  #tail: Promise<void> = Promise.resolve();
  #size = 0;

  run<T>(job: () => Promise<T>): Promise<T> {
    this.#size++;
    const result = this.#tail.then(job);
    this.#tail = result.then(() => { this.#size--; }, () => { this.#size--; });
    return result;
  }

  // Jobs waiting or running.
  get size(): number {
    return this.#size;
  }

  // Resolves once every job queued so far is done.
  idle(): Promise<void> {
    return this.#tail;
  }
}
