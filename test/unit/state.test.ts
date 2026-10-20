import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, encodeState, decodeState, worstCaseLength } from '@elabora/player/state-codec';
import { readLock, assignKeys, buildStateModel } from '@elabora/core/compile/state-model';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { copyExample } from '../helpers.ts';
import * as edit from '@elabora/node/edit';

test('state round-trips through suspend data', () => {
  const s = emptyState();
  s.visited.add('0'); s.visited.add('1'); s.completed.add('0');
  s.quizzes['9'] = { selected: ['a', 'c'], attempts: 2 };
  s.decisions['6'] = 'b';
  s.vars.b = 3;
  s.objects['7'] = { found: true, inspected: ['poste'] };
  s.objectsDone['7'] = 0.75;
  s.visibility['8'] = 1;
  s.retakes = 1;
  const back = decodeState(encodeState(s));
  assert.deepEqual([...back.visited], ['0', '1']);
  assert.deepEqual(back.quizzes['9'], { selected: ['a', 'c'], attempts: 2 });
  assert.equal(back.decisions['6'], 'b');
  assert.deepEqual(back.objects['7'], { found: true, inspected: ['poste'] });
  assert.equal(back.objectsDone['7'], 0.75);
  assert.equal(back.retakes, 1);
});

test('corrupt or foreign suspend data starts a fresh state', () => {
  assert.equal(decodeState('not json').visited.size, 0);
  assert.equal(decodeState('{"v":99}').visited.size, 0);
  assert.equal(decodeState('').visited.size, 0);
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
