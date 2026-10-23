import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { exportDialogue } from '@elabora/node/dialogue-export';
import { setDialogueNode, removeDialogueNode, rename } from '@elabora/node/edit';
import { readLock, assignKeys, statefulEntities } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { dialogueData } from '@elabora/core/dialogue/data';
import { findDialogue, projectDialogue } from '@elabora/core/dialogue/project';
import { dialogueScript, formatScript } from '@elabora/core/dialogue/script';
import { playDialogue, dialoguePaths, formatPaths } from '@elabora/core/dialogue/play';
import { dialogueMap, dialogueMapSvg } from '@elabora/core/dialogue/layout';
import { dialogueDocumentHtml } from '@elabora/core/dialogue/document';
import { extractUnits } from '@elabora/core/i18n/units';
import { lessonMdExport } from '@elabora/core/interop/lesson-md';
import { readRise } from '@elabora/core/import/rise';
import { convertCourse } from '@elabora/core/import/convert';
import { replay, chooseOption, newBeats, presentationOf, expressionsOf, walkScore, MAX_DECISIONS } from '@elabora/player/dialogue/walk';
import { openDialogue, choose, revisit, retryLast, restart, jump, canRevisit, canRetryLast, canRestart, scoredResult, eventConditionHolds, scoredDone } from '@elabora/player/dialogue/run';
import { encodeDialogueProgress, decodeDialogueProgress, worstCaseDialogue } from '@elabora/player/dialogue/state';
import { explorePaths, maxPointsOf } from '@elabora/player/dialogue/paths';
import type { DialogueBlock } from '@elabora/player/course-data';
import { courseWithDialogue, MARC_DIALOGUE } from '../dialogue-fixture.ts';
import { ROOT, readJSON, writeJSON, codes } from '../helpers.ts';

// Dialogues (D61): the format, the pure walk and its replay, the scores, the saved state, the
// validation, the tools, the map, the export and the import from Rise.

const props = MARC_DIALOGUE.props as unknown as Record<string, unknown>;
const marc = () => dialogueData(structuredClone(props));
const lineIds = (beats: ReturnType<typeof replay>['beats']) => beats.filter((beat) => beat.type === 'line').map((beat) => beat.type === 'line' ? beat.line.id : '');
const dialogue = (nodes: unknown[], extra: Record<string, unknown> = {}) => dialogueData({ title: 'T', nodes, ...extra });

test('the walk: lines, a decision waiting, the common way, a branch that comes back', () => {
  const data = marc();
  const start = replay(data, []);
  assert.equal(start.status, 'choosing');
  assert.equal(start.node, 'premiere-question');
  assert.deepEqual(lineIds(start.beats), ['m1', 'l1']);
  assert.deepEqual(start.offer.map((offered) => [offered.option.id, offered.enabled]), [['a', true], ['b', true], ['c', true]]);
  // A: its reply, its note, then the node's next (ticket), a narration first.
  const a = chooseOption(data, start, 'a');
  assert.deepEqual(newBeats(start, a).map((beat) => beat.type), ['choice', 'line', 'line', 'feedback', 'node', 'line', 'decision']);
  assert.equal(a.node, 'ticket');
  assert.equal(a.vars.confiance, 1);
  const narration = a.beats.find((beat) => beat.type === 'line' && beat.line.id === 'n1');
  assert.equal(narration?.type === 'line' && narration.role, 'narration');
  const leila = a.beats.find((beat) => beat.type === 'line' && beat.line.id === 'l2');
  assert.equal(leila?.type === 'line' && leila.role, 'learner', 'the learner\'s character speaks on the right');
  // B: a branch, then back to ticket.
  const b = replay(data, ['premiere-question.b']);
  assert.deepEqual(b.seen, ['appel', 'premiere-question', 'routeur-redemarre', 'ticket']);
  // Deterministic: the same path, the same beats.
  assert.deepEqual(replay(data, ['premiere-question.a', 'ticket.b']).beats, replay(data, ['premiere-question.a', 'ticket.b']).beats);
  // A line whose condition fails is skipped (confiance 1 after A, 0 after B).
  assert.ok(lineIds(replay(data, ['premiere-question.a', 'ticket.a']).beats).includes('m5'));
  assert.ok(!lineIds(replay(data, ['premiere-question.b', 'ticket.a']).beats).includes('m5'));
  // The end: the endings' conditions choose.
  const best = replay(data, ['premiere-question.a', 'ticket.a', 'escalade.a']);
  assert.equal(best.status, 'ended');
  assert.equal(best.ending?.id, 'maitrise');
  assert.equal(replay(data, ['premiere-question.b', 'ticket.b', 'escalade.b']).ending?.id, 'a-revoir');
  assert.throws(() => chooseOption(data, start, 'z'), /does not offer "z"/);
});

test('retry: the same options again, the retried one greyed, its effects undone, its first choice scored', () => {
  const data = marc();
  const tried = replay(data, ['premiere-question.c']);
  assert.equal(tried.status, 'choosing');
  assert.equal(tried.node, 'premiere-question');
  assert.deepEqual(tried.offer.map((offered) => [offered.option.id, offered.enabled, offered.reason ?? null]), [['a', true, null], ['b', true, null], ['c', false, 'retried']]);
  assert.equal(tried.vars.confiance, 0, 'the retry replaces the choice: -1 undone');
  assert.ok(tried.beats.some((beat) => beat.type === 'retry'));
  assert.ok(lineIds(tried.beats).includes('m3'), 'its reaction was played');
  const then = replay(data, ['premiere-question.c', 'premiere-question.a']);
  assert.equal(then.decisions[0].choice, 'a');
  assert.deepEqual(then.decisions[0].tries, [{ option: 'c', by: 'retry' }]);
  assert.equal(then.vars.confiance, 1);
  // Retry is off without going back (assessment): C goes on to the common way.
  const assessment = dialogueData({ ...structuredClone(props), mode: 'assessment' });
  assert.equal(replay(assessment, ['premiere-question.c']).node, 'ticket');
});

