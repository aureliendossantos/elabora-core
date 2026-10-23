import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyExample, readJSON, writeJSON, codes } from '../helpers.ts';
import { narrate, voice, hasFfmpeg } from '../narration.ts';
import { exportTranslation, translationStatus, buildTranslation, translationFile } from '@elabora/node/translate';
import { translationTable, translatedCourse } from '@elabora/core/i18n/translate';
import type { Screen } from '@elabora/format';
import * as edit from '@elabora/node/edit';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { narrationWords, findPhrase, phraseCount, lineWordTimes } from '@elabora/core/narration/words';
import { layoutTimeline, screenTimeline, blockTimings, anchorTime } from '@elabora/core/narration/timeline';
import { parseAnchor, formatAnchor, resolveAt } from '@elabora/core/narration/anchor-text';
import { narrationSidecarPath, screenTiming, narrationLines } from '@elabora/core/narration/narration';
import { STEP_GAP } from '@elabora/core/narration/timing';
import { timelineView, screenAt, timelineMarks } from '@elabora/core/narration/view';
import { timelineReport, formatTimeline } from '@elabora/core/narration/report';
import { renderScreen } from '@elabora/core/render/screen';
import type { BlockData } from '@elabora/player/course-data';

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const SPEAKERS = [{ id: 'narratrice', name: 'Narratrice' }, { id: 'marc', name: 'Marc' }];

test('words: elisions are words, numbers and codes stay whole, punctuation is not a word', () => {
  const words = narrationWords("Bonjour… Plus rien ne marche au 2e étage : ni l'imprimante, ni le partage. 9 h 30, P-12, 3,5 % aujourd'hui", 'fr');
  assert.deepEqual(words.map((word) => word.text), ['Bonjour', 'Plus', 'rien', 'ne', 'marche', 'au', '2e', 'étage', 'ni', "l'", 'imprimante', 'ni', 'le', 'partage', '9', 'h', '30', 'P-12', '3,5', "aujourd'hui"]);
  assert.deepEqual(narrationWords("don't stop at the printer's tray", 'en').map((word) => word.text), ["don't", 'stop', 'at', 'the', "printer's", 'tray'], 'no elision in English');
  const line = narrationWords("Ni l'imprimante, ni l’Imprimante réseau.", 'fr');
  assert.deepEqual(findPhrase(line, 'imprimante', { language: 'fr' }), { index: 2, count: 1 });
  assert.deepEqual(findPhrase(line, 'imprimante', { occurrence: 2, language: 'fr' }), { index: 5, count: 1 }, 'case and apostrophes aside');
  assert.deepEqual(findPhrase(line, "l'imprimante réseau", { language: 'fr' }), { index: 4, count: 3 }, 'a few words');
  assert.equal(findPhrase(line, 'imprimante', { occurrence: 3, language: 'fr' }), null);
  assert.equal(phraseCount(line, 'ni', 'fr'), 2);
  assert.deepEqual(findPhrase(narrationWords("not the printer's tray", 'en'), 'printer', { language: 'en' }), { index: 2, count: 1 }, 'a possessive carries its word');
});

test('word times: aligned, followed through a changed text, estimated without', () => {
  const said = [{ text: 'Plus', start: 0.1, end: 0.3 }, { text: 'rien', start: 0.3, end: 0.5 }, { text: 'ne', start: 0.5, end: 0.6 }, { text: 'marche', start: 0.6, end: 1 }];
  assert.deepEqual(lineWordTimes('Plus rien ne marche.', 1.2, said, 'fr').map((word) => [word.text, word.start, !!word.estimated]), [['Plus', 0.1, false], ['rien', 0.3, false], ['ne', 0.5, false], ['marche', 0.6, false]]);
  // A word added: the others keep their times, the new one shares the gap.
  const changed = lineWordTimes('Plus rien du tout ne marche.', 1.2, said, 'fr');
  assert.deepEqual(changed.map((word) => word.text), ['Plus', 'rien', 'du', 'tout', 'ne', 'marche']);
  assert.ok(changed[2].estimated && changed[2].start >= 0.5 && changed[3].end <= 0.5 + 1e-9, JSON.stringify(changed));
  assert.equal(changed[5].start, 0.6);
  const estimated = lineWordTimes('Un deux trois.', 1.4, null, 'fr');
  assert.ok(estimated.every((word) => word.estimated) && estimated[0].start === 0 && estimated[2].end <= 1.4);
});

