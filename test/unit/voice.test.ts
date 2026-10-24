import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readJSON, writeJSON, ROOT } from '../helpers.ts';
import { narrate, hasFfmpeg } from '../narration.ts';
import { UnigramTokenizer } from '@elabora/node/voice/pocket/tokenizer';
import { prepareText, splitIntoChunks, ensureTerminalPunctuation } from '@elabora/node/voice/pocket/text';
import { endOnPause, gaussian, readNpyFloat32, ortLoadFailure, PocketModel } from '@elabora/node/voice/pocket/runtime';
import { bundleFor, installBundle, isInstalled, BUNDLES, bundleSize } from '@elabora/node/voice/pocket/models';
import type { Bundle } from '@elabora/node/voice/pocket/models';
import { pocketCatalogue, readEmbeddings, CATALOGUE_DIR } from '@elabora/node/voice/pocket/index';
import { registerVoiceProvider, listVoices, generateNarration, setSpeakerVoice, voiceTakes, VoiceError } from '@elabora/node/voice/index';
import { toneProvider } from '@elabora/node/voice/tone';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { narrationLines } from '@elabora/core/narration/narration';
import { undo } from '@elabora/node/edit/history';
import { ALIGNER_MODELS, alignerInstalled, alignerModels, disposeAligner } from '@elabora/node/align/index';
import { localAiSupported } from '@elabora/node/models/platform';

import { resources } from '../resources.ts';
import { bytes } from '../bytes.ts';
import { eventLog, waitFor } from '../events.ts';
import type { EngineEvent } from '@elabora/engine';

registerVoiceProvider(toneProvider);
const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';

// A tiny Unigram vocabulary: what Kyutai's tokenizer.json holds, a few pieces.
function tokenizer(): UnigramTokenizer {
  const vocab: [string, number][] = [['<unk>', 0], ['▁', -2], ['▁Bon', -3], ['jour', -3], ['▁Bonjour', -4], ['.', -2], ['!', -2], ['?', -2], [',', -2], [';', -2], [':', -2], ['▁le', -2], ['▁monde', -3], ['b', -6], ['o', -6], ['n', -6]];
  for (let byte = 0; byte < 256; byte++) vocab.push([`<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`, -10]);
  return new UnigramTokenizer({ model: { type: 'Unigram', vocab, unk_id: 0, byte_fallback: true } });
}

// The native inference seam is not injectable yet; retain these rejection regressions
// until PocketModel can own a fake inference backend (tracked in TEST-CLEANUP.md).
function inferenceModel(latents: () => Promise<{ frames: never[]; ended: boolean }>, sample: number): PocketModel {
  return Object.assign(Object.create(PocketModel.prototype), {
    meta: { max_token_per_chunk: 100, model_recommended_frames_after_eos: 2 }, tokenizer: tokenizer(),
    latents, decode: async () => Float32Array.of(sample)
  });
}
const synthesisOptions = { temperature: 0.5, seed: 1, rules: { replaceCharacters: {}, removeSemicolons: false, padWithSpacesForShortInputs: false } };
for (const [name, ended, sample] of [['silent', true, 0], ['NaN', true, NaN], ['infinite', true, Infinity], ['unfinished', false, 0.2]] as const) {
  test(`a local voice refuses a ${name} take`, async () => {
    const model = inferenceModel(async () => ({ frames: [], ended }), sample);
    await assert.rejects(model.synthesizeWithReport('Bonjour.', {}, synthesisOptions), { code: 'E_VOICE_SYNTHESIS' });
  });
}
test('a local voice recovers from an unfinished chunk and reports the retry', async () => {
  let attempts = 0;
  const model = inferenceModel(async () => ({ frames: [], ended: ++attempts > 1 }), 0.2);
  const result = await model.synthesizeWithReport('Bonjour.', {}, synthesisOptions);
  assert.equal(result.retries, 1);
  assert.deepEqual(result.samples, Float32Array.of(0.2));
});

