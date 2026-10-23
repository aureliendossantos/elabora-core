import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { readLock, assignKeys, buildStateModel } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { playerContent, screenSpeaks } from '@elabora/core/player/config';
import { createCourseState } from '@elabora/player/course-state';
import { emptyState, encodeState, decodeState, worstCaseLength, worstCaseState } from '@elabora/player/state-codec';
import { choose, revisit, restart, canRevisit, scoredDone, scoredResult } from '@elabora/player/dialogue/run';
import { labelKeys, labelLanguages, labelsFor } from '@elabora/player/labels';
import type { CourseData, DialogueBlock } from '@elabora/player/course-data';
import { dialogueCourse } from '../dialogue-fixture.ts';
import { readJSON, writeJSON } from '../helpers.ts';

// The dialogue in the learner's state (D61): its progress in the suspend data, its worst case, the
// course state's conditions, score, completion and the interactions of its scored run, recorded once.

function compiled(dir = dialogueCourse()): { data: CourseData; dir: string } {
  const project = loadProjectFromDir(dir);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  return { data: compileCourseData(project, keys, { buildId: 'test' }), dir };
}
const blockOf = (data: CourseData, id: string) => data.screens.flatMap((screen) => screen.blocks).find((block) => block.id === id) as DialogueBlock;

test('the suspend data holds each dialogue\'s progress under its key, after the other fields; old states read as before', () => {
  const state = emptyState();
  assert.equal(encodeState(state), '{"v":1}');
  state.visited.add('0');
  state.dialogues.k = '1b~.1a|1a.1d|DC|B';
  state.language = 'en';
  const text = encodeState(state);
  assert.equal(text, '{"v":1,"s":"0","g":"en","t":{"k":"1b~.1a|1a.1d|DC|B"}}');
  assert.deepEqual(decodeState(text).dialogues, { k: '1b~.1a|1a.1d|DC|B' });
  assert.deepEqual(decodeState('{"v":1,"s":"0"}').dialogues, {});
  // What is not a string is left out.
  assert.deepEqual(decodeState('{"v":1,"t":{"k":3,"j":"1a"}}').dialogues, { j: '1a' });
  const worst = worstCaseState({ screens: [], quizzes: [], numerics: [], decisions: [], variables: [], objects: [], toggleableBlocks: [], steppedScreens: [], controls: [], dialogues: [{ key: 'k', worst: 'x'.repeat(40) }] });
  assert.equal(worst.dialogues.k.length, 40);
});