test('anchors as written on a command line, and as people read them', () => {
  assert.deepEqual(parseAnchor('l2:imprimante'), { line: 'l2', word: 'imprimante' });
  assert.deepEqual(parseAnchor('l2:imprimante:end'), { line: 'l2', edge: 'end', word: 'imprimante' });
  assert.deepEqual(parseAnchor('l2:imprimante#2'), { line: 'l2', occurrence: 2, word: 'imprimante' });
  assert.deepEqual(parseAnchor('l2:imprimante+0.3s'), { line: 'l2', offset: 0.3, word: 'imprimante' });
  assert.deepEqual(parseAnchor('l2:end-0.2s'), { line: 'l2', offset: -0.2, edge: 'end' });
  assert.deepEqual(parseAnchor('l2+0.5s'), { line: 'l2', offset: 0.5 });
  assert.deepEqual(parseAnchor('l2:P-12'), { line: 'l2', word: 'P-12' }, 'a word ending in digits stays a word');
  assert.deepEqual(parseAnchor('l3:mes collègues'), { line: 'l3', word: 'mes collègues' });
  assert.deepEqual(parseAnchor('1.5s@2'), { seconds: 1.5, step: 2 });
  assert.deepEqual(parseAnchor('step2:end'), { step: 2, edge: 'end' });
  assert.equal(parseAnchor('L2'), null);
  assert.equal(formatAnchor({ line: 'l2', word: 'imprimante', edge: 'end', offset: -0.2 }), 'end of l2 « imprimante » −0.2 s');
});

test('layout: moments anchored to words; an effect at the end of a step lengthens its stretch, never cut by the stop', () => {
  const lines = [
    { id: 'l1', step: 1, text: 'Plus rien ne marche.', duration: 2, words: [{ text: 'Plus', start: 0, end: 0.4 }, { text: 'rien', start: 0.4, end: 0.8 }, { text: 'ne', start: 0.8, end: 1 }, { text: 'marche', start: 1, end: 2 }] },
    { id: 'l2', step: 2, text: 'Ni l’imprimante.', duration: 1 }
  ];
  const layout = layoutTimeline({
    narrated: true, language: 'fr', steps: [1, 2], lines,
    moments: [
      { block: 'a', kind: 'in', step: 1, anchor: { line: 'l1', word: 'rien' }, effect: 'rise', duration: 0.5, path: '/blocks/0/timing/in' },
      { block: 'b', kind: 'in', step: 1, anchor: { line: 'l1', edge: 'end' }, effect: 'fade', duration: 0.6, path: '/blocks/1/timing/in' },
      { block: 'a', kind: 'out', step: 1, anchor: { line: 'l2', word: 'absent' }, effect: 'fade', duration: 0.4, path: '/blocks/0/timing/out' }
    ],
    cues: [{ event: 'e1', anchor: { line: 'l1', word: 'marche', offset: 0.1 }, path: '/events/0/on/at' }]
  });
  const timing = blockTimings(layout);
  assert.equal(timing.get('a')!.in!.at, 0.4);
  assert.equal(timing.get('b')!.in!.at, 2);
  assert.deepEqual(layout.segments[0], { step: 1, start: 0, end: 2.6 }, 'the fade at the end of l1 ends the stretch');
  assert.equal(layout.lines[1].start, 3, 'the next step comes after it, with its pause (at least STEP_GAP)');
  assert.ok(0.4 >= STEP_GAP);
  assert.deepEqual(layout.gaps, [0, 1, 0]);
  assert.equal(timing.get('a')!.out!.problem!.kind, 'word', 'a word the line does not say');
  assert.equal(timing.get('a')!.out!.at, layout.lines[1].start, 'it falls back to the start of its line');
  assert.equal(layout.cues[0].time, 1.1);
  // The silences a build wrote decide, and the measured durations.
  const built = layoutTimeline({ narrated: true, language: 'fr', steps: [1, 2], lines: lines.map((line) => ({ ...line, duration: line.duration + 0.01 })), gaps: layout.gaps });
  assert.equal(built.lines[1].start, 2.01 + 1);
});

