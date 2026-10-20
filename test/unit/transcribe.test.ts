import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { narrationLines } from '@elabora/core/narration/narration';
import { translationTable } from '@elabora/core/i18n/translate';
import * as edit from '@elabora/node/edit';
import { importNarration } from '@elabora/node/narration/audio';
import { addNarrationLineFromAudio, setNarrationTextFromAudio, transcribeNarrationLine } from '@elabora/node/narration/from-audio';
import { disposeTranscriber, transcribeAudio, transcribers, TRANSCRIBER_MODELS, transcriberInstalled } from '@elabora/node/transcribe/index';
import { textOfPieces, withApostrophesOf, wordsOfPieces } from '@elabora/node/transcribe/text';
import { windows } from '@elabora/node/transcribe/parakeet';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { forgetQuota } from '@elabora/node/voice/elevenlabs/costs';
import { copyExample, readJSON, ROOT } from '../helpers.ts';
import { narrate, toneM4a, hasFfmpeg } from '../narration.ts';

// Transcription (docs/decisions.md D46): what a recording says, a line made from a recording, a
// line's text written again from its recording. The tests' transcriber answers from a file
// (ELABORA_TRANSCRIBER_FAKE) once its made-up model is installed; ElevenLabs is a server of this
// test. One test hears the real model, when ELABORA_TRANSCRIBER_MODELS_DIR names a folder where it is.

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg is not installed';
const execFileAsync = promisify(execFile);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-transcribe-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
after(disposeTranscriber);

// The real model's folder, when the one who runs the tests named one where it is installed.
const realDir = process.env.ELABORA_TRANSCRIBER_MODELS_DIR;
const real = !!realDir && transcriberInstalled(TRANSCRIBER_MODELS[0]);

// A made-up model of 10 bytes, installed as a download leaves it (its file checked, verified.json).
const fakeModels = path.join(temp, 'transcribers');
function installFakeModel(): void {
  const body = Buffer.from('not a mod.');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(temp, 'transcribers.json'), JSON.stringify({ [TRANSCRIBER_MODELS[0].id]: [{ name: 'model.bin', url: 'x/model.bin', size: body.length, sha256 }] }));
  const dir = path.join(fakeModels, TRANSCRIBER_MODELS[0].id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.bin'), body);
  fs.writeFileSync(path.join(dir, 'verified.json'), JSON.stringify({ 'model.bin': sha256 }));
}
const heard = path.join(temp, 'heard.json');
const fakeEnv = (texts: Record<string, string>) => {
  fs.writeFileSync(heard, JSON.stringify(texts));
  return { ELABORA_TRANSCRIBER_MODELS_DIR: fakeModels, ELABORA_TRANSCRIBER_MODELS_MANIFEST: path.join(temp, 'transcribers.json'), ELABORA_TRANSCRIBER_FAKE: heard };
};
function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  return run().finally(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}
installFakeModel();

test('a transcriber\'s pieces as text and words: no space before a comma or a full stop, French spaces before ? ! : ;, words without their punctuation', () => {
  const pieces = [' Pou', 'vez', '-', 'vous', ' m', '\'', 'aider', ' ?', ' Il', ' est', ' 9', ':', '30', ',', ' oui', ' !'].map((piece, i) => ({ piece, time: i * 0.08, probability: 0.9 }));
  assert.equal(textOfPieces(pieces, 'fr'), 'Pouvez-vous m\'aider ? Il est 9:30, oui !');
  assert.equal(textOfPieces(pieces, 'en'), 'Pouvez-vous m\'aider? Il est 9:30, oui!');
  const words = wordsOfPieces(pieces, 1.5);
  assert.deepEqual(words.map((word) => word.text), ['Pouvez-vous', 'm\'aider', 'Il', 'est', '9:30', 'oui']);
  assert.deepEqual([words[0].start, words[0].end, words.at(-1)!.end, words[0].score], [0, 0.32, 1.5, 0.9]);
  // A line typed with « ’ » keeps them; one with « ' », or with both, as the transcriber wrote it.
  assert.equal(withApostrophesOf('C\'est l\'imprimante, aujourd\'hui.', 'L’imprimante d’en bas'), 'C’est l’imprimante, aujourd’hui.');
  assert.equal(withApostrophesOf('C’est l’imprimante.', 'L\'imprimante'), 'C\'est l\'imprimante.');
  assert.equal(withApostrophesOf('C\'est l’imprimante.', 'Rien'), 'C\'est l’imprimante.');
});

