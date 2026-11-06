import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { createRenderContext, renderScreen } from '@elabora/core/render/screen';
import { refusedBy } from '@elabora/player/placement';
import * as edit from '@elabora/node/edit';
import { ROOT, codes, copyExample, readJSON, writeJSON } from '../helpers.ts';

// Blocks placed by hand (D72): block place, the commands that write it with the anchor (place_block,
// arrange_screen, update_block place), the checks, the course data. The fixture: on "sketch", a callout
// and a figure placed by hand between two texts of the column; on "page", a note placed in the margin.

const FIXTURE = path.join(ROOT, 'test/fixtures/placement');
const ids = (dir: string, screen = 'sketch') => readJSON(dir, `screens/${screen}.json`).blocks.map((block: { id: string }) => block.id);
const placeOf = (dir: string, id: string, screen = 'sketch') => readJSON(dir, `screens/${screen}.json`).blocks.find((block: { id: string }) => block.id === id)?.place;

test('the fixture is valid: its screens say how many blocks are placed by hand', () => {
  const diagnostics = validateDir(FIXTURE).diagnostics;
  assert.ok(!codes(diagnostics).some((code) => code.startsWith('E_')), codes(diagnostics).join(', '));
  assert.deepEqual(diagnostics.filter((d) => d.code === 'I_BLOCK_PLACED').map((d) => d.target).sort(), ['page', 'sketch']);
});

test('checks: a block of a layer or of a component placed by hand, a place past the frame', () => {
  const dir = copyExample(FIXTURE);
  const sketch = readJSON(dir, 'screens/sketch.json');
  sketch.blocks[1].place = { x: 0.8, y: 0.9, width: 0.3, height: 0.2 };
  sketch.layers = [{ id: 'more', title: 'More', blocks: [{ id: 'more-text', type: 'text', place: { x: 0, y: 0, width: 0.5 }, props: { markdown: 'In a layer.' } }] }];
  writeJSON(dir, 'screens/sketch.json', sketch);
  const found = validateDir(dir).diagnostics.filter((d) => d.code.includes('PLACED')).map((d) => `${d.code} ${d.target}`).sort();
  assert.deepEqual(found, ['E_PLACED_NESTED more-text', 'I_BLOCK_PLACED page', 'I_BLOCK_PLACED sketch', 'W_PLACED_OUTSIDE sketch-keep']);
  // In a page, y is measured from its anchor: below the frame is fine, past its sides is not.
  const course = readJSON(dir, 'course.json');
  course.presentation = { mode: 'scroll' };
  writeJSON(dir, 'course.json', course);
  sketch.blocks[1].place = { x: 0.6, y: 3, width: 0.3 };
  sketch.layers = [];
  writeJSON(dir, 'screens/sketch.json', sketch);
  assert.deepEqual(validateDir(dir).diagnostics.filter((d) => d.code.startsWith('W_PLACED') || d.code.startsWith('E_PLACED')).map((d) => d.code), []);
});

test('compiled: a placed block says where it is; the others say nothing', () => {
  const project = loadProjectFromDir(FIXTURE);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  const data = compileCourseData(project, keys, { buildId: 'test' });
  const blocks = data.screens.find((screen) => screen.id === 'sketch')!.blocks;
  assert.deepEqual(blocks.find((block) => block.id === 'sketch-figure')!.place, { x: 0.06, y: 0.5, width: 0.25, height: 0.3, z: 1 });
  assert.equal(blocks.find((block) => block.id === 'sketch-intro')!.place, undefined);
});

