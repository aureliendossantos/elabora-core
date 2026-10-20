import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { createCourseState } from '@elabora/player/course-state';
import { EXAMPLE, copyExample, addExplorer, readJSON, writeJSON } from '../helpers.ts';
import { decodeState, worstCaseLength } from '@elabora/player/state-codec';
import { buildStateModel } from '@elabora/core/compile/state-model';

function course(overrides = {}) {
  const p = loadProjectFromDir(EXAMPLE);
  const { keys } = assignKeys(p, readLock(p), { dryRun: true });
  const data = compileCourseData(p, keys, { buildId: 'test' });
  data.completion = { ...data.completion, ...overrides };
  return data;
}

type CourseState = ReturnType<typeof createCourseState>;

function completeAll(e: CourseState, { quizCorrect = true, objectScore = 1 } = {}) {
  for (const s of e.screens) {
    e.visit(s);
    for (const b of s.blocks) {
      if (b.behavior === 'quiz') e.answerQuiz(b.id, b.props.options.filter((o) => (quizCorrect ? o.correct : !o.correct)).map((o) => o.id).slice(0, 1));
      if (b.behavior === 'decision') e.chooseDecision(b.id, (b.props.options.find((o) => o.correct) || b.props.options[0]).id);
      if (b.behavior === 'object') e.completeObject(b.id, objectScore);
    }
    e.refreshScreenCompletion(s);
  }
}

test('passed-incomplete: passed when everything is done and the score reaches mastery', () => {
  const e = createCourseState(course());
  assert.equal(e.nextLmsStatus().status, 'incomplete', 'first launch reports incomplete');
  completeAll(e);
  const r = e.nextLmsStatus();
  assert.equal(r.status, 'passed');
  assert.equal(r.score.raw, 100);
});

test('weights: two wrong quizzes and a perfect object (weight 2) give 50 %', () => {
  const e = createCourseState(course({ reportAs: 'passed-failed', masteryScore: 70 }));
  completeAll(e, { quizCorrect: false, objectScore: 1 });
  const r = e.nextLmsStatus();
  assert.equal(r.score.raw, 50);
  assert.equal(r.status, 'failed');
});

test('status never regresses; failed may improve after a retake', () => {
  const c = course({ reportAs: 'passed-failed', masteryScore: 70 });
  const done = createCourseState(c, { initialStatus: 'passed' });
  assert.equal(done.nextLmsStatus().status, 'passed');
  const e = createCourseState(c);
  completeAll(e, { quizCorrect: false, objectScore: 0 });
  e.commitStatus(e.nextLmsStatus().status);
  assert.equal(e.lmsStatus, 'failed');
  e.retake();
  assert.equal(e.nextLmsStatus().status, 'failed', 'not back to incomplete');
  completeAll(e);
  assert.equal(e.nextLmsStatus().status, 'passed');
});

test('events: conditions, else branch and variables', () => {
  const c = course();
  const screen = c.screens.find((s) => s.id === 'premier-reflexe')!;
  screen.events.push({ id: 'cond', on: { type: 'screen.enter' }, if: [{ variable: 'bonsReflexes', op: 'gte', value: 1 }], do: [{ type: 'show-layer', layer: 'rappel-regle' }], else: [{ type: 'set-variable', variable: 'indiceVu', value: true }] });
  const e = createCourseState(c);
  assert.deepEqual(e.eventsFor(screen, 'screen.enter', {})[0].actions.map((a: { type: string }) => a.type), ['set-variable']);
  e.setVar('bonsReflexes', 2);
  assert.deepEqual(e.eventsFor(screen, 'screen.enter', {})[0].actions.map((a: { type: string }) => a.type), ['show-layer']);
  assert.equal(e.eventsFor(screen, 'decision.selected', { target: 'reflexe-choix', option: 'b' })[0].event, 'reflexe-bon');
  e.setVar('bonsReflexes', 99);
  assert.equal(e.getVar('bonsReflexes'), 10, 'clamped to maximum');
});

