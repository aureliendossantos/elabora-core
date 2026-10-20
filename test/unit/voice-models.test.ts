import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, copyExample, readJSON } from '../helpers.ts';
import { narrate, hasFfmpeg } from '../narration.ts';
import { bundleDownloading, bundleFor, bundleInUse, bundleOnDisk, holdBundle, installBundle, isInstalled, modelsRoot, uninstallBundle } from '@elabora/node/voice/pocket/models';
import type { Bundle } from '@elabora/node/voice/pocket/models';
import { generateNarration, localVoices, registerVoiceProvider, setSpeakerVoice, uninstallVoices, voiceTakes } from '@elabora/node/voice/index';
import type { VoiceError, VoiceProvider } from '@elabora/node/voice/index';
import { toneProvider } from '@elabora/node/voice/tone';

// Removing a local voices' model from this computer (elabora voice uninstall, Elabora settings):
// never while a download or a generation uses it, in this process or another; the lines already
// made stay in their modules; the next use downloads it again.

const execFileAsync = promisify(execFile);
const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const sha = (body: Buffer) => crypto.createHash('sha256').update(body).digest('hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-voice-models-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
// Every model of this file in its own folder: uninstallVoices removes Pocket TTS's too, and must
// never reach the computer's own (the author's models).
process.env.ELABORA_VOICE_MODELS_DIR = path.join(temp, 'pocket');
process.env.ELABORA_ALIGNER_MODELS_DIR = path.join(temp, 'aligners');

// A model's files served from this computer, the requests counted.
async function modelServer(files: Record<string, Buffer>): Promise<{ url: string; requests: () => number; close: () => void }> {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    const body = files[path.basename(request.url ?? '')];
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests: () => requests, close: () => server.close() };
}

// A process that has ended: its id is free.
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}

test('models: removed on request, refused while held or downloaded in any process, downloaded again on next use', async () => {
  const files = { 'a.bin': crypto.randomBytes(200_000), 'b.json': Buffer.from('{"x":1}') };
  const server = await modelServer(files);
  const dir = path.join(temp, 'models');
  const env = { ...process.env, ELABORA_VOICE_MODELS_DIR: dir, ELABORA_VOICE_MODELS_URL: server.url };
  const bundle: Bundle = { id: 'test', language: 'xx', model: 'test', files: Object.entries(files).map(([name, body]) => ({ name, url: `repo/${name}`, size: body.length, sha256: sha(body) })) };
  const folder = path.join(dir, 'test');
  const busy = (pattern: RegExp) => (error: Error & { code?: string }) => error.code === 'E_VOICE_IN_USE' && pattern.test(error.message);
  try {
    assert.equal(await uninstallBundle(bundle, { env }), 0, 'nothing there: nothing freed');
    await installBundle(bundle, { env });
    assert.ok(isInstalled(bundle, env));
    const onDisk = bundleOnDisk(bundle, env);
    assert.ok(onDisk >= 200_007 && onDisk < 201_000, `its files and their checks: ${onDisk}`);
    assert.ok(!fs.existsSync(`${folder}.lock`), 'the lock goes with the download');

    // Held by a generation of this process: refused, then removed once released.
    const release = await holdBundle(bundle, { env });
    assert.ok(bundleInUse(bundle, env));
    await assert.rejects(uninstallBundle(bundle, { env }), busy(/in use: a generation is saying lines/));
    assert.ok(isInstalled(bundle, env), 'refused: nothing removed');
    release();
    assert.equal(bundleInUse(bundle, env), false);

    // Held by another live process (its marker), or left by one that is gone.
    const other = process.ppid;
    fs.writeFileSync(path.join(folder, '.in-use', `${other}-1`), '');
    await assert.rejects(uninstallBundle(bundle, { env }), busy(new RegExp(`another Elabora process \\(${other}\\)`)));
    fs.renameSync(path.join(folder, '.in-use', `${other}-1`), path.join(folder, '.in-use', `${deadPid()}-1`));
    assert.equal(bundleInUse(bundle, env), false, 'a process that is gone holds nothing');

    // Being downloaded by another process: refused, its progress read from the disk.
    fs.writeFileSync(`${folder}.lock`, `${other} download`);
    fs.writeFileSync(path.join(folder, 'c.bin.part'), Buffer.alloc(10));
    assert.deepEqual(bundleDownloading({ ...bundle, files: [...bundle.files, { name: 'c.bin', url: 'repo/c.bin', size: 100, sha256: '0'.repeat(64) }] }, env), { received: 200_017, total: 200_107 });
    await assert.rejects(uninstallBundle(bundle, { env }), busy(/being downloaded by another Elabora process/));
    fs.rmSync(`${folder}.lock`);
    fs.rmSync(path.join(folder, 'c.bin.part'));
    assert.equal(bundleDownloading(bundle, env), null);
    // A lock left by a process that is gone is no download; nor is one written before the computer
    // started, whatever process has its id now; nor is a hold's file of then.
    fs.writeFileSync(`${folder}.lock`, `${deadPid()} download`);
    assert.equal(bundleDownloading(bundle, env), null);
    const beforeBoot = new Date(Date.now() - os.uptime() * 1000 - 60_000);
    fs.writeFileSync(`${folder}.lock`, `${other} download`);
    fs.utimesSync(`${folder}.lock`, beforeBoot, beforeBoot);
    assert.equal(bundleDownloading(bundle, env), null);
    fs.writeFileSync(path.join(folder, '.in-use', `${other}-2`), '');
    fs.utimesSync(path.join(folder, '.in-use', `${other}-2`), beforeBoot, beforeBoot);
    assert.equal(bundleInUse(bundle, env), false);
    // Taken over at once by two holds of this process: each has it in turn.
    const both = await Promise.all([holdBundle(bundle, { env }), holdBundle(bundle, { env })]);
    assert.ok(!fs.existsSync(`${folder}.lock`), 'released, the dead one gone');
    for (const release of both) release();

    // Removed: the folder and the stale lock gone, what a removal stopped midway left swept.
    const leftover = `${folder}.removing-${deadPid()}-1`;
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'a.bin'), 'x');
    const freed = await uninstallBundle(bundle, { env });
    assert.equal(freed, onDisk, 'what it took is freed');
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing left beside it');
    assert.equal(isInstalled(bundle, env), false);

    // A hold after the removal finds it gone: the next use downloads it again.
    const before = server.requests();
    const again = await holdBundle(bundle, { env });
    await installBundle(bundle, { env });
    again();
    assert.equal(server.requests(), before + 2, 'downloaded again');
    assert.ok(isInstalled(bundle, env));
  } finally {
    server.close();
  }
});

