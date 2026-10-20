import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followPlanOrder, itemParts } from '@elabora/core/project/plan-order';
import { screenEstimates, roundedMinutes, countWords, READING_WORDS_PER_MINUTE } from '@elabora/core/project/duration';
import type { Course, Plan } from '@elabora/core/project/model';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';

// A module of three parts, a section each; ITEM-4 and ITEM-5 share the screen r-45.
const course = (): Course => ({
  sections: [
    { id: 's1', title: 'Ouverture', screens: ['a1', 'a2'] },
    { id: 's2', title: 'Le texte', screens: ['b3', 'r-45', 'b6'] },
    { id: 's3', title: 'Évaluer', screens: ['c7', 'c8'] }
  ]
} as unknown as Course);
const covers = new Map<string, string[]>([['a1', ['I1']], ['a2', ['I2']], ['b3', ['I3']], ['r-45', ['I4', 'I5']], ['b6', ['I6']], ['c7', ['I7']], ['c8', ['I8']]]);
const PARTS: Record<string, string> = { I1: 'Ouverture', I2: 'Ouverture', I3: 'Le texte', I4: 'Le texte', I5: 'Le texte', I6: 'Le texte', I7: 'Évaluer', I8: 'Évaluer' };
const plan = (order: string[], parts: Record<string, string> | null = PARTS): Plan => ({
  items: order.map((id) => ({ id, kind: 'exposition', title: id, objectives: [], ...(parts?.[id] ? { part: parts[id] } : {}) }))
} as unknown as Plan);
const ORDER = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8'];
const screensOf = (followed: ReturnType<typeof followPlanOrder>) => followed?.course.sections.map((section) => `${section.id}:${section.screens.join(',')}`);

test('the plan\'s parts: an item without one continues the part before it; none at all, no parts', () => {
  assert.deepEqual([...itemParts({ items: [{ id: 'A', part: 'Un' }, { id: 'B' }, { id: 'C', part: 'Deux' }] } as unknown as Plan)!], [['A', 'Un'], ['B', 'Un'], ['C', 'Deux']]);
  assert.equal(itemParts(plan(ORDER, null)), null);
});

test('the screens follow the plan: nothing moves while the order and the parts stay', () => {
  assert.equal(followPlanOrder(course(), covers, plan(ORDER), plan(ORDER)), null);
  // A title changed, an item added at the end: nothing to follow.
  const longer = plan([...ORDER, 'I9'], { ...PARTS, I9: 'Évaluer' });
  assert.equal(followPlanOrder(course(), covers, plan(ORDER), longer), null);
});

test('an item moved within its part takes its screen with it', () => {
  const followed = followPlanOrder(course(), covers, plan(ORDER), plan(['I1', 'I2', 'I6', 'I3', 'I4', 'I5', 'I7', 'I8']));
  assert.deepEqual(screensOf(followed), ['s1:a1,a2', 's2:b6,b3,r-45', 's3:c7,c8']);
  assert.deepEqual(followed!.screens, ['b6']);
  assert.deepEqual(followed!.sections, []);
});

test('an item moved to another part goes to that part\'s section; a screen shared by two items stays', () => {
  // I3 moves to the start of « Évaluer ».
  const parts = { ...PARTS, I3: 'Évaluer' };
  const followed = followPlanOrder(course(), covers, plan(ORDER), plan(['I1', 'I2', 'I4', 'I5', 'I6', 'I3', 'I7', 'I8'], parts));
  assert.deepEqual(screensOf(followed), ['s1:a1,a2', 's2:r-45,b6', 's3:b3,c7,c8']);
  assert.deepEqual(followed!.screens, ['b3']);
  // Only its part changed (the last of « Ouverture » becomes the first of « Le texte »): the next section.
  const regrouped = followPlanOrder(course(), covers, plan(ORDER), plan(ORDER, { ...PARTS, I2: 'Le texte' }));
  assert.deepEqual(screensOf(regrouped), ['s1:a1', 's2:a2,b3,r-45,b6', 's3:c7,c8']);
});

test('a part moved takes its section with it, and the section is renamed with its part', () => {
  const followed = followPlanOrder(course(), covers, plan(ORDER), plan(['I1', 'I2', 'I7', 'I8', 'I3', 'I4', 'I5', 'I6']));
  assert.deepEqual(screensOf(followed), ['s1:a1,a2', 's3:c7,c8', 's2:b3,r-45,b6']);
  assert.deepEqual(followed!.screens, []);
  assert.deepEqual(followed!.sections, ['s3', 's2']);
  const renamed = followPlanOrder(course(), covers, plan(ORDER), plan(ORDER, { ...PARTS, I7: 'Évaluer et conclure', I8: 'Évaluer et conclure' }));
  assert.equal(renamed!.course.sections[2]!.title, 'Évaluer et conclure');
  assert.deepEqual(renamed!.renamed, ['s3']);
  assert.deepEqual(renamed!.screens, []);
});

