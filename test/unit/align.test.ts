import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forcedAlign, STAR, AlignmentError } from '@elabora/node/align/ctc';
import { spokenWords, targetsOf, vocabularyTokens } from '@elabora/node/align/spoken';
import { alignEmissions } from '@elabora/node/align/align';
import { frenchCardinal, englishCardinal } from '@elabora/node/align/numbers';
import { ALIGNER_MODELS, alignerFor, alignerInstalled } from '@elabora/node/align/models';
import { aligners, alignNarration, alignsAtOnce, disposeAligner } from '@elabora/node/align/index';
import { narrationWords, doubtfulWords, swallowedKey } from '@elabora/core/narration/words';
import { narrationSidecarPath, narrationLines } from '@elabora/core/narration/narration';
import { screenTimeline } from '@elabora/core/narration/timeline';
import * as edit from '@elabora/node/edit';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { readJSON, writeJSON, codes } from '../helpers.ts';
import { narrate, voice, hasFfmpeg } from '../narration.ts';
import { agentFindings } from '@elabora/cli/mcp/tool';

import { resources } from '../resources.ts';
import { seededRandom } from '../mutations.ts';

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const SPEAKERS = [{ id: 'narratrice', name: 'Narratrice' }];

// Every CTC path of T frames for the targets (brute force), to check the Viterbi on small cases.
function bestPathScore(logProbs: Float32Array, T: number, V: number, targets: number[], blank: number): number {
  let best = -Infinity;
  const labels = [blank, ...new Set(targets)];
  const walk = (t: number, path: number[]): void => {
    if (t === T) {
      const collapsed: number[] = [];
      let previous = -2;
      for (const label of path) { if (label !== previous && label !== blank) collapsed.push(label); previous = label; }
      if (collapsed.length === targets.length && collapsed.every((x, i) => x === targets[i])) best = Math.max(best, path.reduce((sum, label, i) => sum + logProbs[i * V + label], 0));
      return;
    }
    for (const label of labels) walk(t + 1, [...path, label]);
  };
  walk(0, []);
  return best;
}

test('the Viterbi finds the best CTC path (random emissions, repeated targets); too little audio is an error, a star absorbs', () => {
  const random = seededRandom(7);
  for (let trial = 0; trial < 30; trial++) {
    const T = 6;
    const V = 4;
    const logProbs = new Float32Array(T * V);
    for (let t = 0; t < T; t++) {
      const row = Array.from({ length: V }, () => random() * 4);
      const sum = Math.log(row.reduce((s, x) => s + Math.exp(x), 0));
      row.forEach((x, v) => { logProbs[t * V + v] = x - sum; });
    }
    const targets = trial % 2 ? [1, 1, 2] : [1, 2, 3];
    const found = forcedAlign({ logProbs, frames: T, vocab: V }, targets, 0);
    assert.ok(Math.abs(found.logLikelihood - bestPathScore(logProbs, T, V, targets, 0)) < 1e-4);
    for (let i = 1; i < found.spans.length; i++) assert.ok(found.spans[i].start >= found.spans[i - 1].end);
  }
  assert.throws(() => forcedAlign({ logProbs: new Float32Array(6).fill(Math.log(1 / 3)), frames: 2, vocab: 3 }, [1, 1], 0), (error: AlignmentError) => error.code === 'E_ALIGN_SHORT');
  const V = 3;
  const logProbs = new Float32Array(8 * V).fill(Math.log(0.01));
  const set = (t: number, v: number): void => { for (let u = 0; u < V; u++) logProbs[t * V + u] = Math.log(u === v ? 0.98 : 0.01); };
  for (let t = 0; t < 8; t++) set(t, 0);
  set(1, 1); set(6, 2);
  const star = forcedAlign({ logProbs, frames: 8, vocab: V }, [1, STAR, 2], 0);
  assert.deepEqual([star.spans[0].start, star.spans[2].start], [1, 6]);
  assert.ok(star.spans[1].start >= 2 && star.spans[1].end <= 6);
});