test('tokenizer: the best pieces of each word (Viterbi), unknown characters as their UTF-8 bytes, decoded back', () => {
  const t = tokenizer();
  const ids = t.encode('Bonjour le monde.');
  assert.deepEqual(ids.map((id) => t.pieces[id]), ['▁Bonjour', '▁le', '▁monde', '.'], 'one piece beats two when its score is higher');
  assert.equal(t.decode(ids), 'Bonjour le monde.');
  const unknown = t.encode('é');
  assert.deepEqual(unknown.map((id) => t.pieces[id]), ['▁', '<0xC3>', '<0xA9>'], 'é is not a piece: its two bytes');
  assert.equal(t.decode(unknown), 'é');
  assert.deepEqual(t.encode(''), []);
});

test('tokenizer: the real French model gives Kyutai\'s ids (when the model is installed)', { skip: !fs.existsSync(path.join(process.env.ELABORA_VOICE_MODELS_DIR ?? '/nonexistent', 'french_24l/tokenizer.json')) && 'french_24l not installed (ELABORA_VOICE_MODELS_DIR)' }, () => {
  const t = UnigramTokenizer.fromFile(path.join(process.env.ELABORA_VOICE_MODELS_DIR!, 'french_24l/tokenizer.json'));
  // Kyutai's SentencePiece model of the export (sentencepiece 0.2, Python): the same ids.
  assert.deepEqual(t.encode('Bonjour le monde.'), [875, 1330, 271, 457, 263]);
  assert.deepEqual(t.encode("D'accord."), [467, 262, 847, 263]);
});

test('text: Kyutai\'s preparation (characters replaced, capital, final period) and chunks cut at sentence ends', () => {
  const rules = { replaceCharacters: { '«': '', '»': '', ':': ',', '’': "'" }, removeSemicolons: true, padWithSpacesForShortInputs: false };
  assert.equal(prepareText('« bonjour » : vous êtes Leïla ; c’est parti', rules).text, 'Bonjour , vous êtes Leïla , c\'est parti.');
  assert.equal(prepareText('Un mot', rules).framesAfterEos, 3, 'four words or fewer: three frames after the end');
  assert.equal(ensureTerminalPunctuation('Fin,'), 'Fin.', 'a trailing comma becomes a period');
  assert.equal(ensureTerminalPunctuation('« Fin ! »'), '« Fin ! »', 'a closing quote after the mark is left alone');
  assert.equal(ensureTerminalPunctuation('Bonjour'), 'Bonjour.');
  const t = tokenizer();
  // Three sentences of 2 pieces each (word + mark) with chunks of at most 4 pieces: two chunks.
  assert.deepEqual(splitIntoChunks(t, 'Bonjour. Bonjour! Bonjour?', { replaceCharacters: {}, removeSemicolons: false, padWithSpacesForShortInputs: false }, 4), ['Bonjour. Bonjour!', 'Bonjour?']);
});

test('runtime helpers: the prompt ends on 80 ms of silence, the noise is seeded, .npy float32 is read', (t) => {
  const { tempDir } = resources(t);
  const rate = 1000;
  const samples = new Float32Array(1000);
  for (let i = 0; i < 600; i++) samples[i] = Math.sin(i / 3) * 0.5; // 0.6 s of sound, 0.4 s of silence
  const ended = endOnPause(samples, rate);
  assert.equal(ended.length, 600 + 80, 'the trailing silence cut, 80 ms appended');
  assert.equal(ended[ended.length - 1], 0);
  const a = gaussian(42), b = gaussian(42);
  const first = Array.from({ length: 5 }, a);
  assert.deepEqual(first, Array.from({ length: 5 }, b), 'the same seed, the same noise');
  const values = Array.from({ length: 20000 }, gaussian(7));
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  assert.ok(Math.abs(mean) < 0.03 && Math.abs(sd - 1) < 0.03, `normal: mean ${mean}, sd ${sd}`);
  const dir = tempDir('elabora-npy-');
  const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (1, 1, 2), }";
  const padded = header.padEnd(118, ' ') + '\n';
  const npy = Buffer.concat([Buffer.from([0x93]), Buffer.from('NUMPY'), Buffer.from([1, 0]), Buffer.from([padded.length, 0]), Buffer.from(padded, 'latin1'), Buffer.from(new Float32Array([1.5, -2]).buffer)]);
  fs.writeFileSync(path.join(dir, 'a.npy'), npy);
  assert.deepEqual([...readNpyFloat32(path.join(dir, 'a.npy'))], [1.5, -2]);
  // Windows without the Visual C++ runtime: the message says what to install.
  assert.match(ortLoadFailure('\\?\\C:\\…\\onnxruntime_binding.node: The specified module could not be found.', 'win32', 'x64'), /Visual C\+\+ Redistributable \(x64\).*vc_redist\.x64\.exe/);
  assert.doesNotMatch(ortLoadFailure('Cannot find module', 'darwin', 'arm64'), /Visual C/);
});