test('long recordings are heard in windows of 30 s at most, each ending in the quietest moment of its last third', () => {
  const rate = 16000;
  const samples = new Float32Array(rate * 75).map((_, i) => Math.sin(i / 7) * 0.5);
  // Silences at 25 s and 52 s.
  for (const at of [25, 52]) samples.fill(0, at * rate, at * rate + rate / 10);
  const cuts = windows(samples);
  assert.equal(cuts.length, 3);
  assert.ok(cuts[0].end / rate > 25 && cuts[0].end / rate < 25.1, `first cut at ${cuts[0].end / rate}, in the silence`);
  assert.ok(cuts[1].end / rate > 52 && cuts[1].end / rate < 52.1, `second cut at ${cuts[1].end / rate}, in the silence`);
  assert.equal(cuts[2].end, samples.length);
  assert.ok(cuts.every((cut, i) => cut.end - cut.start <= 30 * rate && (i === 0 || cut.start === cuts[i - 1].end)));
});

test('transcribers: one local model for 25 European languages, its size before it is downloaded; nothing heard before it is here', async () => {
  const empty = path.join(temp, 'none');
  await withEnv({ ELABORA_TRANSCRIBER_MODELS_DIR: empty, ELABORA_TRANSCRIBER_MODELS_MANIFEST: undefined, ELEVENLABS_API_KEY: undefined, ELABORA_ELEVENLABS_KEY_FILE: path.join(temp, 'no-key') }, async () => {
    const view = transcribers('fr-CA');
    assert.deepEqual(view.local && [view.local.model, view.local.installed, view.local.size], ['parakeet-tdt-0.6b-v3@8f23f0c int8', false, 670619706]);
    assert.equal(view.elevenlabs, false, 'no key: no ElevenLabs');
    assert.equal(transcribers('ja').local, null);
    const tone = path.join(temp, 'tone.m4a');
    if (!NO_FFMPEG) toneM4a(tone, 1);
    else fs.writeFileSync(tone, '');
    await assert.rejects(transcribeAudio(tone, 'fr'), (error: Error & { code?: string }) => error.code === 'E_TRANSCRIBE_NOT_INSTALLED' && /671 MB, downloaded once/.test(error.message));
    await assert.rejects(transcribeAudio(tone, 'ja'), (error: Error & { code?: string }) => error.code === 'E_TRANSCRIBE_LANGUAGE');
    const folder = path.join(empty, TRANSCRIBER_MODELS[0].id);
    assert.deepEqual(fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => !name.startsWith('.')) : [], [], 'nothing downloaded without install');
  });
});

// A screen with two lines, the second a recording (a tone: what the test transcriber "hears" is given).
async function recorded(): Promise<{ dir: string; file: string }> {
  const dir = copyExample();
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', seconds: 1, speaker: 'marc' },
    { id: 'l2', text: 'Ni l\'imprimante, ni le partage ne marchent.', step: 2, speaker: 'marc' }
  ], { speakers: [{ id: 'marc', name: 'Marc' }, { id: 'leila', name: 'Leïla' }] });
  const file = path.join(temp, `prise-${crypto.randomUUID()}.m4a`);
  toneM4a(file, 2, 523);
  await importNarration(dir, { screen: 'accueil', line: 'l2', file, trim: false });
  return { dir, file };
}

test('a new line from an audio file: its text what the recording says, its audio the recording, after the last line in its step with its speaker, in one undoable change', { skip: NO_FFMPEG }, async () => {
  const { dir } = await recorded();
  const file = path.join(temp, 'appel-marc.wav');
  toneM4a(file.replace(/wav$/, 'm4a'), 1.5, 660);
  fs.renameSync(file.replace(/wav$/, 'm4a'), file);
  await withEnv(fakeEnv({ 'appel-marc.m4a': 'Vous pouvez m\'aider ?' }), async () => {
    const added = await addNarrationLineFromAudio(dir, { screen: 'accueil', file });
    assert.equal(added.line, 'l3');
    assert.equal(added.text, 'Vous pouvez m\'aider ?');
    assert.equal(added.transcript?.transcriber, 'fake');
    const line = readJSON(dir, 'screens/accueil.json').narration.lines[2];
    assert.deepEqual(line, { id: 'l3', text: 'Vous pouvez m\'aider ?', step: 2, speaker: 'marc' });
    const info = narrationLines(loadProjectFromDir(dir), 'accueil', 'fr')!.find((candidate) => candidate.id === 'l3')!;
    assert.deepEqual([info.status, info.provider, info.voice, info.generated], ['ok', 'recording', 'appel-marc.wav', false]);
    assert.ok(info.duration! > 1 && info.duration! < 2);
    // One change: undone, the line and its audio go together.
    edit.undo(dir);
    assert.equal(readJSON(dir, 'screens/accueil.json').narration.lines.length, 2);
    assert.ok(!fs.existsSync(path.join(dir, 'assets/narration/fr/accueil/l3.m4a')));
    // First, with another speaker and its text given (no transcription), or nothing heard: refused.
    const first = await addNarrationLineFromAudio(dir, { screen: 'accueil', file, after: null, speaker: 'leila', step: 1, text: 'Allô ?' });
    assert.deepEqual(readJSON(dir, 'screens/accueil.json').narration.lines[0], { id: first.line, text: 'Allô ?', speaker: 'leila', step: 1 });
    fs.writeFileSync(heard, JSON.stringify({ '*': '' }));
    await assert.rejects(addNarrationLineFromAudio(dir, { screen: 'accueil', file }), (error: Error & { code?: string }) => error.code === 'E_TRANSCRIBE_EMPTY' && /heard no words/.test(error.message));
    await assert.rejects(addNarrationLineFromAudio(dir, { screen: 'nulle-part', file }), (error: Error & { code?: string }) => error.code === 'E_NARRATION_SCREEN');
  });
});