test('events: one without actions reaches the player and runs nothing', () => {
  const dir = copyExample();
  const file = readJSON(dir, 'screens/premier-reflexe.json');
  file.events.push({ id: 'premier-reflexe-vide', on: { type: 'screen.enter' }, do: [] });
  writeJSON(dir, 'screens/premier-reflexe.json', file);
  const p = loadProjectFromDir(dir);
  const { keys } = assignKeys(p, readLock(p), { dryRun: true });
  const data = compileCourseData(p, keys, { buildId: 'test' });
  const screen = data.screens.find((s) => s.id === 'premier-reflexe')!;
  const runs = createCourseState(data).eventsFor(screen, 'screen.enter', {});
  assert.deepEqual(runs.find((run: { event: string }) => run.event === 'premier-reflexe-vide')?.actions, []);
});

test('resume restores answers from suspend data', () => {
  const c = course();
  const e = createCourseState(c);
  completeAll(e);
  const again = createCourseState(c, { suspendData: e.encode() });
  assert.equal(again.nextLmsStatus().score.raw, 100);
  assert.ok(again.screens.every((s: Parameters<CourseState['screenComplete']>[0]) => again.screenComplete(s)));
});

test('controls: named clicks, visited state saved under the lock keys, visited conditions', () => {
  const dir = copyExample();
  addExplorer(dir);
  const sc = readJSON(dir, 'screens/chemin.json');
  sc.blocks.push({ id: 'chemin-marques', type: 'markers', props: { items: [{ id: 'poste', label: 'Le poste' }, { id: 'switch', label: 'Le commutateur' }] } });
  sc.events = [
    { id: 'poste', on: { type: 'click', target: 'chemin-marques', name: 'poste' }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] },
    { id: 'tout-vu', on: { type: 'click', target: 'chemin-marques' }, if: [{ visited: 'chemin-marques' }], do: [{ type: 'complete-screen' }], else: [{ type: 'go-to', screen: 'next' }] }
  ];
  writeJSON(dir, 'screens/chemin.json', sc);
  const p = loadProjectFromDir(dir);
  const { keys }: { keys: Record<string, string> } = assignKeys(p, readLock(p), { dryRun: true });
  assert.ok(keys['visit:chemin-marques#poste'] && keys['visit:chemin-marques#switch']);
  const c = compileCourseData(p, keys, { buildId: 'test' });
  const screen = c.screens.find((s) => s.id === 'chemin')!;
  assert.deepEqual(Object.keys(screen.blocks.find((b) => b.id === 'chemin-marques')?.visits ?? {}), ['poste', 'switch']);
  const e = createCourseState(c);
  const run = (name: string) => e.eventsFor(screen, 'click', { target: 'chemin-marques', name }).map((r: { event: string; actions: { type: string }[] }) => `${r.event}:${r.actions.map((a) => a.type).join('+')}`);
  // The player records the visit before the events run.
  e.visitControl('chemin-marques', 'switch');
  assert.deepEqual(run('switch'), ['tout-vu:go-to'], 'a named trigger only hears its own control');
  e.visitControl('chemin-marques', 'poste');
  assert.deepEqual(run('poste'), ['poste:set-variable', 'tout-vu:complete-screen'], 'every control visited');
  // Saved in the suspend data and restored.
  const again = createCourseState(c, { suspendData: e.encode() });
  assert.ok(again.blockVisited('chemin-marques') && again.controlVisited('chemin-marques', 'poste'));
  assert.equal(decodeState(e.encode()).visits.size, 2);
  assert.ok(worstCaseLength(buildStateModel(p, keys)) > worstCaseLength(buildStateModel(loadProjectFromDir(EXAMPLE), assignKeys(loadProjectFromDir(EXAMPLE), readLock(loadProjectFromDir(EXAMPLE)), { dryRun: true }).keys)), 'counted in the budget');
});