test('place_block: placed with its anchor in one change, back in the flow at a place, its rank kept without one; undone at once', () => {
  const dir = copyExample(FIXTURE);
  // The last text placed by hand, its anchor after the first text: one change.
  const placed = edit.placeBlock(dir, { block: 'sketch-more', place: { x: 0.523456, y: 0.75, width: 0.475 }, slot: null, after: 'sketch-intro' });
  assert.ok(placed.change);
  assert.deepEqual(placeOf(dir, 'sketch-more'), { x: 0.5235, y: 0.75, width: 0.475 });
  assert.deepEqual(ids(dir), ['sketch-intro', 'sketch-more', 'sketch-keep', 'sketch-figure']);
  // Moved without an anchor: its rank stays.
  edit.placeBlock(dir, { block: 'sketch-more', place: { x: 0.4, y: 0.7, width: 0.475, z: 3 } });
  assert.deepEqual(ids(dir), ['sketch-intro', 'sketch-more', 'sketch-keep', 'sketch-figure']);
  assert.equal(placeOf(dir, 'sketch-more').z, 3);
  // Back in the flow, first of the screen.
  edit.placeBlock(dir, { block: 'sketch-more', place: null, after: null });
  assert.equal(placeOf(dir, 'sketch-more'), undefined);
  assert.deepEqual(ids(dir), ['sketch-more', 'sketch-intro', 'sketch-keep', 'sketch-figure']);
  // A callout placed by hand put back with update_block place null: its rank stays.
  edit.updateBlock(dir, { block: 'sketch-keep', place: null });
  assert.equal(placeOf(dir, 'sketch-keep'), undefined);
  edit.undo(dir);
  assert.deepEqual(placeOf(dir, 'sketch-keep'), { x: 0.62, y: 0.6, width: 0.3 });
  // A block of a layer is refused.
  const sketch = readJSON(dir, 'screens/sketch.json');
  sketch.layers = [{ id: 'more', title: 'More', blocks: [{ id: 'more-text', type: 'text', props: { markdown: 'In a layer.' } }] }];
  writeJSON(dir, 'screens/sketch.json', sketch);
  assert.throws(() => edit.placeBlock(dir, { block: 'more-text', place: { x: 0, y: 0, width: 0.5 } }), /only blocks of the screen itself/);
});

test('arrange_screen: every block placed by hand back in the flow at its anchor, in one change', () => {
  const dir = copyExample(FIXTURE);
  const result = edit.arrangeScreen(dir, { screen: 'sketch' });
  assert.deepEqual(result.blocks, ['sketch-keep', 'sketch-figure']);
  assert.deepEqual(ids(dir), ['sketch-intro', 'sketch-keep', 'sketch-figure', 'sketch-more']);
  assert.equal(placeOf(dir, 'sketch-keep'), undefined);
  assert.equal(placeOf(dir, 'sketch-figure'), undefined);
  edit.undo(dir);
  assert.ok(placeOf(dir, 'sketch-keep') && placeOf(dir, 'sketch-figure'));
  assert.throws(() => edit.arrangeScreen(dir, { screen: 'sketch', blocks: ['sketch-intro'] }), /Not placed by hand/);
});

// A zone of a layout offers its places to the blocks it takes (the founder, 6 Nov 2026): on the example
// diagnostic-reseau's « accueil », « Scène » takes an object or an image, once. The editor's render
// gives the canvas each slot's name and rules; the player's rule says what the validator says, block by
// block and slot by slot.
test('zones: each slot\'s name and rules on the editor\'s canvas, the blocks it refuses as the validator does', () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const project = loadProjectFromDir(dir);
  const layout = renderScreen(project, 'accueil', {}, createRenderContext(project, { fields: true })).course.screens[0]!.layout!;
  assert.deepEqual(layout.slots!.map((slot) => [slot.id, slot.label]), [['body', 'Texte'], ['scene', 'Scène'], ['note', 'Note sur la scène']]);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  assert.equal(compileCourseData(project, keys, { buildId: 'test' }).screens.find((screen) => screen.id === 'accueil')!.layout!.slots, undefined, 'a package carries none');
  const screen = readJSON(dir, 'screens/accueil.json');
  const blocks = screen.blocks as { id: string; type: string; slot?: string }[];
  assert.deepEqual(refusedBy(layout.slots!.find((slot) => slot.id === 'scene')!, blocks, layout.defaultSlot), ['accueil-mission', 'accueil-ticket', 'accueil-go']);
  assert.deepEqual(refusedBy(layout.slots!.find((slot) => slot.id === 'body')!, blocks, layout.defaultSlot), ['accueil-reseau']);
  for (const slot of layout.slots!) {
    const refused = refusedBy(slot, blocks, layout.defaultSlot);
    for (const block of blocks) {
      const moved = structuredClone(screen);
      moved.blocks.find((candidate: { id: string }) => candidate.id === block.id).slot = slot.id;
      writeJSON(dir, 'screens/accueil.json', moved);
      const wrong = validateDir(dir).diagnostics.some((d) => d.code === 'E_COMPONENT_SLOT');
      assert.equal(wrong, refused.includes(block.id), `${block.id} in ${slot.id}`);
    }
  }
  // Full: a slot of one block refuses a second, never the one it holds.
  assert.deepEqual(refusedBy({ id: 'scene', label: 'Scène', accepts: ['image', 'text'], maxBlocks: 1 }, [{ id: 'a', type: 'text', slot: 'scene' }, { id: 'b', type: 'text' }], 'body'), ['b']);
  // A fork is taken where its parent is.
  assert.deepEqual(refusedBy({ id: 'scene', label: 'Scène', accepts: ['image'] }, [{ id: 'a', type: 'photo', lineage: ['photo', 'image'] }], 'body'), []);
});