test('what a voice says: the words of narrationWords, numbers, times and symbols spelt out, elisions run on', () => {
  const said = (text: string, language: string) => spokenWords(text, language).map((word) => (word.spoken ? word.spoken.join(' ') : '*'));
  assert.deepEqual(said('à 9 h 30, au 2e étage, 3,5 %', 'fr'), ['à', 'neuf', 'heures', 'trente', 'au', 'deuxième', 'étage', 'trois virgule cinq pour cent']);
  assert.deepEqual(said('8 h 05 le 1er mars, SUP-NET-04, 9h30', 'fr'), ['huit', 'heures', 'cinq', 'le', 'premier', 'mars', 'sup net zéro quatre', 'neuf heures trente']);
  assert.deepEqual(said('at 9:30 on the 2nd floor, 3.5%, 1,200 users', 'en'), ['at', 'nine thirty', 'on', 'the', 'second', 'floor', 'three point five percent', 'one thousand two hundred', 'users']);
  assert.deepEqual(said('Raum 12', 'de'), ['raum', '*'], 'numbers in a language without its rules: a wildcard');
  assert.equal(frenchCardinal(71).join(' '), 'soixante et onze');
  assert.equal(frenchCardinal(1999).join(' '), 'mille neuf cent quatre vingt dix neuf');
  assert.equal(englishCardinal(1215).join(' '), 'one thousand two hundred fifteen');
  // One word per word of narrationWords, in order: what anchors and the editor count.
  const line = "Ni l'imprimante, ni le partage de fichiers ne marchent.";
  const words = spokenWords(line, 'fr');
  assert.deepEqual(words.map((word) => word.text), narrationWords(line, 'fr').map((word) => word.text));
  assert.deepEqual(words.slice(1, 3).map((word) => [word.text, word.spoken, word.joined]), [["l'", ["l'"], false], ['imprimante', ['imprimante'], true]]);
  // Targets: no delimiter inside « l'imprimante », one between words said apart and between pieces.
  const vocab = { '<pad>': 0, '|': 1, "'": 2, n: 3, i: 4, l: 5, m: 6, p: 7, r: 8, a: 9, t: 10, e: 11 };
  const { targets } = targetsOf(spokenWords("Ni l'imprimante", 'fr'), vocab, 1);
  assert.equal(targets.map((target) => target.token === 1 ? '|' : Object.keys(vocab)[target.token]).join(''), "ni|l'imprimante");
  assert.deepEqual(vocabularyTokens('Leïla', { A: 1, E: 2, I: 3, L: 4 }), [4, 2, 3, 4, 1], 'case and accents fit the vocabulary');
  assert.deepEqual(vocabularyTokens('cœur', { c: 1, o: 2, e: 3, u: 4, r: 5 }), [1, 2, 3, 4, 5], 'ligatures split');
});

test('word times from emissions: the characters\' frames, starts a frame earlier, ends later up to the next start, scores', () => {
  const vocab = { '<pad>': 0, '|': 1, "'": 2, a: 3, i: 4, l: 5, m: 6 };
  const V = 7;
  const T = 12;
  const peaks: Record<number, number> = { 3: 5, 4: 2, 5: 3, 6: 3, 7: 6, 8: 4 }; // l ' a a m i
  const logProbs = new Float32Array(T * V);
  for (let t = 0; t < T; t++) for (let v = 0; v < V; v++) logProbs[t * V + v] = Math.log((peaks[t] ?? 0) === v ? 0.9 : 0.1 / (V - 1));
  const alignment = alignEmissions({ logProbs, frames: T, vocab: V, frameSeconds: 0.02 }, "l'ami", 'fr', { vocab, blank: 0, delimiter: 1 }, { startShift: -0.02, endShift: 0.03 });
  assert.equal(alignment.duration, 0.24);
  assert.deepEqual(alignment.words, [
    { text: "l'", start: 0.04, end: 0.08, score: 0.9, said: "l'" },
    { text: 'ami', start: 0.08, end: 0.21, score: 0.9, said: 'ami' }
  ]);
  // A word the vocabulary cannot spell is a wildcard: its times, no score.
  const star = alignEmissions({ logProbs, frames: T, vocab: V, frameSeconds: 0.02 }, 'ami 12', 'de', { vocab, blank: 0, delimiter: 1 });
  assert.equal(star.words[1].said, '*');
  assert.equal(star.words[1].score, undefined);
  assert.deepEqual(doubtfulWords([{ text: 'le', score: 0.1 }, { text: 'a', score: 0.05 }, { text: 'imprimante', score: 0.9 }, { text: '12' }]), [{ word: 'le', score: 0.1, index: 0 }], 'two letters or more under 0.25, with their place in the line');
});

test('aligners: one per language, pinned and checked; lines are timed at once only where the aligner is installed', (t) => {
  const { tempDir } = resources(t);
  assert.equal(alignerFor('fr-CA')?.language, 'fr');
  assert.equal(alignerFor('de'), null);
  for (const model of ALIGNER_MODELS) {
    assert.deepEqual(model.files.map((file) => file.name), ['model.onnx', 'vocab.json']);
    for (const file of model.files) { assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.match(file.url, /\/resolve\/[0-9a-f]{40}\//, 'a pinned revision'); }
  }
  const empty = tempDir('elabora-aligners-');
  const env = { ...process.env, ELABORA_ALIGNER_MODELS_DIR: empty, ELABORA_ALIGN: '1' };
  assert.equal(alignerInstalled(ALIGNER_MODELS[0], env), false);
  assert.equal(alignsAtOnce('fr', env), null);
  assert.equal(alignsAtOnce('fr', { ...env, ELABORA_ALIGN: '0' }), null);
  const previous = process.env.ELABORA_ALIGNER_MODELS_DIR;
  process.env.ELABORA_ALIGNER_MODELS_DIR = empty;
  try {
    assert.deepEqual(aligners('en').map((aligner) => [aligner.language, aligner.installed, aligner.size]), [['en', false, 95286404]]);
  } finally {
    if (previous === undefined) delete process.env.ELABORA_ALIGNER_MODELS_DIR; else process.env.ELABORA_ALIGNER_MODELS_DIR = previous;
  }
});

// The example's first screen, narrated with tones (no speech: words come from set_narration_words).
function voiced(dir: string) {
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', seconds: 2 },
    { id: 'l2', text: "Ni l'imprimante, ni le partage de fichiers ne marchent.", seconds: 3 },
    { id: 'l3', text: 'Ça bloque toute la comptabilité !' }
  ], { speakers: SPEAKERS });
  return dir;
}

