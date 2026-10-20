import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectTestStep } from '@elabora/format';
import { drawnBeforeSnapshots } from '@elabora/node/objects/test';

test('a dry run of an object test draws the last step that runs frames before each snapshot', () => {
  const steps = (...actions: ObjectTestStep['action'][]) => actions.map((action) => ({ action }));
  // Keys and expectations run no frame: the step before them is drawn.
  assert.deepEqual([...drawnBeforeSnapshots(steps('step', 'key', 'step', 'key', 'expect-state', 'snapshot', 'step', 'expect-event'))], [2]);
  // A click, set-props… run one frame; consecutive snapshots need nothing more.
  assert.deepEqual([...drawnBeforeSnapshots(steps('step', 'click', 'snapshot', 'snapshot', 'set-view', 'snapshot'))], [1, 4]);
  // A snapshot right after the mount, or after only keys: the mount's frame is drawn already.
  assert.deepEqual([...drawnBeforeSnapshots(steps('snapshot', 'key', 'snapshot', 'step'))], []);
  assert.deepEqual([...drawnBeforeSnapshots(steps('step', 'expect-state'))], []);
});
