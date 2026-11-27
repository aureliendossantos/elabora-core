import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askOf } from '@elabora/player/canvas-asks';

// The painter's question (D139), as the canvas page reads it from another window: what it may draw, nothing else.
test('the painter\'s picture question is read with its width and a block\'s scene, and refused with a width out of bounds or fields of the wrong kind', () => {
  assert.deepEqual(askOf({ request: 1, ask: 'picture', params: { id: 'p1', width: 640 } }), { type: 'elabora/ask', request: 1, ask: 'picture', params: { id: 'p1', width: 640 } });
  assert.deepEqual(askOf({ request: 2, ask: 'picture', params: { id: 3, width: 96, block: 'b1', mini: true, slides: true } }), { type: 'elabora/ask', request: 2, ask: 'picture', params: { id: 3, width: 96, block: 'b1', mini: true, slides: true } });
  for (const params of [{ id: 'p', width: 8 }, { id: 'p', width: 5000 }, { id: 'p', width: 64.5 }, { id: 'p' }, { width: 640 }, { id: 'p', width: 640, block: 3 }, { id: 'p', width: 640, mini: 'yes' }]) {
    assert.equal(askOf({ request: 1, ask: 'picture', params }), null, JSON.stringify(params));
  }
});
