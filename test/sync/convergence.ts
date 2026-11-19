import { runBench, type BenchOptions } from './bench.ts';

// The convergence bench's runs, as Node and a browser's Worker play them (test/unit/sync-convergence.test.ts,
// test/e2e/sync-convergence-browser.test.ts): what each seed's draw found wrong.

// Seeds that once failed, kept as fixed cases: each fails again when what it caught comes back.
export const FAILED = [
  31, // a copy's own rebase overwrote another's value, and the change did not say so: no one was told
  48, // two removals emptied a screen's blocks: the server refuses what does not validate
  140, // two copies duplicating a block drew the same id (before D77): the server refused the second
  3834 // an agent rewrote course.json with its keys in another order: every version looked as far (D75 compares values)
];

export type DrawOptions = Pick<BenchOptions, 'external' | 'solo'>;

export const failures = (seeds: Iterable<number>, options: DrawOptions = {}): string[] => {
  const out: string[] = [];
  for (const seed of seeds) {
    const report = runBench({ seed, ...options });
    if (report.problems.length) out.push(`seed ${seed}: ${report.problems.slice(0, 3).join(' | ')}`);
  }
  return out;
};

export const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);
