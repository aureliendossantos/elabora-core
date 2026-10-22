import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyExample, readJSON, writeJSON, codes } from '../helpers.ts';
import { narrate, voice, hasFfmpeg, toneM4a } from '../narration.ts';
import * as edit from '@elabora/node/edit';
import { importNarration, setNarrationAudio } from '@elabora/node/narration/audio';
import { build } from '@elabora/node/build';
import { undo } from '@elabora/node/edit/history';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { narrationTiming, captionChunks, narrationVtt, STEP_GAP } from '@elabora/core/narration/timing';
import { narrationLines, narrationTextHash, screenTiming, lineAnchor, applyPronunciations, spokenTextOf, spokenText } from '@elabora/core/narration/narration';
import type { Course } from '@elabora/format';
import { timelineReport, formatTimeline } from '@elabora/core/narration/report';
import { extractUnits } from '@elabora/core/i18n/units';
import { screenParts } from '@elabora/core/project/parts';
import { assignKeys, buildStateModel, readLock } from '@elabora/core/compile/state-model';
import { renderScreen } from '@elabora/core/render/screen';
import { lessonMdExport } from '@elabora/core/interop/lesson-md';
import { createCourseState } from '@elabora/player/course-state';
import type { CourseData } from '@elabora/player/course-data';
import { textAndAddresses } from '@elabora/player/dom';

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const SPEAKERS = [{ id: 'narratrice', name: 'Narratrice' }, { id: 'marc', name: 'Marc' }];

// The example's first screen, narrated in two steps: two lines with audio in step 1, one in step 2.
function narrated({ audio = true, advance }: { audio?: boolean; advance?: 'learner' | 'auto' | 'next-screen' } = {}) {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[1].step = 2;
  screen.blocks[2].step = 2;
  writeJSON(dir, 'screens/accueil.json', screen);
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', seconds: audio ? 1.5 : undefined },
    { id: 'l2', text: "Il n'arrive plus à imprimer les bulletins de paie.", seconds: audio ? 2 : undefined },
    { id: 'l3', step: 2, speaker: 'marc', text: 'Ça bloque toute la comptabilité !', seconds: audio ? 1.2 : undefined }
  ], { speakers: SPEAKERS, ...(advance ? { advance } : {}) });
  return dir;
}

test('timing: lines end to end with their pauses, a step gap, a segment per step (one without lines too)', () => {
  const timing = narrationTiming([
    { id: 'l1', step: 1, text: 'Un.', duration: 2 },
    { id: 'l2', step: 1, text: 'Deux.', duration: 1, pauseBefore: 0 },
    { id: 'l3', step: 3, text: 'x'.repeat(45), duration: null, pauseBefore: 0.1 }
  ], [1, 2, 3]);
  assert.deepEqual(timing.lines.map((line) => [line.id, line.start, line.end]), [['l1', 0, 2], ['l2', 2, 3], ['l3', 3 + STEP_GAP, 3 + STEP_GAP + 3]]);
  assert.deepEqual(timing.segments, [{ step: 1, start: 0, end: 3 }, { step: 2, start: 3, end: 3 }, { step: 3, start: 3, end: 6.3 }]);
  assert.equal(timing.duration, 6.3);
  assert.ok(timing.estimated && timing.lines[2].estimated, 'the line without audio is estimated (15 characters a second)');
  // The default pause: none before the first line, 0.4 s before the others.
  assert.deepEqual(narrationTiming([{ id: 'a', step: 1, text: 'a', duration: 1 }, { id: 'b', step: 1, text: 'b', duration: 1 }]).lines.map((line) => line.start), [0, 1.4]);
});

