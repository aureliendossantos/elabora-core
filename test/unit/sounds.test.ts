import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZip } from '@elabora/node/zip';
import { build } from '@elabora/node/build';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { interfaceSounds, courseHasSound, soundCreditsText, PLAYER_SOUND_CREDITS } from '@elabora/core/sounds/sounds';
import { INTERFACE_ROLES, PLAYER_INTERFACE_SOUNDS } from '@elabora/player/sound-roles';
import { execFileSync } from 'node:child_process';
import * as edit from '@elabora/node/edit';
import { classifyLicence, soundCredit } from '@elabora/core/sounds/licences';
import { screenVoiceLines } from '@elabora/core/narration/voice-lines';
import { screenTimeline } from '@elabora/core/narration/timeline';
import { extractUnits as translationUnits } from '@elabora/core/i18n/units';
import { findDialogue as findDialogueBlock, projectDialogue } from '@elabora/core/dialogue/project';
import { playDialogue } from '@elabora/core/dialogue/play';
import { dialogueScript, formatScript } from '@elabora/core/dialogue/script';
import type { DialogueData } from '@elabora/player/dialogue/types';
import { ROOT, copyExample, readJSON, writeJSON, codes } from '../helpers.ts';
import { FFMPEG, hasFfmpeg, narrate } from '../narration.ts';

const QUIET = path.join(ROOT, 'examples/coffee-in-brief');
const VOICED = path.join(ROOT, 'examples/phishing-by-numbers');
const PLAYER_SOUNDS = path.join(ROOT, 'packages/player/src/interface-sounds');

const compiled = (dir: string) => {
  const project = loadProjectFromDir(dir);
  return compileCourseData(project, assignKeys(project, readLock(project)).keys, { buildId: 'test' });
};
const setInterface = (dir: string, settings: unknown) => {
  const course = readJSON(dir, 'course.json');
  course.sounds = { interface: settings };
  writeJSON(dir, 'course.json', course);
};

test('the player package has a file for each interface sound it names, as sources.json says', () => {
  const sources = JSON.parse(fs.readFileSync(path.join(PLAYER_SOUNDS, 'sources.json'), 'utf8'));
  assert.deepEqual(Object.keys(sources.roles).sort(), [...PLAYER_INTERFACE_SOUNDS].sort());
  for (const role of PLAYER_INTERFACE_SOUNDS) {
    assert.ok(INTERFACE_ROLES.includes(role), role);
    const bytes = fs.readFileSync(path.join(PLAYER_SOUNDS, `${role}.m4a`));
    // Short and light: the end's jingle, the longest (2.8 s), weighs 35 KB; the others a few.
    assert.ok(bytes.length > 1000 && bytes.length < (role === 'end' ? 40000 : 20000), `${role}.m4a: ${bytes.length} bytes`);
    // A role made from a library master is credited to its author, not to Kenney's pack.
    if ('library' in sources.roles[role]) assert.ok(PLAYER_SOUND_CREDITS[`elabora/sounds/${role}.m4a`], `${role}: a credit in PLAYER_SOUND_CREDITS`);
    assert.equal(bytes.subarray(4, 8).toString('latin1'), 'ftyp', `${role}.m4a is an MP4 file`);
  }
});

test('CREDITS.txt credits each interface sound to its own author: the end jingle to Fupicat, the others to Kenney', () => {
  const project = loadProjectFromDir(QUIET);
  const text = soundCreditsText(project, { interface: { files: { good: 'elabora/sounds/good.m4a', end: 'elabora/sounds/end.m4a' } } } as never, (name) => name) ?? '';
  assert.match(text, /elabora\/sounds\/end\.m4a\n {2}« WinBanjo » by Fupicat/);
  assert.match(text, /elabora\/sounds\/good\.m4a\n {2}Interface Sounds 1\.0 by Kenney/);
});

