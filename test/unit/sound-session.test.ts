import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { openProject } from '@elabora/engine';
import type { OpenOptions, Session } from '@elabora/engine';
import { librarySounds } from '@elabora/node/sounds/library';
import { searchSounds, soundPreview } from '@elabora/node/sounds/search';
import { forgetQuota } from '@elabora/node/voice/elevenlabs/costs';
import { soundCredits } from '@elabora/node/sounds/generate';
import { ROOT, copyExample, readJSON } from '../helpers.ts';
import { FFMPEG, hasFfmpeg } from '../narration.ts';

// The sounds of an editing session (D67), as the app's sound browser uses them: another library
// (the app's, CC BY) beside « Sons courants », a sound heard before it is added, add_sound and the
// sound lines of a narration as changes ⌘Z undoes, the module's sounds, a sound made with ElevenLabs.

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg not found';
const QUIET: OpenOptions = { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 };
const EXAMPLE = path.join(ROOT, 'examples/coffee-in-brief');
const temporary: string[] = [];
const sessions: Session[] = [];
let server: http.Server;
let mp3: Buffer;
const saved = { libraries: process.env.ELABORA_SOUND_LIBRARIES, eleven: process.env.ELABORA_ELEVENLABS_URL, key: process.env.ELEVENLABS_API_KEY };

// A library of one CC BY sound, as the app keeps its own.
function appLibrary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-app-sounds-'));
  temporary.push(dir);
  fs.mkdirSync(path.join(dir, 'files'));
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=1.5:sample_rate=44100', '-c:a', 'flac', path.join(dir, 'files/vraie-sonnerie.flac')]);
  fs.writeFileSync(path.join(dir, 'catalogue.json'), JSON.stringify({ sounds: [{
    id: 'vraie-sonnerie', title: { en: 'Real desk phone ring', fr: 'Téléphone fixe, vraie sonnerie' }, category: 'telephone', kind: 'effect', file: 'files/vraie-sonnerie.flac',
    format: 'flac', channels: 1, sampleRate: 44100, duration: 1.5, bytes: 1, hash: 'sha256:0', source: 'freesound', url: 'https://freesound.org/s/345812/', author: 'knufds',
    license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', checked: '2026-10-29', credit: '“Office phone ring” by knufds — CC BY 4.0, shortened',
    caption: { fr: 'Le téléphone sonne.', en: 'The phone rings.' }, tags: ['telephone', 'ring']
  }] }));
  return dir;
}

async function open(): Promise<{ dir: string; session: Session }> {
  const dir = copyExample(EXAMPLE);
  temporary.push(dir);
  const session = await openProject(dir, QUIET);
  sessions.push(session);
  await session.flush();
  return { dir, session };
}

before(async () => {
  if (hasFfmpeg()) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sound-session-'));
    temporary.push(work);
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2:sample_rate=44100', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(work, 'g.mp3')]);
    mp3 = fs.readFileSync(path.join(work, 'g.mp3'));
  }
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/v1/user') { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ subscription: { tier: 'starter', character_count: 1000, character_limit: 30000 } })); }
      if (request.url?.startsWith('/v1/sound-generation')) { response.writeHead(200, { 'content-type': 'audio/mpeg', 'character-cost': String(Math.ceil(40 * (JSON.parse(body).duration_seconds ?? 5))) }); return response.end(mp3); }
      response.writeHead(404); response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ELABORA_ELEVENLABS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ELEVENLABS_API_KEY = 'sk_test_sound_session_0123456789';
});
after(async () => {
  for (const session of sessions) await session.close().catch(() => {});
  server.close();
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, name] of [['libraries', 'ELABORA_SOUND_LIBRARIES'], ['eleven', 'ELABORA_ELEVENLABS_URL'], ['key', 'ELEVENLABS_API_KEY']] as const) {
    if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
  forgetQuota();
});

test('another library joins « Sons courants »: searched with it, heard, added with its credit; the core\'s own ids come first', { skip: NO_FFMPEG }, async () => {
  const core = librarySounds().length;
  process.env.ELABORA_SOUND_LIBRARIES = appLibrary();
  try {
    assert.equal(librarySounds().length, core + 1);
    const found = await searchSounds({ source: 'library', text: 'sonnerie', language: 'fr' });
    const own = found.find((sound) => sound.from === 'vraie-sonnerie');
    assert.ok(own, found.map((sound) => sound.from).join(', '));
    assert.equal(own.label, 'Téléphone fixe, vraie sonnerie');
    assert.equal(own.license, 'CC-BY-4.0');
    assert.match(own.credit ?? '', /knufds/);
    assert.ok(found.some((sound) => sound.from === 'telephone-fixe'), 'the core\'s library is searched too');
    const heard = await soundPreview('vraie-sonnerie');
    assert.equal(heard.type, 'audio/flac');
    assert.ok(heard.audio.byteLength > 1000);

    const { dir, session } = await open();
    const added = await session.run('add_sound', { from: 'vraie-sonnerie' });
    assert.equal(added.result.id, 'vraie-sonnerie');
    const sidecar = readJSON(dir, 'assets/sounds/vraie-sonnerie.json');
    assert.equal(sidecar.license, 'CC-BY-4.0');
    assert.match(sidecar.credit, /knufds/);
    assert.equal(sidecar.author, 'knufds');
    const sounds = session.courseSounds();
    const sound = sounds.find((candidate) => candidate.id === 'vraie-sonnerie')!;
    assert.equal(sound.author, 'knufds');
    assert.deepEqual(sound.caption, { fr: 'Le téléphone sonne.', en: 'The phone rings.' });
  } finally {
    delete process.env.ELABORA_SOUND_LIBRARIES;
  }
  assert.equal(librarySounds().length, core, 'without the variable, the core\'s library alone');
});