test('captions: sentences cut to two lines at most, timed in proportion to their length; WebVTT with voices', () => {
  const long = 'Plus rien ne marche au deuxième étage : ni l’imprimante, ni le partage de fichiers. C’est la troisième fois cette semaine, et mon directeur attend un rapport pour midi.';
  const chunks = captionChunks(long);
  assert.ok(chunks.length >= 2 && chunks.every((chunk) => chunk.length <= 84), JSON.stringify(chunks));
  assert.equal(chunks.join(' '), long);
  assert.deepEqual(captionChunks('Oui. Non. Peut-être.'), ['Oui. Non. Peut-être.'], 'short sentences share a caption');
  const timing = narrationTiming([{ id: 'l1', step: 1, text: 'A < B & C', duration: 1.5 }]);
  assert.equal(narrationVtt(timing.lines.map((line) => ({ ...line, speaker: 'Léa' }))), 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\n<v Léa>A &lt; B &amp; C\n');
});

test('text hash: Unicode NFC, whitespace runs, trimmed; line anchors', () => {
  assert.equal(narrationTextHash('  Café\n crème '), narrationTextHash('Café crème'));
  assert.notEqual(narrationTextHash('Café'), narrationTextHash('Cafe'));
  assert.deepEqual(lineAnchor('l2'), { line: 'l2', edge: 'start' });
  assert.deepEqual(lineAnchor('l2:end'), { line: 'l2', edge: 'end' });
  assert.equal(lineAnchor('2s'), null);
});

test('narration lines: audio ok, missing, out of date (text, audio, voice), untranslated', { skip: NO_FFMPEG }, () => {
  const dir = narrated();
  let lines = narrationLines(loadProjectFromDir(dir), 'accueil')!;
  assert.deepEqual(lines.map((line) => line.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(lines.map((line) => line.speakerName), ['Narratrice', 'Narratrice', 'Marc'], 'a line without speaker: the first one');
  // The text changed; the audio replaced by hand; the speaker's voice changed.
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.narration.lines[0].text = 'Bonjour, voici le nouveau ticket de Marc.';
  writeJSON(dir, 'screens/accueil.json', screen);
  toneM4a(path.join(dir, 'assets/narration/fr/accueil/l2.m4a'), 2.5, 880);
  const course = readJSON(dir, 'course.json');
  course.speakers[1].voices = { fr: { provider: 'kokoro', voice: 'ff_siwis' } };
  writeJSON(dir, 'course.json', course);
  fs.rmSync(path.join(dir, 'assets/narration/fr/accueil/l3.json'));
  lines = narrationLines(loadProjectFromDir(dir), 'accueil')!;
  assert.deepEqual(lines.map((line) => line.status), ['stale', 'stale', 'missing']);
  assert.match(lines[0].reasons.join(), /text changed/);
  assert.match(lines[1].reasons.join(), /replaced/);
  voice(dir, 'accueil', { id: 'l3', text: 'Ça bloque toute la comptabilité !', seconds: 1.2 }, { language: 'fr' });
  assert.match(narrationLines(loadProjectFromDir(dir), 'accueil')![2].reasons.join(), /voice is now kokoro ff_siwis/);
  // Another language: the text of its translation, untranslated until then.
  assert.deepEqual(narrationLines(loadProjectFromDir(dir), 'accueil', 'en')!.map((line) => line.status), ['untranslated', 'untranslated', 'untranslated']);
});

test('validator: script, pace, redundancy (E4), cues and audio', { skip: NO_FFMPEG }, () => {
  const dir = narrated({ advance: 'next-screen' });
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.narration.lines.push(
    { id: 'l3', text: 'Encore une fois.', speaker: 'personne' },
    { id: 'l4', step: 1, text: 'Lundi, 9 h 05. Marc, du service comptable, vous appelle : il doit imprimer les bulletins de paie avant midi.' }
  );
  screen.events = [
    { id: 'cue-unknown', on: { type: 'timeline.reached', at: { line: 'l9' } }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] },
    { id: 'cue-count', on: { type: 'timeline.reached', at: { line: 'l1', edge: 'end' } }, do: [{ type: 'increment-variable', variable: 'bonsReflexes', by: 1 }] },
    { id: 'image-ended', on: { type: 'media.ended', target: 'accueil-illustration' }, do: [{ type: 'pause-timeline' }] },
    { id: 'play-image', on: { type: 'timeline.ended' }, do: [{ type: 'play-media', block: 'accueil-illustration' }] }
  ];
  writeJSON(dir, 'screens/accueil.json', screen);
  const other = readJSON(dir, 'screens/chemin.json');
  other.events = [{ id: 'no-narration', on: { type: 'timeline.ended' }, do: [{ type: 'play-timeline' }] }];
  writeJSON(dir, 'screens/chemin.json', other);
  const found = validateDir(dir).diagnostics;
  const c = codes(found);
  for (const code of ['E_NARRATION_LINE_DUPLICATE', 'E_NARRATION_SPEAKER', 'E_NARRATION_STEP_ORDER', 'W_AUTO_ADVANCE', 'W_NARRATION_DUPLICATED', 'E_TIMELINE_CUE', 'W_TIMED_INCREMENT', 'E_EVENT_TARGET', 'E_ACTION_TARGET', 'W_NARRATION_AUDIO_MISSING']) assert.ok(c.includes(code), code);
  assert.equal(found.filter((d) => d.code === 'E_TIMELINE_CUE').length, 3, 'an unknown line, a trigger and an action on a screen without narration');
  assert.equal(found.find((d) => d.code === 'W_NARRATION_DUPLICATED')?.target, 'accueil-situation');
  // A long step (estimated from its text): more than 90 s.
  const long = narrated({ audio: false });
  const script = readJSON(long, 'screens/accueil.json');
  script.narration.lines[0].text = 'Une phrase de narration qui dure. '.repeat(45);
  writeJSON(long, 'screens/accueil.json', script);
  const report = validateDir(long).diagnostics;
  assert.ok(codes(report).includes('W_SEGMENT_TOO_LONG'));
  assert.match(report.find((d) => d.code === 'W_NARRATION_AUDIO_MISSING')?.message ?? '', /no narration audio in fr yet/);
  // auto chains the steps in the screen and waits for Next: no time limit (only next-screen is one),
  // also as the course's default.
  const auto = narrated({ advance: 'auto' });
  assert.ok(!codes(validateDir(auto).diagnostics).includes('W_AUTO_ADVANCE'));
  const byDefault = narrated();
  const defaults = readJSON(byDefault, 'course.json');
  defaults.narration = { advance: 'next-screen', seek: 'free' };
  writeJSON(byDefault, 'course.json', defaults);
  assert.ok(codes(validateDir(byDefault).diagnostics).includes('W_AUTO_ADVANCE'));
  const data = renderScreen(loadProjectFromDir(byDefault), 'accueil').course.screens[0].narration!;
  assert.deepEqual([data.advance, data.seek], ['next-screen', 'free'], 'the course\'s defaults reach the course data');
  // A narrated course with its audio, as written: no finding of its own.
  assert.deepEqual(codes(validateDir(narrated()).diagnostics).filter((code) => /NARRATION|TIMELINE|SEGMENT|AUTO_ADVANCE/.test(code)), []);
});

test('steps of lines: reveal-step reaches them, screen parts list the lines, the state model counts them', () => {
  const dir = narrated({ audio: false });
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.narration.lines.push({ id: 'l4', step: 3, text: 'Une étape sans bloc.' });
  screen.events = [{ id: 'go-3', on: { type: 'screen.enter' }, do: [{ type: 'reveal-step', step: 3 }] }];
  writeJSON(dir, 'screens/accueil.json', screen);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_ACTION_TARGET'), 'step 3 exists: a line has it');
  const project = loadProjectFromDir(dir);
  const parts = screenParts(project, 'accueil')!;
  assert.deepEqual(parts.steps, [1, 2, 3]);
  const { keys } = assignKeys(project, readLock(project));
  assert.ok(buildStateModel(project, keys).steppedScreens.some((entry) => entry.key === keys['screen:accueil'] && entry.step === 2), 'resume: at worst the last step but one');
  assert.deepEqual(parts.narration?.lines.map((line) => [line.id, line.step, line.speaker]), [['l1', 1, null], ['l2', 1, null], ['l3', 2, 'marc'], ['l4', 3, null]]);
});

test('translation: lines and speaker names are units; a translated line has its own audio', () => {
  const dir = narrated({ audio: false });
  const units = extractUnits(loadProjectFromDir(dir));
  const unit = units.find((candidate) => candidate.id === 'screen.accueil.narration.l3.text');
  assert.equal(unit?.text, 'Ça bloque toute la comptabilité !');
  assert.equal(unit?.pointer, '/narration/lines/2/text');
  assert.equal(units.find((candidate) => candidate.id === 'course.speaker.marc.name')?.pointer, '/speakers/1/name');
});

test('course data: lines, times, captions and segments; the canvas gets them without a track', () => {
  const render = renderScreen(loadProjectFromDir(narrated({ audio: false })), 'accueil');
  const narration = render.course.screens[0].narration!;
  assert.equal(narration.src, null);
  assert.equal(narration.advance, 'learner');
  assert.equal(narration.seek, 'seen');
  assert.ok(narration.estimated);
  assert.deepEqual(narration.segments.map((segment) => segment.step), [1, 2]);
  assert.deepEqual(narration.lines.map((line) => line.speaker), ['Narratrice', 'Narratrice', 'Marc']);
  assert.equal(narration.lines[2].cues[0].text, 'Ça bloque toute la comptabilité !');
});

test('elabora timeline: steps, lines, audio and the events on the timeline, as text', { skip: NO_FFMPEG }, () => {
  const dir = narrated();
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.events = [{ id: 'cue-l2', on: { type: 'timeline.reached', at: { line: 'l2' } }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] }];
  writeJSON(dir, 'screens/accueil.json', screen);
  const report = timelineReport(loadProjectFromDir(dir), 'accueil')!;
  assert.ok(report.voiced);
  assert.equal(report.duration, 5.5);
  assert.deepEqual(report.cues.map((cue) => [cue.event, cue.time]), [['cue-l2', 1.9]]);
  const text = formatTimeline(report);
  assert.match(text, /l2\s+Narratrice\s+0:01\.9\s+0:03\.9\s+ok/);
  assert.match(text, /cue-l2: timeline\.reached l2 at 0:01\.9 → set-variable variable=indiceVu value=true/);
});

test('narration edits: lines added, changed, moved and removed (with their audio), as undoable changes', { skip: NO_FFMPEG }, () => {
  const dir = narrated();
  const added = edit.addNarrationLine(dir, { screen: 'accueil', line: { text: 'Une dernière chose.', step: 2 } });
  assert.equal(added.line, 'l4');
  edit.updateNarrationLine(dir, { screen: 'accueil', line: 'l4', speaker: 'marc', pauseBefore: 1 });
  edit.moveNarrationLine(dir, { screen: 'accueil', line: 'l4', after: 'l2' });
  edit.updateNarration(dir, { screen: 'accueil', seek: 'free' });
  let screen = readJSON(dir, 'screens/accueil.json');
  assert.deepEqual(screen.narration.lines.map((line: { id: string }) => line.id), ['l1', 'l2', 'l4', 'l3']);
  assert.equal(screen.narration.seek, 'free');
  const removed = edit.removeNarrationLine(dir, { screen: 'accueil', line: 'l2' });
  assert.ok(!fs.existsSync(path.join(dir, 'assets/narration/fr/accueil/l2.m4a')) && !fs.existsSync(path.join(dir, 'assets/narration/fr/accueil/l2.json')), 'its audio goes with it');
  undo(dir, removed.change!.seq);
  assert.ok(fs.existsSync(path.join(dir, 'assets/narration/fr/accueil/l2.m4a')), 'and comes back with undo');
  screen = readJSON(dir, 'screens/accueil.json');
  assert.ok(screen.narration.lines.some((line: { id: string }) => line.id === 'l2'));
});

test('a speaker removed: its lines go to another speaker, or to none, in one undoable change', () => {
  const dir = narrated({ audio: false });
  const course = readJSON(dir, 'course.json');
  course.speakers[1].voices = { fr: { provider: 'pocket-tts', voice: 'jean' } };
  writeJSON(dir, 'course.json', course);
  assert.throws(() => edit.removeSpeaker(dir, { speaker: 'personne' }), /No speaker "personne"/);
  assert.throws(() => edit.removeSpeaker(dir, { speaker: 'marc', to: 'marc' }), /another speaker/);
  const given = edit.removeSpeaker(dir, { speaker: 'marc', to: 'narratrice' });
  assert.deepEqual([given.lines, given.screens], [1, ['accueil']]);
  assert.deepEqual(readJSON(dir, 'course.json').speakers.map((speaker: { id: string }) => speaker.id), ['narratrice'], 'its voices go with it');
  assert.equal(readJSON(dir, 'screens/accueil.json').narration.lines[2].speaker, 'narratrice');
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_NARRATION_SPEAKER'));
  undo(dir, given.change!.seq);
  assert.equal(readJSON(dir, 'screens/accueil.json').narration.lines[2].speaker, 'marc', 'undone in one change');
  assert.deepEqual(readJSON(dir, 'course.json').speakers[1].voices, { fr: { provider: 'pocket-tts', voice: 'jean' } });
  // The last speaker: its lines are left without one.
  edit.removeSpeaker(dir, { speaker: 'marc', to: 'narratrice' });
  const left = edit.removeSpeaker(dir, { speaker: 'narratrice' });
  assert.equal(left.lines, 1, 'l1 and l2 had no speaker');
  assert.equal(readJSON(dir, 'course.json').speakers, undefined);
  assert.ok(readJSON(dir, 'screens/accueil.json').narration.lines.every((line: { speaker?: string }) => line.speaker === undefined));
});

test('a renamed screen takes the audio of its lines along, their sidecars naming it', { skip: NO_FFMPEG }, () => {
  const dir = narrated();
  edit.rename(dir, { from: 'accueil', to: 'bienvenue' });
  assert.ok(fs.existsSync(path.join(dir, 'assets/narration/fr/bienvenue/l1.m4a')));
  assert.ok(!fs.existsSync(path.join(dir, 'assets/narration/fr/accueil')) || !fs.readdirSync(path.join(dir, 'assets/narration/fr/accueil')).length);
  assert.equal(readJSON(dir, 'assets/narration/fr/bienvenue/l1.json').screen, 'bienvenue');
  assert.deepEqual(narrationLines(loadProjectFromDir(dir), 'bienvenue')!.map((line) => line.status), ['ok', 'ok', 'ok']);
});

test('a recorded voice imported for a line: converted to M4A mono, its silences trimmed, its sidecar written', { skip: NO_FFMPEG }, async () => {
  const dir = narrated({ audio: false });
  const recording = path.join(dir, 'take.wav');
  fs.mkdirSync(path.dirname(recording), { recursive: true });
  // 0.8 s of silence, 2 s of voice, 1 s of silence.
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=0.8', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2:sample_rate=44100', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=1', '-filter_complex', '[1]aformat=channel_layouts=stereo[s];[0][s][2]concat=n=3:v=0:a=1', recording]);
  const result = await importNarration(dir, { screen: 'accueil', line: 'l3', file: recording });
  assert.equal(result.audio, 'assets/narration/fr/accueil/l3.m4a');
  const sidecar = readJSON(dir, 'assets/narration/fr/accueil/l3.json');
  assert.equal(sidecar.provider, 'recording');
  assert.equal(sidecar.generated, false);
  assert.equal(sidecar.textHash, narrationTextHash('Ça bloque toute la comptabilité !'));
  assert.ok(sidecar.duration > 2 && sidecar.duration < 2.4, `trimmed: ${sidecar.duration} s`);
  const timing = screenTiming(loadProjectFromDir(dir), 'accueil')!;
  assert.equal(timing.lines[2].estimated, false);
  assert.equal(narrationLines(loadProjectFromDir(dir), 'accueil')![2].status, 'ok');
});

test('course state: timeline.reached matches its line and edge', () => {
  const course = {
    screens: [{ id: 's', key: '1', section: 'a', title: 'S', showTitle: true, required: true, completeWhen: 'viewed', covers: [], blocks: [], layers: [], events: [
      { id: 'start', on: { type: 'timeline.reached', at: { line: 'l2' } }, do: [{ type: 'complete-screen' }] },
      { id: 'end', on: { type: 'timeline.reached', at: { line: 'l2', edge: 'end' } }, do: [{ type: 'exit-course' }] }
    ] }],
    variables: [], completion: { reportAs: 'completed-incomplete' }
  } as unknown as CourseData;
  const state = createCourseState(course);
  const screen = course.screens[0];
  assert.deepEqual(state.eventsFor(screen, 'timeline.reached', { line: 'l2', edge: 'start' }).map((run) => run.event), ['start']);
  assert.deepEqual(state.eventsFor(screen, 'timeline.reached', { line: 'l2', edge: 'end' }).map((run) => run.event), ['end']);
  assert.deepEqual(state.eventsFor(screen, 'timeline.reached', { line: 'l1', edge: 'start' }), []);
});

test('LESSON.md: a decorative sound has no transcript to export; narration is reported as lost', () => {
  const dir = narrated({ audio: false });
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.blocks.push({ id: 'ambiance', type: 'audio', props: { asset: 'audio/ambiance.m4a', title: 'Ambiance', decorative: true } });
  writeJSON(dir, 'screens/chemin.json', screen);
  const exported = lessonMdExport(loadProjectFromDir(dir));
  const text = [...exported.output.values()].join('\n');
  assert.ok(!text.includes('undefined'), 'no "Transcription undefined"');
  assert.ok(exported.losses.some((loss) => /narration \(3 lines/.test(loss.loss)), JSON.stringify(exported.losses));
});

test('pronunciations: whole words, case-sensitive, the longest first, the line\'s before the course\'s', () => {
  assert.equal(applyPronunciations('La P-12 et la P-120, pas la p-12.', [{ text: 'P-12', say: 'pé douze' }, { text: 'P-120', say: 'pé cent vingt' }]), 'La pé douze et la pé cent vingt, pas la p-12.');
  assert.equal(applyPronunciations('RDV à 9 h 30.', [{ text: '9 h 30', say: 'neuf heures trente' }, { text: 'h', say: 'ache' }]), 'RDV à neuf heures trente.');
  const course = { pronunciations: { fr: [{ text: 'P-12', say: 'pé douze' }] } } as unknown as Course;
  assert.equal(spokenTextOf(course, { pronunciations: { fr: [{ text: 'P-12', say: 'la pièce douze' }] } }, 'Prenez la P-12.', 'fr'), 'Prenez la la pièce douze.');
  assert.equal(spokenTextOf(course, {}, 'Prenez la P-12.', 'en'), 'Prenez la P-12.', 'each language has its own list');
});

test('a generated voice remembers what it was told to say and how: another pronunciation or delivery makes it out of date, another model does not', { skip: NO_FFMPEG }, async () => {
  const dir = narrated({ audio: false });
  const course = readJSON(dir, 'course.json');
  course.speakers[0].voices = { fr: { provider: 'pocket-tts', voice: 'camille', settings: { speed: 1 } } };
  writeJSON(dir, 'course.json', course);
  const tone = path.join(dir, 'tone.m4a');
  toneM4a(tone, 1.2);
  await setNarrationAudio(dir, { screen: 'accueil', line: 'l1', file: tone, provider: 'pocket-tts', voice: 'camille', generated: true, take: 2, credit: 'Voix de synthèse Pocket TTS (Kyutai, CC-BY 4.0)', model: 'pocket-tts/french@1' });
  const sidecar = readJSON(dir, 'assets/narration/fr/accueil/l1.json');
  assert.equal(sidecar.take, 2);
  assert.equal(sidecar.model, 'pocket-tts/french@1');
  assert.match(sidecar.spokenHash, /^sha256:/);
  assert.match(sidecar.settingsHash, /^sha256:/);
  const status = () => narrationLines(loadProjectFromDir(dir), 'accueil')![0];
  assert.equal(status().status, 'ok');
  assert.equal(spokenText(loadProjectFromDir(dir), 'accueil', 'l1')?.spoken, 'Bonjour, voici le ticket de Marc.');
  // Another model: nothing to do.
  writeJSON(dir, 'assets/narration/fr/accueil/l1.json', { ...sidecar, model: 'pocket-tts/french@2' });
  assert.equal(status().status, 'ok');
  // A pronunciation for a word of the line (the course's lexicon): out of date.
  course.pronunciations = { fr: [{ text: 'Marc', say: 'Marque' }] };
  writeJSON(dir, 'course.json', course);
  assert.equal(status().status, 'stale');
  assert.match(status().reasons.join(), /pronunciation/);
  assert.equal(spokenText(loadProjectFromDir(dir), 'accueil', 'l1')?.spoken, 'Bonjour, voici le ticket de Marque.');
  delete course.pronunciations;
  writeJSON(dir, 'course.json', course);
  // The line said faster: out of date.
  edit.updateNarrationLine(dir, { screen: 'accueil', line: 'l1', delivery: { fr: { speed: 1.1 } } });
  assert.match(status().reasons.join(), /delivery/);
  // The credits of the voices reach the build report and the proof dossier.
  edit.updateNarrationLine(dir, { screen: 'accueil', line: 'l1', delivery: null });
  for (const line of ['l2', 'l3']) await setNarrationAudio(dir, { screen: 'accueil', line, file: tone, provider: 'recording', voice: '', generated: false });
  const built = await build(dir, { out: path.join(dir, 'dist'), writeLock: false });
  assert.ok(built.ok);
  assert.deepEqual(built.report.narration?.credits, ['Voix de synthèse Pocket TTS (Kyutai, CC-BY 4.0)']);
  assert.match(fs.readFileSync(built.reportPath.replace(/\.report\.json$/, '.proof.md'), 'utf8'), /Voix de synthèse Pocket TTS \(Kyutai, CC-BY 4\.0\)/);
});

// Credits of CC-BY voices name their sources and licence by address: the player makes them links.
test('credits: their web addresses become links, without the punctuation that ends them', () => {
  const credit = 'Pocket TTS, https://huggingface.co/kyutai/pocket-tts, CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/) ; voix de Kyutai (CC0), https://huggingface.co/kyutai/tts-voices.';
  assert.deepEqual(textAndAddresses(credit), [
    { text: 'Pocket TTS, ' }, { href: 'https://huggingface.co/kyutai/pocket-tts' },
    { text: ', CC-BY 4.0 (' }, { href: 'https://creativecommons.org/licenses/by/4.0/' },
    { text: ') ; voix de Kyutai (CC0), ' }, { href: 'https://huggingface.co/kyutai/tts-voices' }, { text: '.' }
  ]);
  assert.deepEqual(textAndAddresses('Voix de synthèse : sinusoïdes de test (domaine public).'), [{ text: 'Voix de synthèse : sinusoïdes de test (domaine public).' }]);
  assert.deepEqual(textAndAddresses('http://example.com is not linked'), [{ text: 'http://example.com is not linked' }]);
});