test('models: a language\'s bundle, downloaded once, resumed, checked against its SHA-256', async (t) => {
  const { tempDir } = resources(t);
  assert.equal(bundleFor('fr')?.id, 'french_24l');
  assert.equal(bundleFor('fr-CA')?.id, 'french_24l', 'a regional tag speaks its language');
  assert.equal(bundleFor('en')?.id, 'english_2026-04');
  assert.equal(bundleFor('de'), null);
  assert.ok(bundleSize(BUNDLES[0]) > 350e6 && bundleSize(BUNDLES[0]) < 360e6, 'French: 354 MB');
  const files = { 'a.bin': bytes(300_000), 'b.json': Buffer.from('{"x":1}') };
  let requests = 0;
  let cut = true;
  const dir = tempDir('elabora-models-');
  const folder = path.join(dir, 'test');
  fs.mkdirSync(folder);
  const received = new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(folder, () => {
      if ((fs.statSync(path.join(folder, 'a.bin.part'), { throwIfNoEntry: false })?.size ?? 0) >= 100_000) {
        watcher.close(); clearTimeout(deadline); resolve();
      }
    });
    const deadline = setTimeout(() => { watcher.close(); reject(new Error('partial download was not written')); }, 5000);
    t.after(() => { watcher.close(); clearTimeout(deadline); });
  });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
  requests++;
  const name = path.basename(String(input)), body = files[name as keyof typeof files];
  if (!body) return new Response(null, { status: 404 });
  const range = /bytes=(\d+)-/.exec(new Headers(options?.headers).get('range') ?? '');
  const start = range ? Number(range[1]) : 0;
  let delivered = false;
  const stream = name === 'a.bin' && cut ? new ReadableStream({ async pull(controller) {
    if (!delivered) { delivered = true; cut = false; controller.enqueue(body.subarray(start, 100_000)); }
    else { await received; controller.error(new Error('connection closed')); }
  } }) : new Uint8Array(body.subarray(start));
  return new Response(stream, { status: range ? 206 : 200, headers: { 'content-length': String(body.length - start) } });
  });
  const env = { ...process.env, ELABORA_VOICE_MODELS_DIR: dir, ELABORA_VOICE_MODELS_URL: 'https://models.invalid' };
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const bundle: Bundle = { id: 'test', language: 'xx', model: 'test', files: Object.entries(files).map(([name, body]) => ({ name, url: `repo/${name}`, size: body.length, sha256: sha(body) })) };
  assert.equal(isInstalled(bundle, env), false);
  await assert.rejects(installBundle(bundle, { env }), 'the broken connection fails the first try');
  assert.ok(fs.statSync(path.join(dir, 'test/a.bin.part')).size >= 100_000, 'what was received is kept');
  const progress: number[] = [];
  await installBundle(bundle, { env, onProgress: (p) => progress.push(p.received / p.total) });
  assert.equal(isInstalled(bundle, env), true);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'test/a.bin')), files['a.bin'], 'resumed from where it broke off');
  assert.equal(progress.at(-1), 1);
  const before = requests;
  await installBundle(bundle, { env });
  assert.equal(requests, before, 'installed: nothing downloaded again');
  // A damaged file is refused.
  const bad: Bundle = { ...bundle, id: 'bad', files: [{ ...bundle.files[1], sha256: '0'.repeat(64) }] };
  await assert.rejects(installBundle(bad, { env }), (error: Error & { code?: string }) => error.code === 'E_VOICE_DOWNLOAD' && /damaged/.test(error.message));

});

