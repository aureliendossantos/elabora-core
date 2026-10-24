// Voice lines on every track of a screen and the timelines of layers (docs/decisions.md D62): the
// common voiceLine shape, ids unique in the screen, screenVoiceLines and its tracks, a layer's own
// timeline (its lines, its timed blocks, its cues), the checks, translation units and anchors, the
// course data, the commands, the report and the layer's track in the package.
import { test } from 'node:test';
import { resources } from '../resources.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON, codes } from '../helpers.ts';
import { narrate, voice, hasFfmpeg } from '../narration.ts';
import { validateSchema } from '@elabora/format';
import type { CourseData } from '@elabora/player/course-data';
import { createCourseState } from '@elabora/player/course-state';
import * as edit from '@elabora/node/edit';
import { build } from '@elabora/node/build';
import { exportTranslation } from '@elabora/node/translate';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { screenVoiceLines, trackKey, timelineVoiceLines } from '@elabora/core/narration/voice-lines';
import { narrationLines, narrationAudioPath } from '@elabora/core/narration/narration';
import { screenTimeline, blockTimings, isTimedLayer, cuesOf } from '@elabora/core/narration/timeline';
import { timelineView, screenAt, timelineMarks, narrationView } from '@elabora/core/narration/view';
import { timelineReport, formatTimeline } from '@elabora/core/narration/report';
import { resolveAt } from '@elabora/core/narration/anchor-text';
import { extractUnits } from '@elabora/core/i18n/units';
import { screenParts } from '@elabora/core/project/parts';
import { renderScreen } from '@elabora/core/render/screen';
import { readZip } from '@elabora/node/zip';

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const SPEAKERS = [{ id: 'narratrice', name: 'Narratrice' }, { id: 'guide', name: 'La guide' }];
const RAPPEL = [
  { id: 'r1', speaker: 'guide', text: 'Un rappel de la règle avant de continuer.', seconds: 2 },
  { id: 'r2', speaker: 'guide', text: 'On vérifie toujours le poste avant le réseau.', seconds: 2.5 }
];

// The screen accueil narrated (l1, l2), with a layer « Rappel de la règle » said by the guide whose
// schema comes at the word « poste »; audio: tones for every line (a layer's too).
function layered(dir: string, { audio = true }: { audio?: boolean } = {}): string {
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', ...(audio ? { seconds: 2 } : {}) },
    { id: 'l2', text: "Ni l'imprimante, ni le partage ne marchent.", ...(audio ? { seconds: 3 } : {}) }
  ], { speakers: SPEAKERS });
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.layers = [{
    id: 'rappel', title: 'Rappel de la règle',
    narration: { lines: RAPPEL.map(({ seconds: _seconds, ...line }) => line) },
    blocks: [
      { id: 'consigne-texte', type: 'text', props: { markdown: 'Le poste, puis le réseau.' } },
      { id: 'consigne-schema', type: 'text', props: { markdown: 'Schéma' }, timing: { in: { at: { line: 'r2', word: 'poste' } } } }
    ]
  }];
  screen.events = [
    { id: 'ouvre', on: { type: 'timeline.reached', at: { line: 'l2', edge: 'end' } }, do: [{ type: 'show-layer', layer: 'rappel' }] },
    { id: 'ferme', on: { type: 'timeline.ended', layer: 'rappel' }, do: [{ type: 'hide-layer', layer: 'rappel' }] },
    { id: 'repere', on: { type: 'timeline.reached', at: { line: 'r2', word: 'réseau' } }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] }
  ];
  writeJSON(dir, 'screens/accueil.json', screen);
  if (audio) RAPPEL.forEach((line, index) => voice(dir, 'accueil', line, { language: 'fr', frequency: 660 + 110 * index }));
  return dir;
}