test('interface sounds: on by themselves when the module has sound, never in a silent one', () => {
  const quiet = loadProjectFromDir(QUIET);
  assert.equal(courseHasSound(quiet), false);
  assert.equal(interfaceSounds(quiet).active, false);
  assert.equal('sounds' in compiled(QUIET), false, 'a course without sound keeps its course data');

  const voiced = loadProjectFromDir(VOICED);
  assert.equal(courseHasSound(voiced), true, 'its voices are there');
  const data = compiled(VOICED);
  assert.deepEqual(data.sounds?.interface?.volume, 0.5);
  assert.deepEqual(Object.keys(data.sounds?.interface?.files ?? {}).sort(), [...PLAYER_INTERFACE_SOUNDS].sort());
  assert.equal(data.sounds?.interface?.files.good, 'elabora/sounds/good.m4a');

  const off = copyExample(VOICED);
  setInterface(off, { when: 'off' });
  const silent = compiled(off);
  assert.equal(silent.sounds?.interface, undefined);
  assert.deepEqual(Object.keys(silent.sounds?.files ?? {}), ['sonnerie'], 'its phone still rings');
});

test('interface sounds: on for a silent module that asks, a role muted or replaced by a sound of the course', () => {
  const dir = copyExample(QUIET);
  setInterface(dir, { when: 'on', volume: 0.3, replace: { bad: null, good: 'ding' } });
  let data = compiled(dir);
  assert.equal(data.sounds?.interface?.volume, 0.3);
  assert.equal(data.sounds?.interface?.files.bad, undefined, 'muted');
  assert.equal(data.sounds?.interface?.files.good, undefined, 'its sound is not there');
  assert.ok(codes(validateDir(dir).diagnostics).includes('E_SOUND_MISSING'));

  fs.mkdirSync(path.join(dir, 'assets/sounds'), { recursive: true });
  fs.copyFileSync(path.join(PLAYER_SOUNDS, 'good.m4a'), path.join(dir, 'assets/sounds/ding.m4a'));
  data = compiled(dir);
  assert.equal(data.sounds?.interface?.files.good, 'assets/sounds/ding.m4a');
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_SOUND_MISSING'));
});