test('catalogue: every voice has its embeddings (checked), a licence that allows commercial use and its credits', () => {
  const voices = pocketCatalogue();
  assert.ok(voices.length >= 4, 'French and English voices');
  for (const language of ['fr', 'en']) {
    for (const gender of ['female', 'male']) assert.ok(voices.filter((v) => v.language === language && v.gender === gender).length >= 2, `at least two ${gender} voices in ${language}`);
  }
  for (const voice of voices) {
    const bytes = fs.readFileSync(path.join(CATALOGUE_DIR, voice.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), voice.sha256, `${voice.id}: its embeddings`);
    assert.equal(readEmbeddings(path.join(CATALOGUE_DIR, voice.file)).length, voice.frames * 1024);
    assert.ok(['CC0-1.0', 'CC-BY-4.0'].includes(voice.licence), `${voice.id}: ${voice.licence}`);
    assert.ok(voice.credit.fr && voice.credit.en && /Kyutai/.test(voice.credit.fr), `${voice.id}: credits naming Kyutai`);
    if (voice.licence === 'CC-BY-4.0') assert.match(voice.credit.fr, /CC-BY/, `${voice.id}: the attribution its recording needs`);
  }
  assert.deepEqual(listVoices('fr').filter((v) => v.provider === 'pocket-tts').map((v) => v.id), voices.filter((v) => v.language === 'fr').map((v) => v.id));
});

// The example's first screen narrated by Leïla and Marc, without audio.
function narrated(dir: string): string {
  narrate(dir, 'accueil', [
    { id: 'l1', speaker: 'leila', text: 'Support informatique, Leïla, bonjour.' },
    { id: 'l2', speaker: 'marc', text: 'Plus rien ne marche au 2e étage.' },
    { id: 'l3', speaker: 'leila', text: 'Le poste P-12 ne répond plus.' }
  ], { speakers: [{ id: 'leila', name: 'Leïla' }, { id: 'marc', name: 'Marc' }] });
  return dir;
}