test('format: a narration line is a voice line with step and pauseBefore; a layer\'s lines have no step', (t) => {
  const base = { id: 's', title: 'S', covers: ['OBJ-1'], blocks: [{ id: 'b', type: 'text', props: { markdown: 'a' } }] };
  assert.deepEqual(validateSchema('screen', { ...base, narration: { lines: [{ id: 'l1', text: 'Bonjour', step: 2, pauseBefore: 1, speaker: 'marc', delivery: { fr: { speed: 1.1 } } }] } }), []);
  const extra = validateSchema('screen', { ...base, narration: { lines: [{ id: 'l1', text: 'Bonjour', expression: 'inquiet' }] } });
  assert.deepEqual(extra.map((error) => [error.path, error.message]), [['/narration/lines/0', 'unknown property "expression" (not allowed by the schema)']]);
  assert.deepEqual(validateSchema('screen', { ...base, layers: [{ id: 'r', title: 'R', narration: { seek: 'free', lines: [{ id: 'r1', text: 'Hé', pauseBefore: 0.2 }] }, blocks: base.blocks }] }), []);
  assert.equal(validateSchema('screen', { ...base, layers: [{ id: 'r', title: 'R', narration: { lines: [{ id: 'r1', text: 'Hé', step: 2 }] }, blocks: base.blocks }] }).length, 1, 'no step on a layer');
  assert.deepEqual(validateSchema('event', { id: 'e', on: { type: 'timeline.ended', layer: 'r' }, do: [{ type: 'play-timeline', layer: 'r' }] }), []);
});

test('screenVoiceLines: every line of a screen with its track, its unit and where it is written; narrationLines reads them all', (t) => {
  const dir = layered(resources(t).copyExample(), { audio: false });
  const project = loadProjectFromDir(dir);
  const entries = screenVoiceLines(project, 'accueil');
  assert.deepEqual(entries.map((entry) => [entry.line.id, trackKey(entry.track), entry.unit, entry.path]), [
    ['l1', 'screen', 'screen.accueil.narration.l1.text', '/narration/lines/0'],
    ['l2', 'screen', 'screen.accueil.narration.l2.text', '/narration/lines/1'],
    ['r1', 'layer:rappel', 'screen.accueil.layer.rappel.narration.r1.text', '/layers/0/narration/lines/0'],
    ['r2', 'layer:rappel', 'screen.accueil.layer.rappel.narration.r2.text', '/layers/0/narration/lines/1']
  ]);
  assert.deepEqual(timelineVoiceLines(project, 'accueil', 'rappel').map((entry) => entry.line.id), ['r1', 'r2']);
  const infos = narrationLines(project, 'accueil')!;
  assert.deepEqual(infos.map((info) => [info.id, info.track.kind, info.status, info.audio]), [
    ['l1', 'screen', 'missing', 'assets/narration/fr/accueil/l1.m4a'], ['l2', 'screen', 'missing', 'assets/narration/fr/accueil/l2.m4a'],
    ['r1', 'layer', 'missing', 'assets/narration/fr/accueil/r1.m4a'], ['r2', 'layer', 'missing', 'assets/narration/fr/accueil/r2.m4a']
  ], 'a layer\'s line keeps the path of every line: the screen and its id');
  assert.equal(infos[2].speakerName, 'La guide');
  const parts = screenParts(project, 'accueil')!;
  assert.deepEqual(parts.layers, [{ id: 'rappel', title: 'Rappel de la règle', timed: true, narration: { seek: 'seen', lines: [{ id: 'r1', speaker: 'guide', text: RAPPEL[0].text }, { id: 'r2', speaker: 'guide', text: RAPPEL[1].text }] } }]);
});