test('layout without narration: seconds from a step\'s start, steps as long as their moments or their duration', () => {
  const layout = layoutTimeline({
    narrated: false, steps: [1, 2], lines: [], stepSeconds: new Map([[2, 4]]),
    moments: [
      { block: 'a', kind: 'in', step: 1, anchor: { seconds: 1 }, effect: 'fade', duration: 0.4, path: '' },
      { block: 'b', kind: 'in', step: 1, anchor: { seconds: 2.5 }, effect: 'zoom', duration: 0.4, path: '' },
      { block: 'c', kind: 'in', step: 2, anchor: { seconds: 0.5 }, effect: 'rise', duration: 0.5, path: '' },
      { block: 'd', kind: 'in', step: 2, anchor: { step: 2, edge: 'end' }, effect: 'fade', duration: 0.4, path: '' }
    ]
  });
  assert.deepEqual(layout.segments, [{ step: 1, start: 0, end: 2.9 }, { step: 2, start: 2.9, end: 7.3 }]);
  assert.equal(blockTimings(layout).get('c')!.in!.at, 3.4);
  assert.equal(blockTimings(layout).get('d')!.in!.at, 6.9);
  const seconds = layoutTimeline({ narrated: true, steps: [1], lines: [{ id: 'l1', step: 1, text: 'Un.', duration: 1 }], moments: [{ block: 'a', kind: 'in', step: 1, anchor: { seconds: 1 }, effect: 'fade', duration: 0.4, path: '' }] });
  assert.equal(seconds.moments[0].problem!.kind, 'seconds', 'a narrated screen anchors to its lines');
});

// The example's first screen, narrated, with timed blocks: l1 and l2 in step 1, l3 in step 2.
function timed({ words = true }: { words?: boolean } = {}) {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[2].step = 2;
  writeJSON(dir, 'screens/accueil.json', screen);
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', seconds: 2 },
    { id: 'l2', text: "Ni l'imprimante, ni le partage de fichiers ne marchent.", seconds: 3 },
    { id: 'l3', step: 2, speaker: 'marc', text: 'Ça bloque toute la comptabilité !', seconds: 1.5 }
  ], { speakers: SPEAKERS });
  if (words) {
    const sidecar = readJSON(dir, narrationSidecarPath('fr', 'accueil', 'l2'));
    sidecar.words = narrationWords("Ni l'imprimante, ni le partage de fichiers ne marchent.", 'fr').map((word, index) => ({ text: word.text, start: Math.round(index * 0.3 * 1000) / 1000, end: Math.round((index * 0.3 + 0.28) * 1000) / 1000 }));
    writeJSON(dir, narrationSidecarPath('fr', 'accueil', 'l2'), sidecar);
  }
  return dir;
}

test('set_block_timing: in and out as patches, null removes; the screen\'s timeline, report and course data follow', { skip: NO_FFMPEG }, async () => {
  const dir = timed();
  let result = await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l2', word: 'imprimante' }, effect: 'rise' } });
  assert.deepEqual(result.timing, { in: { at: { line: 'l2', word: 'imprimante' }, effect: 'rise' } });
  result = await edit.setBlockTiming(dir, { block: 'accueil-illustration', out: { at: { line: 'l3' } }, in: { duration: 0.8 } });
  assert.deepEqual(readJSON(dir, 'screens/accueil.json').blocks[1].timing, { in: { at: { line: 'l2', word: 'imprimante' }, effect: 'rise', duration: 0.8 }, out: { at: { line: 'l3' } } });
  assert.throws(() => edit.setBlockTiming(dir, { block: 'accueil-situation', in: { effect: 'fade' } }), /needs a moment/);
  const project = loadProjectFromDir(dir);
  const timeline = screenTimeline(project, 'accueil')!;
  const l2 = timeline.lines.find((line) => line.id === 'l2')!;
  const block = blockTimings(timeline).get('accueil-illustration')!;
  assert.equal(block.in!.at, Math.round((l2.start + 0.6) * 1000) / 1000, "« imprimante » is the third word of l2 (ni, l', imprimante)");
  assert.equal(block.in!.estimated, false);
  assert.equal(block.out!.at, timeline.lines[2].start);
  // The screen at a time, the editor's view, the agent's text.
  const middle = screenAt(project, 'accueil', block.in!.at + 0.4)!;
  assert.deepEqual(middle.blocks, [{ block: 'accueil-illustration', state: 'entering', progress: 0.5 }]);
  assert.equal(middle.line, 'l2');
  assert.equal(screenAt(project, 'accueil', 0.5)!.blocks[0].state, 'before');
  assert.equal(screenAt(project, 'accueil', timeline.duration)!.blocks[0].state, 'after');
  const view = timelineView(project, 'accueil')!;
  assert.equal(view.lines[1].words[2].text, 'imprimante');
  assert.deepEqual([view.lines[1].words[2].from, view.lines[1].words[2].to], [5, 15], 'offsets in the text, to underline the word');
  assert.equal(view.blocks[0].in!.effect, 'rise');
  const report = formatTimeline(timelineReport(project, 'accueil')!);
  assert.match(report, /accueil-illustration\s+step 1\s+in 0:0\d\.\d l2 « imprimante » rise 0\.8 s\s+·\s+out \d:\d\d\.\d l3 fade 0\.4 s/, report);
  // The course data: the block's moments in seconds.
  const render = renderScreen(project, 'accueil');
  const compiled = render.course.screens[0].blocks.find((candidate: BlockData) => candidate.id === 'accueil-illustration')!;
  assert.deepEqual(compiled.timing, { in: { at: block.in!.at, effect: 'rise', duration: 0.8 }, out: { at: block.out!.at, effect: 'fade', duration: 0.4 } });
  assert.ok(render.course.screens[0].narration!.lines[1].words!.length > 5);
  // Removed: the block shows with its step again.
  result = await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: null, out: null });
  assert.equal(result.timing, null);
  assert.equal(readJSON(dir, 'screens/accueil.json').blocks[1].timing, undefined);
});

