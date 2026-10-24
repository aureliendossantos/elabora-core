import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from '../helpers.ts';
import { downloadKinds, installDownload, optionalDownloads, uninstallDownload } from '@elabora/node/downloads/index';
import { alignerFor, alignerInstalled, holdAligner } from '@elabora/node/align/models';
import { modelsRoot } from '@elabora/node/voice/pocket/models';
import { holdTranscriber, transcriberFor, transcriberInstalled } from '@elabora/node/transcribe/models';

// Optional downloads (D38): every model Elabora downloads once per computer, listed by kind with what
// it is for, sized, installed and removed alike, the word aligners and the transcriber as the local
// voices; a kind only registers.

const execFileAsync = promisify(execFile);
const sha = (body: Buffer) => crypto.createHash('sha256').update(body).digest('hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-downloads-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// The aligners as made-up models of 40 KB and 20 KB, from a server of this test; the voices too.
const bodies: Record<string, Buffer> = { 'fr.onnx': Buffer.alloc(40_000, 1), 'en.onnx': Buffer.alloc(20_000, 2), 'voice.bin': Buffer.alloc(10_000, 3), 'stt.onnx': Buffer.alloc(30_000, 4) };
let requests = 0;
const server = http.createServer((request, response) => {
  requests++;
  const body = bodies[path.basename(request.url ?? '')];
  if (!body) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-length': body.length }).end(body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const file = (name: string) => ({ name: 'model.onnx', url: `repo/${name}`, size: bodies[name].length, sha256: sha(bodies[name]) });
fs.writeFileSync(path.join(temp, 'aligners.json'), JSON.stringify({ 'wav2vec2-xlsr53-french-int8': [file('fr.onnx')], 'wav2vec2-base-960h-q8': [file('en.onnx')] }));
fs.writeFileSync(path.join(temp, 'voices.json'), JSON.stringify({ 'english_2026-04': [{ ...file('voice.bin'), name: 'model.bin' }] }));
fs.writeFileSync(path.join(temp, 'transcribers.json'), JSON.stringify({ 'parakeet-tdt-0.6b-v3-int8': [file('stt.onnx')] }));
Object.assign(process.env, {
  ELABORA_VOICE_MODELS_DIR: path.join(temp, 'voices'), ELABORA_VOICE_MODELS_URL: url, ELABORA_VOICE_MODELS_MANIFEST: path.join(temp, 'voices.json'),
  ELABORA_ALIGNER_MODELS_DIR: path.join(temp, 'aligners'), ELABORA_ALIGNER_MODELS_URL: url, ELABORA_ALIGNER_MODELS_MANIFEST: path.join(temp, 'aligners.json'),
  ELABORA_TRANSCRIBER_MODELS_DIR: path.join(temp, 'transcribers'), ELABORA_TRANSCRIBER_MODELS_URL: url, ELABORA_TRANSCRIBER_MODELS_MANIFEST: path.join(temp, 'transcribers.json')
});

beforeEach(() => {
  requests = 0;
  for (const folder of ['voices', 'aligners', 'transcribers']) fs.rmSync(path.join(temp, folder), { recursive: true, force: true });
});

test('downloads: the local voices and the word aligners by language, what each is for, sized, installed, refused while in use, removed', async () => {
  assert.ok(modelsRoot().startsWith(temp), 'never the computer\'s own models');
  assert.deepEqual(downloadKinds().map((kind) => kind.kind), ['voices', 'aligner', 'transcriber']);
  const ids = () => optionalDownloads().map((view) => `${view.id}:${view.installed ? view.size : `-${view.download}`}`);
  assert.deepEqual(ids(), ['voices-en:-10000', `voices-fr:-${optionalDownloads({ kind: 'voices', language: 'fr' })[0].download}`, 'aligner-en:-20000', 'aligner-fr:-40000', 'transcriber:-30000']);
  const aligner = optionalDownloads({ kind: 'aligner', language: 'fr-CA' });
  assert.equal(aligner.length, 1, 'a regional tag lists its language');
  assert.match(aligner[0].serves, /each word/);
  assert.match(aligner[0].without, /in proportion to the text/);
  assert.equal(aligner[0].title, 'Word aligner');
  assert.deepEqual(optionalDownloads({ kind: 'voices', language: 'en' })[0].contents?.map((voice) => voice.name), ['Grace', 'Iris', 'Nora', 'Felix', 'Owen']);

  // Installed, with its progress; its size on disk.
  const progress: number[] = [];
  const installed = await installDownload('aligner-fr', { onProgress: (p) => progress.push(p.received / p.total) });
  assert.equal(installed.installed, true);
  assert.ok(installed.size >= 40_000);
  assert.equal(progress.at(-1), 1);
  assert.ok(alignerInstalled(alignerFor('fr')!));

  // Words being placed with it (an alignment holds it): refused, then removed.
  const release = await holdAligner(alignerFor('fr')!);
  try {
    assert.equal(optionalDownloads({ kind: 'aligner', language: 'fr' })[0].inUse, true);
    await assert.rejects(uninstallDownload('aligner-fr'), (error: Error & { code?: string }) => error.code === 'E_ALIGN_IN_USE' && /in use: words are being placed with it/.test(error.message));
  } finally { release(); }
  const removed = await uninstallDownload('aligner-fr');
  assert.ok(removed.freed >= 40_000);
  assert.equal(optionalDownloads({ kind: 'aligner', language: 'fr' })[0].installed, false);

  // A reinstall downloads it again; an unknown id is refused.
  await installDownload('aligner-fr');
  const before = requests;
  await installDownload('aligner-fr', { force: true });
  assert.equal(requests, before + 1);
  // What a stopped download left is removed, not a model that is all there (another process's).
  assert.deepEqual(await uninstallDownload('aligner-fr', { partial: true }), { id: 'aligner-fr', freed: 0 });
  assert.equal(optionalDownloads({ kind: 'aligner', language: 'fr' })[0].installed, true);
  fs.mkdirSync(path.join(process.env.ELABORA_ALIGNER_MODELS_DIR!, 'wav2vec2-base-960h-q8'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ELABORA_ALIGNER_MODELS_DIR!, 'wav2vec2-base-960h-q8', 'model.onnx.part'), Buffer.alloc(500));
  assert.deepEqual(await uninstallDownload('aligner-en', { partial: true }), { id: 'aligner-en', freed: 500 });
  await assert.rejects(installDownload('aligner-de'), (error: Error & { code?: string }) => error.code === 'E_DOWNLOAD_UNKNOWN' && /aligner-fr/.test(error.message));
  await uninstallDownload('aligner-fr');
});

test('downloads: the transcriber is one download for every language it hears, refused while a recording is transcribed, removed', async () => {
  const [view] = optionalDownloads({ kind: 'transcriber' });
  assert.deepEqual([view.id, view.language, view.title, view.installed, view.download], ['transcriber', null, 'Transcription', false, 30_000]);
  assert.match(view.serves, /what a recording says, on this computer/);
  assert.equal(optionalDownloads({ kind: 'transcriber', language: 'fr' }).length, 0, 'not listed by language: one model for all');
  assert.equal((await installDownload('transcriber')).installed, true);
  assert.ok(transcriberInstalled(transcriberFor('fr-CA')!) && transcriberFor('en')?.id === transcriberFor('de')?.id);
  assert.equal(transcriberFor('ja'), null, 'Parakeet hears 25 European languages');
  const release = await holdTranscriber(transcriberFor('fr')!);
  try {
    await assert.rejects(uninstallDownload('transcriber'), (error: Error & { code?: string }) => error.code === 'E_TRANSCRIBE_IN_USE' && /a recording is being transcribed with it/.test(error.message));
  } finally { release(); }
  assert.ok((await uninstallDownload('transcriber')).freed >= 30_000);
  assert.equal(optionalDownloads({ kind: 'transcriber' })[0].installed, false);
});

test('a registered download kind lists, installs and removes through the public API', async () => {
  // The registry has process lifetime and no unregister API. Exercise extensions in their own
  // process so that built-in-kind tests never depend on running before this one.
  const script = `
    import assert from 'node:assert/strict';
    import { registerDownloadKind, optionalDownloads, installDownload, uninstallDownload } from '@elabora/node/downloads/index';
  let there = false;
  registerDownloadKind({
    kind: 'test-kind', title: 'Test kind', serves: 'tests', without: 'nothing',
    list: () => [{ language: null, model: 'test@1', installed: there, size: there ? 5 : 7, download: 7, installing: null, inUse: false }],
    install: async () => { there = true; },
    uninstall: async () => { const freed = there ? 5 : 0; there = false; return freed; }
  });
  assert.deepEqual(optionalDownloads({ kind: 'test-kind' }).map(({ id, language, installed, size }) => ({ id, language, installed, size })), [{ id: 'test-kind', language: null, installed: false, size: 7 }]);
  assert.equal((await installDownload('test-kind')).installed, true);
  assert.deepEqual(await uninstallDownload('test-kind'), { id: 'test-kind', freed: 5 });
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: process.env });
});

test('cli: elabora downloads list, install and uninstall; voice uninstall is the voices\' part', async () => {
  const elabora = async (...args: string[]) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { env: process.env, encoding: 'utf8' });
      return { status: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { status: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };
  const listed = await elabora('downloads', 'list', '--kind', 'aligner');
  assert.match(listed.stdout, /^Word aligner: Places each word/);
  assert.match(listed.stdout, /\n {2}Without it: Words are placed in proportion to the text/);
  assert.match(listed.stdout, /\n {2}aligner-en {3}not on this computer: 0 MB downloaded on first use \(elabora downloads install aligner-en\)\n/);
  assert.equal((await elabora('downloads', 'install', 'aligner-en')).status, 0);
  assert.match((await elabora('downloads', 'list', '--kind', 'aligner', '--language', 'en')).stdout, /aligner-en {3}on this computer: 0 MB \(elabora downloads uninstall aligner-en\)/);
  const json = JSON.parse((await elabora('downloads', 'list', '--json')).stdout).downloads;
  assert.deepEqual(json.map((view: { id: string }) => view.id), ['voices-en', 'voices-fr', 'aligner-en', 'aligner-fr', 'transcriber']);
  const removed = await elabora('downloads', 'uninstall', 'aligner-en', '--json');
  assert.equal(JSON.parse(removed.stdout).ok, true);
  assert.equal(JSON.parse(removed.stdout).id, 'aligner-en');
  assert.match((await elabora('downloads', 'uninstall', 'aligner-en')).stdout, /aligner-en was not on this computer/);
  // The voices' alias.
  assert.equal((await elabora('downloads', 'install', 'voices-en')).status, 0);
  assert.match((await elabora('voice', 'uninstall', 'en-GB')).stdout, /voices-en is removed from this computer/);
  const unknown = await elabora('voice', 'uninstall', 'de');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No optional download "voices-de"/);
});
