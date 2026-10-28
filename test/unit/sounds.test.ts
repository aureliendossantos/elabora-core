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
import { interfaceSounds, courseHasSound } from '@elabora/core/sounds/sounds';
import { INTERFACE_ROLES, PLAYER_INTERFACE_SOUNDS } from '@elabora/player/sound-roles';
import { ROOT, copyExample, readJSON, writeJSON, codes } from '../helpers.ts';

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
    assert.ok(bytes.length > 1000 && bytes.length < 20000, `${role}.m4a: ${bytes.length} bytes`);
    assert.equal(bytes.subarray(4, 8).toString('latin1'), 'ftyp', `${role}.m4a is an MP4 file`);
  }
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
  assert.equal('sounds' in compiled(off), false);
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
