import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { readLock, assignKeys, buildStateModel } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import type { BlockData, ObjectBlock } from '@elabora/player/course-data';
import * as edit from '@elabora/node/edit';
import { ROOT, codes, copyExample, readJSON, writeJSON } from '../helpers.ts';

// Continuity between screens (D65): blocks of different screens that share a key. The fixture's
// screens one, two and four share a free object ("scene"); one and two share a heading ("title").

const FIXTURE = path.join(ROOT, 'test/fixtures/continuity');

test('the fixture is valid: a key shared by blocks of the same kind, once per screen', () => {
  const found = codes(validateDir(FIXTURE).diagnostics);
  assert.deepEqual(found.filter((code) => code.includes('CONTINUITY')), []);
  assert.ok(!found.some((code) => code.startsWith('E_')), found.join(', '));
});

test('continuity checks: twice on a screen, another kind, a layer, a timed object, a key alone', () => {
  const dir = copyExample(FIXTURE);
  const two = readJSON(dir, 'screens/two.json');
  // The text above the title now carries the title's key too, on the same screen.
  two.blocks[0].continuity = { key: 'title' };
  writeJSON(dir, 'screens/two.json', two);
  const four = readJSON(dir, 'screens/four.json');
  // A heading where the scene's key names a free object.
  four.blocks.push({ id: 'four-heading', type: 'heading', continuity: { key: 'scene-two' }, props: { text: 'Alone' } });
  four.layers = [{ id: 'more', title: 'More', blocks: [{ id: 'more-text', type: 'text', continuity: { key: 'title' }, props: { markdown: 'In a layer.' } }] }];
  four.blocks[0].timing = { in: { at: { seconds: 1 }, effect: 'fade' } };
  writeJSON(dir, 'screens/four.json', four);
  const found = validateDir(dir).diagnostics.filter((d) => d.code.includes('CONTINUITY')).map((d) => `${d.code} ${d.target}`).sort();
  assert.deepEqual(found, [
    'E_CONTINUITY_DUPLICATE two-title',
    'E_CONTINUITY_MISMATCH two-text',
    'E_CONTINUITY_PLACE four-scene',
    'E_CONTINUITY_PLACE more-text',
    'W_CONTINUITY_ALONE four-heading'
  ]);
});

test('compiled: each block says its key and the passage\'s duration; the free objects of a chain share one state, counted once', () => {
  const project = loadProjectFromDir(FIXTURE);
  const lock = readLock(project);
  const { keys } = assignKeys(project, lock, { dryRun: true });
  const data = compileCourseData(project, keys, { buildId: 'test' });
  const block = (screen: string, id: string) => data.screens.find((candidate) => candidate.id === screen)!.blocks.find((candidate) => candidate.id === id) as BlockData;
  const state = keys['continuity:scene'];
  assert.ok(state, 'the chain has a key of its own in the lock');
  assert.deepEqual(block('one', 'one-scene').continuity, { key: 'scene', duration: 700, state });
  assert.deepEqual(block('two', 'two-scene').continuity, { key: 'scene', duration: 900, state });
  assert.deepEqual(block('four', 'four-scene').continuity, { key: 'scene', duration: 700, state });
  // A block that is not an object has no state.
  assert.deepEqual(block('two', 'two-title').continuity, { key: 'title', duration: 500 });
  // Each block keeps the key of its completion.
  assert.notEqual((block('one', 'one-scene') as ObjectBlock).key, (block('two', 'two-scene') as ObjectBlock).key);
  // The worst case counts the chain's state once, and the blocks' completions.
  const model = buildStateModel(project, keys);
  const objects = model.objects.filter((entry) => entry.persistMax > 0);
  assert.deepEqual(objects, [{ key: state, persistMax: 120 }]);
  assert.equal(model.objects.length, 4);
});

test('set_continuity links two blocks, joins chains, cuts one, sets the passage, and refuses a key twice on a screen', () => {
  const dir = copyExample(FIXTURE);
  const keyOf = (screen: string, id: string) => readJSON(dir, `screens/${screen}.json`).blocks.find((block: { id: string }) => block.id === id)?.continuity;
  // Screen three gets a text that carries on from screen two's text: a new key, named after it.
  const three = readJSON(dir, 'screens/three.json');
  assert.equal(three.blocks[0].type, 'text');
  assert.equal(edit.setContinuity(dir, { block: 'three-text', with: 'two-text' }).key, 'two-text');
  assert.deepEqual([keyOf('two', 'two-text'), keyOf('three', 'three-text')], [{ key: 'two-text' }, { key: 'two-text' }]);
  // The passage, then back to the default.
  edit.setContinuity(dir, { block: 'three-text', duration: 1200 });
  assert.deepEqual(keyOf('three', 'three-text'), { key: 'two-text', duration: 1200 });
  edit.setContinuity(dir, { block: 'three-text', duration: null });
  assert.deepEqual(keyOf('three', 'three-text'), { key: 'two-text' });
  // Cut: a key left on one block goes.
  edit.setContinuity(dir, { block: 'three-text', with: null });
  assert.deepEqual([keyOf('two', 'two-text'), keyOf('three', 'three-text')], [undefined, undefined]);
  // A second heading of screen two joining the title's chain would put "title" twice on screen two.
  const two = readJSON(dir, 'screens/two.json');
  two.blocks.push({ id: 'two-subtitle', type: 'heading', props: { text: 'Another title' } });
  writeJSON(dir, 'screens/two.json', two);
  assert.throws(() => edit.setContinuity(dir, { block: 'two-subtitle', with: 'one-title' }), /one block per screen/);
  assert.equal(keyOf('two', 'two-subtitle'), undefined, 'nothing written');
});