test('once, fallback, if with hide or disable, next cases', () => {
  const hub = dialogue([
    { id: 'hub', lines: [{ id: 'h', speaker: 'x', text: 'Questions ?' }], options: [
      { id: 'a', text: 'A', once: true, unavailable: 'disable' },
      { id: 'b', text: 'B', once: true },
      { id: 'c', text: 'C', if: [{ seen: 'later' }] },
      { id: 'd', text: 'D', once: true, if: [{ chosen: 'hub.a' }], unavailable: 'disable', unavailableText: 'Posez A d\'abord' },
      { id: 'z', fallback: true, next: 'later' }
    ], next: 'hub' },
    { id: 'later', lines: [{ id: 'l', text: 'Fin.' }], end: true }
  ]);
  const first = replay(hub, []);
  assert.deepEqual(first.offer.map((offered) => [offered.option.id, offered.enabled, offered.reason ?? null]), [['a', true, null], ['b', true, null], ['d', false, 'if']], 'c hidden, d greyed, the fallback never shown');
  const afterA = replay(hub, ['hub.a']);
  assert.equal(afterA.node, 'hub');
  assert.deepEqual(afterA.offer.map((offered) => [offered.option.id, offered.enabled]), [['a', false], ['b', true], ['d', true]], 'a once greyed, b still, d now open');
  // Nothing left to choose: the fallback is taken by itself, not scored.
  const done = replay(hub, ['hub.a', 'hub.b', 'hub.d']);
  assert.equal(done.status, 'ended');
  assert.ok(done.decisions.some((decision) => decision.auto && decision.choice === 'z'));
  // One option left is not taken by itself.
  assert.equal(replay(hub, ['hub.a', 'hub.b']).status, 'choosing');
  // Next cases: the first that holds.
  const cases = dialogue([
    { id: 'start', options: [{ id: 'a', text: 'A', set: { flag: true } }, { id: 'b', text: 'B' }], next: [{ if: [{ var: 'flag', op: 'eq', value: true }], go: 'yes' }, { go: 'no' }] },
    { id: 'yes', lines: [{ id: 'y', text: 'Oui' }], end: true },
    { id: 'no', lines: [{ id: 'n', text: 'Non' }], end: true }
  ], { vars: [{ id: 'flag', default: false }] });
  assert.deepEqual(replay(cases, ['start.a']).seen, ['start', 'yes']);
  assert.deepEqual(replay(cases, ['start.b']).seen, ['start', 'no']);
  // A condition naming what does not exist holds.
  const ghost = dialogue([{ id: 'n', lines: [{ id: 'g', text: 'Toujours', if: [{ seen: 'gone' }, { chosen: 'gone.x' }, { var: 'nope', op: 'eq', value: 1 }] }], end: true }]);
  assert.deepEqual(lineIds(replay(ghost).beats), ['g']);
});

test('replay stops at the first choice a new version no longer has', () => {
  const data = marc();
  const saved = ['premiere-question.a', 'ticket.b', 'escalade.a'];
  const edited = structuredClone(props) as { nodes: { id: string; options?: { id: string }[] }[] };
  edited.nodes.find((node) => node.id === 'ticket')!.options = edited.nodes.find((node) => node.id === 'ticket')!.options!.filter((option) => option.id !== 'b');
  const walk = replay(dialogueData(edited as unknown as Record<string, unknown>), saved);
  assert.equal(walk.invalid?.index, 1);
  assert.equal(walk.node, 'ticket', 'the learner resumes at that decision');
  assert.equal(walk.status, 'choosing');
  assert.deepEqual(replay(data, saved).invalid, null);
  // A run opened from that path keeps what replays.
  const run = openDialogue(dialogueData(edited as unknown as Record<string, unknown>), { path: saved, scored: null, explored: ['ticket.b'], endings: [] });
  assert.deepEqual(run.progress.path, ['premiere-question.a']);
  assert.deepEqual(run.progress.explored, ['premiere-question.a']);
});

test('the four scores and the highest sum of points', () => {
  const data = marc();
  assert.equal(data.maxPoints, 30, 'a, a, a: 10 + 10 + 10');
  const exploration = explorePaths(data);
  assert.equal(exploration.complete, true);
  assert.equal(exploration.paths.length, 24);
  assert.equal(exploration.minPoints, -25);
  assert.equal(maxPointsOf(data, { ...exploration, complete: false }), 30, 'the bound from the graph, when the paths are too many');
  const path = replay(data, ['premiere-question.c', 'premiere-question.a', 'ticket.a', 'escalade.a']);
  // quality: c (bad, first choice) 0, a 1, a 1.
  assert.equal(walkScore(data, path, 'quality').score, 2 / 3);
  assert.equal(walkScore(data, path, 'points').points, 10);
  assert.equal(walkScore(data, path, 'points').score, 10 / 30);
  const ending = dialogueData({ ...structuredClone(props), scoring: 'ending', endings: [{ id: 'maitrise', score: 100, if: [{ chosen: 'escalade.a' }] }, { id: 'a-revoir', score: 40 }] });
  assert.equal(walkScore(ending, replay(ending, ['premiere-question.a', 'ticket.a', 'escalade.a']), 'ending').score, 1);
  assert.equal(walkScore(ending, replay(ending, ['premiere-question.a', 'ticket.a', 'escalade.b']), 'ending').score, 0.4);
  const none = dialogueData({ ...structuredClone(props), scoring: 'none' });
  assert.equal(scoredResult(openDialogue(none, { path: ['premiere-question.a', 'ticket.a', 'escalade.a'], scored: null, explored: [], endings: [] })).score, null, 'not scored');
  assert.equal(scoredResult(openDialogue(none, { path: ['premiere-question.a', 'ticket.a', 'escalade.a'], scored: null, explored: [], endings: [] })).quality, 1, 'its quality still read by conditions and the debrief');
});