test('set_narration_words: the words, their aligner and the text they time go into the sidecar; anchors take their times; swallowed words are a finding', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample } = resources(t);
  const dir = voiced(copyExample());
  await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l2', word: 'partage' } } });
  assert.ok(codes(validateDir(dir).diagnostics).includes('I_TIMELINE_WORDS_ESTIMATED'));
  const text = "Ni l'imprimante, ni le partage de fichiers ne marchent.";
  const words = narrationWords(text, 'fr').map((word, index) => ({ text: word.text, start: index * 0.3, end: index * 0.3 + 0.25, score: word.text === 'le' ? 0.08 : 0.97 }));
  const sidecarPath = narrationSidecarPath('fr', 'accueil', 'l2');
  const before = readJSON(dir, sidecarPath);
  assert.throws(() => edit.setNarrationWords(dir, { screen: 'accueil', line: 'l2', words, aligner: 'test', audioHash: `sha256:${'0'.repeat(64)}` }), /changed while its words were timed/);
  const result = await edit.setNarrationWords(dir, { screen: 'accueil', line: 'l2', words, aligner: 'test-aligner', audioHash: before.audioHash });
  assert.equal(result.words, words.length);
  const sidecar = readJSON(dir, sidecarPath);
  assert.equal(sidecar.text, text);
  assert.equal(sidecar.aligner, 'test-aligner');
  assert.deepEqual(sidecar.words, words);
  assert.equal(sidecar.audioHash, before.audioHash, 'the rest of the sidecar stays');
  const timeline = screenTimeline(loadProjectFromDir(dir), 'accueil')!;
  const moment = timeline.moments.find((candidate) => candidate.block === 'accueil-illustration')!;
  assert.equal(moment.estimated, false);
  assert.equal(moment.at, Math.round((timeline.lines[1].start + 1.5) * 1000) / 1000, '« partage » is the sixth word');
  const diagnostics = validateDir(dir).diagnostics;
  assert.ok(!codes(diagnostics).includes('I_TIMELINE_WORDS_ESTIMATED'));
  const swallowed = diagnostics.filter((d) => d.code === 'W_NARRATION_WORD_SWALLOWED');
  assert.equal(swallowed.length, 1);
  assert.match(swallowed[0].message, /may have swallowed « le » \(word 5, score 0\.08\)/);
  assert.equal(swallowed[0].path, '/narration/lines/1');
  assert.equal(swallowed[0].key, swallowedKey('accueil', 'l2', 'fr', { index: 4, word: 'le' }, before.audioHash), 'keyed by the line, the word and its take\'s audio');
  assert.equal(swallowed[0].ignored, undefined);
  assert.equal(narrationLines(loadProjectFromDir(dir), 'accueil')![1].aligner, 'test-aligner');
  // A line without audio has no words to time.
  assert.throws(() => edit.setNarrationWords(dir, { screen: 'accueil', line: 'l3', words, aligner: 'test' }), /has no audio in fr to time/);
});