test('a layer\'s timeline: its lines from its opening, its blocks at its words, its cues; the screen\'s keeps its own', { skip: NO_FFMPEG }, (t) => {
  const project = loadProjectFromDir(layered(resources(t).copyExample()));
  const own = screenTimeline(project, 'accueil', { layer: 'rappel' })!;
  assert.equal(own.layer, 'rappel');
  assert.deepEqual(own.lines.map((line) => [line.id, line.start, line.end]), [['r1', 0, 2], ['r2', 2.4, 4.9]]);
  assert.deepEqual(own.segments, [{ step: 1, start: 0, end: 4.9 }]);
  const schema = blockTimings(own).get('consigne-schema')!.in!;
  assert.ok(schema.at > 2.4 && schema.at < 4.9 && !schema.problem, JSON.stringify(schema));
  assert.deepEqual(own.cues.map((cue) => cue.event), ['repere'], 'a cue on a layer\'s line is on the layer\'s timeline');
  const screen = screenTimeline(project, 'accueil')!;
  assert.deepEqual(screen.lines.map((line) => line.id), ['l1', 'l2']);
  assert.deepEqual(screen.cues.map((cue) => cue.event), ['ouvre']);
  assert.ok(!blockTimings(screen).has('consigne-schema'));
  assert.ok(isTimedLayer(project, project.screens.get('accueil')!.data, 'rappel'));
  assert.deepEqual(cuesOf(project.screens.get('accueil')!.data, { layer: 'rappel' }).map((cue) => cue.event), ['repere']);
  // What editors read: the layer's view, its moment, its marks, the time of an anchor on it.
  assert.equal(timelineView(project, 'accueil', 'fr', { layer: 'rappel' })?.blocks[0]?.block, 'consigne-schema');
  assert.equal(screenAt(project, 'accueil', 3, 'fr', { layer: 'rappel' })?.line, 'r2');
  assert.ok(timelineMarks(project, 'accueil', 'fr', { layer: 'rappel' })!.some((mark) => mark.events.some((event) => event.block === 'consigne-schema')));
  const at = resolveAt(project, 'accueil', 'r2:poste', { layer: 'rappel' });
  assert.ok('time' in at && at.time === schema.at, JSON.stringify(at));
  assert.match(String((resolveAt(project, 'accueil', 'l1', { layer: 'rappel' }) as { error: string }).error), /No line "l1" in the narration of layer "rappel"/);
  const view = narrationView(project, 'accueil', 'fr', { layer: 'rappel' })!;
  assert.deepEqual([view.layer, view.advance, view.seek, view.lines.map((line) => line.id)], ['rappel', 'auto', 'seen', ['r1', 'r2']]);
  // The report: the screen's, then the layer's under it.
  const report = timelineReport(project, 'accueil')!;
  assert.deepEqual(report.layers?.map((layer) => [layer.layer, layer.duration, layer.cues.map((cue) => cue.event)]), [['rappel', 4.9, ['repere', 'ferme']]]);
  assert.deepEqual(report.cues.map((cue) => cue.event), ['ouvre']);
  assert.match(formatTimeline(report), /accueil › layer rappel — "Rappel de la règle" — narration in fr/);
});

test('an anchor stays on its own timeline: a line of another track is E_TIMELINE_ANCHOR_TRACK, not a missing line', (t) => {
  const dir = layered(resources(t).copyExample(), { audio: false });
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[0].timing = { in: { at: { line: 'r1' } } };
  screen.layers[0].blocks[0].timing = { in: { at: { line: 'l2', word: 'partage' } } };
  screen.events.push({ id: 'croise', on: { type: 'timeline.reached', layer: 'rappel', at: { line: 'l1' } }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] });
  screen.events.push({ id: 'saute', on: { type: 'screen.enter' }, do: [{ type: 'seek-timeline', layer: 'rappel', to: { line: 'l1' } }] });
  writeJSON(dir, 'screens/accueil.json', screen);
  const found = validateDir(dir).diagnostics.filter((d) => d.code === 'E_TIMELINE_ANCHOR_TRACK');
  assert.deepEqual(found.map((d) => d.target).sort(), ['croise', 'consigne-texte', 'saute', screen.blocks[0].id].sort(), JSON.stringify(found, null, 1));
  assert.match(found.find((d) => d.target === 'consigne-texte')!.message, /line "l2" is said on the screen's narration, another timeline/);
  const timeline = screenTimeline(loadProjectFromDir(dir), 'accueil', { layer: 'rappel' })!;
  assert.equal(blockTimings(timeline).get('consigne-texte')?.in?.problem?.kind, 'track');
});

