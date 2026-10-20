import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAjv, validateSchema, BLOCK_TYPES, getSchema } from '@elabora/format/schemas';
import { listProfiles } from '@elabora/core/lms/profiles';

test('every schema compiles in strict mode', () => {
  getAjv();
  for (const t of BLOCK_TYPES) assert.ok(getSchema(`blocks/${t}`), t);
});

test('every LMS profile matches the profile schema', () => {
  const ps = listProfiles();
  assert.ok(ps.length >= 11);
  for (const p of ps) assert.deepEqual(validateSchema('lms-profile', p), [], p.id);
});

test('block props are checked through the screen schema', () => {
  const screen = { id: 's', title: 'S', covers: ['ITEM-1'], blocks: [{ id: 'b', type: 'image', props: { alt: 'x' } }] };
  const errors = validateSchema('screen', screen);
  assert.ok(errors.some((e) => e.path === '/blocks/0/props' && /asset/.test(e.message)));
});

test('an event may have no actions yet', () => {
  const screen = { id: 's', title: 'S', covers: ['ITEM-1'], blocks: [{ id: 'b', type: 'text', props: { markdown: 'x' } }], events: [{ id: 'e', on: { type: 'screen.enter' }, do: [] }] };
  assert.deepEqual(validateSchema('screen', screen), []);
});

test('hide-layer may leave out its layer (the one open on top); show-layer may not', () => {
  const screen = (action: Record<string, unknown>) => ({ id: 's', title: 'S', covers: ['ITEM-1'], blocks: [{ id: 'b', type: 'text', props: { markdown: 'x' } }], events: [{ id: 'e', on: { type: 'screen.enter' }, do: [action] }] });
  assert.deepEqual(validateSchema('screen', screen({ type: 'hide-layer' })), []);
  assert.deepEqual(validateSchema('screen', screen({ type: 'hide-layer', layer: 'l' })), []);
  assert.ok(validateSchema('screen', screen({ type: 'show-layer' })).some((e) => /layer/.test(e.message)));
});

test('event actions require their target fields', () => {
  const screen = { id: 's', title: 'S', covers: ['ITEM-1'], blocks: [{ id: 'b', type: 'text', props: { markdown: 'x' } }], events: [{ id: 'e', on: { type: 'click' }, do: [{ type: 'go-to' }] }] };
  const errors = validateSchema('screen', screen).map((e) => e.message);
  assert.ok(errors.some((m) => /target/.test(m)));
  assert.ok(errors.some((m) => /screen/.test(m)));
});