test('a package ships the interface sounds its course data names, and none without them', async () => {
  const dir = copyExample(QUIET);
  setInterface(dir, { when: 'on', replace: { back: null } });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sounds-'));
  const built = await build(dir, { out });
  assert.ok(built.ok && built.zipPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error')));
  const { files } = readZip(fs.readFileSync(built.zipPath));
  const shipped = [...files.keys()].filter((name) => name.startsWith('elabora/sounds/')).sort();
  assert.deepEqual(shipped, PLAYER_INTERFACE_SOUNDS.filter((role) => role !== 'back').map((role) => `elabora/sounds/${role}.m4a`).sort());
  assert.deepEqual(files.get('elabora/sounds/good.m4a'), fs.readFileSync(path.join(PLAYER_SOUNDS, 'good.m4a')));
  assert.match(files.get('imsmanifest.xml')!.toString(), /elabora\/sounds\/good\.m4a/);

  const quiet = await build(copyExample(QUIET), { out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sounds-')) });
  assert.ok(quiet.ok && quiet.zipPath);
  assert.ok(![...readZip(fs.readFileSync(quiet.zipPath)).files.keys()].some((name) => name.startsWith('elabora/sounds/')));
});

// ── Sounds of the story (D67) ──

const tone = (file: string, seconds: number, codec: 'flac' | 'aac' = 'flac', frequency = 660) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}:sample_rate=44100`, '-ac', '1', ...(codec === 'flac' ? ['-c:a', 'flac'] : ['-c:a', 'aac', '-b:a', '96k']), '-fflags', '+bitexact', '-map_metadata', '-1', file]);
};
const addSound = (dir: string, id: string, sidecar: Record<string, unknown> | null, seconds = 1) => {
  tone(path.join(dir, `assets/sounds/${id}.flac`), seconds);
  if (sidecar) writeJSON(dir, `assets/sounds/${id}.json`, sidecar);
};
const playOnEnter = (dir: string, screen: string, action: Record<string, unknown>) => {
  const data = readJSON(dir, `screens/${screen}.json`);
  data.events = [...(data.events ?? []), { id: `sound-${String(action.sound)}`, on: { type: 'screen.enter' }, do: [{ type: 'play-sound', ...action }] }];
  writeJSON(dir, `screens/${screen}.json`, data);
};
const RINGING = { title: 'Telephone ringing', source: 'wikimedia', url: 'https://commons.wikimedia.org/wiki/File:Ring.ogg', author: 'Jane Doe', license: 'CC-BY-4.0', modified: ['trimmed'], duration: 1 };

test('licences: CC0, public domain, CC BY and BY-SA ship; NC, ND and unknown do not; a CC BY sound gets its credit line', () => {
  for (const [value, kind] of [['CC0-1.0', 'cc0'], ['cc0', 'cc0'], ['PDM-1.0', 'public-domain'], ['CC BY 4.0', 'by'], ['CC-BY-SA-3.0', 'by-sa'], ['own', 'own']] as const) {
    const licence = classifyLicence(value);
    assert.ok(licence.ok && licence.kind === kind, `${value}: ${JSON.stringify(licence)}`);
  }
  for (const [value, refusal] of [['CC-BY-NC-4.0', 'non-commercial'], ['CC BY-ND 4.0', 'no-derivatives'], ['CC-BY-NC-SA-4.0', 'non-commercial'], ['Sampling+', 'unknown'], ['', 'unknown']] as const) {
    const licence = classifyLicence(value);
    assert.ok(!licence.ok && licence.refusal === refusal, `${value}: ${JSON.stringify(licence)}`);
  }
  assert.equal(soundCredit(RINGING as never, 'fr'), '“Telephone ringing”, Jane Doe — CC BY 4.0, modifié — https://commons.wikimedia.org/wiki/File:Ring.ogg');
  assert.equal(soundCredit({ ...RINGING, credit: 'Sonnerie : Jane Doe (CC BY)' } as never, 'fr'), 'Sonnerie : Jane Doe (CC BY)');
  assert.equal(soundCredit({ license: 'CC0-1.0' } as never, 'fr'), null);
});

test('sound checks: a missing sound, an unknown or refused licence, a CC BY credit the player hides', { skip: !hasFfmpeg() && 'ffmpeg not found' }, () => {
  const dir = copyExample(QUIET);
  addSound(dir, 'ring', RINGING);
  addSound(dir, 'nc', { license: 'CC-BY-NC-4.0' });
  addSound(dir, 'bare', null);
  for (const sound of ['ring', 'nc', 'bare', 'nowhere']) playOnEnter(dir, 'the-cherry', { sound });
  let found = validateDir(dir).diagnostics;
  const of = (code: string) => found.filter((d) => d.code === code).map((d) => d.target).sort();
  assert.deepEqual(of('E_SOUND_MISSING'), ['nowhere']);
  assert.deepEqual(of('E_SOUND_LICENSE'), ['bare', 'nc']);
  assert.deepEqual(of('W_SOUND_CREDITS_HIDDEN'), []);
  edit.updatePlayer(dir, { disable: ['credits'] });
  found = validateDir(dir).diagnostics;
  assert.deepEqual(of('W_SOUND_CREDITS_HIDDEN'), [undefined]);
});

test('sound checks: a part outside its file or ending before it starts, a duck asked of an ambience (schemas 0.1.7)', { skip: !hasFfmpeg() && 'ffmpeg not found' }, () => {
  const dir = copyExample(QUIET);
  addSound(dir, 'ring', RINGING, 2);
  playOnEnter(dir, 'the-cherry', { sound: 'ring', start: 0.4, end: 1.6, volume: 1.8, fadeOut: 0.3, duck: 12 });
  const course = readJSON(dir, 'course.json');
  course.sounds = { background: [{ sound: 'ring', from: 'the-cherry', start: 0.5, end: 1.5, volume: 1.5 }] };
  writeJSON(dir, 'course.json', course);
  const found = () => validateDir(dir).diagnostics.filter((d) => d.code === 'E_SOUND_PART' || d.code === 'W_SOUND_DUCK_LOOP').map((d) => `${d.code} ${d.path} ${d.message}`);
  assert.deepEqual(found(), [], 'a part inside the file, a duck on a sound played once, 200 % at most: valid');
  const screen = readJSON(dir, 'screens/the-cherry.json');
  screen.events.at(-1).do[0] = { type: 'play-sound', sound: 'ring', start: 1.2, end: 0.8 };
  screen.events.push({ id: 'rain', on: { type: 'screen.enter' }, do: [{ type: 'play-sound', sound: 'ring', loop: true, duck: 6, start: 3 }] });
  writeJSON(dir, 'screens/the-cherry.json', screen);
  course.sounds.background[0].end = 2.5;
  writeJSON(dir, 'course.json', course);
  const events = (screen.events as unknown[]).length;
  assert.deepEqual(found().sort(), [
    `E_SOUND_PART /events/${events - 2}/do/0/end A play-sound action plays "ring" from 1.2 s to 0.8 s: nothing lies between.`,
    `E_SOUND_PART /events/${events - 1}/do/0/start A play-sound action plays "ring" from 3 s, and it lasts 2 s.`,
    'E_SOUND_PART /sounds/background/0/end A track of music or ambience plays "ring" up to 2.5 s, and it lasts 2 s.',
    `W_SOUND_DUCK_LOOP /events/${events - 1}/do/0/duck An ambience of "ring" asks to lower the music and the ambiences (duck 6 dB): it is one of them, and it plays for the whole screen, so it never does.`
  ].sort());
  screen.events.at(-1).do[0].volume = 2.5;
  writeJSON(dir, 'screens/the-cherry.json', screen);
  assert.ok(validateDir(dir).diagnostics.some((d) => d.code === 'E_SCHEMA' && /volume/.test(`${d.path}`)), 'above 200 %: refused by the schema');
});

test('a sound of the story: a FLAC master ships as M4A at every quality, in the course data, « IA et crédits » and CREDITS.txt', { skip: !hasFfmpeg() && 'ffmpeg not found' }, async () => {
  const dir = copyExample(QUIET);
  addSound(dir, 'ring', RINGING, 1.5);
  playOnEnter(dir, 'the-cherry', { sound: 'ring', caption: 'The phone rings.', volume: 0.8 });
  const project = loadProjectFromDir(dir);
  const master = project.files.get('assets/sounds/ring.flac');
  assert.equal(master?.kind === 'binary' && master.media?.conformant, true, 'a FLAC sound is a master as it is');
  assert.equal(courseHasSound(project), true, 'a sound of the story is sound: interface sounds are on');
  const built = await build(dir, { out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sounds-')) });
  assert.ok(built.ok && built.zipPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error')));
  const { files } = readZip(fs.readFileSync(built.zipPath));
  assert.ok(files.has('assets/sounds/ring.m4a') && !files.has('assets/sounds/ring.flac'), [...files.keys()].filter((name) => name.includes('sound')).join(', '));
  const course = JSON.parse(files.get('elabora/course.js')!.toString().replace(/^window\.ELABORA_COURSE = /, '').replace(/;\n$/, ''));
  assert.deepEqual(course.sounds.files.ring, { src: 'assets/sounds/ring.m4a', duration: 1.5 });
  assert.ok(course.sounds.interface, 'interface sounds on');
  assert.ok(course.about.credits.includes('“Telephone ringing”, Jane Doe — CC BY 4.0, modified — https://commons.wikimedia.org/wiki/File:Ring.ogg'), JSON.stringify(course.about));
  const credits = files.get('CREDITS.txt')!.toString();
  assert.match(credits, /assets\/sounds\/ring\.m4a\n {2}“Telephone ringing” by Jane Doe — CC-BY-4\.0 — https:\/\/commons/);
  assert.match(credits, /elabora\/sounds\/good\.m4a/);
  assert.match(credits, /Modified: trimmed\./);
  // Its caption is a unit of translation.
  assert.ok(translationUnits(project).some((unit) => unit.id === 'screen.the-cherry.event.sound-ring.do.0.caption' && unit.text === 'The phone rings.'));
});

test('a sound line in a narration: its place and length on the timeline, its caption, its sound in the track', { skip: !hasFfmpeg() && 'ffmpeg not found' }, async () => {
  const dir = copyExample(QUIET);
  addSound(dir, 'ring', { license: 'CC0-1.0' }, 2);
  narrate(dir, 'the-cherry', [{ id: 'l1', text: 'Hello there.', seconds: 1 }, { id: 'l2', text: 'Who is it?', seconds: 1 }]);
  const screen = readJSON(dir, 'screens/the-cherry.json');
  screen.narration.lines.splice(1, 0, { id: 'ring', sound: 'ring', caption: 'The phone rings.', pauseBefore: 0.2 });
  writeJSON(dir, 'screens/the-cherry.json', screen);
  assert.deepEqual(codes(validateDir(dir).diagnostics).filter((code) => code.startsWith('E_')), []);
  const project = loadProjectFromDir(dir);
  assert.deepEqual(screenVoiceLines(project, 'the-cherry').map((entry) => entry.line.id), ['l1', 'l2'], 'no voice says a sound');
  const timeline = screenTimeline(project, 'the-cherry')!;
  assert.deepEqual(timeline.lines.map((line) => line.id), ['l1', 'ring', 'l2']);
  const ring = timeline.lines[1];
  assert.ok(Math.abs(ring.end - ring.start - 2) < 0.05, `${ring.start} → ${ring.end}`);
  assert.equal(ring.cues[0]?.text, 'The phone rings.');
  assert.ok(translationUnits(project).some((unit) => unit.id === 'screen.the-cherry.narration.ring.caption'));

  const built = await build(dir, { out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sounds-')) });
  assert.ok(built.ok && built.zipPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error')));
  const { files } = readZip(fs.readFileSync(built.zipPath));
  const course = JSON.parse(files.get('elabora/course.js')!.toString().replace(/^window\.ELABORA_COURSE = /, '').replace(/;\n$/, ''));
  const narration = course.screens.find((candidate: { id: string }) => candidate.id === 'the-cherry').narration;
  assert.ok(narration.src, 'a track: every line has its audio');
  assert.deepEqual(narration.lines.map((line: { id: string; sound?: true; speaker: string | null }) => [line.id, !!line.sound, line.speaker === null]), [['l1', false, false], ['ring', true, true], ['l2', false, false]]);
  assert.ok(narration.duration > 4, `${narration.duration}: two lines of a second and a sound of two`);
  assert.match(files.get('narration/the-cherry.vtt')!.toString(), /The phone rings\./);
  assert.ok(!files.has('assets/sounds/ring.m4a'), 'its sound is in the track: no file of its own');
});

test('a sound line in a dialogue: compiled with its length, played as a beat of its own, in the script, the path and the translation', { skip: !hasFfmpeg() && 'ffmpeg not found' }, () => {
  const dir = copyExample(VOICED);
  const screen = readJSON(dir, 'screens/practice.json');
  const dialogue = JSON.stringify(screen).includes('"bank-call"') ? findDialogue(screen) : null;
  assert.ok(dialogue);
  dialogue.props.nodes[0].lines.unshift({ id: 'ring-first', sound: 'sonnerie', caption: 'The phone rings.' });
  writeJSON(dir, 'screens/practice.json', screen);
  assert.deepEqual(codes(validateDir(dir).diagnostics).filter((code) => code.startsWith('E_')), []);
  const data = compiled(dir);
  const props = data.screens.find((entry) => entry.id === 'practice')!.blocks.find((block) => block.id === 'bank-call')!.props as unknown as DialogueData;
  const ring = props.nodes[0]!.lines[0]!;
  assert.deepEqual({ ...ring, duration: Math.round((ring as { duration?: number }).duration! * 100) / 100 }, { id: 'ring-first', sound: 'sonnerie', caption: 'The phone rings.', duration: 1.15 });
  assert.ok(data.sounds?.files?.sonnerie, 'shipped');
  const project = loadProjectFromDir(dir);
  const ref = findDialogueBlock(project, 'bank-call')!;
  const raw = projectDialogue(project, ref);
  const played = playDialogue(project, ref, []);
  assert.deepEqual(played.steps[0], { kind: 'sound', node: 'call', text: '(sound sonnerie: The phone rings.)', line: 'ring-first', sound: 'sonnerie' });
  assert.match(formatScript(dialogueScript(raw, { id: 'bank-call', screen: 'practice' })), /sound sonnerie[^\n]*The phone rings\./);
  assert.ok(translationUnits(project).some((unit) => unit.id === 'block.bank-call.nodes.call.lines.ring-first.caption' && unit.text === 'The phone rings.'));
  assert.ok(translationUnits(project).some((unit) => unit.id === 'block.bank-call.nodes.call.lines.dana-call.text'), 'the voice lines still translate');
  assert.ok(!screenVoiceLines(project, 'practice').some((line) => line.line.id === 'ring-first'), 'no voice for a sound');
});

function findDialogue(value: unknown): { props: { nodes: { lines: unknown[] }[] } } | null {
  if (Array.isArray(value)) { for (const item of value) { const found = findDialogue(item); if (found) return found; } return null; }
  if (!value || typeof value !== 'object') return null;
  if ((value as { type?: unknown }).type === 'dialogue') return value as { props: { nodes: { lines: unknown[] }[] } };
  for (const item of Object.values(value)) { const found = findDialogue(item); if (found) return found; }
  return null;
}