test('a swallowed word the author ignores (D31): kept in course.json for this word of this take, it counts no more; another take brings it back', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample } = resources(t);
  const dir = voiced(copyExample());
  const text = "Ni l'imprimante, ni le partage de fichiers ne marchent.";
  const timed = (scores: Record<string, number>) => narrationWords(text, 'fr').map((word, index) => ({ text: word.text, start: index * 0.3, end: index * 0.3 + 0.25, score: scores[word.text] ?? 0.97 }));
  const audioHash = () => readJSON(dir, narrationSidecarPath('fr', 'accueil', 'l2')).audioHash;
  await edit.setNarrationWords(dir, { screen: 'accueil', line: 'l2', words: timed({ le: 0.08, fichiers: 0.03 }), aligner: 'test', audioHash: audioHash() });
  const swallowed = () => validateDir(dir).diagnostics.filter((d) => d.code === 'W_NARRATION_WORD_SWALLOWED');
  assert.deepEqual(swallowed().map((d) => (d.details as { words: { word: string }[] }).words[0].word), ['le', 'fichiers'], 'one finding per word');
  const warnings = validateDir(dir).summary.warnings;
  const le = swallowed()[0];
  // « Ignorer »: one change, the finding marked and no longer counted, the other word still one.
  const result = edit.ignoreFindings(dir, { findings: [{ code: le.code, key: le.key! }] });
  assert.ok(result.change, 'an undoable change');
  assert.deepEqual(readJSON(dir, 'course.json').ignored, [{ code: 'W_NARRATION_WORD_SWALLOWED', key: le.key }]);
  const after = validateDir(dir);
  assert.deepEqual(after.diagnostics.filter((d) => d.code === 'W_NARRATION_WORD_SWALLOWED').map((d) => [(d.details as { words: { word: string }[] }).words[0].word, d.ignored ?? false]), [['le', true], ['fichiers', false]]);
  assert.equal(after.summary.warnings, warnings - 1);
  assert.equal(after.summary.ignored, 1);
  assert.deepEqual(agentFindings(after.diagnostics).filter((d) => d.code === 'W_NARRATION_WORD_SWALLOWED').map((d) => (d.details as { words: { word: string }[] }).words[0].word), ['fichiers'], 'what agents are given after an edit, an undo or a build');
  // A hand-written entry without a key does not stop the next choice: it goes.
  const course = readJSON(dir, 'course.json');
  writeJSON(dir, 'course.json', { ...course, ignored: [...course.ignored, { code: 'W_NARRATION_WORD_SWALLOWED' }] });
  assert.ok(edit.ignoreFindings(dir, { findings: [{ code: le.code, key: le.key! }] }).change);
  writeJSON(dir, 'course.json', { ...course });
  // Timed again (the same audio): still ignored.
  await edit.setNarrationWords(dir, { screen: 'accueil', line: 'l2', words: timed({ le: 0.05, fichiers: 0.03 }), aligner: 'test', audioHash: audioHash() });
  assert.equal(swallowed()[0].ignored, true, 'the same take: the choice holds');
  // Another take of the line: its audio differs, the word may be swallowed for real, the alert is back.
  voice(dir, 'accueil', { id: 'l2', text, seconds: 3 }, { language: 'fr', frequency: 990 });
  await edit.setNarrationWords(dir, { screen: 'accueil', line: 'l2', words: timed({ le: 0.08 }), aligner: 'test', audioHash: audioHash() });
  const again = swallowed();
  assert.equal(again.length, 1);
  assert.equal(again[0].ignored, undefined, 'a new take: the alert comes back');
  assert.notEqual(again[0].key, le.key);
  // Ignoring it in the new take replaces the old choice about the same word; « Rétablir » takes it back.
  edit.ignoreFindings(dir, { findings: [{ code: again[0].code, key: again[0].key! }] });
  assert.deepEqual(readJSON(dir, 'course.json').ignored, [{ code: 'W_NARRATION_WORD_SWALLOWED', key: again[0].key }], 'one entry per word');
  edit.ignoreFindings(dir, { findings: [{ code: again[0].code, key: again[0].key! }], ignored: false });
  assert.equal(readJSON(dir, 'course.json').ignored, undefined);
  assert.equal(swallowed()[0].ignored, undefined);
  // Errors are never ignored, and a key is needed.
  assert.throws(() => edit.ignoreFindings(dir, { findings: [{ code: 'E_NARRATION_SPEAKER', key: 'accueil@x' }] }), /Only a warning or an information may be ignored/);
  assert.throws(() => edit.ignoreFindings(dir, { findings: [{ code: 'W_NARRATION_WORD_SWALLOWED', key: ' ' }] }), /by its key/);
  // Both words in one change.
  const both = swallowed();
  edit.ignoreFindings(dir, { findings: both.map((d) => ({ code: d.code, key: d.key! })) });
  assert.ok(swallowed().every((d) => d.ignored));
});