test('checks on layers: ids unique in the screen, missing audio by track, cues and actions on a layer\'s timeline, times in the layer', { skip: NO_FFMPEG }, (t) => {
  const dir = layered(resources(t).copyExample());
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.layers[0].narration.lines.push({ id: 'l1', text: 'Encore un rappel.' });
  writeJSON(dir, 'screens/accueil.json', screen);
  const duplicate = validateDir(dir).diagnostics.filter((d) => d.code === 'E_NARRATION_LINE_DUPLICATE');
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].path, '/layers/0/narration/lines/2/id');
  assert.match(duplicate[0].message, /in the screen's narration and in the narration of layer "rappel"/);
  screen.layers[0].narration.lines[2].id = 'r3';
  // A question that leaves while the layer plays on, a block that leaves before it comes, text too fast.
  screen.layers[0].blocks.push({ id: 'consigne-question', type: 'quiz', props: { questionRef: 'Q-1' }, timing: { in: { at: { line: 'r1' } }, out: { at: { line: 'r2' } } } });
  screen.layers[0].blocks.push({ id: 'consigne-flash', type: 'text', props: { markdown: 'Un texte bien trop long pour être lu en si peu de temps, vraiment.' }, timing: { in: { at: { line: 'r2', word: 'toujours' } }, out: { at: { line: 'r2', word: 'poste' } } } });
  screen.layers[0].blocks.push({ id: 'consigne-envers', type: 'text', props: { markdown: 'Envers' }, timing: { in: { at: { line: 'r2' } }, out: { at: { line: 'r1' } } } });
  // A layer without a timeline cannot be followed.
  screen.layers.push({ id: 'muet', title: 'Muet', blocks: [{ id: 'muet-texte', type: 'text', props: { markdown: 'Rien' } }] });
  screen.events.push({ id: 'fin-muet', on: { type: 'timeline.ended', layer: 'muet' }, do: [{ type: 'hide-layer' }] });
  screen.events.push({ id: 'pause-muet', on: { type: 'screen.enter' }, do: [{ type: 'pause-timeline', layer: 'muet' }, { type: 'show-layer', layer: 'muet' }] });
  writeJSON(dir, 'screens/accueil.json', screen);
  const found = validateDir(dir).diagnostics;
  const at = (code: string) => found.filter((d) => d.code === code).map((d) => d.target);
  assert.deepEqual(at('E_NARRATION_LINE_DUPLICATE'), []);
  const missing = found.filter((d) => d.code === 'W_NARRATION_AUDIO_MISSING');
  assert.deepEqual(missing.map((d) => [d.path, d.message]), [['/layers/0/narration/lines', '1 of 3 lines of the narration of layer "rappel" (screen "accueil") have no audio in fr (r3): its timeline runs silent, on estimated times, until every line has its audio.']]);
  assert.deepEqual(at('E_ACTIVITY_LEAVES_UNANSWERED'), ['consigne-question']);
  assert.ok(at('W_TEXT_TOO_FAST').includes('consigne-flash'));
  assert.deepEqual(at('E_TIMING_ORDER'), ['consigne-envers']);
  assert.deepEqual(at('E_TIMELINE_CUE').sort(), ['fin-muet', 'pause-muet']);
  assert.ok(!codes(found).includes('W_TIMING_IGNORED'), 'a layer\'s timed blocks apply');
});