test('a line\'s new text takes its word anchors along; an anchor whose words are gone is a finding', { skip: NO_FFMPEG }, async () => {
  const dir = timed();
  await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l2', word: 'partage' } } });
  await edit.upsertEvent(dir, { screen: 'accueil', event: { id: 'imprimante-entendue', on: { type: 'timeline.reached', at: { line: 'l2', word: 'ni', occurrence: 2 } }, do: [{ type: 'pause-timeline' }] } });
  let result = await edit.updateNarrationLine(dir, { screen: 'accueil', line: 'l2', text: "Ni le copieur, ni l'imprimante, ni le partage de fichiers ne marchent." });
  assert.deepEqual(result.anchors?.moved, [{ where: 'imprimante-entendue', word: 'ni' }]);
  assert.equal(readJSON(dir, 'screens/accueil.json').events.at(-1).on.at.occurrence, 3, 'the second « ni » is now the third');
  assert.deepEqual(codes(validateDir(dir).diagnostics).filter((code) => code.startsWith('E_TIMELINE')), []);
  result = await edit.updateNarrationLine(dir, { screen: 'accueil', line: 'l2', text: "Ni le copieur, ni l'imprimante, ni les dossiers ne marchent." });
  assert.deepEqual(result.anchors?.lost, [{ where: 'accueil-illustration in', word: 'partage' }]);
  const found = validateDir(dir).diagnostics.filter((d) => d.code === 'E_TIMELINE_ANCHOR_MISSING');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, '/blocks/1/timing/in/at/word');
  assert.match(found[0].message, /does not say "partage"/);
});