test('generate: each line said by its speaker\'s voice, a take written with its sidecar, takes kept off the course', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample } = resources(t);
  const dir = narrated(copyExample());
  await assert.rejects(generateNarration(dir, { screen: 'accueil' }), (error: VoiceError) => error.code === 'E_VOICE_NOT_SET' && /elabora voice set leila/.test(error.message), 'a speaker without a voice: nothing made');
  assert.ok(!fs.existsSync(path.join(dir, 'assets/narration/fr/accueil/l1.m4a')));
  await assert.rejects(generateNarration(dir, { screen: 'accueil', voice: 'tone-a' }), (error: VoiceError) => error.code === 'E_VOICE_SPEAKERS', 'two speakers: --voice needs a line');
  const change = await setSpeakerVoice(dir, { speaker: 'leila', voice: 'tone-a' });
  assert.ok(change !== null);
  assert.equal(await setSpeakerVoice(dir, { speaker: 'leila', voice: 'tone-a' }), null, 'the same voice again: no change');
  assert.deepEqual(readJSON(dir, 'course.json').speakers[0].voices, { fr: { provider: 'tone', voice: 'tone-a' } });
  await assert.rejects(setSpeakerVoice(dir, { speaker: 'leila', voice: 'tone-c' }), (error: VoiceError) => error.code === 'E_VOICE_LANGUAGE', 'an English voice for French');

  const progress: string[] = [];
  const result = await generateNarration(dir, { screen: 'accueil', lines: ['l2'], voice: 'tone-b', onProgress: (p) => progress.push(`${p.phase}:${p.line}`) });
  assert.deepEqual(result.voiceSet, { speaker: 'marc', provider: 'tone', voice: 'tone-b' });
  assert.deepEqual(result.lines.map((line) => [line.line, line.status, line.take]), [['l2', 'generated', 1]]);
  assert.ok(progress.includes('line:l2'));
  const all = await generateNarration(dir, { screen: 'accueil' });
  assert.deepEqual(all.lines.map((line) => line.line), ['l1', 'l3'], 'then the lines still missing');
  assert.equal(all.changes.length, 2, 'one change a line');
  assert.deepEqual(all.credits, ['Tonalité de test']);

  const sidecar = readJSON(dir, 'assets/narration/fr/accueil/l1.json');
  assert.equal(sidecar.generated, true);
  assert.equal(sidecar.provider, 'tone');
  assert.equal(sidecar.voice, 'tone-a');
  assert.equal(sidecar.take, 1);
  assert.equal(sidecar.credit, 'Tonalité de test');
  assert.equal(sidecar.model, 'tone');
  assert.ok(sidecar.spokenHash && sidecar.settingsHash);
  // The tone has 0.3 s of silence at both ends: trimmed to 0.1 s; 37 characters at 60 ms.
  assert.ok(Math.abs(sidecar.duration - (0.06 * 37 + 0.2)) < 0.1, `trimmed: ${sidecar.duration}`);
  const project = loadProjectFromDir(dir);
  assert.deepEqual(narrationLines(project, 'accueil')!.map((line) => line.status), ['ok', 'ok', 'ok']);
  assert.equal(fs.readdirSync(path.join(dir, 'assets/narration/fr/accueil')).filter((f) => !/\.(m4a|json)$/.test(f)).length, 0, 'only the audio and its sidecar in the course');

  // Nothing out of date: nothing to make. --all: a new take of each.
  assert.deepEqual((await generateNarration(dir, { screen: 'accueil' })).lines, []);
  const again = await generateNarration(dir, { screen: 'accueil', lines: ['l1'] });
  assert.equal(again.lines[0].take, 2);
  const takes = voiceTakes(dir, { screen: 'accueil', line: 'l1' }).takes;
  assert.deepEqual(takes.map((take) => [take.take, take.current, take.usable]), [[1, false, true], [2, true, true]]);
  assert.ok(takes.every((take) => take.file.startsWith(path.join(dir, '.elabora'))), 'takes in the machine-local data');
  const back = await generateNarration(dir, { screen: 'accueil', lines: ['l1'], take: 1 });
  assert.deepEqual(back.lines.map((line) => [line.status, line.take]), [['selected', 1]]);
  assert.equal(readJSON(dir, 'assets/narration/fr/accueil/l1.json').take, 1);
  await assert.rejects(generateNarration(dir, { screen: 'accueil', lines: ['l1'], take: 9 }), (error: VoiceError) => error.code === 'E_VOICE_TAKE');

  // A pronunciation of the course makes l3 out of date; generating says it the new way.
  const course = readJSON(dir, 'course.json');
  course.pronunciations = { fr: [{ text: 'P-12', say: 'pé douze' }] };
  writeJSON(dir, 'course.json', course);
  assert.deepEqual(narrationLines(loadProjectFromDir(dir), 'accueil')!.map((line) => line.status), ['ok', 'ok', 'stale']);
  const fixed = await generateNarration(dir, { screen: 'accueil' });
  assert.deepEqual(fixed.lines.map((line) => line.line), ['l3']);
  assert.equal(voiceTakes(dir, { screen: 'accueil', line: 'l3' }).takes.filter((take) => take.usable).length, 1, 'the take said with the old text cannot be put back');

  // A delivery speed: said faster (ffmpeg atempo), a new take.
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.narration.lines[0].delivery = { fr: { speed: 1.25 } };
  writeJSON(dir, 'screens/accueil.json', screen);
  const before = readJSON(dir, 'assets/narration/fr/accueil/l1.json').duration;
  await generateNarration(dir, { screen: 'accueil' });
  const after = readJSON(dir, 'assets/narration/fr/accueil/l1.json').duration;
  assert.ok(after < before * 0.9, `faster: ${before} s → ${after} s`);

  // Each line's change undoes on its own.
  undo(dir, fixed.changes[0]);
  assert.equal(narrationLines(loadProjectFromDir(dir), 'accueil')!.find((line) => line.id === 'l3')!.status, 'stale');
});

test('cli: elabora voice list, set, generate and takes', { skip: NO_FFMPEG }, (t) => {
  const { copyExample } = resources(t);
  const dir = narrated(copyExample());
  const env = { ...process.env, ELABORA_VOICE_TONES: '1' };
  const elabora = (...args: string[]) => execFileSync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: dir, env, encoding: 'utf8' });
  const voices = JSON.parse(elabora('voice', 'list', '--language', 'fr', '--json')).voices;
  assert.ok(voices.some((v: { id: string; installed: boolean }) => v.id === 'tone-a' && v.installed));
  assert.ok(voices.some((v: { provider: string }) => v.provider === 'pocket-tts'), 'Pocket TTS voices listed with their download size');
  elabora('voice', 'set', 'leila', 'tone-a');
  elabora('voice', 'set', 'marc', 'tone-b');
  const out = JSON.parse(elabora('voice', 'generate', 'accueil', '--json'));
  assert.deepEqual(out.lines.map((line: { line: string; status: string }) => `${line.line}:${line.status}`), ['l1:generated', 'l2:generated', 'l3:generated']);
  const text = elabora('voice', 'generate', 'accueil', '--line', 'l2');
  assert.match(text, /✔ l2: take 2/);
  const takes = JSON.parse(elabora('voice', 'takes', 'accueil', 'l2', '--json')).takes;
  assert.equal(takes.length, 2);
  assert.match(elabora('voice', 'generate', 'accueil', '--line', 'l2', '--take', '1'), /take 1 put back/);
});