test('models: ELABORA_VOICE_MODELS_MANIFEST gives a bundle made-up files (tests only)', () => {
  const manifest = path.join(temp, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ 'english_2026-04': [{ name: 'x.bin', url: 'x/x.bin', size: 3, sha256: 'a'.repeat(64) }] }));
  const env = { ...process.env, ELABORA_VOICE_MODELS_MANIFEST: manifest };
  assert.deepEqual(bundleFor('en', env)!.files.map((file) => file.name), ['x.bin']);
  assert.equal(bundleFor('fr', env)!.files.length, 7, 'the others as pinned');
  assert.equal(bundleFor('en')!.files.length, 7);
});

// A local voice whose model is a test bundle: it says a line as the test tone does, once the test
// lets it (to remove its model while a generation runs).
const files = { 'model.bin': crypto.randomBytes(50_000) };
const server = await modelServer(files);
after(() => server.close());
const env = { ...process.env, ELABORA_VOICE_MODELS_DIR: path.join(temp, 'held'), ELABORA_VOICE_MODELS_URL: server.url };
const held: Bundle = { id: 'held', language: 'fr', model: 'held@1', files: [{ name: 'model.bin', url: 'repo/model.bin', size: 50_000, sha256: sha(files['model.bin']) }] };
let installs = 0;
let gate: Promise<void> = Promise.resolve();
let speaking: () => void = () => {};
const heldProvider: VoiceProvider = {
  id: 'held',
  name: 'Held test voice',
  voices: (language) => toneProvider.voices('fr').filter(() => !language || language.startsWith('fr')).slice(0, 1).map((voice) => ({ ...voice, id: 'held-a', name: 'Héloïse', provider: 'held' })),
  status: (language) => (language.startsWith('fr') ? { installed: isInstalled(held, env), size: isInstalled(held, env) ? 0 : 50_000, onDisk: bundleOnDisk(held, env), download: 50_000, installing: bundleDownloading(held, env), inUse: bundleInUse(held, env) } : null),
  model: (language) => (language.startsWith('fr') ? { id: held.id, model: held.model } : null),
  async install(_language, { signal, onProgress, force } = {}) {
    installs++;
    if (force) await uninstallBundle(held, { env });
    await installBundle(held, { env, signal, onProgress });
  },
  uninstall: async () => ({ freed: await uninstallBundle(held, { env }) }),
  hold: (_language, signal) => holdBundle(held, { env, signal }),
  async synthesize(request) {
    speaking();
    await gate;
    return { ...(await toneProvider.synthesize({ ...request, voice: 'tone-a' })), model: held.model };
  },
  dispose: async () => {}
};
registerVoiceProvider(toneProvider);
registerVoiceProvider(heldProvider);