test('validation: anchors, seconds, effects, layers, stacks, order, reading time, questions that leave, long movement', { skip: NO_FFMPEG }, async () => {
  const dir = timed();
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[0].timing = { in: { at: { line: 'l2', word: 'imprimante' } }, out: { at: { line: 'l2', word: 'partage' } } };
  screen.blocks[1].timing = { in: { at: { seconds: 2 }, effect: 'spin' } };
  screen.blocks.push({ id: 'accueil-question', type: 'quiz', props: { questionRef: 'Q-1' }, timing: { in: { at: { line: 'l1' } }, out: { at: { line: 'l2' } } } });
  screen.blocks.push({ id: 'accueil-pile', type: 'stack', props: {}, blocks: [
    { id: 'pile-1', type: 'text', props: { markdown: 'Un' } },
    { id: 'pile-2', type: 'text', props: { markdown: 'Deux' } }
  ] });
  screen.blocks.push({ id: 'accueil-long', type: 'text', props: { markdown: 'Long' }, timing: { in: { at: { line: 'l1' }, effect: 'draw', duration: 6 } } });
  screen.layers = [{ id: 'aide', title: 'Aide', blocks: [{ id: 'aide-texte', type: 'text', props: { markdown: 'Aide' }, timing: { in: { at: { line: 'l1' } } } }] }];
  screen.events = [{ id: 'saut', on: { type: 'screen.enter' }, do: [{ type: 'seek-timeline', to: { line: 'l9' } }] }];
  writeJSON(dir, 'screens/accueil.json', screen);
  const found = validateDir(dir).diagnostics;
  const at = (code: string) => found.filter((d) => d.code === code).map((d) => d.target);
  assert.deepEqual(at('E_TIMING_SECONDS_NARRATED'), ['accueil-illustration']);
  assert.deepEqual(at('E_TIMING_EFFECT_UNKNOWN'), ['accueil-illustration']);
  assert.deepEqual(at('E_TIMELINE_ANCHOR_TRACK'), ['aide-texte'], 'a block of a layer anchors to the layer\'s own lines (D62)');
  assert.deepEqual(at('W_STACK_UNTIMED'), ['pile-2']);
  assert.deepEqual(at('W_TEXT_TOO_FAST'), ['accueil-situation'], 'shown for a fraction of l2');
  assert.deepEqual(at('E_ACTIVITY_LEAVES_UNANSWERED'), ['accueil-question']);
  assert.deepEqual(at('W_MOTION_LONG'), ['accueil-long']);
  assert.deepEqual(at('E_TIMELINE_CUE'), ['saut']);
  // A question that stays until the end of its step: playback stops there for the learner.
  screen.blocks[3].timing.out = { at: { line: 'l3' } };
  screen.blocks[0].timing.out = { at: { line: 'l2', word: 'imprimante' } };
  writeJSON(dir, 'screens/accueil.json', screen);
  const again = validateDir(dir).diagnostics;
  assert.equal(again.filter((d) => d.code === 'E_ACTIVITY_LEAVES_UNANSWERED').length, 0);
  assert.deepEqual(again.filter((d) => d.code === 'E_TIMING_ORDER').map((d) => d.target), ['accueil-situation']);
});

test('word anchors without word times are estimated, and said so', { skip: NO_FFMPEG }, async () => {
  const dir = timed({ words: false });
  await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l2', word: 'partage' } } });
  const finding = validateDir(dir).diagnostics.find((d) => d.code === 'I_TIMELINE_WORDS_ESTIMATED');
  assert.match(finding?.message ?? '', /Line "l2" .* "partage" \(accueil-illustration\)/);
  const timeline = screenTimeline(loadProjectFromDir(dir), 'accueil')!;
  assert.equal(blockTimings(timeline).get('accueil-illustration')!.in!.estimated, true);
});

test('a screen timed in seconds, without narration: its timeline, its cues, seek-timeline resolved', () => {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[1].timing = { in: { at: { seconds: 1 }, effect: 'zoom' } };
  screen.blocks[2].timing = { in: { at: { seconds: 2.5 } } };
  screen.events = [
    { id: 'repere', on: { type: 'timeline.reached', at: { seconds: 2 } }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] },
    { id: 'retour', on: { type: 'timeline.ended' }, do: [{ type: 'seek-timeline', to: { seconds: 1 } }] }
  ];
  writeJSON(dir, 'screens/accueil.json', screen);
  const project = loadProjectFromDir(dir);
  const timeline = screenTimeline(project, 'accueil')!;
  assert.equal(timeline.narrated, false);
  assert.equal(timeline.duration, 2.9);
  assert.equal(screenTiming(project, 'accueil'), null, 'not narrated');
  const render = renderScreen(project, 'accueil');
  const data = render.course.screens[0];
  assert.deepEqual(data.narration?.cues, [{ time: 2, event: 'repere' }]);
  assert.deepEqual(data.narration?.lines, []);
  assert.equal(data.events.find((event) => event.id === 'retour')!.do[0].type === 'seek-timeline' && (data.events.find((event) => event.id === 'retour')!.do[0] as { time?: number }).time, 1);
  assert.deepEqual(codes(validateDir(dir).diagnostics).filter((code) => /TIMING|TIMELINE|ACTIVITY|MOTION/.test(code)), []);
  const at = resolveAt(project, 'accueil', '2.5s');
  assert.deepEqual('time' in at && at.time, 2.5);
  assert.match(('error' in resolveAt(project, 'accueil', 'l2')) ? (resolveAt(project, 'accueil', 'l2') as { error: string }).error : '', /no narration/);
  assert.equal(anchorTime(timeline, { step: 1, edge: 'end' }).time, 2.9);
});