test('parts written for the first time, from the sections, as the app does: the moved item\'s screen alone moves, and no section ends empty', () => {
  // I7 (« Évaluer ») moves to the start of « Le texte »: every item now says its part, the sections' titles.
  const parts = { ...PARTS, I7: 'Le texte' };
  const followed = followPlanOrder(course(), covers, plan(ORDER, null), plan(['I1', 'I2', 'I7', 'I3', 'I4', 'I5', 'I6', 'I8'], parts));
  assert.deepEqual(screensOf(followed), ['s1:a1,a2', 's2:c7,b3,r-45,b6', 's3:c8']);
  // The last screen of a section stays, its item moved elsewhere.
  const alone = followPlanOrder(course(), covers, plan(ORDER, null), plan(['I1', 'I2', 'I8', 'I7', 'I3', 'I4', 'I5', 'I6'], { ...PARTS, I7: 'Ouverture', I8: 'Ouverture' }));
  assert.ok(alone!.course.sections.every((section) => section.screens.length > 0), JSON.stringify(screensOf(alone)));
  // Its items moved into a part that already was, the section keeps its title (no two « Ouverture »).
  assert.deepEqual(alone!.renamed, []);
  // A part renamed in a plan that took its parts from the sections renames its section.
  const renamed = followPlanOrder(course(), covers, plan(ORDER, null), plan(ORDER, { ...PARTS, I3: 'Le texte du Gai Savoir', I4: 'Le texte du Gai Savoir', I5: 'Le texte du Gai Savoir', I6: 'Le texte du Gai Savoir' }));
  assert.equal(renamed!.course.sections[1]!.title, 'Le texte du Gai Savoir');
  assert.deepEqual(renamed!.renamed, ['s2']);
  assert.deepEqual(renamed!.screens, []);
});

test('a plan without parts: a moved item\'s screen goes after the screens of the item now before it', () => {
  const followed = followPlanOrder(course(), covers, plan(ORDER, null), plan(['I1', 'I3', 'I2', 'I4', 'I5', 'I6', 'I7', 'I8'], null));
  // I3 moved up: its screen joins the section of the item before it, after a1.
  assert.deepEqual(screensOf(followed), ['s1:a1,b3,a2', 's2:r-45,b6', 's3:c7,c8']);
});

test('write_plan with a move patch moves the screens in the same change, a validated version or not (D50, D52)', () => {
  const dir = copyExample();
  // ITEM-5 (Évaluation, screen evaluation of « Valider ») moves before ITEM-3 (Premier réflexe, « Pratiquer »).
  const result = edit.writePlan(dir, { patch: [{ op: 'move', from: '/items/4', path: '/items/2' }] }, { author: { kind: 'human' } });
  assert.deepEqual(result.moved, { screens: ['evaluation'], sections: [], renamed: [] });
  assert.deepEqual(readJSON(dir, 'plan.json').items.map((item: { id: string }) => item.id), ['ITEM-1', 'ITEM-2', 'ITEM-5', 'ITEM-3', 'ITEM-4', 'ITEM-6']);
  assert.deepEqual(readJSON(dir, 'course.json').sections.map((section: { screens: string[] }) => section.screens), [['accueil', 'chemin', 'evaluation'], ['premier-reflexe', 'simulation'], ['bilan']]);
  // Undone at once, plan and screens together.
  edit.undo(dir);
  assert.deepEqual(readJSON(dir, 'course.json').sections.map((section: { screens: string[] }) => section.screens), [['accueil', 'chemin'], ['premier-reflexe', 'simulation'], ['evaluation', 'bilan']]);
  // « Revenir à la V1 » on a move takes the screens back too.
  edit.writePlan(dir, { patch: [{ op: 'move', from: '/items/4', path: '/items/2' }] }, { author: { kind: 'human' } });
  const back = edit.revertPlanChange(dir, { key: 'item:ITEM-5' }, { author: { kind: 'human' } });
  assert.deepEqual(back.moved?.screens, ['evaluation']);
  // After the screens of the item before it (D50): the learner's order is the plan's again.
  assert.deepEqual(readJSON(dir, 'course.json').sections.flatMap((section: { screens: string[] }) => section.screens), ['accueil', 'chemin', 'premier-reflexe', 'simulation', 'evaluation', 'bilan']);
});

test('how long a screen takes: its words read, or its voice when longer, and a moment per activity (D50)', () => {
  assert.equal(countWords('Le **chemin** d’une [impression](https://example.org/x) : 4 équipements'), 5);
  const dir = copyExample();
  const project = loadProjectFromDir(dir);
  const estimates = screenEstimates(project);
  assert.deepEqual([...estimates.keys()].sort(), [...project.screens.keys()].sort());
  for (const [id, estimate] of estimates) {
    assert.ok(estimate.seconds >= 10, `${id} lasts at least a glance`);
    assert.ok(estimate.seconds >= Math.round((estimate.words / READING_WORDS_PER_MINUTE) * 60), `${id}: at least its reading`);
  }
  // The assessment's questions count as activities.
  assert.ok(estimates.get('evaluation')!.activities >= 1);
  assert.equal(roundedMinutes(20), 1);
  assert.equal(roundedMinutes(150), 3);
  assert.equal(roundedMinutes(41 * 60, { module: true }), 40);
  assert.equal(roundedMinutes(12 * 60 + 40, { module: true }), 13);
});
