import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, encodeState, decodeState } from '@elabora/player/state-codec';

// Suspend data written by packages in learners' LMS records must decode the same forever, and the
// encoder must not drift: these strings are pinned (checked against the original JavaScript codec of
// elabora 0.1 when they were written). Change them only with a state format version and a migration.
const GOLDEN = '{"v":1,"s":"0.1.2.a.b1","c":"0.a","q":{"9":"a.c|2","c":"|0"},"n":{"n":"3.25|1","m":"|0"},"d":{"6":"b"},"x":{"score":3,"done":true,"name":"Zoé, « x »"},"o":{"7":{"found":true,"inspected":["poste","baie"]}},"k":{"7":0.75},"a":1,"b":{"8":1,"8z":0},"p":{"3":2},"w":"v1.v0"}';

function sampleState() {
  const s = emptyState();
  for (const k of ['0', '1', '2', 'a', 'b1']) s.visited.add(k);
  s.completed.add('0'); s.completed.add('a');
  s.quizzes['9'] = { selected: ['a', 'c'], attempts: 2 };
  s.quizzes['c'] = { selected: [], attempts: 0 };
  s.numerics['n'] = { value: 3.25, attempts: 1 };
  s.numerics['m'] = { value: null, attempts: 0 };
  s.decisions['6'] = 'b';
  s.vars.score = 3; s.vars.done = true; s.vars.name = 'Zoé, « x »';
  s.objects['7'] = { found: true, inspected: ['poste', 'baie'] };
  s.objectsDone['7'] = 0.75;
  s.visibility['8'] = 1; s.visibility['8z'] = 0;
  s.steps['3'] = 2;
  s.visits.add('v1'); s.visits.add('v0');
  s.retakes = 1;
  return s;
}

test('suspend data encoding is pinned', () => {
  assert.equal(encodeState(emptyState()), '{"v":1}');
  assert.equal(encodeState(sampleState()), GOLDEN);
});

test('pinned suspend data decodes to the same state', () => {
  const back = decodeState(GOLDEN);
  assert.equal(encodeState(back), GOLDEN);
  assert.deepEqual([...back.visits], ['v1', 'v0']);
  assert.deepEqual(back.numerics.m, { value: null, attempts: 0 });
  assert.equal(back.vars.name, 'Zoé, « x »');
});