test('engine: the app sets a speaker\'s voice and generates through its session (its queue, its events)', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample, own } = resources(t);
  const { openProject } = await import('@elabora/engine');
  const dir = narrated(copyExample());
  const session = own(await openProject(dir, { backups: { onOpen: false, prune: false }, rescanIntervalMs: 0, media: { enabled: false } }), value => value.close());
  const events = eventLog<EngineEvent>();
  session.subscribe(({ event }) => events.record(event));
  const voices = session.voices('fr');
  assert.ok(voices.some((voice) => voice.id === 'tone-a' && voice.installed));
  await assert.rejects(session.generateVoice({ screen: 'accueil' }), (error: Error & { kind?: string; code?: string }) => error.kind === 'refused' && error.code === 'E_VOICE_NOT_SET');
  assert.ok((await session.setSpeakerVoice({ speaker: 'leila', voice: 'tone-a' })).change !== null);
  await session.setSpeakerVoice({ speaker: 'marc', voice: 'tone-b' });
  const result = await session.generateVoice({ screen: 'accueil' });
  assert.deepEqual(result.lines.map((line) => line.status), ['generated', 'generated', 'generated']);
  assert.equal(narrationLines(session.project, 'accueil')!.every((line) => line.status === 'ok'), true, 'the session\'s snapshot has the audio');
  assert.ok(events.some((event) => event.type === 'voiceProgress' && event.screen === 'accueil' && event.progress.line === 'l3'));
  const changed = events.filter((event) => event.type === 'changed' && event.source === 'engine');
  assert.ok(changed.length >= 5, `the voices set and three lines, journaled by the session (${changed.length})`);
  const takes = session.voiceTakes({ screen: 'accueil', line: 'l2' });
  assert.deepEqual(takes.takes.map((take) => [take.take, take.current]), [[1, true]]);
  await assert.rejects(session.generateVoice({ screen: 'nope' }), (error: Error & { kind?: string }) => error.kind === 'not-found');
});