test('translation: a layer\'s lines are units with their anchors\' markers; the translated course anchors there', { skip: NO_FFMPEG }, async (t) => {
  const dir = layered(resources(t).copyExample());
  const units = extractUnits(loadProjectFromDir(dir));
  const unit = units.find((candidate) => candidate.id === 'screen.accueil.layer.rappel.narration.r2.text')!;
  assert.equal(unit.pointer, '/layers/0/narration/lines/1/text');
  assert.deepEqual(unit.marks?.map((mark) => mark.id), ['w-poste', 'w-réseau']);
  exportTranslation(dir, { to: 'en' });
  await edit.translateText(dir, { language: 'en', texts: [{ unit: 'screen.accueil.layer.rappel.narration.r2.text', target: 'We always check the <mrk id="w-poste">computer</mrk> before the <mrk id="w-réseau">network</mrk>.' }] });
  const timeline = screenTimeline(loadProjectFromDir(dir), 'accueil', { layer: 'rappel', language: 'en' })!;
  const schema = blockTimings(timeline).get('consigne-schema')!.in!;
  assert.deepEqual(schema.anchor, { line: 'r2', word: 'computer' });
  assert.equal(timeline.infos.get('r2')?.text, 'We always check the computer before the network.');
});

test('course data: a layer\'s narration, its timed blocks and the events on its timeline', (t) => {
  const dir = layered(resources(t).copyExample(), { audio: false });
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.layers[0].narration.seek = 'free';
  screen.events.push({ id: 'saut', on: { type: 'layer.closed', target: 'rappel' }, do: [{ type: 'seek-timeline', to: { line: 'r2' } }] });
  writeJSON(dir, 'screens/accueil.json', screen);
  const data = renderScreen(loadProjectFromDir(dir), 'accueil').course.screens[0];
  const layer = data.layers[0];
  assert.equal(layer.narration?.advance, 'auto');
  assert.equal(layer.narration?.seek, 'free');
  assert.equal(layer.narration?.src, null, 'silent until every line has its audio');
  assert.deepEqual(layer.narration?.lines.map((line) => [line.id, line.speaker]), [['r1', 'La guide'], ['r2', 'La guide']]);
  assert.deepEqual(layer.narration?.cues.map((cue) => cue.event), ['repere']);
  assert.ok(layer.blocks[1].timing?.in && layer.blocks[1].timing.in.at > 0);
  assert.deepEqual(data.narration?.lines.map((line) => line.id), ['l1', 'l2']);
  const seek = data.events.find((event) => event.id === 'saut')!.do[0] as { layer?: string; time?: number };
  assert.equal(seek.layer, 'rappel', 'a seek to a layer\'s line moves the layer\'s timeline');
  assert.equal(seek.time, layer.narration?.lines[1].start);
  assert.ok(codes(validateDir(dir).diagnostics).every((code) => code !== 'E_TIMELINE_CUE'));
});

test('course state: timeline.ended with a layer fires at the end of that layer\'s timeline only', (t) => {
  const course = {
    screens: [{ id: 's', key: '1', section: 'a', title: 'S', showTitle: true, required: true, completeWhen: 'viewed', covers: [], blocks: [], layers: [], events: [
      { id: 'screen-end', on: { type: 'timeline.ended' }, do: [{ type: 'complete-screen' }] },
      { id: 'layer-end', on: { type: 'timeline.ended', layer: 'rappel' }, do: [{ type: 'hide-layer', layer: 'rappel' }] }
    ] }],
    variables: [], completion: { reportAs: 'completed-incomplete' }
  } as unknown as CourseData;
  const state = createCourseState(course);
  const screen = course.screens[0];
  assert.deepEqual(state.eventsFor(screen, 'timeline.ended', {}).map((run) => run.event), ['screen-end']);
  assert.deepEqual(state.eventsFor(screen, 'timeline.ended', { layer: 'rappel' }).map((run) => run.event), ['layer-end']);
  assert.deepEqual(state.eventsFor(screen, 'timeline.ended', { layer: 'autre' }), []);
});