test('the first run is the only one scored: going back after the end, retry, restart, final decisions', () => {
  const data = marc();
  let run = openDialogue(data);
  assert.equal(canRevisit(run, 0), false);
  run = choose(run, 'b');
  assert.equal(canRetryLast(run), true, '« Choisir autrement » right after the consequence');
  run = retryLast(run);
  assert.deepEqual(run.progress.path, ['premiere-question.b~'], 'the replaced first choice stays');
  run = choose(run, 'a');
  run = choose(run, 'a');
  run = choose(run, 'a');
  assert.equal(scoredDone(run), true);
  const first = scoredResult(run);
  assert.equal(first.done, true);
  assert.deepEqual(first.decisions.map((decision) => [decision.node, decision.option, decision.kept]), [['premiere-question', 'b', 'a'], ['ticket', 'a', null], ['escalade', 'a', null]]);
  assert.equal(first.score, (0.5 + 1 + 1) / 3);
  assert.equal(first.ending?.id, 'maitrise', 'b counted first: 83 %');
  assert.deepEqual(first.interactions.map((interaction) => [interaction.id, interaction.response, interaction.result, interaction.objective]), [['premiere-question', 'b', 'neutral', 'OBJ-2'], ['ticket', 'a', 'correct', 'OBJ-2'], ['escalade', 'a', 'correct', 'OBJ-2']]);
  // After the end (practice: after-end), back to any decision before the final one is refused…
  assert.equal(canRevisit(run, 2), false, 'escalade is final');
  assert.equal(canRevisit(run, 0), false, 'nor before it');
  // Starting over is a new run, not a revisit: it stays once the dialogue has ended.
  assert.equal(canRestart(run), true, 'a final decision does not stop « Recommencer » after the end');
  const again = restart(run);
  assert.equal(again.walk.node, 'premiere-question');
  assert.deepEqual(again.progress.scored, ['premiere-question.b~', 'premiere-question.a', 'ticket.a', 'escalade.a'], 'the scored run is kept');
  // Before the end (anytime), a final decision closed on the path forbids starting over.
  const finalTicket = (structuredClone(props.nodes) as { id: string; final?: boolean }[]).map(({ final, ...node }) => (node.id === 'ticket' ? { ...node, final: true } : node));
  let midway = openDialogue(dialogueData({ ...structuredClone(props), revisit: 'anytime', nodes: finalTicket }));
  midway = choose(midway, 'a');
  assert.equal(canRestart(midway), true, 'nothing final closed yet');
  midway = choose(midway, 'a');
  assert.equal(canRestart(midway), false, 'ticket is final and closed, the dialogue goes on');
  midway = choose(midway, 'a');
  assert.equal(midway.walk.status, 'ended');
  assert.equal(canRestart(midway), true);
  // …so without final decisions the learner explores, and the scored run stays.
  const open = dialogueData({ ...structuredClone(props), nodes: (structuredClone(props.nodes) as { final?: boolean }[]).map(({ final, ...node }) => node) });
  let explore = openDialogue(open);
  for (const option of ['a', 'a', 'a']) explore = choose(explore, option);
  explore = revisit(explore, 1);
  assert.deepEqual(explore.progress.scored, ['premiere-question.a', 'ticket.a', 'escalade.a'], 'the scored run is kept apart');
  assert.deepEqual(explore.progress.path, ['premiere-question.a']);
  explore = choose(choose(explore, 'c'), 'b');
  assert.equal(scoredResult(explore).score, 1, 'unchanged by the exploration');
  assert.deepEqual(explore.progress.endings, ['maitrise', 'a-revoir'], 'both endings found');
  assert.equal(scoredResult(explore).endingsFound, 2);
  assert.deepEqual(explore.progress.explored, ['premiere-question.a', 'ticket.a', 'ticket.c', 'escalade.a', 'escalade.b']);
  explore = restart(explore);
  assert.equal(explore.walk.node, 'premiere-question');
  // Event conditions read the scored run.
  assert.equal(eventConditionHolds(explore, { dialogue: 'x', ending: 'maitrise' }), true);
  assert.equal(eventConditionHolds(explore, { dialogue: 'x', chosen: 'ticket.c' }), false);
  assert.equal(eventConditionHolds(explore, { dialogue: 'x', done: true }), true);
  assert.equal(eventConditionHolds(explore, { dialogue: 'x', score: { op: 'gte', value: 80 } }), true);
  // Before the end, going back (anytime) keeps each decision's first choice.
  const anytime = dialogueData({ ...structuredClone(props), revisit: 'anytime' });
  let free = choose(openDialogue(anytime), 'b');
  free = revisit(free, 0);
  free = choose(free, 'a');
  assert.deepEqual(free.progress.path, ['premiere-question.b~', 'premiere-question.a']);
  assert.equal(scoredResult(free).decisions[0].option, 'b');
  assert.throws(() => revisit(openDialogue(data), 0), /cannot be revisited/);
});

test('jumps from the screen, the screen\'s presentation and the characters\' faces on replay', () => {
  const data = marc();
  let run = openDialogue(data);
  run = jump(run, 'ticket');
  run = jump(run, 'escalade');
  assert.deepEqual(run.progress.path, ['>escalade'], 'two jumps in a row: the second replaces the first');
  assert.equal(run.walk.node, 'escalade');
  const walk = replay(data, ['premiere-question.a']);
  assert.deepEqual(presentationOf(walk), { blocks: { 'plan-etage': true }, props: {}, step: 0 }, 'the cue on « étage » showed the plan');
  assert.deepEqual(expressionsOf(walk), { marc: 'soulage', leila: 'concentree' });
});

test('the saved state: one compact string, decoded back, its worst case', () => {
  const data = dialogueData(structuredClone(props), { keys: { choices: { 'premiere-question.a': '1a', 'premiere-question.b': '1b', 'premiere-question.c': '1c', 'ticket.a': '1d', 'ticket.b': '1e', 'ticket.c': '1f', 'escalade.a': '1g', 'escalade.b': '1h' }, bits: { 'premiere-question.a': 0, 'premiere-question.b': 1, 'premiere-question.c': 2, 'ticket.a': 3, 'ticket.b': 4, 'ticket.c': 5, 'escalade.a': 6, 'escalade.b': 7 }, endings: { maitrise: 0, 'a-revoir': 1 } } });
  const progress = { path: ['premiere-question.b~', 'premiere-question.a', '>escalade'], scored: ['premiere-question.a', 'ticket.a', 'escalade.a'], explored: ['premiere-question.a', 'premiere-question.b', 'escalade.b'], endings: ['maitrise'] };
  const text = encodeDialogueProgress(progress, data.keys);
  assert.equal(text, '1b~.1a.>escalade|1a.1d.1g|DC|B');
  assert.deepEqual(decodeDialogueProgress(text, data.keys), progress);
  assert.equal(encodeDialogueProgress({ path: ['premiere-question.a'], scored: null, explored: [], endings: [] }, data.keys), '1a');
  assert.equal(encodeDialogueProgress({ path: [], scored: [], explored: [], endings: [] }, data.keys), '|-');
  assert.deepEqual(decodeDialogueProgress('|-', data.keys).scored, []);
  // A key no option has any more stops the replay there.
  assert.deepEqual(decodeDialogueProgress('1a.zz.1d', data.keys).path, ['premiere-question.a', '?zz', 'ticket.a']);
  assert.equal(openDialogue(data, decodeDialogueProgress('1a.zz.1d', data.keys)).walk.node, 'ticket');
  assert.deepEqual(decodeDialogueProgress('', data.keys), { path: [], scored: null, explored: [], endings: [] });
  // The worst case: the longest path the graph allows, its retries, a jump before each decision.
  const worst = worstCaseDialogue(data);
  assert.ok(worst.length > text.length);
  assert.ok(worst.length < 400, `${worst.length} characters`);
  const loop = dialogueData({ title: 'L', nodes: [{ id: 'a', options: [{ id: 'x', text: 'x' }], next: 'a' }], }, { keys: { choices: { 'a.x': '9' }, bits: { 'a.x': 0 }, endings: {} } });
  assert.ok(worstCaseDialogue(loop).length >= MAX_DECISIONS * 3, 'a loop: the decisions cap');
});