test('automatic alignment reports its phase and failures while keeping generated and selected audio', { skip: NO_FFMPEG || (!localAiSupported() && 'local AI unavailable') }, async (t) => {
  const { copyExample, tempDir, own } = resources(t);
  const { openProject } = await import('@elabora/engine');
  const dir = narrated(copyExample());
  const temp = tempDir('elabora-align-failure-');
  const saved = { ELABORA_ALIGN: process.env.ELABORA_ALIGN, ELABORA_ALIGNER_MODELS_DIR: process.env.ELABORA_ALIGNER_MODELS_DIR, ELABORA_ALIGNER_MODELS_MANIFEST: process.env.ELABORA_ALIGNER_MODELS_MANIFEST };
  const folder = path.join(temp, ALIGNER_MODELS[0].id);
  fs.mkdirSync(folder);
  // A checked installation whose ONNX file cannot run: no download or large model required.
  const files = Object.entries({ 'model.onnx': 'invalid model', 'vocab.json': '{"<pad>":0,"a":1}' }).map(([name, body]) => {
    fs.writeFileSync(path.join(folder, name), body);
    return { name, url: name, size: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') };
  });
  fs.writeFileSync(path.join(folder, 'verified.json'), JSON.stringify(Object.fromEntries(files.map((file) => [file.name, file.sha256]))));
  const manifest = path.join(temp, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ [ALIGNER_MODELS[0].id]: files }));
  Object.assign(process.env, { ELABORA_ALIGN: '1', ELABORA_ALIGNER_MODELS_DIR: temp, ELABORA_ALIGNER_MODELS_MANIFEST: manifest });
  const session = own(await openProject(dir, { backups: { onOpen: false, prune: false }, rescanIntervalMs: 0, media: { enabled: false } }), value => value.close());
  const events = eventLog<EngineEvent>();
  session.subscribe(({ event }) => events.record(event));
  try {
    assert.equal(alignerInstalled(alignerModels()[0]), true);
    await session.setSpeakerVoice({ speaker: 'leila', voice: 'tone-a' });
    // Two takes first: selecting take 1 while it is the line's audio writes nothing, so no
    // set_narration_audio change would follow the alignment.
    for (const take of [undefined, undefined, 1]) {
      events.length = 0;
      const result = await session.generateVoice({ screen: 'accueil', lines: ['l1'], ...(take ? { take } : {}) });
      assert.equal(result.lines[0].status, take ? 'selected' : 'generated');
      assert.ok(result.lines[0].alignmentError, 'the failed alignment reaches the renderer');
      const aligning = events.findIndex((event) => event.type === 'voiceProgress' && event.progress.phase === 'align' && event.progress.line === 'l1');
      // Watcher changes can precede alignment; compare with this audio command's write.
      const written = events.findIndex((event) => event.type === 'changed' && event.change.command?.name === 'set_narration_audio');
      assert.ok(aligning >= 0 && written > aligning, 'alignment is announced before writing the audio');
      assert.equal(narrationLines(session.project, 'accueil')![0].status, 'ok', 'the voice is kept');
      assert.equal(readJSON(dir, 'assets/narration/fr/accueil/l1.json').words, undefined);
    }
    const result = await generateNarration(dir, { screen: 'accueil', lines: ['l3'] });
    assert.ok(result.lines[0].alignmentError, 'the folder writer reports the same failure');
  } finally {
    await disposeAligner();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('engine: a narrated screen as the app shows it, generation stopped midway, a voice heard before it is chosen', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample, own } = resources(t);
  const { openProject } = await import('@elabora/engine');
  const dir = narrated(copyExample());
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.narration.seek = 'free';
  screen.narration.lines[2].step = 2;
  writeJSON(dir, 'screens/accueil.json', screen);
  const session = own(await openProject(dir, { backups: { onOpen: false, prune: false }, rescanIntervalMs: 0, media: { enabled: false } }), value => value.close());
  const events = eventLog<EngineEvent>();
  session.subscribe(({ event }) => events.record(event));
  const before = session.narration('accueil')!;
  assert.equal(before.language, 'fr');
  assert.deepEqual([before.advance, before.seek, before.own], ['learner', 'free', { advance: null, seek: 'free' }], 'the screen\'s own seek, the default advance');
  assert.deepEqual(before.lines.map((line) => [line.id, line.status, line.step, line.timing.estimated]), [['l1', 'missing', 1, true], ['l2', 'missing', 1, true], ['l3', 'missing', 2, true]]);
  assert.deepEqual(before.segments.map((segment) => segment.step), [1, 2]);
  assert.ok(before.lines[1]!.timing.start > before.lines[0]!.timing.end, 'the pause between two lines');
  assert.throws(() => session.narration('inconnu'), (error: Error & { kind?: string }) => error.kind === 'not-found');
  assert.equal(session.narration('bilan'), null, 'a screen without narration');
  await session.setSpeakerVoice({ speaker: 'leila', voice: 'tone-a' });
  await session.setSpeakerVoice({ speaker: 'marc', voice: 'tone-b' });

  // The fake voice service answers the first line, then waits for cancellation on the next.
  let calls = 0;
  t.after(() => registerVoiceProvider(toneProvider));
  registerVoiceProvider({ ...toneProvider, async synthesize(request) {
    request.onProgress?.(0.5);
    if (calls++ === 0) return toneProvider.synthesize(request);
    return new Promise<never>((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
      request.signal!.throwIfAborted();
    });
  } });
  const running = session.generateVoice({ screen: 'accueil' });
  await waitFor(events, (event): event is Extract<EngineEvent, { type: 'changed' }> => event.type === 'changed' && event.change.files.some(file => file.endsWith('l1.m4a')));
  assert.deepEqual(session.cancelVoice('ailleurs'), { cancelled: 0 }, 'another screen: nothing stopped');
  assert.deepEqual(session.cancelVoice('accueil'), { cancelled: 1 });
  const stopped = await running;
  registerVoiceProvider(toneProvider);
  assert.equal(stopped.cancelled, true);
  assert.deepEqual(stopped.lines.map((line) => line.line), ['l1']);
  const after = session.narration('accueil')!;
  assert.deepEqual(after.lines.map((line) => line.status), ['ok', 'missing', 'missing']);
  assert.equal(after.lines[0]!.timing.estimated, false, 'the line said has its real length');
  assert.equal(after.lines[0]!.provider, 'tone');
  assert.ok(events.some((event) => event.type === 'voiceProgress' && event.progress.phase === 'line' && event.progress.fraction > 0 && event.progress.fraction < 1), 'progress while a line is said');
  assert.deepEqual(after.lines[1]!.causes, ['no-audio', 'no-sidecar']);
  // The text of the line said changed: its voice says the old one.
  await session.run('update_narration_line', { screen: 'accueil', line: 'l1', text: 'Un autre texte.' });
  assert.deepEqual(session.narration('accueil')!.lines.map((line) => [line.status, line.causes]), [['stale', ['text']], ['missing', ['no-audio', 'no-sidecar']], ['missing', ['no-audio', 'no-sidecar']]]);

  // In another language: the lines without their translation.
  assert.deepEqual(session.narration('accueil', 'en')!.lines.map((line) => line.status), ['untranslated', 'untranslated', 'untranslated']);

  const sample = await session.voiceSample({ voice: 'tone-a', text: 'Bonjour.' });
  assert.equal(Buffer.from(sample.audio.subarray(0, 4)).toString('latin1'), 'RIFF', 'a WAV');
  assert.ok(sample.duration > 0.5);
  assert.ok(!fs.existsSync(path.join(dir, 'assets/narration/fr/accueil/sample.m4a')) && session.narration('accueil')!.lines[1]!.status === 'missing', 'written nowhere');
  await assert.rejects(session.voiceSample({ voice: 'tone-c', language: 'fr', text: 'Hello.' }), (error: Error & { code?: string }) => error.code === 'E_VOICE_LANGUAGE');
});