test('elabora narration align: lines without audio or already timed are skipped, the aligner downloaded once, its failure said', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample, tempDir } = resources(t);
  const dir = voiced(copyExample());
  // A mirror that has nothing: the download fails with its code, nothing is written.
  const server = http.createServer((_request, response) => { response.writeHead(404).end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = { dir: process.env.ELABORA_ALIGNER_MODELS_DIR, url: process.env.ELABORA_ALIGNER_MODELS_URL };
  process.env.ELABORA_ALIGNER_MODELS_DIR = tempDir('elabora-aligners-');
  process.env.ELABORA_ALIGNER_MODELS_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await assert.rejects(alignNarration(dir, { screen: 'accueil' }), (error: Error & { code?: string }) => error.code === 'E_ALIGN_DOWNLOAD' && /word aligner model could not be downloaded: 404/.test(error.message));
    const words = narrationWords('Bonjour, voici le ticket de Marc.', 'fr').map((word, index) => ({ text: word.text, start: index * 0.3, end: index * 0.3 + 0.2 }));
    await edit.setNarrationWords(dir, { screen: 'accueil', line: 'l1', words, aligner: ALIGNER_MODELS[0].model });
    const result = await alignNarration(dir, { screen: 'accueil', lines: ['l1', 'l3'] });
    assert.deepEqual(result.lines.map((line) => [line.line, line.status, line.reason]), [['l1', 'skipped', 'already timed'], ['l3', 'skipped', 'no audio']]);
    assert.deepEqual(result.changes, []);
    await assert.rejects(alignNarration(dir, { screen: 'accueil', lines: ['l9'] }), (error: Error & { code?: string }) => error.code === 'E_ALIGN_LINE');
    const german = await alignNarration(dir, { language: 'de' });
    assert.ok(german.lines.every((line) => line.status === 'skipped'), 'no line in German');
  } finally {
    server.close();
    for (const [key, value] of [['ELABORA_ALIGNER_MODELS_DIR', saved.dir], ['ELABORA_ALIGNER_MODELS_URL', saved.url]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

// With a real voice and the real aligner: ELABORA_VOICE_MODELS_DIR and ELABORA_ALIGNER_MODELS_DIR
// pointing to installed models.
const realModels = (): boolean => !!(process.env.ELABORA_VOICE_MODELS_DIR && process.env.ELABORA_ALIGNER_MODELS_DIR && alignerInstalled(ALIGNER_MODELS[0]) && fs.existsSync(path.join(process.env.ELABORA_VOICE_MODELS_DIR, 'french_24l/verified.json')));

test('a real voice is timed as it is made: words in its sidecar, anchors on them, the voice heard where the alignment puts it (when the models are installed)', { skip: !realModels() && 'the French voice and aligner are not installed (ELABORA_VOICE_MODELS_DIR, ELABORA_ALIGNER_MODELS_DIR)' }, async (t) => {
  const { copyExample } = resources(t);
  const { generateNarration, disposeVoiceProviders } = await import('@elabora/node/voice/index');
  const dir = copyExample();
  narrate(dir, 'accueil', [{ id: 'l1', text: "Bonjour, c'est Marc. J'ai lancé l'impression à 9 h 30, mais rien ne sort." }], { speakers: [{ id: 'narratrice', name: 'Narratrice', voices: { fr: { provider: 'pocket-tts', voice: 'estelle' } } }] });
  const savedAlign = process.env.ELABORA_ALIGN;
  process.env.ELABORA_ALIGN = '1';
  try {
    await generateNarration(dir, { screen: 'accueil' });
    const sidecar = readJSON(dir, narrationSidecarPath('fr', 'accueil', 'l1'));
    assert.equal(sidecar.aligner, ALIGNER_MODELS[0].model);
    assert.deepEqual(sidecar.words.map((word: { text: string }) => word.text), narrationWords(sidecar.text, 'fr').map((word) => word.text));
    for (let i = 1; i < sidecar.words.length; i++) assert.ok(sidecar.words[i].start >= sidecar.words[i - 1].start, 'in order');
    assert.ok(sidecar.words.at(-1).end <= sidecar.duration + 0.001);
    assert.ok(sidecar.words.filter((word: { score?: number }) => (word.score ?? 0) > 0.5).length >= sidecar.words.length - 2, 'the voice says its words');
    await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l1', word: 'impression' } } });
    const moment = screenTimeline(loadProjectFromDir(dir), 'accueil')!.moments[0];
    assert.equal(moment.estimated, false);
    // Again with --force: the same words, from the same audio.
    const again = await alignNarration(dir, { screen: 'accueil', force: true });
    assert.equal(again.lines[0].status, 'aligned');
    assert.deepEqual(readJSON(dir, narrationSidecarPath('fr', 'accueil', 'l1')).words, sidecar.words);
  } finally {
    if (savedAlign === undefined) delete process.env.ELABORA_ALIGN; else process.env.ELABORA_ALIGN = savedAlign;
    await disposeVoiceProviders();
    await disposeAligner();
  }
});

test('the sidecar keeps the text its audio says', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample, tempDir } = resources(t);
  const dir = voiced(copyExample());
  const file = path.join(dir, 'assets/narration/fr/accueil/l1.m4a');
  const copy = path.join(tempDir('elabora-line-'), 'l1.m4a');
  fs.copyFileSync(file, copy);
  await edit.updateNarrationLine(dir, { screen: 'accueil', line: 'l1', text: 'Bonjour, voici le ticket de Leïla.' });
  const { importNarration } = await import('@elabora/node/narration/audio');
  await importNarration(dir, { screen: 'accueil', line: 'l1', file: copy, trim: false });
  const sidecar = readJSON(dir, narrationSidecarPath('fr', 'accueil', 'l1'));
  assert.equal(sidecar.text, 'Bonjour, voici le ticket de Leïla.');
  assert.equal(sidecar.words, undefined, 'no aligner in tests (ELABORA_ALIGN=0): words untimed');
});

test('engine: the app asks which aligners are here, writes words and times lines through its session', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample, own } = resources(t);
  const { openProject } = await import('@elabora/engine');
  type EngineEvent = import('@elabora/engine').EngineEvent;
  const dir = voiced(copyExample());
  const session = own(await openProject(dir, { backups: { onOpen: false, prune: false }, rescanIntervalMs: 0, media: { enabled: false } }), value => value.close());
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  assert.deepEqual(session.aligners('fr-CA').map((aligner) => [aligner.language, aligner.model]), [['fr', ALIGNER_MODELS[0].model]]);
  const words = narrationWords('Bonjour, voici le ticket de Marc.', 'fr').map((word, index) => ({ text: word.text, start: index * 0.3, end: index * 0.3 + 0.2 }));
  const written = await session.run('set_narration_words', { screen: 'accueil', line: 'l1', words, aligner: ALIGNER_MODELS[0].model });
  assert.ok(written.change);
  assert.equal(narrationLines(session.project, 'accueil')![0].aligner, ALIGNER_MODELS[0].model, 'the session\'s snapshot has the words');
  const result = await session.alignNarration({ screen: 'accueil', lines: ['l1', 'l3'] });
  assert.deepEqual(result.lines.map((line) => line.status), ['skipped', 'skipped']);
  assert.ok(events.some((event) => event.type === 'changed' && event.source === 'engine'));
  // Through the protocol, as the app asks.
  for (const [type, params] of [['aligners', {}], ['timeline', { screen: 'accueil' }], ['timelineAt', { screen: 'accueil', time: 1 }], ['timelineMarks', { screen: 'accueil' }]] as const) {
    const response = await session.handle({ kind: 'request', id: type, type, params });
    assert.ok(response.ok, `${type}: ${JSON.stringify(response)}`);
  }
  const relative = await session.handle({ kind: 'request', id: 'tr', type: 'transcribeRecording', params: { file: 'l1.m4a' } });
  assert.ok(!relative.ok && relative.error.kind === 'bad-request', 'a recording is an absolute path');
  assert.equal(session.effects()[0].name, 'none');
  await assert.rejects(session.alignNarration({ screen: 'accueil', lines: ['l9'] }), (error: Error & { kind?: string; code?: string }) => error.kind === 'not-found' && error.code === 'E_ALIGN_LINE');
});