test('XLIFF: word anchors travel as markers; the translator places them, the translated course anchors to their words', { skip: NO_FFMPEG }, async () => {
  const dir = timed();
  await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l2', word: 'imprimante' }, effect: 'rise' } });
  await edit.upsertEvent(dir, { screen: 'accueil', event: { id: 'partage-entendu', on: { type: 'timeline.reached', at: { line: 'l2', word: 'partage' } }, do: [{ type: 'pause-timeline' }] } });
  exportTranslation(dir, { to: 'en' });
  const xlf = fs.readFileSync(translationFile(dir, 'en'), 'utf8');
  assert.match(xlf, /<source>Ni l'<mrk id="w-imprimante" type="elabora:anchor">imprimante<\/mrk>, ni le <mrk id="w-partage" type="elabora:anchor">partage<\/mrk> de fichiers ne marchent\.<\/source>/);
  assert.match(xlf, /markers/i, 'a note tells translators what the markers are');
  const unit = 'screen.accueil.narration.l2.text';
  // Every other text as is; l2 with one marker placed, the other not yet.
  let table = translationTable(loadProjectFromDir(dir), 'en');
  const others = table.rows.filter((row) => row.id !== unit).map((row) => ({ unit: row.id, target: row.source }));
  await edit.translateText(dir, { language: 'en', texts: [...others, { unit, target: 'Neither the <mrk id="w-imprimante">printer</mrk> nor file sharing work.' }] });
  table = translationTable(loadProjectFromDir(dir), 'en');
  const row = table.rows.find((candidate) => candidate.id === unit)!;
  assert.equal(row.target, 'Neither the printer nor file sharing work.', 'the target is the words; its markers apart');
  assert.equal(row.targetMarked, 'Neither the <mrk id="w-imprimante">printer</mrk> nor file sharing work.');
  assert.deepEqual(row.anchors, [{ id: 'w-imprimante', word: 'imprimante', placed: { word: 'printer', occurrence: 1 } }, { id: 'w-partage', word: 'partage', placed: null }]);
  const [status] = translationStatus(dir, { to: 'en' });
  assert.ok(status.exists);
  assert.deepEqual(status.exists && status.anchors.toPlace, [{ unit, id: 'w-partage', word: 'partage' }]);
  // In English, before its build: the placed anchor names its words, the other is at its line's start.
  let english = screenTimeline(loadProjectFromDir(dir), 'accueil', { language: 'en' })!;
  const coming = english.moments.find((moment) => moment.block === 'accueil-illustration')!;
  assert.deepEqual(coming.anchor, { line: 'l2', word: 'printer' });
  assert.equal(coming.problem, undefined);
  const l2 = english.lines.find((line) => line.id === 'l2')!;
  assert.equal(coming.at, l2.words.find((word) => word.text === 'printer')!.start);
  assert.equal(english.cues[0].problem!.kind, 'unplaced');
  assert.equal(english.cues[0].time, l2.start);
  // A build refuses an anchor left to place, a draft takes it.
  assert.throws(() => translatedCourse(loadProjectFromDir(dir), { to: 'en' }), /1 word anchor\(s\) not placed in the en translation \(« partage » of accueil\/l2\)/);
  const draft = translatedCourse(loadProjectFromDir(dir), { to: 'en', allowMissing: true });
  assert.deepEqual(draft.unplaced, [{ screen: 'accueil', line: 'l2', word: 'partage', where: 'partage-entendu' }]);
  assert.deepEqual((draft.files.get('screens/accueil.json') as Screen).events!.at(-1)!.on, { type: 'timeline.reached', at: { line: 'l2' } });
  // Placed by naming the words (the editor's « Accrocher »); the markers already there stay.
  assert.throws(() => edit.translateText(dir, { language: 'en', texts: [{ unit, target: 'Neither the printer nor file sharing work.', anchors: [{ id: 'w-partage', word: 'copier' }] }] }), /"copier" is not in the translation/);
  assert.throws(() => edit.translateText(dir, { language: 'en', texts: [{ unit, target: 'Neither the <mrk id="w-copieur">printer</mrk> nor file sharing work.' }] }), /has no anchor w-copieur \(its anchors: w-imprimante, w-partage\)/);
  await edit.translateText(dir, { language: 'en', texts: [{ unit, target: 'Neither the printer nor file sharing work.', anchors: [{ id: 'w-partage', word: 'file sharing' }] }] });
  const marked = translationTable(loadProjectFromDir(dir), 'en').rows.find((candidate) => candidate.id === unit)!;
  assert.equal(marked.targetMarked, 'Neither the <mrk id="w-imprimante">printer</mrk> nor <mrk id="w-partage">file sharing</mrk> work.');
  const [placed] = translationStatus(dir, { to: 'en' });
  assert.deepEqual(placed.exists && placed.anchors.toPlace, []);
  // Another unit translated again: the line's markers stay in the file.
  await edit.translateText(dir, { language: 'en', texts: [{ unit: others[0].unit, target: `${others[0].target} ` }] });
  assert.match(fs.readFileSync(translationFile(dir, 'en'), 'utf8'), /<target>Neither the <mrk id="w-imprimante" type="elabora:anchor">printer<\/mrk> nor <mrk id="w-partage" type="elabora:anchor">file sharing<\/mrk> work\.<\/target>/);
  // The translated course: anchors on the English words, its own voice gives them their times.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-anchors-')), 'en');
  const built = await buildTranslation(dir, { to: 'en', out });
  assert.equal(built.unplaced, 0);
  const screen = readJSON(out, 'screens/accueil.json');
  assert.deepEqual(screen.blocks[1].timing.in.at, { line: 'l2', word: 'printer' });
  assert.deepEqual(screen.events.at(-1).on.at, { line: 'l2', word: 'file sharing' });
  voice(out, 'accueil', { id: 'l2', text: 'Neither the printer nor file sharing work.', seconds: 2.4 }, { language: 'en' });
  const sidecar = readJSON(out, narrationSidecarPath('en', 'accueil', 'l2'));
  sidecar.words = narrationWords('Neither the printer nor file sharing work.', 'en').map((word, index) => ({ text: word.text, start: index * 0.3, end: index * 0.3 + 0.25 }));
  writeJSON(out, narrationSidecarPath('en', 'accueil', 'l2'), sidecar);
  english = screenTimeline(loadProjectFromDir(out), 'accueil')!;
  const line = english.lines.find((candidate) => candidate.id === 'l2')!;
  assert.equal(english.language, 'en');
  assert.equal(english.moments.find((moment) => moment.block === 'accueil-illustration')!.at, Math.round((line.start + 0.6) * 1000) / 1000, '« printer » is the third English word');
  assert.equal(english.cues.at(-1)!.time, Math.round((line.start + 1.2) * 1000) / 1000, '« file sharing » starts with the fifth');
  assert.deepEqual(codes(validateDir(out).diagnostics).filter((code) => code.startsWith('E_TIMELINE')), []);
});

test('marks of a timed screen: its start, blocks that come and go, cues and steps\' ends, at the time each settles', { skip: NO_FFMPEG }, async () => {
  const dir = timed();
  await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l2', word: 'imprimante' }, effect: 'rise' }, out: { at: { line: 'l3' } } });
  await edit.upsertEvent(dir, { screen: 'accueil', event: { id: 'partage-entendu', on: { type: 'timeline.reached', at: { line: 'l2', word: 'partage' } }, do: [{ type: 'pause-timeline' }] } });
  const project = loadProjectFromDir(dir);
  const timeline = screenTimeline(project, 'accueil')!;
  const marks = timelineMarks(project, 'accueil')!;
  const coming = timeline.moments.find((moment) => moment.kind === 'in')!;
  const mark = marks.find((candidate) => candidate.events.some((event) => event.kind === 'in'))!;
  assert.equal(mark.at, coming.at);
  assert.equal(mark.time, Math.round((coming.at + 0.5) * 1000) / 1000, 'captured once its effect has played');
  assert.match(mark.label, /^0:0\d\.\d · l2 « imprimante » · accueil-illustration comes \(rise\)$/);
  assert.equal(mark.line, 'l2');
  assert.deepEqual(marks.map((candidate) => candidate.events.map((event) => event.kind).join('+')), ['start', 'in', 'cue', 'step-end', 'out', 'step-end']);
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i].time - marks[i - 1].time >= 0.05);
  assert.equal(timelineMarks(project, 'premier-reflexe'), null);
});