test('narration commands on a layer: a line added there (its id unique in the screen), changed, removed with its audio; no step', { skip: NO_FFMPEG }, (t) => {
  const dir = layered(resources(t).copyExample());
  const added = edit.addNarrationLine(dir, { screen: 'accueil', layer: 'rappel', line: { text: 'Et on note ce qu\'on a vu.', speaker: 'guide' } });
  assert.equal(added.line, 'l5', 'the next free id of the screen, every track counted');
  assert.throws(() => edit.addNarrationLine(dir, { screen: 'accueil', layer: 'rappel', line: { id: 'l1', text: 'Doublon.' } }), /already has a line "l1"/);
  assert.throws(() => edit.addNarrationLine(dir, { screen: 'accueil', layer: 'rappel', line: { text: 'Étape.', step: 2 } }), /no step/);
  edit.updateNarrationLine(dir, { screen: 'accueil', line: 'r1', pauseBefore: 0.2, text: 'Un rappel de la règle, rapidement.' });
  assert.throws(() => edit.updateNarrationLine(dir, { screen: 'accueil', line: 'r1', step: 2 }), /whose timeline has no steps/);
  edit.updateNarration(dir, { screen: 'accueil', layer: 'rappel', seek: 'none' });
  let screen = readJSON(dir, 'screens/accueil.json');
  assert.deepEqual(screen.layers[0].narration.lines.map((line: { id: string }) => line.id), ['r1', 'r2', 'l5']);
  assert.equal(screen.layers[0].narration.lines[0].pauseBefore, 0.2);
  assert.equal(screen.layers[0].narration.seek, 'none');
  assert.equal(screen.narration.lines.length, 2, 'the screen\'s narration untouched');
  edit.moveNarrationLine(dir, { screen: 'accueil', line: 'l5', after: null });
  edit.removeNarrationLine(dir, { screen: 'accueil', line: 'r2' });
  screen = readJSON(dir, 'screens/accueil.json');
  assert.deepEqual(screen.layers[0].narration.lines.map((line: { id: string }) => line.id), ['l5', 'r1']);
  assert.ok(!fs.existsSync(path.join(dir, narrationAudioPath('fr', 'accueil', 'r2'))), 'its audio goes with it');
  edit.removeSpeaker(dir, { speaker: 'guide', to: 'narratrice' });
  screen = readJSON(dir, 'screens/accueil.json');
  assert.ok(screen.layers[0].narration.lines.every((line: { speaker?: string }) => line.speaker === 'narratrice'), 'a layer\'s lines change speaker too');
});

test('build: a layer\'s track next to its screen\'s (narration/<screen>.<layer>.m4a), the same bytes twice', { skip: NO_FFMPEG }, async (t) => {
  const dir = layered(resources(t).copyExample());
  const out = resources(t).tempDir('elabora-layer-');
  const first = await build(dir, { out });
  assert.ok(first.ok, JSON.stringify(first.diagnostics?.filter((d) => d.severity === 'error')));
  const { files } = readZip(fs.readFileSync(first.zipPath!));
  const names = [...files.keys()];
  assert.ok(names.includes('narration/accueil.m4a') && names.includes('narration/accueil.rappel.m4a') && names.includes('narration/accueil.rappel.vtt'), names.filter((name) => name.startsWith('narration/')).join(', '));
  assert.deepEqual(first.report?.narration?.tracks.map((track) => [track.screen, track.layer ?? null, track.path]).filter(([screen]) => screen === 'accueil'), [['accueil', null, 'narration/accueil.m4a'], ['accueil', 'rappel', 'narration/accueil.rappel.m4a']]);
  const course = files.get('elabora/course.js')!.toString();
  assert.match(course, /"src":"narration\/accueil\.rappel\.m4a"/, 'the layer\'s narration plays its track');
  const second = await build(dir, { out: resources(t).tempDir('elabora-layer-') });
  assert.equal(first.report.package.sha256, second.report?.package.sha256, 'deterministic');
  assert.match(files.get('narration/accueil.rappel.vtt')!.toString(), /<v La guide>Un rappel de la règle/);
});
