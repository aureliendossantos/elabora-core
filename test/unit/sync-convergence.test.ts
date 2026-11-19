import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAILED, failures, range } from '../sync/convergence.ts';

// The convergence bench (test/sync/bench.ts, D73–D75): two copies, a server in memory, people and
// agents drawn at random, a copy offline and back. ELABORA_SYNC_DRAWS=5000 runs more draws. The same
// runs in a browser's Worker: test/e2e/sync-convergence-browser.test.ts.
const DRAWS = Number(process.env.ELABORA_SYNC_DRAWS ?? 120);

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