test('split_step (« Couper à une réplique »): the line and those after it start the next step; later steps, blocks on moved lines and anchors follow', { skip: NO_FFMPEG }, async () => {
  const dir = timed();
  // Step 1: l1, l2; step 2: l3. The illustration comes on « partage » of l2.
  await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l2', word: 'partage' } } });
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.steps = { 2: { opens: 'answered' } };
  screen.events = [...(screen.events ?? []), { id: 'vers-la-fin', on: { type: 'timeline.reached', at: { step: 2, edge: 'end' } }, do: [{ type: 'reveal-step', step: 2 }] }];
  writeJSON(dir, 'screens/accueil.json', screen);
  assert.throws(() => edit.splitStep(dir, { screen: 'accueil', line: 'l1' }), /already starts step 1/);
  const result = await edit.splitStep(dir, { screen: 'accueil', line: 'l2' });
  assert.deepEqual([result.step, result.lines, result.blocks], [2, ['l2'], ['accueil-illustration']]);
  const after = readJSON(dir, 'screens/accueil.json');
  assert.deepEqual(after.narration.lines.map((line: { id: string; step?: number }) => [line.id, line.step ?? 1]), [['l1', 1], ['l2', 2], ['l3', 3]]);
  assert.equal(after.blocks[1].step, 2, 'the block that comes on l2 moved with it');
  assert.equal(after.blocks[2].step, 3);
  assert.deepEqual(after.steps, { 3: { opens: 'answered' } });
  const event = after.events.find((candidate: { id: string }) => candidate.id === 'vers-la-fin');
  assert.deepEqual([event.on.at, event.do[0].step], [{ step: 3, edge: 'end' }, 3]);
  const timeline = screenTimeline(loadProjectFromDir(dir), 'accueil')!;
  assert.deepEqual(timeline.segments.map((segment) => segment.step), [1, 2, 3]);
});