test('uninstall: the local voices by language; refused while a generation says lines, the lines made stay, the next one downloads it again', { skip: NO_FFMPEG }, async () => {
  const dir = copyExample();
  narrate(dir, 'accueil', [{ id: 'l1', speaker: 'leila', text: 'Bonjour.' }, { id: 'l2', speaker: 'leila', text: 'Au revoir.' }], { speakers: [{ id: 'leila', name: 'Leïla' }] });
  await setSpeakerVoice(dir, { speaker: 'leila', voice: 'held-a', provider: 'held' });

  const view = () => localVoices('fr').find((entry) => entry.provider === 'held')!;
  assert.deepEqual(view(), { language: 'fr', provider: 'held', model: 'held@1', voices: [{ id: 'held-a', name: 'Héloïse', gender: 'female' }], installed: false, size: 50_000, download: 50_000, installing: null, inUse: false });
  assert.ok(!localVoices().some((entry) => entry.provider === 'tone'), 'only voices whose model can be removed');

  // The first generation downloads it; while it says its first line, the model cannot be removed.
  let release!: () => void;
  gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { speaking = resolve; });
  const generating = generateNarration(dir, { screen: 'accueil' });
  await started;
  assert.equal(installs, 1);
  assert.equal(view().inUse, true);
  await assert.rejects(uninstallVoices('fr'), (error: VoiceError) => error.code === 'E_VOICE_IN_USE');
  release();
  const made = await generating;
  assert.deepEqual(made.lines.map((line) => line.status), ['generated', 'generated']);
  assert.equal(view().inUse, false, 'released when the generation ends');
  assert.equal(view().installed, true);
  assert.ok(view().size >= 50_000, 'its size on disk');

  // Removed: the lines made keep their audio and their takes.
  const audio = fs.readFileSync(path.join(dir, 'assets/narration/fr/accueil/l1.m4a'));
  const takes = voiceTakes(dir, { screen: 'accueil', line: 'l1' }).takes.length;
  assert.ok(modelsRoot().startsWith(temp), 'never the computer\'s own models');
  const removed = await uninstallVoices('fr');
  assert.deepEqual(removed.providers, ['pocket-tts', 'held'].filter((id) => removed.providers.includes(id)));
  assert.ok(removed.freed >= 50_000);
  assert.equal(view().installed, false);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'assets/narration/fr/accueil/l1.m4a')), audio, 'the line keeps its audio');
  assert.equal(readJSON(dir, 'assets/narration/fr/accueil/l1.json').model, 'held@1');
  assert.equal(voiceTakes(dir, { screen: 'accueil', line: 'l1' }).takes.length, takes, 'and its takes');

  // The next generation downloads it again, as on first use; --force downloads it again too.
  gate = Promise.resolve();
  speaking = () => {};
  await generateNarration(dir, { screen: 'accueil', lines: ['l2'] });
  assert.equal(installs, 2);
  assert.equal(view().installed, true);
  const requests = server.requests();
  await heldProvider.install('fr', { force: true });
  assert.equal(server.requests(), requests + 1, 'a reinstall downloads it again');
});

test('cli: elabora voice models, uninstall and install --force on a made-up model', { skip: NO_FFMPEG }, async () => {
  // The English model as a 30 KB made-up file, from a server of this test (the commands run in
  // children, so that it answers meanwhile).
  const body = crypto.randomBytes(30_000);
  const manifest = path.join(temp, 'cli-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ 'english_2026-04': [{ name: 'model.bin', url: 'repo/model.bin', size: body.length, sha256: sha(body) }] }));
  const serve = await modelServer({ 'model.bin': body });
  const cliEnv = { ...process.env, ELABORA_VOICE_MODELS_DIR: path.join(temp, 'cli'), ELABORA_VOICE_MODELS_URL: serve.url, ELABORA_VOICE_MODELS_MANIFEST: manifest };
  const elabora = async (...args: string[]) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { env: cliEnv, encoding: 'utf8' });
      return { status: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { status: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };
  try {
    const models = JSON.parse((await elabora('voice', 'models', '--language', 'en', '--json')).stdout).models;
    assert.deepEqual(models.map((m: { language: string; provider: string; installed: boolean; size: number }) => [m.language, m.provider, m.installed, m.size]), [['en', 'pocket-tts', false, 30_000]]);
    assert.deepEqual(models[0].voices.map((voice: { name: string }) => voice.name), ['Grace', 'Iris', 'Nora', 'Felix', 'Owen']);
    assert.match((await elabora('voice', 'models', '--language', 'en')).stdout, /^en {2}Pocket TTS \(Kyutai\) · 5 voices: Grace, Iris, Nora, Felix, Owen\n {4}not on this computer: 0 MB downloaded on first use \(elabora voice install en\)\n$/);
    assert.equal((await elabora('voice', 'install', 'en')).status, 0);
    assert.match((await elabora('voice', 'models', '--language', 'en')).stdout, /on this computer: 0 MB \(elabora voice uninstall en removes it\)/);
    assert.match((await elabora('voice', 'install', 'en', '--force')).stdout, /downloaded again/);
    const removed = await elabora('voice', 'uninstall', 'en', '--json');
    assert.equal(removed.status, 0, removed.stderr);
    const answer = JSON.parse(removed.stdout);
    assert.deepEqual({ ...answer, freed: answer.freed >= 30_000 }, { ok: true, id: 'voices-en', freed: true });
    assert.match((await elabora('voice', 'uninstall', 'en')).stdout, /voices-en was not on this computer/);
    const unknown = await elabora('voice', 'uninstall', 'de');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /No optional download "voices-de"/);
  } finally {
    serve.close();
  }
});