test('recordings imported together: each file to the line its name gives; the others said unmatched; the waveform of the lines', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample, tempDir } = resources(t);
  const { importNarrationFiles } = await import('@elabora/node/narration/audio');
  const { narrationPeaks } = await import('@elabora/node/narration/peaks');
  const { toneM4a } = await import('../narration.ts');
  const dir = copyExample();
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.' },
    { id: 'l2', text: "Ni l'imprimante, ni le partage de fichiers ne marchent." },
    { id: 'l3', text: 'Ça bloque toute la comptabilité !' }
  ], { speakers: SPEAKERS });
  const folder = tempDir('elabora-recordings-');
  const files = ['L1.m4a', 'accueil-l2.m4a', '03 fin.m4a', 'autre chose.m4a'].map((name, index) => { const file = path.join(folder, name); toneM4a(file, 1 + index * 0.5); return file; });
  const result = await importNarrationFiles(dir, { screen: 'accueil', files, trim: false });
  assert.deepEqual(result.files.map((file) => [path.basename(file.file), file.status, file.line ?? null, file.by ?? null]), [
    ['L1.m4a', 'imported', 'l1', 'name'], ['accueil-l2.m4a', 'imported', 'l2', 'name'], ['03 fin.m4a', 'imported', 'l3', 'name'], ['autre chose.m4a', 'unmatched', null, null]
  ]);
  assert.match(result.files[3].reason!, /no line is named so/);
  assert.ok(result.files.slice(0, 3).every((file) => typeof file.change === 'number'), 'one change a line');
  assert.ok(narrationLines(loadProjectFromDir(dir), 'accueil')!.every((line) => line.status === 'ok'));
  // The waveform: a slice every 20 ms, loud where the tone is.
  const peaks = (await narrationPeaks(dir, loadProjectFromDir(dir), 'accueil', { perSecond: 50 }))!;
  assert.deepEqual(peaks.lines.map((line) => line.line), ['l1', 'l2', 'l3']);
  assert.ok(Math.abs(peaks.lines[1].peaks.length - Math.round(peaks.lines[1].duration * 50)) <= 2);
  assert.ok(peaks.lines[0].peaks[20] >= 30, `ffmpeg's sine is an eighth of full scale (${peaks.lines[0].peaks[20]})`);
  const again = (await narrationPeaks(dir, loadProjectFromDir(dir), 'accueil', { perSecond: 50 }))!;
  assert.deepEqual(again.lines[0].peaks, peaks.lines[0].peaks, 'from the cache');
});