test('the state model measures each dialogue\'s longest progress, and the budget counts it', () => {
  const dir = dialogueCourse();
  const project = loadProjectFromDir(dir);
  const lock = readLock(project);
  const { keys } = assignKeys(project, lock, { dryRun: true });
  const model = buildStateModel(project, keys, lock);
  const appel = model.dialogues!.find((entry) => entry.key === keys['dialogue:appel-marc']);
  const rencontre = model.dialogues!.find((entry) => entry.key === keys['dialogue:rencontre-marc']);
  assert.ok(appel && rencontre, 'both dialogues');
  assert.ok(appel.worst.length > 20 && appel.worst.length < 400, `${appel.worst.length} characters`);
  const without = worstCaseLength({ ...model, dialogues: [] });
  assert.equal(worstCaseLength(model) - without, JSON.stringify({ t: Object.fromEntries(model.dialogues!.map((entry) => [entry.key, entry.worst])) }).length - 1, 'the field t and its strings');
  // The fixture validates (its two dialogues, the characters, the scene's backdrop).
  const result = validateDir(dir);
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`), []);
});

test('the course state: progress saved, the scored run\'s interactions returned once, at its first end', () => {
  const { data } = compiled();
  const state = createCourseState(data);
  const block = blockOf(data, 'appel-marc');
  let run = state.dialogueRun(block);
  assert.equal(run.walk.status, 'choosing');
  assert.equal(state.activityDone(block), false);
  // A retried option, then the common way to the end.
  for (const option of ['c', 'b', 'a', 'a']) {
    run = choose(run, option);
    const saved = state.saveDialogue('appel-marc', run);
    if (run.walk.status !== 'ended') assert.deepEqual(saved, { finished: false, interactions: [] });
    else {
      assert.equal(saved.finished, true);
      assert.deepEqual(saved.interactions.map((interaction) => [interaction.id, interaction.response, interaction.result]), [['premiere-question', 'c', 'wrong'], ['ticket', 'a', 'correct'], ['escalade', 'a', 'correct']]);
      assert.equal(saved.interactions[0].objective, 'OBJ-2');
    }
  }
  assert.equal(state.activityDone(block), true);
  assert.match(state.st.dialogues[block.key], /^[0-9a-z~.>|A-Za-z_-]+$/);
  // Going back after the end changes neither the score nor the interactions.
  const before = state.score();
  assert.equal(canRevisit(run, 0), false, 'the final decision closes everything before it');
  run = state.dialogueRun(block);
  assert.equal(scoredDone(run), true);
  // Resumed in a new session: the same run.
  const again = createCourseState(data, { suspendData: state.encode() });
  assert.deepEqual(again.dialogueRun(block).progress.path, run.progress.path);
  assert.deepEqual(again.score(), before);
});

test('the course state: a practice run without final decision, revisited after its end, records nothing more', () => {
  const dir = dialogueCourse();
  const screen = readJSON(dir, 'screens/appel.json');
  delete screen.blocks[0].props.nodes[4].final;
  writeJSON(dir, 'screens/appel.json', screen);
  const { data } = compiled(dir);
  const state = createCourseState(data);
  const block = blockOf(data, 'appel-marc');
  let run = state.dialogueRun(block);
  for (const option of ['a', 'a', 'a']) { run = choose(run, option); state.saveDialogue('appel-marc', run); }
  assert.equal(run.walk.status, 'ended');
  assert.equal(scoredResult(run).score, 1);
  const scored = state.score().raw;
  // « Reprendre d'ici » on the first decision, another choice, another end.
  assert.equal(canRevisit(run, 0), true);
  run = revisit(run, 0);
  assert.deepEqual(state.saveDialogue('appel-marc', run), { finished: false, interactions: [] });
  for (const option of ['b', 'c', 'b']) { run = choose(run, option); assert.deepEqual(state.saveDialogue('appel-marc', run).interactions, []); }
  assert.equal(state.score().raw, scored, 'the first run stays scored');
  assert.equal(scoredResult(state.dialogueRun(block)).score, 1);
  assert.deepEqual(state.dialogueRun(block).progress.endings.sort(), ['a-revoir', 'maitrise']);
  run = restart(run);
  assert.deepEqual(state.saveDialogue('appel-marc', run).interactions, []);
});

test('the course state: score and completion of a scored dialogue, conditions on its scored run, its triggers, a retake', () => {
  const { data } = compiled();
  const state = createCourseState(data);
  const block = blockOf(data, 'rencontre-marc');
  const screen = data.screens.find((candidate) => candidate.id === 'rencontre')!;
  assert.equal(state.score().decided, false);
  const holds = (condition: Record<string, unknown>) => state.eventsFor({ ...screen, events: [{ id: 'e', on: { type: 'click' }, if: [condition as never], do: [{ type: 'complete-screen' }], else: [] }] }, 'click', {})[0].actions.length === 1;
  assert.equal(holds({ dialogue: 'rencontre-marc', done: false }), true);
  assert.equal(holds({ dialogue: 'rencontre-marc', done: true }), false);
  let run = state.dialogueRun(block);
  run = choose(run, 'b');
  state.saveDialogue('rencontre-marc', run);
  run = choose(run, 'a');
  const saved = state.saveDialogue('rencontre-marc', run);
  assert.equal(saved.finished, true);
  assert.deepEqual(saved.interactions.map((interaction) => interaction.result), ['neutral', 'correct']);
  assert.equal(holds({ dialogue: 'rencontre-marc', done: true }), true);
  assert.equal(holds({ dialogue: 'rencontre-marc', ending: 'bien' }), true, '75 %: well led');
  assert.equal(holds({ dialogue: 'rencontre-marc', ending: 'revoir' }), false);
  assert.equal(holds({ dialogue: 'rencontre-marc', chosen: 'ouverture.b' }), true);
  assert.equal(holds({ dialogue: 'rencontre-marc', chosen: 'ouverture.a' }), false);
  assert.equal(holds({ dialogue: 'rencontre-marc', score: { op: 'gte', value: 75 } }), true);
  assert.equal(holds({ dialogue: 'rencontre-marc', score: { op: 'gt', value: 75 } }), false);
  assert.equal(holds({ dialogue: 'nothing', done: true }), false);
  // Completion: the screen completes once its dialogue's first run reached an end.
  state.refreshScreenCompletion(screen);
  assert.equal(state.screenComplete(screen), true);
  // Triggers and their filters.
  const on = (trigger: Record<string, unknown>, type: string, info: Record<string, unknown>) => state.eventsFor({ ...screen, events: [{ id: 'e', on: { target: 'rencontre-marc', ...trigger } as never, do: [] }] }, type as never, { target: 'rencontre-marc', ...info }).length;
  assert.equal(on({ type: 'dialogue.chosen', node: 'ouverture', option: 'b' }, 'dialogue.chosen', { node: 'ouverture', option: 'b' }), 1);
  assert.equal(on({ type: 'dialogue.chosen', node: 'ouverture', option: 'a' }, 'dialogue.chosen', { node: 'ouverture', option: 'b' }), 0);
  assert.equal(on({ type: 'dialogue.chosen', node: 'suite' }, 'dialogue.chosen', { node: 'ouverture', option: 'b' }), 0);
  assert.equal(on({ type: 'dialogue.node', node: 'suite' }, 'dialogue.node', { node: 'suite' }), 1);
  assert.equal(on({ type: 'dialogue.line', line: 'r1' }, 'dialogue.line', { line: 'r2' }), 0);
  assert.equal(on({ type: 'dialogue.ended', ending: 'bien' }, 'dialogue.ended', { ending: 'bien' }), 1);
  assert.equal(on({ type: 'dialogue.ended', ending: 'bien' }, 'dialogue.ended', { ending: 'revoir' }), 0);
  assert.equal(on({ type: 'dialogue.ended' }, 'dialogue.ended', { ending: null }), 1);
  assert.equal(on({ type: 'dialogue.started' }, 'dialogue.started', {}), 1);
  // The score counts the scored dialogues with their weight (appel: quality, not done yet).
  assert.equal(state.score().decided, false);
  // A retake starts the scored dialogue afresh.
  state.retake();
  assert.equal(state.dialogueRun(block).progress.path.length, 0);
  assert.equal(state.activityDone(block), false);
});

test('a screen without narration whose dialogue or layer speaks shows the controls (its transcript)', () => {
  const dir = dialogueCourse();
  const project = loadProjectFromDir(dir);
  assert.equal(screenSpeaks(project, 'appel'), true);
  assert.equal(screenSpeaks(project, 'chemin'), false);
  assert.equal(playerContent(project).spoken, true);
});

test('the player\'s dialogue labels exist in its seven languages', () => {
  const keys = labelKeys().filter((key) => key.startsWith('dialogue') || key === 'textInstant');
  assert.ok(keys.length >= 30, `${keys.length} labels`);
  assert.deepEqual(labelLanguages().sort(), ['de', 'en', 'es', 'fr', 'it', 'nl', 'pt']);
  for (const language of labelLanguages()) {
    const labels = labelsFor(language);
    for (const key of keys) assert.ok(typeof labels[key] === 'string' && labels[key]!.trim(), `${language} ${key}`);
  }
  assert.equal(labelsFor('fr').dialogueChooseAgain, 'Choisir autrement');
  assert.equal(labelsFor('fr').dialogueResumeHere, 'Reprendre d’ici');
});