test('« Régénérer le texte d\'après l\'audio »: the line says what its recording says, the recording kept up to date, anchors followed, translations changed since; one change', { skip: NO_FFMPEG }, async () => {
  const { dir } = await recorded();
  const before = narrationLines(loadProjectFromDir(dir), 'accueil', 'fr')!.find((line) => line.id === 'l2')!;
  await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l2', word: 'imprimante' } } });
  edit.exportTranslationChange(dir, { to: 'en' });
  edit.translateText(dir, { language: 'en', unit: 'screen.accueil.narration.l2.text', target: 'Neither the printer nor sharing work.' });
  await withEnv(fakeEnv({ 'l2.m4a': 'Ni l\'imprimante, ni le partage de fichiers ne marchent.' }), async () => {
    // What it says, beside the text now: nothing written.
    const preview = await transcribeNarrationLine(dir, { screen: 'accueil', line: 'l2' });
    assert.deepEqual([preview.before, preview.transcript.text, preview.audioHash], [before.text, 'Ni l\'imprimante, ni le partage de fichiers ne marchent.', readJSON(dir, 'assets/narration/fr/accueil/l2.json').audioHash]);
    assert.equal(readJSON(dir, 'screens/accueil.json').narration.lines[1].text, before.text);
    const written = await setNarrationTextFromAudio(dir, { screen: 'accueil', line: 'l2', text: preview.transcript.text, audioHash: preview.audioHash! });
    assert.equal(written.before, before.text);
    assert.ok(written.change);
    const after = narrationLines(loadProjectFromDir(dir), 'accueil', 'fr')!.find((line) => line.id === 'l2')!;
    assert.deepEqual([after.text, after.status, after.provider], ['Ni l\'imprimante, ni le partage de fichiers ne marchent.', 'ok', 'recording']);
    assert.equal(readJSON(dir, 'assets/narration/fr/accueil/l2.json').audioHash, preview.audioHash, 'the same recording');
    const block = readJSON(dir, 'screens/accueil.json').blocks.find((candidate: { id: string }) => candidate.id === 'accueil-illustration');
    assert.deepEqual(block.timing.in.at, { line: 'l2', word: 'imprimante' }, 'its anchor follows its word');
    const row = translationTable(loadProjectFromDir(dir), 'en').rows.find((candidate) => candidate.id === 'screen.accueil.narration.l2.text')!;
    assert.deepEqual([row.status, row.previousSource], ['stale', before.text], 'the translation is « Modifié depuis »');
    // Undone in one step: the old text, its audio up to date again.
    edit.undo(dir);
    assert.equal(narrationLines(loadProjectFromDir(dir), 'accueil', 'fr')!.find((line) => line.id === 'l2')!.status, 'ok');
    assert.equal(readJSON(dir, 'screens/accueil.json').narration.lines[1].text, before.text);
    // Transcribed now when no text is given; the same text again changes nothing.
    const again = await setNarrationTextFromAudio(dir, { screen: 'accueil', line: 'l2' });
    assert.equal(again.text, 'Ni l\'imprimante, ni le partage de fichiers ne marchent.');
    assert.equal((await setNarrationTextFromAudio(dir, { screen: 'accueil', line: 'l2' })).change, null);
    // Refused: a generated voice, a line without audio, an audio that changed meanwhile, a translation.
    await assert.rejects(setNarrationTextFromAudio(dir, { screen: 'accueil', line: 'l1' }), (error: Error & { code?: string }) => error.code === 'E_NARRATION_GENERATED');
    await assert.rejects(setNarrationTextFromAudio(dir, { screen: 'accueil', line: 'l2', text: 'Autre chose.', audioHash: 'sha256:0000' }), /changed while it was transcribed/);
    await assert.rejects(setNarrationTextFromAudio(dir, { screen: 'accueil', line: 'l2', language: 'en', text: 'Hello.' }), /Only the course's language/);
  });
});

test('engine: what can transcribe, a line\'s recording heard, both flows as commands of the session', { skip: NO_FFMPEG }, async () => {
  const { openProject } = await import('@elabora/engine');
  const { dir } = await recorded();
  const file = path.join(temp, 'nouvelle.m4a');
  toneM4a(file, 1, 700);
  await withEnv(fakeEnv({ 'l2.m4a': 'Rien ne marche.', 'nouvelle.m4a': 'Et le copieur ?' }), async () => {
    const session = await openProject(dir, { backups: { onOpen: false, prune: false }, rescanIntervalMs: 0, media: { enabled: false } });
    const events: string[] = [];
    session.subscribe(({ event }) => events.push(event.type));
    try {
      assert.ok(session.transcribers().local?.installed);
      const line = await session.transcribeLine({ screen: 'accueil', line: 'l2' });
      assert.ok(line.transcript.text === 'Rien ne marche.' && line.before.startsWith('Ni l'), JSON.stringify(line));
      assert.ok(events.includes('transcribeProgress'));
      // Through the protocol, as the app asks.
      const recording = await session.handle({ kind: 'request', id: 'r', type: 'transcribeRecording', params: { file } });
      assert.ok(recording.ok && (recording.result as { text: string }).text === 'Et le copieur ?');
      const added = await session.run('add_narration_line_with_audio', { screen: 'accueil', file, text: 'Et le copieur ?' });
      assert.ok(added.change);
      assert.equal(narrationLines(session.project, 'accueil')!.at(-1)!.text, 'Et le copieur ?');
      const written = await session.run('set_narration_text_from_audio', { screen: 'accueil', line: 'l2', text: 'Rien ne marche.' });
      assert.ok(written.change);
      assert.equal(narrationLines(session.project, 'accueil')!.find((candidate) => candidate.id === 'l2')!.status, 'ok');
      const missing = await session.handle({ kind: 'request', id: 'm', type: 'transcribeLine', params: { screen: 'accueil', line: 'l1' } });
      assert.ok(!missing.ok && missing.error.code === 'E_NARRATION_GENERATED');
    } finally {
      await session.close();
    }
  });
});

test('cli: elabora narration add-from-audio and retranscribe, --dry-run printing the old text and the new', { skip: NO_FFMPEG }, async () => {
  const { dir } = await recorded();
  const file = path.join(temp, 'cli.m4a');
  toneM4a(file, 1, 800);
  const env = { ...process.env, ...fakeEnv({ 'cli.m4a': 'Le copieur aussi.', 'l2.m4a': 'Plus rien ne marche.' }) };
  const elabora = (...args: string[]) => execFileAsync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { env, encoding: 'utf8' });
  const added = await elabora('narration', 'add-from-audio', dir, 'accueil', file);
  assert.match(added.stdout, /^✔ Line l3 of accueil, from cli\.m4a: « Le copieur aussi\. »\n {2}Transcribed by fake: check the text/);
  const dry = await elabora('narration', 'retranscribe', dir, 'accueil', 'l2', '--dry-run');
  assert.match(dry.stdout, /Now: {8}Ni l'imprimante, ni le partage ne marchent\.\n {2}Recording: {2}Plus rien ne marche\./);
  assert.equal(readJSON(dir, 'screens/accueil.json').narration.lines[1].text, 'Ni l\'imprimante, ni le partage ne marchent.');
  const json = JSON.parse((await elabora('narration', 'retranscribe', dir, 'accueil', 'l2', '--json')).stdout);
  assert.deepEqual([json.before, json.text, typeof json.change.seq], ['Ni l\'imprimante, ni le partage ne marchent.', 'Plus rien ne marche.', 'number']);
  await assert.rejects(elabora('narration', 'retranscribe', dir, 'accueil', 'l2', '--service', 'cloud'), (error: { code: number; stderr: string }) => error.code === 2 && /--service takes local/.test(error.stderr));
});

// ElevenLabs' speech to text, as a server of this test: the request it is sent, the words it answers.
test('elevenlabs: a recording transcribed with the author\'s key once its share of the quota is approved, the key never said', { skip: NO_FFMPEG }, async () => {
  const asked: { route: string; fields: string }[] = [];
  let limit = 1_000;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const route = request.url ?? '';
      if (request.headers['xi-api-key'] !== 'sk_test_transcribe1234') { response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key: sk_test_transcribe1234' } })); return; }
      if (route === '/v1/user') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ subscription: { tier: 'starter', character_count: 100, character_limit: limit } })); return; }
      asked.push({ route, fields: Buffer.concat(chunks).toString('latin1') });
      response.writeHead(200, { 'content-type': 'application/json', 'character-cost': '7' }).end(JSON.stringify({
        language_code: 'fra', text: 'Bonjour, c\'est Marc.',
        words: [{ text: 'Bonjour,', start: 0.1, end: 0.5, type: 'word', logprob: -0.01 }, { text: ' ', start: 0.5, end: 0.55, type: 'spacing' }, { text: 'c\'est', start: 0.55, end: 0.7, type: 'word' }, { text: ' ', type: 'spacing' }, { text: 'Marc.', start: 0.7, end: 1.1, type: 'word' }]
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const file = path.join(temp, 'eleven.m4a');
  toneM4a(file, 3, 440);
  try {
    await withEnv({ ELABORA_ELEVENLABS_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ELEVENLABS_API_KEY: 'sk_test_transcribe1234', ELABORA_ELEVENLABS_KEY_FILE: path.join(temp, 'no-key') }, async () => {
      forgetQuota();
      assert.equal(transcribers('fr').elevenlabs, true);
      // A small quota: 3 s is more than 1 % of it, refused with the share, nothing sent.
      await assert.rejects(transcribeAudio(file, 'fr', { service: 'elevenlabs' }), (error: Error & { code?: string; estimate?: { percent: number; needsApproval: boolean } }) => error.code === 'E_TRANSCRIBE_SPEND' && error.estimate!.needsApproval && error.estimate!.percent > 1 && /~\d+ % of your monthly quota/.test(error.message));
      assert.equal(asked.length, 0);
      const estimate = (await import('@elabora/node/transcribe/index')).estimateTranscription;
      const share = (await estimate(file)).percent!;
      const transcript = await transcribeAudio(file, 'fr', { service: 'elevenlabs', approvedPercent: share });
      assert.deepEqual([transcript.text, transcript.service, transcript.transcriber], ['Bonjour, c\'est Marc.', 'elevenlabs', 'elevenlabs/scribe_v2']);
      assert.deepEqual(transcript.words.map((word) => [word.text, word.start]), [['Bonjour', 0.1], ['c\'est', 0.55], ['Marc', 0.7]]);
      assert.equal(asked[0].route, '/v1/speech-to-text');
      assert.match(asked[0].fields, /name="model_id"\r\n\r\nscribe_v2/);
      assert.match(asked[0].fields, /name="language_code"\r\n\r\nfr\r\n/);
      assert.match(asked[0].fields, /name="timestamps_granularity"\r\n\r\nword/);
      assert.match(asked[0].fields, /name="file"; filename="eleven\.m4a"/);
      // A large quota: under 1 %, no approval asked.
      limit = 10_000_000;
      forgetQuota();
      assert.equal((await transcribeAudio(file, 'fr', { service: 'elevenlabs' })).text, 'Bonjour, c\'est Marc.');
      // A wrong key is said without the key.
      process.env.ELEVENLABS_API_KEY = 'sk_wrong_key_9999';
      forgetQuota();
      await assert.rejects(transcribeAudio(file, 'fr', { service: 'elevenlabs', approvedPercent: 100 }), (error: Error & { code?: string }) => !error.message.includes('sk_wrong_key_9999') && !error.message.includes('sk_test_transcribe1234'));
    });
  } finally {
    server.close();
    forgetQuota();
  }
});

test('the real model hears a recorded French line, punctuated (when ELABORA_TRANSCRIBER_MODELS_DIR has it installed)', { skip: !real && 'the transcription model is not installed (ELABORA_TRANSCRIBER_MODELS_DIR)' }, async () => {
  const file = path.join(ROOT, 'examples/diagnostic-reseau/assets/narration/fr/chemin/chemin-reseaux.m4a');
  const transcript = await transcribeAudio(file, 'fr');
  assert.equal(transcript.text, 'Le routeur dirige ensuite les paquets vers le réseau des serveurs. Le pare-feu décide quels flux peuvent passer. Le serveur d\'impression reçoit enfin la demande.');
  assert.equal(transcript.service, 'local');
  assert.equal(transcript.words[0].text, 'Le');
  for (let i = 1; i < transcript.words.length; i++) assert.ok(transcript.words[i].start >= transcript.words[i - 1].start);
  assert.ok(Math.abs(transcript.duration - 8.8) < 0.3);
});