test('a recording without a name finds its line by what it says (when the models are installed)', { skip: !realModels() && 'the French voice and aligner are not installed (ELABORA_VOICE_MODELS_DIR, ELABORA_ALIGNER_MODELS_DIR)' }, async (t) => {
  const { copyExample, tempDir } = resources(t);
  const { generateNarration, disposeVoiceProviders } = await import('@elabora/node/voice/index');
  const { importNarrationFiles } = await import('@elabora/node/narration/audio');
  const dir = copyExample();
  const lines = [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.' },
    { id: 'l2', text: "Ni l'imprimante, ni le partage de fichiers ne marchent." },
    { id: 'l3', text: 'Ça bloque toute la comptabilité depuis ce matin !' }
  ];
  narrate(dir, 'accueil', lines, { speakers: [{ id: 'narratrice', name: 'Narratrice', voices: { fr: { provider: 'pocket-tts', voice: 'estelle' } } }] });
  const savedAlign = process.env.ELABORA_ALIGN;
  process.env.ELABORA_ALIGN = '1';
  try {
    await generateNarration(dir, { screen: 'accueil' });
    const folder = tempDir('elabora-recordings-');
    // The voices made, as unnamed recordings, in another order; the lines' audio removed.
    const files = ['l3', 'l1', 'l2'].map((line, index) => { const file = path.join(folder, `prise ${index + 1}.m4a`); fs.copyFileSync(path.join(dir, `assets/narration/fr/accueil/${line}.m4a`), file); return file; });
    for (const line of lines) for (const ext of ['m4a', 'json']) fs.rmSync(path.join(dir, `assets/narration/fr/accueil/${line.id}.${ext}`));
    const result = await importNarrationFiles(dir, { screen: 'accueil', files, trim: false });
    assert.deepEqual(result.files.map((file) => [file.line, file.by]), [['l3', 'voice'], ['l1', 'voice'], ['l2', 'voice']]);
  } finally {
    if (savedAlign === undefined) delete process.env.ELABORA_ALIGN; else process.env.ELABORA_ALIGN = savedAlign;
    await disposeVoiceProviders();
    await disposeAligner();
  }
});

test('keep_narration_audio (« La voix dit bien ce texte »): a corrected text keeps its audio, its words follow; refused for other causes', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample } = resources(t);
  const dir = voiced(copyExample());
  const text = "Ni l'imprimante, ni le partage de fichiers ne marchent.";
  const words = narrationWords(text, 'fr').map((word, index) => ({ text: word.text, start: index * 0.3, end: index * 0.3 + 0.25, score: 0.9 }));
  await edit.setNarrationWords(dir, { screen: 'accueil', line: 'l2', words, aligner: 'test' });
  assert.throws(() => edit.keepNarrationAudio(dir, { screen: 'accueil', line: 'l2' }), /is up to date: nothing to keep/);
  await edit.updateNarrationLine(dir, { screen: 'accueil', line: 'l2', text: "Ni l'imprimante ni le partage des fichiers ne marchent." });
  assert.equal(narrationLines(loadProjectFromDir(dir), 'accueil')![1].status, 'stale');
  await edit.keepNarrationAudio(dir, { screen: 'accueil', line: 'l2' });
  const line = narrationLines(loadProjectFromDir(dir), 'accueil')![1];
  assert.equal(line.status, 'ok');
  const sidecar = readJSON(dir, narrationSidecarPath('fr', 'accueil', 'l2'));
  assert.equal(sidecar.text, "Ni l'imprimante ni le partage des fichiers ne marchent.");
  assert.ok(!sidecar.words.some((word: { text: string }) => word.text === 'des'), 'a new word is not given a time it was never measured at');
  assert.equal(sidecar.words.find((word: { text: string }) => word.text === 'fichiers').start, 2.1, 'the words that stayed keep theirs');
  assert.throws(() => edit.keepNarrationAudio(dir, { screen: 'accueil', line: 'l3' }), /missing: nothing to keep/);
});

test('set_plan_voiceover: written in the plan, whether a version of it was validated or not (D52)', async (t) => {
  const { copyExample } = resources(t);
  const dir = copyExample();
  const item = readJSON(dir, 'screens/accueil.json').covers[0];
  await edit.setPlanVoiceover(dir, { item, lines: [{ speaker: 'marc', text: ' Bonjour,   c\'est Marc. ' }] }, { author: { kind: 'agent', name: 'claude-code' } });
  assert.deepEqual(readJSON(dir, 'plan.json').items.find((candidate: { id: string }) => candidate.id === item).voiceover, [{ speaker: 'marc', text: "Bonjour, c'est Marc." }]);
  await edit.setPlanVoiceover(dir, { item, lines: null });
  assert.equal(readJSON(dir, 'plan.json').items.find((candidate: { id: string }) => candidate.id === item).voiceover, undefined);
  assert.throws(() => edit.setPlanVoiceover(dir, { item, lines: null }), /has no voice-over to remove/);
  assert.throws(() => edit.setPlanVoiceover(dir, { item: 'ITEM-404', lines: [{ text: 'x' }] }), /No item "ITEM-404"/);
  assert.throws(() => edit.setPlanVoiceover(dir, { item, lines: [{ text: '  ' }] }), /has its words/);
});