test('a sound line through the engine: added after a line, its caption and volume changed, moved, removed, each undone', { skip: NO_FFMPEG }, async () => {
  const { dir, session } = await open();
  const screen = 'the-cherry';
  const first = await session.run('add_narration_line', { screen, line: { text: 'Hello there.' } });
  const line = String(first.result.line);
  await session.run('add_sound', { from: 'telephone-fixe', trim: { start: 0, end: 1.2 } });
  const ring = await session.run('add_narration_line', { screen, after: line, line: { sound: 'telephone-fixe', step: 1 } });
  const id = String(ring.result.line);
  let lines = readJSON(dir, `screens/${screen}.json`).narration.lines;
  assert.deepEqual(lines.map((entry: { id: string }) => entry.id), [line, id]);
  assert.equal(lines[1].sound, 'telephone-fixe');

  const view = session.narration(screen)!;
  const shown = view.lines.find((entry) => entry.id === id)!;
  assert.deepEqual(shown.sound, { id: 'telephone-fixe', volume: 1 });
  assert.ok(Math.abs((shown.duration ?? 0) - 1.2) < 0.05, String(shown.duration));

  await session.run('update_narration_line', { screen, line: id, caption: 'Le téléphone sonne.', volume: 0.8 });
  lines = readJSON(dir, `screens/${screen}.json`).narration.lines;
  assert.equal(lines[1].caption, 'Le téléphone sonne.');
  assert.equal(lines[1].volume, 0.8);
  await assert.rejects(session.run('update_narration_line', { screen, line: id, text: 'No.' }), /is a sound/);
  await assert.rejects(session.run('update_narration_line', { screen, line, caption: 'No.' }), /voice's/);
  await session.run('update_narration_line', { screen, line: id, caption: '' });
  assert.equal(readJSON(dir, `screens/${screen}.json`).narration.lines[1].caption, undefined, 'an empty caption is none');

  await session.run('move_narration_line', { screen, line: id, after: null });
  assert.deepEqual(readJSON(dir, `screens/${screen}.json`).narration.lines.map((entry: { id: string }) => entry.id), [id, line]);
  await session.undo();
  assert.deepEqual(readJSON(dir, `screens/${screen}.json`).narration.lines.map((entry: { id: string }) => entry.id), [line, id]);

  await session.run('remove_narration_line', { screen, line: id });
  assert.deepEqual(readJSON(dir, `screens/${screen}.json`).narration.lines.map((entry: { id: string }) => entry.id), [line]);
  assert.ok(fs.existsSync(path.join(dir, 'assets/sounds/telephone-fixe.flac')), 'the sound stays in the module');

  await session.run('update_course', { sounds: { interface: { when: 'on', volume: 0.4, replace: { bad: null } }, background: [{ sound: 'telephone-fixe', from: screen }] } });
  assert.deepEqual(readJSON(dir, 'course.json').sounds.interface, { when: 'on', volume: 0.4, replace: { bad: null } });
});

test('a sound made with ElevenLabs through the engine: added by add_sound in the session\'s queue, one change', { skip: NO_FFMPEG }, async () => {
  forgetQuota();
  const { dir, session } = await open();
  const estimate = await session.soundEstimate({ duration: 3 });
  assert.equal(estimate.credits, soundCredits(3, 'starter'), 'the ledger\'s price of 3 s on a Starter plan');
  assert.equal(estimate.needsApproval, false, 'well under 1 % of a Starter plan');
  const made = await session.generateSound({ prompt: 'A ship bell rings twice', duration: 3 });
  assert.equal(made.cached, false);
  assert.ok(made.change, 'one change');
  const sidecar = readJSON(dir, `assets/sounds/${made.id}.json`);
  assert.equal(sidecar.license, 'generated');
  assert.equal(sidecar.generated.provider, 'elevenlabs');
  await session.undo();
  assert.ok(!fs.existsSync(path.join(dir, made.path)), 'undone');
});

test('« Placer dans le script »: the sound and its line in one change, undone together', { skip: NO_FFMPEG }, async () => {
  const { dir, session } = await open();
  const screen = 'the-cherry';
  const first = await session.run('add_narration_line', { screen, line: { text: 'Hello there.' } });
  const placed = await session.run('add_sound', { from: 'telephone-fixe', line: { screen, after: null, step: 1, caption: ' Le téléphone sonne. ' } });
  const lines = readJSON(dir, `screens/${screen}.json`).narration.lines;
  assert.deepEqual(lines.map((entry: { id: string }) => entry.id), [placed.result.line, first.result.line]);
  assert.deepEqual(lines[0], { sound: 'telephone-fixe', step: 1, caption: 'Le téléphone sonne.', id: placed.result.line });
  await session.undo();
  assert.equal(readJSON(dir, `screens/${screen}.json`).narration.lines.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'assets/sounds/telephone-fixe.flac')), 'the file went with its line');
});
