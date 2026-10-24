import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, encodeState, decodeState, worstCaseLength } from '@elabora/player/state-codec';
import { readLock, assignKeys, buildStateModel } from '@elabora/core/compile/state-model';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { copyExample } from '../helpers.ts';
import * as edit from '@elabora/node/edit';

test('suspend data preserves every learner-state field across generated values', () => {
  for (let seed = 0; seed < 100; seed++) {
    const state = emptyState(), key = seed.toString(36);
    state.visited.add(key); state.completed.add(key); state.visits.add(`v${key}`);
    state.quizzes[key] = { selected: seed % 2 ? ['a', 'c'] : [], attempts: seed };
    state.numerics[key] = { value: seed % 2 ? seed / 4 : null, attempts: seed };
    state.decisions[key] = 'b'; state.vars[key] = seed % 2 ? `Zoé 日本 ${seed}` : false;
    state.objects[key] = { found: true, inspected: ['poste', seed] };
    state.objectsDone[key] = seed / 100; state.visibility[key] = seed % 2;
    state.steps[key] = 2 + seed; state.retakes = seed;
    state.language = seed % 2 ? 'fr' : 'en'; state.dialogues[key] = 'a|b';
    assert.deepEqual(decodeState(encodeState(state)), state, `seed ${seed}`);
  }
});

test('corrupt or foreign suspend data starts a fresh state', () => {
  for (const input of ['not json', '{"v":99}', '']) assert.deepEqual(decodeState(input), emptyState(), input);
});

test('keys are permanent: inserting a screen keeps every existing key', () => {
  const dir = copyExample();
  const lock = readLock(loadProjectFromDir(dir));
  const before: Record<string, string> = assignKeys(loadProjectFromDir(dir), lock).keys;
  edit.createScreen(dir, { id: 'nouvel-ecran', title: 'Nouvel écran', covers: ['ITEM-2'], after: 'accueil' });
  const after: Record<string, string> = assignKeys(loadProjectFromDir(dir), lock).keys;
  for (const [ent, key] of Object.entries(before)) assert.equal(after[ent], key, ent);
  assert.ok(after['screen:nouvel-ecran']);
});

test('the worst case grows with persisted string variables', () => {
  const dir = copyExample();
  const p = loadProjectFromDir(dir);
  const { keys } = assignKeys(p, readLock(p), { dryRun: true });
  const base = worstCaseLength(buildStateModel(p, keys));
  assert.ok(p.course?.variables);
  p.course.variables.push({ id: 'texte', type: 'string', default: '', maxLength: 100 });
  const k2 = assignKeys(p, readLock(p), { dryRun: true }).keys;
  assert.ok(worstCaseLength(buildStateModel(p, k2)) >= base + 200);
});