test('effects a timing can take: the presets, then the theme\'s, with their durations and directions; diagnostics carry structured details', { skip: NO_FFMPEG }, async (t) => {
  const { copyExample } = resources(t);
  const { effectsOf } = await import('@elabora/core/narration/timeline');
  const dir = voiced(copyExample());
  const course = readJSON(dir, 'course.json');
  course.theme = { ...(course.theme ?? {}), effects: { tampon: 'Comes in like a rubber stamp' } };
  writeJSON(dir, 'course.json', course);
  const effects = effectsOf(loadProjectFromDir(dir));
  assert.deepEqual(effects.map((effect) => [effect.name, effect.builtin, effect.duration]), [['none', true, 0], ['fade', true, 0.4], ['rise', true, 0.5], ['slide', true, 0.5], ['zoom', true, 0.4], ['wipe', true, 0.6], ['draw', true, 1.2], ['tampon', false, 0.4]]);
  assert.deepEqual(effects.find((effect) => effect.name === 'slide')!.directions, ['left', 'right', 'up', 'down']);
  assert.equal(effects.at(-1)!.description, 'Comes in like a rubber stamp');
  await edit.setBlockTiming(dir, { block: 'accueil-illustration', in: { at: { line: 'l2', word: 'copieur' } } });
  const lost = validateDir(dir).diagnostics.find((d) => d.code === 'E_TIMELINE_ANCHOR_MISSING')!;
  assert.deepEqual(lost.details, { screen: 'accueil', block: 'accueil-illustration', kind: 'in', anchor: { line: 'l2', word: 'copieur' }, lost: 'word' });
});

test('the aligner runs in a process of its own: when ONNX Runtime aborts it, the job fails with E_ALIGN_CRASHED and the next one still runs', async (t) => {
  const { own } = resources(t);
  const { AlignProcess } = await import('@elabora/node/align/process');
  const aligner = own(new AlignProcess(new URL('../fixtures/align-stand-in.ts', import.meta.url).href), value => value.dispose());
  const job = (text: string) => ({ dir: '', samples: new Float32Array(16000), text, language: 'fr', startShift: 0, endShift: 0 });
  assert.equal((await aligner.align(job('bonjour'))).words[0].text, 'bonjour');
  // Windows reports process.abort() as exit code 134 rather than a Unix signal.
  await assert.rejects(aligner.align(job('crash')), (error: Error & { code?: string }) => error.code === 'E_ALIGN_CRASHED' && (process.platform === 'win32' ? /exit code 134/ : /SIGABRT/).test(error.message));
  assert.equal((await aligner.align(job('encore'))).duration, 1, 'another process answers');
});

test('a line of more than 45 s is suggested to be cut, as a warning that blocks nothing', { skip: NO_FFMPEG }, (t) => {
  const { copyExample } = resources(t);
  const dir = copyExample();
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', seconds: 2 },
    { id: 'l2', text: 'Une réplique de la longueur d’un cours entier.', seconds: 50 }
  ], { speakers: SPEAKERS });
  const found = validateDir(dir).diagnostics.filter((d) => d.code === 'W_NARRATION_LINE_LONG');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, '/narration/lines/1');
  assert.equal(found[0].severity, 'warning');
  assert.deepEqual(found[0].details, { screen: 'accueil', line: 'l2', duration: 50 });
});

// A command that stops the aligner and prints its answer afterwards: the process of the aligner is
// not held while idle (the engine may end), so the wait for its exit has to hold it.
test('stopping the aligner\'s process keeps the program alive until it has gone, so the answer after it is printed', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../fixtures/align-dispose.ts', import.meta.url))], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.stdout, 'stopped after an alignment\n', run.stderr);
  assert.equal(run.status, 0);
});

test('a command that never settles ends with E_COMMAND_UNSETTLED and exit code 70, not as a silent success', () => {
  const unsettled = fileURLToPath(new URL('../fixtures/command-unsettled.ts', import.meta.url));
  const stuck = spawnSync(process.execPath, [unsettled], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(stuck.status, 70);
  assert.equal(stuck.stdout, '');
  assert.match(stuck.stderr, /^✘ E_COMMAND_UNSETTLED: elabora narration transcribe x\.m4a stopped before it finished/);
  const fine = spawnSync(process.execPath, [unsettled, 'finishes'], { encoding: 'utf8', timeout: 60_000 });
  assert.deepEqual([fine.status, fine.stdout, fine.stderr], [0, 'done\n', '']);
});