test('duplicate_screen: the copy says its lines with the same audio, its sidecars naming it', { skip: NO_FFMPEG }, async () => {
  const dir = timed();
  const result = await edit.duplicateScreen(dir, { id: 'accueil', newId: 'accueil-bis' });
  assert.equal(result.screen, 'accueil-bis');
  const sidecar = readJSON(dir, narrationSidecarPath('fr', 'accueil-bis', 'l2'));
  assert.equal(sidecar.screen, 'accueil-bis');
  assert.deepEqual(sidecar.words, readJSON(dir, narrationSidecarPath('fr', 'accueil', 'l2')).words);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'assets/narration/fr/accueil-bis/l2.m4a')), fs.readFileSync(path.join(dir, 'assets/narration/fr/accueil/l2.m4a')));
  assert.ok(narrationLines(loadProjectFromDir(dir), 'accueil-bis')!.every((line) => line.status === 'ok'), 'its audio is up to date');
});

test('« Reprendre la voix off du plan »: the screen\'s script from the voice-over its plan items give, translated with the plan', { skip: NO_FFMPEG }, async () => {
  const dir = copyExample();
  const plan = readJSON(dir, 'plan.json');
  const covered = readJSON(dir, 'screens/accueil.json').covers[0];
  const item = plan.items.find((candidate: { id: string }) => candidate.id === covered);
  item.voiceover = [{ speaker: 'marc', text: "Bonjour, c'est Marc. Rien ne s'imprime." }, { speaker: 'personne', text: 'Voyons le trajet de la demande.' }];
  writeJSON(dir, 'plan.json', plan);
  const course = readJSON(dir, 'course.json');
  course.speakers = [{ id: 'narratrice', name: 'Narratrice' }, { id: 'marc', name: 'Marc' }];
  writeJSON(dir, 'course.json', course);
  const { planVoiceover } = await import('@elabora/core/commands/index');
  assert.equal(planVoiceover(loadProjectFromDir(dir), 'accueil').length, 2);
  assert.deepEqual(planVoiceover(loadProjectFromDir(dir), 'bilan'), []);
  const result = await edit.narrationFromPlan(dir, { screen: 'accueil' });
  assert.deepEqual(result.lines, ['l1', 'l2']);
  assert.deepEqual(readJSON(dir, 'screens/accueil.json').narration.lines, [{ id: 'l1', speaker: 'marc', text: "Bonjour, c'est Marc. Rien ne s'imprime." }, { id: 'l2', text: 'Voyons le trajet de la demande.' }], 'an unknown speaker is left to the default');
  assert.throws(() => edit.narrationFromPlan(dir, { screen: 'accueil' }), /already has a narration/);
  assert.throws(() => edit.narrationFromPlan(dir, { screen: 'bilan' }), /gives no voice-over/);
  // The voice-over is a text of the plan to translate.
  const units = translationTable(loadProjectFromDir(dir), 'en').rows.map((row) => row.id);
  assert.ok(units.includes(`plan.item.${covered}.voiceover.1`), units.filter((unit) => unit.startsWith('plan.item')).join(', '));
});