test('the course: lock keys, compiled data, a valid fixture, rename keeps the keys', async () => {
  const dir = courseWithDialogue();
  const project = loadProjectFromDir(dir);
  const entities = statefulEntities(project);
  for (const entity of ['dialogue:appel-marc', 'choice:appel-marc#premiere-question.a', 'choice:appel-marc#escalade.b', 'ending:appel-marc#maitrise']) assert.ok(entities.includes(entity), entity);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  const data = compileCourseData(project, keys, { buildId: 'test' });
  const block = data.screens.find((screen) => screen.id === 'appel')!.blocks.find((candidate) => candidate.id === 'appel-marc') as DialogueBlock;
  assert.equal(block.behavior, 'dialogue');
  assert.equal(block.key, keys['dialogue:appel-marc']);
  assert.equal(block.props.keys.choices['premiere-question.a'], keys['choice:appel-marc#premiere-question.a']);
  assert.deepEqual(Object.values(block.props.keys.bits).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(block.props.nodes[0].lines[0].text, 'Bonjour… plus rien ne marche au deuxième étage : ni l\'imprimante, ni le partage de fichiers.', 'stage directions left out of what learners read');
  assert.match(block.props.nodes[1].options[0].feedbackHtml ?? '', /^<p>Bon réflexe/);
  assert.equal(block.props.revisit, 'after-end', 'the mode\'s default resolved');
  assert.equal(block.props.maxPoints, 30);
  assert.deepEqual(Object.keys(block.props.speakers), ['leila', 'marc']);
  assert.equal(block.props.speakers.leila.look?.svg, 'assets/personnages/leila.svg');
  assert.match(block.html ?? '', /<section class="t-dialogue t-dialogue--messaging" data-t-group aria-label="L'appel de Marc">/);
  assert.match(block.html ?? '', /data-t-log/);
  const result = validateDir(dir);
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`), []);
  assert.deepEqual(codes(result.diagnostics).filter((code) => code.includes('DIALOGUE')), []);
  // Renaming the block carries its keys and its references.
  const lock = assignKeys(project, readLock(project));
  fs.writeFileSync(path.join(dir, 'elabora.lock.json'), JSON.stringify(lock.lock, null, 2));
  const before = lock.keys['choice:appel-marc#ticket.b'];
  await rename(dir, { from: 'appel-marc', to: 'appel-client' });
  const after = readJSON(dir, 'elabora.lock.json').keys;
  assert.equal(after['choice:appel-client#ticket.b'], before);
  assert.equal(readJSON(dir, 'screens/appel.json').events[0].on.target, 'appel-client');
});

test('validation: every dialogue code, with its place', () => {
  const dir = courseWithDialogue({
    id: 'bad', type: 'dialogue', props: {
      title: 'Mauvais', learner: 'nobody', mode: 'practice', revisit: 'retry', scoring: 'quality', start: 'nowhere',
      vars: [{ id: 'v', default: 0 }, { id: 'v', default: 1 }],
      nodes: [
        { id: 'a', lines: [
          { id: 'x1', speaker: 'ghost', text: 'Bonjour' },
          { id: 'x2', speaker: 'leila', expression: 'furieuse', text: 'Salut tout le monde.', cues: [{ at: { word: 'ailleurs' }, gesture: 'danser' }, { at: { line: 'x1' }, gesture: 'saluer' }, { at: { word: 'Salut' }, do: [{ type: 'set-variable', variable: 'bonsReflexes', value: 1 }, { type: 'show-block', block: 'nope' }] }] },
          { id: 'x2', text: 'x'.repeat(300) }
        ], options: [
          { id: 'o', text: 'Court', next: 'void' },
          { id: 'o', text: 'Une option beaucoup beaucoup plus longue que la première', quality: 'good', set: { w: 1 }, add: { v: 'x' }, if: [{ chosen: 'a.zz' }, { seen: 'zz' }, { variable: 'nope', op: 'eq', value: 1 }] },
          { id: 'p', text: 'P', quality: 'ok' }, { id: 'q', text: 'Q', quality: 'ok' }, { id: 'r', text: 'R', quality: 'ok' }
        ], end: 'missing' },
        { id: 'a', next: [{ if: [{ var: 'v', op: 'gt', value: 0 }], go: 'b' }] },
        { id: 'b', lines: [{ id: 'y', text: 'b' }], next: 'c' },
        { id: 'c', lines: [{ id: 'z', text: 'c' }], next: 'b' },
        { id: 'orphan', lines: [{ id: 'w', text: 'w' }], end: true },
        { id: 't1', options: [{ id: 'a', text: 'A', quality: 'good', next: 't2' }, { id: 'b', text: 'B', quality: 'bad', next: 't3' }] },
        { id: 't2', options: [{ id: 'a', text: 'A', quality: 'good', next: 't4' }, { id: 'b', text: 'B', quality: 'bad', next: 't5' }] },
        { id: 't3', end: true },
        { id: 't4', options: [{ id: 'a', text: 'A', quality: 'good', next: 't6' }, { id: 'b', text: 'B', quality: 'bad', next: 't7' }] },
        { id: 't5', end: true },
        { id: 't6', options: [{ id: 'a', text: 'A', quality: 'good', next: 't8' }, { id: 'b', text: 'B', quality: 'bad', next: 't9' }] },
        { id: 't7', end: true }, { id: 't8', end: true }, { id: 't9', end: true },
        { id: 'loop', options: [{ id: 'a', text: 'Encore', quality: 'good', next: 'loop' }, { id: 'b', text: 'Sortir', quality: 'bad', end: true }] }
      ],
      endings: [{ id: 'e1', if: [{ score: { op: 'gte', value: 80 } }] }, { id: 'e1', if: [{ score: { op: 'lt', value: 40 } }] }]
    }
  });
  const screen = readJSON(dir, 'screens/appel.json');
  screen.narration = { lines: [{ id: 'y', text: 'Une ligne de narration.' }] };
  screen.blocks[0].props.nodes[0].lines.push({ id: 'jump', text: 'saut' });
  screen.events.push({ id: 'saut', on: { type: 'screen.enter' }, do: [{ type: 'goto-dialogue', block: 'bad', node: 't1' }, { type: 'goto-dialogue', block: 'bad', node: 'loop' }, { type: 'goto-dialogue', block: 'bad', node: 'b' }] });
  writeJSON(dir, 'screens/appel.json', screen);
  const course = readJSON(dir, 'course.json');
  course.speakers[1].look = { svg: 'personnages/leila.svg' };
  course.speakers[0].color = 'color.nope';
  writeJSON(dir, 'course.json', course);
  const found = validateDir(dir).diagnostics.filter((d) => d.target === 'bad' || d.code.startsWith('E_DIALOGUE') || d.code.startsWith('W_DIALOGUE') || d.target === 'marc');
  const byCode = (code: string) => found.filter((d) => d.code === code);
  for (const code of ['E_DIALOGUE_TARGET', 'E_DIALOGUE_DUPLICATE_ID', 'E_DIALOGUE_DEAD_END', 'E_DIALOGUE_SPEAKER', 'E_DIALOGUE_CONDITION', 'E_DIALOGUE_VAR', 'E_DIALOGUE_ACTION', 'E_DIALOGUE_CUE', 'E_ACTION_TARGET', 'E_UNKNOWN_REFERENCE',
    'W_DIALOGUE_UNREACHABLE', 'W_DIALOGUE_LOOP', 'W_DIALOGUE_OPTIONS_MANY', 'W_DIALOGUE_OPTIONS_UNEVEN', 'W_DIALOGUE_LINE_LONG', 'W_DIALOGUE_SCORE_MISSING', 'W_DIALOGUE_ENDINGS_UNCOVERED', 'W_DIALOGUE_TREE', 'W_DIALOGUE_NO_RETURN', 'W_DIALOGUE_LOOK']) {
    assert.ok(byCode(code).length, `${code}: ${found.map((d) => d.code).join(', ')}`);
  }
  assert.ok(byCode('E_DIALOGUE_TARGET').some((d) => d.path === '/blocks/0/props/start'));
  assert.ok(byCode('E_DIALOGUE_TARGET').some((d) => d.path === '/blocks/0/props/nodes/0/end'));
  // A line id taken twice in the screen has one code, whatever holds the lines (D61, D62).
  const lineDuplicates = validateDir(dir).diagnostics.filter((d) => d.code === 'E_NARRATION_LINE_DUPLICATE');
  assert.ok(lineDuplicates.some((d) => d.path === '/blocks/0/props/nodes/2/lines/0/id' && /lines "y": in the screen's narration and in dialogue "bad"/.test(d.message)), JSON.stringify(lineDuplicates));
  assert.ok(lineDuplicates.some((d) => d.path === '/blocks/0/props/nodes/0/lines/2/id'), 'a narration of the dialogue that takes the id of a voiced line');
  assert.ok(!byCode('E_DIALOGUE_DUPLICATE_ID').some((d) => /line/.test(d.message)));
  assert.ok(byCode('E_DIALOGUE_DUPLICATE_ID').some((d) => d.path === '/blocks/0/props/nodes/1/id'));
  assert.ok(byCode('E_DIALOGUE_CUE').some((d) => d.path === '/blocks/0/props/nodes/0/lines/1/cues/0/at/word'));
  assert.ok(byCode('E_DIALOGUE_CUE').some((d) => d.path === '/blocks/0/props/nodes/0/lines/1/cues/1/at/line'));
  assert.ok(byCode('W_DIALOGUE_LOOK').some((d) => /no expression "furieuse" \(expressions: neutre, souriante, concentree\)/.test(d.message)));
  assert.ok(byCode('W_DIALOGUE_LOOK').some((d) => /no gesture "danser"/.test(d.message)));
  assert.ok(byCode('W_DIALOGUE_LOOP').some((d) => /b, c/.test(d.message)));
  assert.ok(byCode('W_DIALOGUE_ENDINGS_UNCOVERED').some((d) => /from 40 to 80/.test(d.message)));
  assert.ok(byCode('W_DIALOGUE_UNREACHABLE').some((d) => /node "orphan"/.test(d.message)));
  assert.ok(byCode('E_UNKNOWN_REFERENCE').some((d) => d.path === '/speakers/0/color'));
  // The cap: a loop the learner may take forever.
  const capped = { id: 'boucle', type: 'dialogue', props: { title: 'Boucle', nodes: [{ id: 'a', lines: [{ id: 'q', speaker: 'marc', text: 'Encore ?' }], options: [{ id: 'x', text: 'Oui, encore une fois' }, { id: 'y', text: 'Non, merci beaucoup', end: true }], next: 'a' }] } };
  assert.ok(explorePaths(dialogueData(capped.props), { limit: 5 }).capped);
  assert.ok(codes(validateDir(courseWithDialogue(capped)).diagnostics).includes('W_DIALOGUE_DECISION_CAP'));
});

test('events: dialogue triggers, conditions and actions are checked, and layers shown by a dialogue are reached', () => {
  const dir = courseWithDialogue();
  const screen = readJSON(dir, 'screens/appel.json');
  screen.layers = [{ id: 'rappel', title: 'Rappel', blocks: [{ id: 'rappel-texte', type: 'text', props: { markdown: 'Jamais de mot de passe.' } }] }];
  screen.blocks[0].props.nodes[1].options[2].do = [{ type: 'show-layer', layer: 'rappel' }];
  screen.events.push(
    { id: 'e1', on: { type: 'dialogue.chosen', target: 'appel-marc', node: 'ticket', option: 'z' }, do: [{ type: 'complete-screen' }] },
    { id: 'e2', on: { type: 'dialogue.ended', target: 'plan-etage' }, do: [{ type: 'complete-screen' }] },
    { id: 'e3', on: { type: 'dialogue.line', target: 'appel-marc', line: 'm9' }, do: [{ type: 'complete-screen' }] },
    { id: 'e4', on: { type: 'screen.enter' }, if: [{ dialogue: 'appel-marc', ending: 'jamais' }], do: [{ type: 'goto-dialogue', block: 'appel-marc', node: 'nulle-part' }] },
    { id: 'e5', on: { type: 'screen.enter' }, if: [{ dialogue: 'plan-etage', done: true }], do: [{ type: 'restart-dialogue', block: 'plan-etage' }] },
    { id: 'e6', on: { type: 'dialogue.chosen', target: 'appel-marc', node: 'ticket', option: 'a' }, if: [{ dialogue: 'appel-marc', chosen: 'premiere-question.c' }], do: [{ type: 'start-dialogue', block: 'appel-marc' }] }
  );
  writeJSON(dir, 'screens/appel.json', screen);
  const found = validateDir(dir).diagnostics.filter((d) => d.file === 'screens/appel.json');
  const at = (path: string) => found.filter((d) => d.path === path).map((d) => d.code);
  assert.deepEqual(at('/events/1/on/option'), ['E_EVENT_TARGET']);
  assert.deepEqual(at('/events/2/on/target'), ['E_EVENT_TARGET']);
  assert.deepEqual(at('/events/3/on/line'), ['E_EVENT_TARGET']);
  assert.deepEqual(at('/events/4/if/0/ending'), ['E_UNKNOWN_REFERENCE']);
  assert.deepEqual(at('/events/4/do/0/node'), ['E_ACTION_TARGET']);
  assert.deepEqual(at('/events/5/if/0/dialogue'), ['E_UNKNOWN_REFERENCE']);
  assert.deepEqual(at('/events/5/do/0/block'), ['E_ACTION_TARGET']);
  assert.deepEqual(found.filter((d) => d.path?.startsWith('/events/6')), [], 'a valid event');
  assert.ok(!found.some((d) => d.code === 'W_UNREACHABLE_LAYER'), 'the dialogue shows the layer');
});

test('show, play and paths: the script, a path and every path, as agents read them', () => {
  const dir = courseWithDialogue();
  const project = loadProjectFromDir(dir);
  const ref = findDialogue(project, 'appel-marc')!;
  const text = formatScript(dialogueScript(projectDialogue(project, ref), { id: ref.id, screen: ref.screen }));
  assert.match(text, /^L'appel de Marc {2}\(dialogue appel-marc, screen appel\)\npractice · revisit after-end · feedback now · scoring quality · style messaging · objective OBJ-2 · the learner plays Leïla/);
  assert.match(text, /\n {3}Marc \(inquiet, au téléphone\): Bonjour… /);
  assert.match(text, /\n {5}↳ at « étage » \(end\): show-block plan-etage/);
  assert.match(text, /\n {3}C \[c\] « Pouvez-vous me donner votre mot de passe pour vérifier votre session \? » \(button: Demander le mot de passe\) {2}bad, −10, retry, confiance −1\n/);
  assert.match(text, /\n {6}then the same options again\n/);
  assert.match(text, /\n {3}\(narration\) Leïla ouvre un ticket/);
  assert.match(text, /\nEndings\n {3}maitrise « Maîtrisé » {2}if score ≥ 80/);
  assert.equal(formatScript(dialogueScript(projectDialogue(project, ref), { id: ref.id, screen: ref.screen })), text, 'stable');
  const played = playDialogue(project, ref, ['c', 'a', 'a', 'a']);
  assert.equal(played.ok, true);
  assert.equal(played.ending?.id, 'a-revoir');
  assert.equal(played.score, 66.7);
  assert.equal(played.points, 10);
  assert.deepEqual(played.decisions.map((decision) => [decision.node, decision.letter, decision.kept]), [['premiere-question', 'C', 'a'], ['ticket', 'A', null], ['escalade', 'A', null]]);
  assert.ok(played.seconds > 30 && played.estimated);
  // The steps say what they are, for a reader that words them itself (the app's « Jouer un chemin »).
  assert.deepEqual(played.steps.filter((step) => step.kind === 'choice').map((step) => [step.node, step.option]), [['premiere-question', 'c'], ['premiere-question', 'a'], ['ticket', 'a'], ['escalade', 'a']]);
  assert.deepEqual(played.steps.find((step) => step.kind === 'line' && step.option === 'c'), { kind: 'line', node: 'premiere-question', line: 'm3', role: 'character', option: 'c', text: 'Marc: Euh… c\'est « Soleil2026 ». C\'est normal de le dire ?' });
  assert.equal(played.steps.at(-1)?.ending, 'a-revoir');
  assert.equal(played.waiting, null);
  const waiting = playDialogue(project, ref, ['b']);
  assert.equal(waiting.waiting, 'ticket');
  assert.deepEqual(waiting.offered, ['a', 'b', 'c']);
  const refused = playDialogue(project, ref, ['b', 'z']);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.offered, ['a', 'b', 'c']);
  assert.match(refused.error ?? '', /Choice 2 « z » is not offered at ticket/);
  const paths = dialoguePaths(project, ref);
  assert.equal(paths.count, 24);
  assert.equal(paths.complete, true);
  assert.equal(paths.maxScore, 100);
  assert.equal(paths.minScore, 0);
  assert.deepEqual(paths.endings, [{ id: 'maitrise', title: 'Maîtrisé', paths: 3 }, { id: 'a-revoir', title: 'À revoir', paths: 21 }]);
  assert.deepEqual(paths.unreachedNodes, []);
  assert.match(formatPaths(paths), /^appel-marc \(screen appel\) — 24 paths, 3 decisions at most\n/);
});

test('the map: placed by layers, deterministic, dashed edges going back', () => {
  const data = marc();
  const map = dialogueMap(data);
  assert.deepEqual(map, dialogueMap(marc()), 'deterministic');
  const rank = (id: string) => map.nodes.find((node) => node.id === id)!.rank;
  // The branch through « Conséquence B » comes back to the ticket forward: only the retry goes back.
  assert.deepEqual(['appel', 'premiere-question', 'routeur-redemarre', 'ticket', 'escalade', 'bilan', 'end:maitrise', 'end:a-revoir'].map(rank), [0, 1, 2, 3, 4, 5, 6, 6]);
  assert.deepEqual(map.edges.filter((edge) => edge.back).map((edge) => `${edge.from}>${edge.to}`), ['premiere-question>premiere-question']);
  const retry = map.edges.find((edge) => edge.from === 'premiere-question' && edge.option === 'c')!;
  assert.equal(retry.to, 'premiere-question');
  assert.equal(retry.back, true);
  assert.equal(map.edges.filter((edge) => edge.to.startsWith('end:')).length, 2, 'end: true reaches each ending its conditions choose');
  assert.equal(map.edges.find((edge) => edge.to === 'end:maitrise')!.label, 'score ≥ 80');
  for (const node of map.nodes) for (const other of map.nodes) if (node !== other && node.rank === other.rank) assert.ok(node.y + node.height <= other.y || other.y + other.height <= node.y, `${node.id} and ${other.id} overlap`);
  const svg = dialogueMapSvg(map, { title: 'Carte' });
  assert.match(svg, /^<svg class="dm" xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /class="dm-edge dm-back"/);
  const loop = dialogue([{ id: 'a', options: [{ id: 'x', text: 'x', next: 'b' }] }, { id: 'b', lines: [{ id: 'l', text: 'b' }], next: 'a' }]);
  assert.ok(dialogueMap(loop).edges.some((edge) => edge.from === 'b' && edge.to === 'a' && edge.back));
});

test('the map going down, for a portrait page: rows by layer, the ways from the bottom with their letters', () => {
  const across = dialogueMap(marc());
  const map = dialogueMap(marc(), { direction: 'down' });
  assert.equal(map.direction, 'down');
  assert.deepEqual(map.nodes.map((node) => [node.id, node.rank]), across.nodes.map((node) => [node.id, node.rank]), 'the same layers');
  // Each layer a row below the one before; a row's nodes side by side, never overlapping.
  for (const node of map.nodes) for (const other of map.nodes) {
    if (other.rank === node.rank + 1) assert.ok(other.y >= node.y + node.height, `${other.id} below ${node.id}`);
    if (node !== other && node.rank === other.rank) assert.ok(node.x + node.width <= other.x || other.x + other.width <= node.x, `${node.id} and ${other.id} overlap`);
  }
  assert.ok(map.height > map.width, 'taller than wide');
  // An option's own way leaves the node's bottom, its letter beside it (the common way from the middle,
  // without); the retry goes back on the right.
  const question = map.nodes.find((node) => node.id === 'premiere-question')!;
  const b = map.edges.find((edge) => edge.from === 'premiere-question' && edge.option === 'b')!;
  assert.equal(b.letter?.text, 'B');
  assert.match(b.d, new RegExp(`^M \\d+ ${question.y + question.height} C`));
  const retry = map.edges.find((edge) => edge.from === 'premiere-question' && edge.option === 'c')!;
  assert.equal(retry.back, true);
  assert.equal(retry.letter, undefined);
  assert.match(dialogueMapSvg(map, { title: 'Carte' }), /<text class="dm-label dm-way" x="\d+" y="\d+">B<\/text>/);
  // The client's page takes the map that reads best on A4: Marc's call (7 layers) goes down.
  assert.match(dialogueDocumentHtml(marc(), { id: 'appel-marc', screen: 'appel', language: 'fr' }), /class="dm-label dm-way"/);
  const short = dialogue([{ id: 'a', options: [{ id: 'x', text: 'x' }, { id: 'y', text: 'y' }] }]);
  assert.doesNotMatch(dialogueDocumentHtml(short, { id: 'court', screen: 'appel', language: 'fr' }), /class="dm-label dm-way"/, 'a short one keeps going right');
});

test('the export for the client: the map then the script, in the course\'s language, as one page', async () => {
  const dir = courseWithDialogue();
  const html = dialogueDocumentHtml(marc(), { id: 'appel-marc', screen: 'appel', course: 'Diagnostic réseau', screenTitle: 'Signaler l\'incident', language: 'fr' });
  assert.match(html, /^<!doctype html>\n<html lang="fr">/);
  assert.ok(html.indexOf('<h2>Carte du dialogue</h2>') < html.indexOf('<h2>Script</h2>'), 'the map first');
  assert.match(html, /<span class="quality q-bad">mauvaise<\/span>/);
  assert.match(html, /<p class="then">puis les mêmes options à nouveau<\/p>/);
  assert.match(html, /<span class="label">Note du formateur<\/span><p>Ne demandez jamais/);
  assert.doesNotMatch(html, /<script/);
  const result = await exportDialogue(dir, { block: 'appel-marc', to: 'html' });
  assert.equal(path.relative(dir, result.file), path.join('dist', `${readJSON(dir, 'course.json').id}-appel-marc.html`));
  const written = fs.readFileSync(result.file, 'utf8');
  assert.match(written, /@font-face \{ font-family: "Inter"/, 'its fonts inline');
  assert.equal((await exportDialogue(dir, { block: 'appel-marc', to: 'html' })).bytes, result.bytes, 'the same page every time');
  await assert.rejects(exportDialogue(dir, { block: 'nope', to: 'html' }), /No dialogue block "nope"/);
});

test('translation units, LESSON.md and the project view carry the dialogue\'s words', () => {
  const dir = courseWithDialogue();
  const project = loadProjectFromDir(dir);
  const units = new Map(extractUnits(project).map((unit) => [unit.id, unit]));
  for (const id of ['block.appel-marc.title', 'block.appel-marc.nodes.appel.lines.m1.text', 'block.appel-marc.nodes.premiere-question.prompt', 'block.appel-marc.nodes.premiere-question.options.a.text', 'block.appel-marc.nodes.premiere-question.options.a.label', 'block.appel-marc.nodes.premiere-question.options.a.reply.m2.text', 'block.appel-marc.endings.maitrise.title']) assert.ok(units.has(id), id);
  assert.equal(units.get('block.appel-marc.nodes.premiere-question.options.a.feedback')?.format, 'markdown');
  assert.ok(!units.has('block.appel-marc.nodes.appel.title'), 'a node\'s title is for authors only');
  const lesson = lessonMdExport(project);
  const page = [...lesson.output.values()].find((text) => text.includes('L\'appel de Marc')) ?? '';
  assert.match(page, /\*\*Marc\*\* \(inquiet, au téléphone\) : Bonjour…/);
  assert.ok(lesson.losses.some((loss) => loss.block === 'appel-marc' && /dialogue \(exported as its script/.test(loss.loss)));
});

test('set_dialogue_node writes one node whole, remove_dialogue_node removes one', () => {
  const dir = courseWithDialogue();
  const added = setDialogueNode(dir, { block: 'appel-marc', after: 'ticket', node: { id: 'rappel', lines: [{ id: 'r1', speaker: 'marc', text: 'Je reste joignable.' }] } });
  assert.equal(added.ok, true);
  const nodes = () => readJSON(dir, 'screens/appel.json').blocks[0].props.nodes.map((node: { id: string }) => node.id);
  assert.deepEqual(nodes(), ['appel', 'premiere-question', 'routeur-redemarre', 'ticket', 'rappel', 'escalade', 'bilan']);
  setDialogueNode(dir, { block: 'appel-marc', node: { id: 'rappel', lines: [{ id: 'r1', speaker: 'marc', text: 'Je reste joignable, merci.' }] } });
  assert.equal(readJSON(dir, 'screens/appel.json').blocks[0].props.nodes[4].lines[0].text, 'Je reste joignable, merci.', 'replaced in place');
  removeDialogueNode(dir, { block: 'appel-marc', node: 'routeur-redemarre' });
  assert.ok(!nodes().includes('routeur-redemarre'));
  assert.ok(codes(validateDir(dir).diagnostics).includes('E_DIALOGUE_TARGET'), 'option b still goes there');
  assert.throws(() => setDialogueNode(dir, { block: 'plan-etage', node: { id: 'x' } }), /not a dialogue/);
});

test('Rise: a scenario block becomes a dialogue, its answers options with where they go', () => {
  const lesson = (items: unknown[]) => ({ course: { title: 'Rise', lessons: [{ id: 'l1', type: 'blocks', title: 'Scénario', items: [{ id: 'b1', type: 'interactive', family: 'interactive', variant: 'scenario', title: 'Appel client', items }] }] } });
  const source = readRise(lesson([
    { id: 'sc1', title: 'Accueil', character: { name: 'Marc' }, background: { media: { image: { key: 'bg.jpg' } } }, slides: [
      { id: 'c1', type: 'dialogue', description: '<p>Bonjour, plus rien ne marche.</p>', sceneDescription: 'Marc appelle le support.', characterPose: 'worried', responses: [
        { id: 'r1', description: '<p>Depuis quand ?</p>', feedback: '<p>Bon réflexe.</p>', destination: { type: 'slide', id: 'c2' }, correctness: 'correct' },
        { id: 'r2', description: '<p>Votre mot de passe ?</p>', feedback: '<p>Jamais.</p>', destination: 'retry', correctness: 'incorrect' },
        { id: 'r3', description: '<p>Raccrocher</p>', destination: { type: 'end' } }
      ] },
      { id: 'c2', type: 'text', description: '<p>Depuis 8 h 52.</p>' }
    ] },
    { id: 'sc2', title: 'Suite', character: { name: 'Leïla' }, slides: [{ id: 'c3', type: 'dialogue', description: '<p>Je note.</p>', responses: [{ id: 'r4', description: '<p>Merci</p>', destination: { type: 'end' } }] }] }
  ]), { has: () => true });
  const converted = convertCourse(source, { language: 'fr' });
  const course = JSON.parse(converted.files.get('course.json')!);
  assert.deepEqual(course.speakers, [{ id: 'marc', name: 'Marc' }, { id: 'leila', name: 'Leïla' }]);
  const screen = JSON.parse([...converted.files].find(([file]) => file.startsWith('screens/'))![1]);
  const block = screen.blocks.find((candidate: { type: string }) => candidate.type === 'dialogue');
  assert.ok(block, JSON.stringify(screen.blocks));
  assert.equal(block.props.title, 'Appel client');
  assert.deepEqual(block.props.nodes.map((node: { id: string }) => node.id), ['n1', 'n2', 'n3']);
  assert.deepEqual(block.props.nodes[0].lines, [{ id: 'l1', text: 'Marc appelle le support.' }, { id: 'l2', speaker: 'marc', text: 'Bonjour, plus rien ne marche.' }]);
  assert.deepEqual(block.props.nodes[0].options, [
    { id: 'a', text: 'Depuis quand ?', quality: 'good', feedback: 'Bon réflexe.', next: 'n2' },
    { id: 'b', text: 'Votre mot de passe ?', quality: 'bad', feedback: 'Jamais.', retry: true },
    { id: 'c', text: 'Raccrocher', end: true }
  ]);
  assert.match(block.note, /Poses du personnage/);
  assert.ok(converted.report.losses.some((loss) => /Arrière-plans de scène/.test(loss.feature)));
  // The imported module validates: its dialogue walks.
  const data = dialogueData(block.props, { course });
  assert.equal(replay(data, ['n1.a']).node, 'n3', 'the text content goes on to the next scene');
});

test('a dialogue\'s worst case takes a small share of the suspend data', () => {
  assert.ok(worstCaseDialogue(marc()).length < 4096 / 8, 'under an eighth of SCORM 1.2\'s 4096 characters');
});

test('the command line: show, play (exit code 1 on a choice not offered), paths, export', () => {
  const dir = courseWithDialogue();
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { encoding: 'utf8' });
  const show = run('dialogue', 'show', dir, 'appel-marc');
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /^L'appel de Marc {2}\(dialogue appel-marc, screen appel\)/);
  const played = run('dialogue', 'play', dir, 'appel-marc', '--choose', 'a,a,a', '--json');
  assert.equal(played.status, 0, played.stderr);
  assert.equal(JSON.parse(played.stdout).ending.id, 'maitrise');
  const refused = run('dialogue', 'play', dir, 'appel-marc', '--choose', 'z');
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /✘ Choice 1 « z » is not offered at premiere-question/);
  assert.equal(run('dialogue', 'paths', dir, 'appel-marc').status, 0);
  const exported = run('dialogue', 'export', dir, 'appel-marc', '--to', 'html', '--json');
  assert.equal(exported.status, 0, exported.stderr);
  assert.ok(fs.existsSync(JSON.parse(exported.stdout).file));
  assert.equal(run('dialogue', 'show', dir, 'nope').status, 1);
  assert.equal(run('dialogue', 'export', dir, 'appel-marc').status, 2, '--to is required');
});