test('pocket-tts: a real voice says a line, the same take for the same seed (when the French model is installed)', { skip: !(process.env.ELABORA_VOICE_MODELS_DIR && isInstalled(BUNDLES[0])) && 'french_24l not installed (ELABORA_VOICE_MODELS_DIR)' }, async (t) => {
  const { pocketProvider } = await import('@elabora/node/voice/pocket/index');
  try {
    const say = (seed: number) => pocketProvider.synthesize({ text: 'D’accord : je prends quelques informations.', voice: 'henri', language: 'fr', settings: {}, seed });
    // The model speaks in its own thread: this one goes on answering (the engine, the MCP server).
    let answered = false;
    const response = new Promise<void>(resolve => setImmediate(() => { answered = true; resolve(); }));
    const first = await say(7);
    assert.equal(answered, true, 'the event loop answered before inference completed');
    await response;
    const seconds = first.samples.length / first.sampleRate;
    const rms = Math.sqrt(first.samples.reduce((sum, v) => sum + v * v, 0) / first.samples.length);
    assert.ok(seconds > 1 && seconds < 6, `${seconds} s`);
    assert.ok(rms > 0.01, `speech, not silence: rms ${rms}`);
    assert.equal(first.model, 'pocket-tts/french_24l@d29db79');
    assert.match(first.credit, /Henri.*Kyutai|Kyutai.*Henri/);
    assert.deepEqual((await say(7)).samples.slice(0, 2000), first.samples.slice(0, 2000), 'the same seed, the same take');
    await assert.rejects(pocketProvider.synthesize({ text: 'Hello.', voice: 'henri', language: 'en', settings: {}, seed: 1 }), (error: VoiceError) => error.code === 'E_VOICE_LANGUAGE');
    // Stopped between two steps of the model, then the next line said as usual.
    const controller = new AbortController();
    const stopping = pocketProvider.synthesize({ text: 'Une phrase assez longue pour être arrêtée au milieu, bien avant sa fin, par l’auteur.', voice: 'estelle', language: 'fr', settings: {}, seed: 3, signal: controller.signal, onProgress: fraction => { if (fraction > 0 && fraction < 1) controller.abort(); } });
    await assert.rejects(stopping, (error: Error) => error.name === 'AbortError');
    assert.ok((await say(7)).samples.length > 0);
  } finally {
    await pocketProvider.dispose();
  }
});
