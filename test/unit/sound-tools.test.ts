import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import * as edit from '@elabora/node/edit';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { courseSounds } from '@elabora/core/sounds/sounds';
import { addSound } from '@elabora/node/sounds/add';
import { generateSound, estimateSound } from '@elabora/node/sounds/generate';
import { searchLibrary, librarySounds, libraryFile } from '@elabora/node/sounds/library';
import { searchOpenverse } from '@elabora/node/sounds/openverse';
import { forgetQuota } from '@elabora/node/voice/elevenlabs/costs';
import { ROOT, copyExample, codes } from '../helpers.ts';
import { FFMPEG, hasFfmpeg } from '../narration.ts';

// The agents' sound commands (D67): the library, Openverse and ElevenLabs imitated, adding a sound.

const QUIET = path.join(ROOT, 'examples/coffee-in-brief');
const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg not found';
const tone = (file: string, seconds: number, args: string[]) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=500:duration=${seconds}:sample_rate=44100`, ...args, file]);

let server: http.Server;
const asked: { route: string; body: string }[] = [];
let limit = 30000;
const saved = { eleven: process.env.ELABORA_ELEVENLABS_URL, key: process.env.ELEVENLABS_API_KEY, openverse: process.env.ELABORA_OPENVERSE_URL };
let mp3: Buffer;
before(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sound-tools-'));
  if (hasFfmpeg()) { tone(path.join(work, 'g.mp3'), 2, ['-c:a', 'libmp3lame', '-b:a', '128k']); mp3 = fs.readFileSync(path.join(work, 'g.mp3')); }
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      asked.push({ route: request.url ?? '', body });
      const json = (value: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.url === '/v1/user') return json({ subscription: { tier: 'starter', character_count: 1000, character_limit: limit } });
      if (request.url?.startsWith('/v1/sound-generation')) { response.writeHead(200, { 'content-type': 'audio/mpeg', 'character-cost': String(Math.ceil(40 * (JSON.parse(body).duration_seconds ?? 5))) }); return response.end(mp3); }
      if (request.url?.startsWith('/v1/audio/?')) return json({ results: [
        { id: '11111111-1111-1111-1111-111111111111', title: 'Door knock', creator: 'Ann', license: 'cc0', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.mp3`, foreign_landing_url: 'https://freesound.org/s/1/', duration: 2100, source: 'freesound' },
        { id: '22222222-2222-2222-2222-222222222222', title: 'Knock (BY)', creator: 'Bo', license: 'by', license_version: '4.0', url: 'https://example.org/b.mp3', foreign_landing_url: 'https://freesound.org/s/2/', duration: 1500, source: 'freesound' },
        { id: '33333333-3333-3333-3333-333333333333', title: 'Knock (ND)', creator: 'Cy', license: 'by-nd', url: 'https://example.org/c.mp3', source: 'freesound' },
        { id: '44444444-4444-4444-4444-444444444444', title: 'Knock (SA)', creator: 'Di', license: 'by-sa', url: 'https://example.org/d.mp3', source: 'freesound' }
      ] });
      if (request.url === '/v1/audio/11111111-1111-1111-1111-111111111111/') return json({ id: '11111111-1111-1111-1111-111111111111', title: 'Door knock', creator: 'Ann', license: 'cc0', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.mp3`, foreign_landing_url: 'https://freesound.org/s/1/', duration: 2100, source: 'freesound' });
      if (request.url === '/file.mp3') { response.writeHead(200, { 'content-type': 'audio/mpeg' }); return response.end(mp3); }
      response.writeHead(404); response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ELABORA_ELEVENLABS_URL = base;
  process.env.ELEVENLABS_API_KEY = 'sk_test_sounds_0123456789abcdef';
  process.env.ELABORA_OPENVERSE_URL = base;
});
after(() => {
  server.close();
  for (const [name, value] of [['ELABORA_ELEVENLABS_URL', saved.eleven], ['ELEVENLABS_API_KEY', saved.key], ['ELABORA_OPENVERSE_URL', saved.openverse]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

test('the library: its catalogue matches its files, CC0 or public domain only; a search by words in French or English', () => {
  const sounds = librarySounds();
  assert.ok(sounds.length >= 30);
  for (const sound of sounds) {
    assert.ok(['CC0-1.0', 'PDM-1.0'].includes(sound.license), `${sound.id}: ${sound.license}`);
    assert.equal(fs.statSync(libraryFile(sound)).size, sound.bytes, sound.id);
    assert.ok(sound.kind === 'ambience' ? sound.format === 'aac' : sound.format === 'flac', `${sound.id}: ${sound.format}`);
  }
  assert.equal(searchLibrary('téléphone')[0]?.category, 'telephone');
  assert.ok(searchLibrary('door').some((sound) => sound.id.startsWith('porte')));
  assert.ok(searchLibrary('', { kind: 'ambience' }).every((sound) => sound.kind === 'ambience'));
});

test('sound add: a library sound, then a file cut and faded into FLAC, a lossy file kept as it came; licences checked; undo', { skip: NO_FFMPEG }, async () => {
  const dir = copyExample(QUIET);
  const ring = await addSound(dir, { from: 'telephone-fixe', caption: { en: 'The phone rings.' } });
  assert.equal(ring.path, 'assets/sounds/telephone-fixe.flac');
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'assets/sounds/telephone-fixe.json'), 'utf8'));
  assert.equal(sidecar.source, 'library');
  assert.equal(sidecar.license, 'CC0-1.0');
  assert.equal(sidecar.caption.en, 'The phone rings.');
  assert.equal(sidecar.caption.fr, 'Le téléphone sonne.');
  assert.deepEqual(fs.readFileSync(path.join(dir, ring.path)), fs.readFileSync(libraryFile(librarySounds().find((sound) => sound.id === 'telephone-fixe')!)), 'the same bytes');
  // The same again: kept, not copied twice.
  assert.equal((await addSound(dir, { from: 'telephone-fixe' })).reused, true);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sound-file-'));
  tone(path.join(work, 'Door Bell.wav'), 4, ['-c:a', 'pcm_s16le']);
  await assert.rejects(addSound(dir, { from: path.join(work, 'Door Bell.wav') }), /Say the licence/);
  await assert.rejects(addSound(dir, { from: path.join(work, 'Door Bell.wav'), license: 'CC-BY-NC-4.0' }), /cannot|may ship/);
  const bell = await addSound(dir, { from: path.join(work, 'Door Bell.wav'), license: 'own', trim: { start: 0.5, end: 2 }, fade: 0.3 });
  assert.equal(bell.path, 'assets/sounds/door-bell.flac');
  assert.ok(Math.abs(bell.duration - 1.5) < 0.05, String(bell.duration));
  const bellSidecar = JSON.parse(fs.readFileSync(path.join(dir, 'assets/sounds/door-bell.json'), 'utf8'));
  assert.deepEqual([bellSidecar.source, bellSidecar.modified, bellSidecar.trim], ['recording', ['trimmed', 'faded'], { start: 0.5, end: 2 }]);

  fs.writeFileSync(path.join(work, 'chime.mp3'), mp3);
  const chime = await addSound(dir, { from: path.join(work, 'chime.mp3'), license: 'CC0-1.0' });
  assert.equal(chime.path, 'assets/sounds/chime.mp3');
  assert.deepEqual(fs.readFileSync(path.join(dir, chime.path)), mp3, 'not encoded again');
  // A FLAC that loops is an ambience: AAC 256, like any long sound (D67).
  tone(path.join(work, 'rain.flac'), 4, ['-c:a', 'flac']);
  assert.equal((await addSound(dir, { from: path.join(work, 'rain.flac'), license: 'CC0-1.0', loop: true })).path, 'assets/sounds/rain.m4a');

  const listed = courseSounds(loadProjectFromDir(dir));
  assert.deepEqual(listed.map((sound) => [sound.id, sound.licence.ok, sound.uses.length]), [['chime', true, 0], ['door-bell', true, 0], ['rain', true, 0], ['telephone-fixe', true, 0]]);
  assert.ok(!codes(validateDir(dir).diagnostics).some((code) => code.startsWith('E_SOUND') || code === 'W_MEDIA_NOT_OPTIMIZED'));
  edit.undo(dir);
  assert.ok(!fs.existsSync(path.join(dir, 'assets/sounds/rain.m4a')), 'undone');
});

test('Openverse: CC0, public domain and CC BY only (its commercial filter lets ND and SA through); a sound added from it keeps its page and author', { skip: NO_FFMPEG }, async () => {
  const found = await searchOpenverse('door knock');
  assert.deepEqual(found.map((sound) => [sound.title, sound.license]), [['Door knock', 'CC0-1.0'], ['Knock (BY)', 'CC-BY-4.0']]);
  assert.match(asked.at(-1)!.route, /license=cc0%2Cpdm%2Cby/);
  const dir = copyExample(QUIET);
  const added = await addSound(dir, { from: found[0].id });
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `assets/sounds/${added.id}.json`), 'utf8'));
  assert.deepEqual([added.id, sidecar.source, sidecar.url, sidecar.author, sidecar.license], ['door-knock', 'openverse', 'https://freesound.org/s/1/', 'Ann', 'CC0-1.0']);
});

test('sound generate: under 1 % of the quota it runs, from 1 % it asks; the same request is never paid twice; its sidecar says it was generated', { skip: NO_FFMPEG }, async () => {
  const dir = copyExample(QUIET);
  forgetQuota();
  limit = 30000;
  assert.deepEqual(await estimateSound({ duration: 3 }).then((estimate) => [estimate.credits, estimate.percent, estimate.needsApproval]), [120, 0.4, false]);
  await assert.rejects(generateSound(dir, { prompt: 'A desk phone rings twice', duration: 10 }), (error: Error & { code?: string }) => error.code === 'E_VOICE_SPEND' && /~1 %/.test(error.message));
  const made = await generateSound(dir, { prompt: 'A desk phone rings twice', duration: 3, id: 'desk-phone' });
  assert.equal(made.path, 'assets/sounds/desk-phone.mp3');
  assert.equal(made.credits, 120);
  const body = JSON.parse(asked.filter((entry) => entry.route.startsWith('/v1/sound-generation')).at(-1)!.body);
  assert.deepEqual(body, { text: 'A desk phone rings twice', model_id: 'eleven_text_to_sound_v2', duration_seconds: 3, prompt_influence: 0.3 });
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'assets/sounds/desk-phone.json'), 'utf8'));
  assert.deepEqual([sidecar.source, sidecar.license, sidecar.generated.provider, sidecar.generated.model], ['elevenlabs', 'generated', 'elevenlabs', 'eleven_text_to_sound_v2']);
  const before = asked.length;
  const again = await generateSound(copyExample(QUIET), { prompt: 'A desk phone rings twice', duration: 3 });
  assert.equal(again.cached, true);
  assert.equal(asked.filter((entry, index) => index >= before && entry.route.startsWith('/v1/sound-generation')).length, 0, 'from the cache');
  const approved = await generateSound(dir, { prompt: 'Rain on a window', duration: 10, approvedPercent: 1 });
  assert.ok(approved.id.startsWith('rain-on-a-window'));
});
