import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBench } from '../sync/bench.ts';

// The convergence bench (test/sync/bench.ts, D73–D75): two copies, a server in memory, people and
// agents drawn at random, a copy offline and back. ELABORA_SYNC_DRAWS=5000 runs more draws.
const DRAWS = Number(process.env.ELABORA_SYNC_DRAWS ?? 120);

// Seeds that once failed, kept as fixed cases (what each one caught).
const FAILED = [
  31, // an agent's stale file write over a person's edit of the same field: both versions as close (D75 takes the oldest)
  23, // two people adding a pronunciation at once: the copy's own rebase overwrote, and the other was not told
  48, // two removals emptied a screen's blocks: the server refuses what does not validate
  140, // two copies duplicating a block drew the same id: the server refused the second
  3834 // an agent rewrote course.json with its keys in another order: every version looked as far (D75 compares values)
];

const failures = (seeds: Iterable<number>, options: { external?: 'closest-version' | 'current'; solo?: boolean } = {}) => {
  const out: string[] = [];
  for (const seed of seeds) {
    const report = runBench({ seed, ...options });
    if (report.problems.length) out.push(`seed ${seed}: ${report.problems.slice(0, 3).join(' | ')}`);
  }
  return out;
};
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

test('sync bench: one copy alone, the generator makes valid changes the server places as they are', () => {
  assert.deepEqual(failures(range(1, 30), { solo: true }), []);
});

test('sync bench: copies converge, the project validates, no edit of a person is lost without being told', () => {
  assert.deepEqual(failures([...FAILED, ...range(1000, DRAWS)]), []);
});

test('sync bench: a file written from what an agent read long before is merged from that version (D75)', () => {
  // Computed from the files as they are, the same writes undo people's edits in silence: the bench sees it.
  assert.ok(failures(range(1, 60), { external: 'current' }).some((failure) => failure.includes('-files) replaced')));
});
