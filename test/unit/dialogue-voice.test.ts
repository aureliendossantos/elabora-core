import { test, type TestContext } from 'node:test';
import { resources } from '../resources.ts';
import { seededRandom } from '../mutations.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withoutDirections } from '@elabora/core/narration/directions';
import { narrationWords } from '@elabora/core/narration/words';
import { mouthEnvelope } from '@elabora/core/narration/mouth';
import { screenVoiceLines, trackKey } from '@elabora/core/narration/voice-lines';
import { narrationLines } from '@elabora/core/narration/narration';
import { inlineSvg } from '@elabora/core/render/svg-inline';
import { characterProblems, characterManifest } from '@elabora/core/dialogue/character';
import { dialogueView } from '@elabora/core/dialogue/view';
import { extractUnits } from '@elabora/core/i18n/units';
import { screenAnchors } from '@elabora/core/i18n/anchors';
import { translationExport } from '@elabora/core/i18n/translate';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { textVoice, voiceAt, textWords } from '@elabora/player/character/voice';
import type { DialogueData } from '@elabora/player/dialogue/types';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { registerVoiceProvider, generateNarration, setSpeakerVoice } from '@elabora/node/voice/index';
import { toneProvider } from '@elabora/node/voice/tone';
import { build } from '@elabora/node/build';
import { importNarrationFiles } from '@elabora/node/narration/audio';
import { setNarrationTextFromAudioChange } from '@elabora/node/edit';
import { readZip } from '@elabora/node/zip';
import { resolveComments } from '@elabora/node/cloud/resolve';
import type { CloudReview, CommentsAnswer } from '@elabora/node/cloud/types';
import { courseWithDialogue as makeDialogueCourse, MARC_DIALOGUE } from '../dialogue-fixture.ts';
import { ROOT, readJSON, writeJSON, codes } from '../helpers.ts';
import { hasFfmpeg } from '../narration.ts';

// The lines of dialogues are voice lines like the others (D61, D62): their sources, units, checks,
// voices and audio in the package; the mouth's envelope; characters read, checked and sanitized.

registerVoiceProvider(toneProvider);
const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const tmp = (t: TestContext, prefix: string) => resources(t).tempDir(prefix);
const courseWithDialogue = (t: TestContext, ...args: Parameters<typeof makeDialogueCourse>) => resources(t).own(makeDialogueCourse(...args), dir => fs.rmSync(dir, { recursive: true, force: true }));

test('withoutDirections keeps the line\'s own typography: the space a French line puts before : ; ! ? stays', (t) => {
  assert.equal(withoutDirections('[inquiet, au téléphone] Bonjour… plus rien ne marche au deuxième étage : ni l\'imprimante !'), 'Bonjour… plus rien ne marche au deuxième étage : ni l\'imprimante !');
  assert.equal(withoutDirections('Vraiment ? [un temps] Bon ; on y va : maintenant !'), 'Vraiment ? Bon ; on y va : maintenant !');
  assert.equal(withoutDirections('Bonjour [rit] !'), 'Bonjour !', 'the space before a direction goes, the line\'s own space before ! stays');
  assert.equal(withoutDirections('Hello [laughs]!'), 'Hello!');
  assert.equal(withoutDirections('Wait [beat]: now.'), 'Wait: now.');
  assert.equal(withoutDirections('mot [un temps], suite.'), 'mot, suite.');
  assert.equal(withoutDirections('a [x] [y] b'), 'a b');
  assert.equal(withoutDirections('Fin [soupire].'), 'Fin.');
});

test('the sanitizer (D33) reads a <style> as text, scopes selector lists at their own level, renames id selectors only, and drops @property', (t) => {
  const run = (source: string) => inlineSvg(source, { prefix: 'p', decorative: true });
  const scope = 'svg[data-t-svg="p"]';
  // A « < » in a comment or a string is no tag: the rules after it stay.
  let out = run('<svg><style>/* durée < 300 ms */.a{fill:red}.b{fill:blue}</style><g class="a"/></svg>');
  assert.ok(out.html.includes(`${scope} .a{fill:red;}${scope} .b{fill:blue;}`), out.html);
  assert.deepEqual(out.removed, []);
  assert.match(out.html, /<g class="a"><\/g>/);
  out = run('<svg><style>.a{--note:"a<b"}.c{fill:red}</style></svg>');
  assert.ok(out.html.includes(`${scope} .a{--note:"a\\3c b";}${scope} .c{fill:red;}`), out.html);
  out = run('<svg><style><![CDATA[/* < */.a{fill:red}]]></style></svg>');
  assert.ok(out.html.includes(`${scope} .a{fill:red;}`), out.html);
  out = run('<svg><style><!-- old --> .a{fill:red} &amp; </style></svg>');
  assert.ok(out.html.includes(`${scope} .a{fill:red;}`) && !out.html.includes('old'), out.html);
  // Lists inside :is(), :where(), :not(), :has() stay whole; the top-level list is scoped part by part.
  out = run('<svg><style>[data-part="character"]:has(> .a, > .b) .c, .d{fill:red}</style></svg>');
  assert.ok(out.html.includes(`${scope} [data-part="character"]:has(> .a, > .b) .c,${scope} .d{fill:red;}`), out.html);
  out = run('<svg><style>[data-part="character"]:is([data-paused],[data-reduced-motion]) *{animation:none}</style></svg>');
  assert.ok(out.html.includes(`${scope} [data-part="character"]:is([data-paused],[data-reduced-motion]) *{animation:none;}`), out.html);
  out = run('<svg><style>.m:not([data-mouth="open"],[data-mouth="wide"]){opacity:1}:where(.a,.b) .c{fill:red}</style></svg>');
  assert.ok(out.html.includes(`${scope} .m:not([data-mouth="open"],[data-mouth="wide"]){opacity:1;}${scope} :where(.a,.b) .c{fill:red;}`), out.html);
  // « # » in an attribute's value or a string is no id; id selectors are renamed, in :is() too.
  out = run('<svg><style>[fill="#fff"]{opacity:.5}#a,:is(#b) .c{fill:red}</style><g id="a"/></svg>');
  assert.ok(out.html.includes(`${scope} [fill="#fff"]{opacity:.5;}${scope} #p-a,${scope} :is(#p-b) .c{fill:red;}`), out.html);
  assert.match(out.html, /<g id="p-a">/);
  // @property is the page's, not the drawing's: removed, and said; so is a layer statement.
  out = run('<svg><style>@property --open{syntax:"<number>";inherits:true;initial-value:0}.b{fill:red}</style></svg>');
  assert.ok(out.html.includes(`${scope} .b{fill:red;}`) && !out.html.includes('@property'), out.html);
  assert.match(out.removed.join(' | '), /@property/);
  assert.match(run('<svg><style>@layer base;.a{fill:red}</style></svg>').removed.join(' | '), /@layer/);
  // What the convention needs is kept: data-* everywhere, var(), @keyframes renamed with their
  // animations, @media, !important, transform-origin in px; text and clip paths are the validator's.
  const probes: [string, (html: string, removed: string[]) => boolean][] = [
    ['<svg viewBox="0 0 10 10"><rect fill="var(--character-skin, #c68e6a)" width="10" height="10"/></svg>', (html) => html.includes('fill="var(--character-skin, #c68e6a)"')],
    ['<svg viewBox="0 0 10 10"><rect style="fill: var(--character-skin, #c68e6a)" width="10" height="10"/></svg>', (html) => html.includes('style="fill: var(--character-skin, #c68e6a)"')],
    ['<svg><style>@media (prefers-reduced-motion: reduce){.arm{animation:none}}</style></svg>', (html) => html.includes(`@media (prefers-reduced-motion: reduce){${scope} .arm{animation:none;}}`)],
    ['<svg><style>.arm{animation:wave 1.2s ease-in-out both}@keyframes wave{0%{transform:rotate(0deg)}100%{transform:rotate(9deg)}}</style></svg>', (html) => html.includes('animation:p-wave 1.2s') && html.includes('@keyframes p-wave')],
    ['<svg><style>.a{animation-name:blink,breathe}@keyframes blink{to{opacity:0}}@keyframes breathe{to{opacity:1}}</style></svg>', (html) => html.includes('animation-name:p-blink,p-breathe')],
    ['<svg><style>[data-part="character"][data-gesture="saluer"] .arm{animation:wave 1s}</style></svg>', (html) => html.includes(`${scope} [data-part="character"][data-gesture="saluer"] .arm`)],
    ['<svg><style>svg[data-character] .x{fill:red}</style></svg>', (html) => html.includes(`${scope}[data-character] .x{fill:red;}`)],
    ['<svg><style>[data-paused] *{animation-play-state:paused!important}</style></svg>', (html) => html.includes('animation-play-state:paused!important')],
    ['<svg><style>@supports (transform-box: view-box){.a{transform-box:view-box}}</style></svg>', (html) => html.includes(`@supports (transform-box: view-box){${scope} .a{transform-box:view-box;}}`)],
    ['<svg><style>.arm{&[data-x]{fill:red}}</style></svg>', (html) => html.includes(`${scope} .arm{&[data-x]{fill:red;}}`)],
    ['<svg><style>.head{transform-box:view-box;transform-origin:200px 330px}</style></svg>', (html) => html.includes('transform-origin:200px 330px')],
    ['<svg viewBox="0 0 400 600" data-character="marc" data-expressions="neutre inquiet" data-default-expression="neutre" data-gestures="saluer:1.2" data-portrait="84 104 232 232"></svg>', (html) => html.includes('data-character="marc" data-expressions="neutre inquiet" data-default-expression="neutre" data-gestures="saluer:1.2" data-portrait="84 104 232 232"')],
    ['<svg><g data-part="character" data-paused><path data-mouth="closed" data-expression="souriant"/></g></svg>', (html) => html.includes('<g data-part="character" data-paused=""><path data-mouth="closed" data-expression="souriant"></path></g>')],
    ['<svg><defs><clipPath id="face"><circle r="5"/></clipPath></defs><g clip-path="url(#face)"/></svg>', (html) => html.includes('clip-path="url(#p-face)"')],
    ['<svg><title>Marc</title><g/></svg>', (html) => !html.includes('<title>')],
    ['<svg><rect><animate attributeName="opacity" values="0;1" dur="1s" repeatCount="indefinite"/></rect></svg>', (html) => html.includes('<animate attributeName="opacity"')],
    ['<svg><text x="0" y="10">Marc</text></svg>', (html) => html.includes('<text x="0" y="10">Marc</text>')],
    ['<svg><style>.a{font-family:"A\\\\B"}</style></svg>', (_html, removed) => removed.some((item) => /escape/.test(item))]
  ];
  for (const [source, ok] of probes) {
    const result = run(source);
    assert.ok(ok(result.html, result.removed), `${source}\n→ ${result.html}\n  removed: ${result.removed.join('; ')}`);
  }
  // A character gets t-character, not t-figure-svg.
  assert.match(inlineSvg('<svg/>', { prefix: 'c', decorative: true, kind: 'character' }).html, /class="t-character"/);
  // The sample characters lose nothing.
  for (const name of ['marc', 'leila']) assert.deepEqual(run(fs.readFileSync(path.join(ROOT, `test/fixtures/characters/${name}.svg`), 'utf8')).removed, [], name);
});

// A voice line: syllables of a carrier, louder and softer, with silences between words.
function syllables(rate: number, words: { start: number; end: number }[], gain = 1, noise = false): Float32Array {
  const duration = Math.max(...words.map((word) => word.end)) + 0.3;
  const samples = new Float32Array(Math.round(duration * rate));
  const random = seededRandom(7);
  for (let index = 0; index < samples.length; index++) {
    const t = index / rate;
    const word = words.find((candidate) => t >= candidate.start && t <= candidate.end);
    if (!word) continue;
    // About three syllables a second, each opening and closing.
    const syllable = Math.abs(Math.sin(Math.PI * (t - word.start) * 3));
    const carrier = noise ? random() * 2 - 1 : Math.sin(2 * Math.PI * 180 * t);
    samples[index] = gain * syllable * carrier * 0.6;
  }
  return samples;
}

test('the mouth\'s envelope: 30 letters a second, deterministic, the same for a whispered voice, closed in silences and on m, b, p', (t) => {
  const rate = 16000;
  const words = [{ text: 'Bonjour', start: 0.1, end: 0.6 }, { text: 'Marc', start: 0.7, end: 1.1 }, { text: 'merci', start: 1.8, end: 2.3 }];
  const loud = syllables(rate, words);
  const envelope = mouthEnvelope(loud, rate, words);
  assert.equal(envelope.length, Math.ceil((loud.length / rate) * 30));
  assert.match(envelope, /^[csow]+$/);
  assert.equal(mouthEnvelope(loud, rate, words), envelope, 'the same samples give the same letters');
  // Every shape is used; a silence of more than 250 ms closes the mouth (between Marc and merci).
  for (const shape of 'csow') assert.ok(envelope.includes(shape), `${shape} in ${envelope}`);
  assert.match(envelope.slice(Math.ceil(1.15 * 30), Math.floor(1.75 * 30)), /^c+$/);
  assert.match(envelope.slice(0, 3), /^c+$/, 'closed before the first word');
  // m of « Marc » and « merci », b of « Bonjour »: closed where the letter falls.
  for (const word of words) {
    const at = Math.floor((word.start + (word.end - word.start) * 0.5 / word.text.length) * 30);
    assert.equal(envelope[at], 'c', `${word.text} starts closed (${envelope.slice(at - 2, at + 3)})`);
  }
  // A whisper: the same speech forty times softer, then as breath (noise) rather than voice.
  assert.equal(mouthEnvelope(syllables(rate, words, 0.025), rate, words), envelope, 'the thresholds come from the line itself');
  const breath = mouthEnvelope(syllables(rate, words, 0.03, true), rate, words);
  let same = 0;
  for (let index = 0; index < envelope.length; index++) if (breath[index] === envelope[index]) same++;
  assert.ok(same / envelope.length > 0.7, `a whispered voice moves the mouth as the voiced one (${same}/${envelope.length})\n${envelope}\n${breath}`);
  // Silence, and a flat tone: closed, and open while it sounds.
  assert.match(mouthEnvelope(new Float32Array(rate), rate, words), /^c+$/);
  const tone = Float32Array.from({ length: rate }, (_v, index) => Math.sin(2 * Math.PI * 440 * index / rate) * 0.5);
  assert.equal(mouthEnvelope(tone, rate, [{ text: 'aaa', start: 0, end: 1 }]).replace(/c/g, ''), 'o'.repeat(30));
});

test('a voice without audio: words placed as the core places them, a mouth from the letters, voiceAt for the player', (t) => {
  for (const [text, language] of [["L'imprimante du 2e étage ne répond plus : ni le partage, ni le 3,5.", 'fr'], ["The printer's down, isn't it? P-12 at 9:30.", 'en']] as const) {
    assert.deepEqual(textWords(text, language).map((word) => [word.text, word.start, word.end]), narrationWords(text, language).map((word) => [word.text, word.start, word.end]), 'the player and the core count the same words');
  }
  const voice = textVoice('Bonjour Marc, je suis Leïla, du support. Je vous écoute.');
  assert.equal(voice.src, null);
  assert.equal(voice.estimated, true);
  assert.equal(voice.duration, 3.7, 'the core\'s estimate: 15 characters a second');
  assert.deepEqual(voice.words.map(([word]) => word), ['Bonjour', 'Marc', 'je', 'suis', 'Leïla', 'du', 'support', 'Je', 'vous', 'écoute']);
  assert.equal(voice.mouth!.length, Math.ceil(3.7 * 30));
  assert.equal(voice.mouth![Math.floor(0.01 * 30)], 'c', 'B closes');
  assert.match(voice.mouth!, /w/, 'a opens wide');
  assert.deepEqual(voiceAt(voice, -1), { talking: false, mouth: 'closed', word: null });
  const middle = voiceAt(voice, (voice.words[4]![1] + voice.words[4]![2]) / 2);
  assert.equal(middle.word, 4);
  assert.equal(middle.talking, true);
  assert.deepEqual(voiceAt(voice, 10), { talking: false, mouth: 'closed', word: 9 });
  // Without an envelope the mouth follows the words: open in speech, closed in a long silence.
  const words: [string, number, number][] = [['un', 0, 0.3], ['deux', 1, 1.3]];
  assert.equal(voiceAt({ src: null, duration: 1.5, words, mouth: null, estimated: true }, 0.2).mouth, 'open');
  assert.deepEqual(voiceAt({ src: null, duration: 1.5, words, mouth: null, estimated: true }, 0.6), { talking: false, mouth: 'closed', word: 0 });
});

test('a dialogue\'s lines are voice lines: their track, unit and place, the learner\'s answers with learnerVoice, never a narration without voice', (t) => {
  const dialogue = structuredClone(MARC_DIALOGUE);
  (dialogue.props as Record<string, unknown>).learnerVoice = true;
  const dir = courseWithDialogue(t, dialogue);
  const project = loadProjectFromDir(dir);
  const entries = screenVoiceLines(project, 'appel');
  const byId = new Map(entries.map((entry) => [entry.line.id, entry]));
  assert.deepEqual(entries.map((entry) => entry.line.id), ['m1', 'l1', 'premiere-question.a', 'm2', 'l2', 'premiere-question.b', 'premiere-question.c', 'm3', 'm4', 'ticket.a', 'ticket.b', 'ticket.c', 'm5', 'm6', 'escalade.a', 'escalade.b', 'm7']);
  assert.ok(!byId.has('n1') && !byId.has('n2'), 'a narration without speaker has no voice');
  assert.deepEqual([trackKey(byId.get('m1')!.track), byId.get('m1')!.unit, byId.get('m1')!.path, byId.get('m1')!.blockUnit], ['dialogue:appel-marc:appel', 'block.appel-marc.nodes.appel.lines.m1.text', '/blocks/0/props/nodes/0/lines/0', true]);
  assert.deepEqual([trackKey(byId.get('m2')!.track), byId.get('m2')!.unit, byId.get('m2')!.path], ['dialogue:appel-marc:premiere-question:a', 'block.appel-marc.nodes.premiere-question.options.a.reply.m2.text', '/blocks/0/props/nodes/1/options/0/reply/0']);
  const answer = byId.get('premiere-question.a')!;
  assert.deepEqual([answer.line.speaker, answer.line.text, answer.unit, answer.path], ['leila', 'Depuis quand le problème a-t-il commencé ?', 'block.appel-marc.nodes.premiere-question.options.a.text', '/blocks/0/props/nodes/1/options/0']);
  // The engine's dialogue view gives them with their audio's state (the dock).
  assert.deepEqual(dialogueView(project, 'appel-marc')!.voices.map((line) => `${line.id}:${line.status}`).slice(0, 3), ['m1:missing', 'l1:missing', 'premiere-question.a:missing']);
  // Their audio follows the convention; missing audio is told once for the dialogue.
  const lines = narrationLines(project, 'appel')!;
  assert.equal(lines.find((line) => line.id === 'premiere-question.a')!.audio, 'assets/narration/fr/appel/premiere-question.a.m4a');
  const missing = validateDir(dir).diagnostics.filter((d) => d.code === 'W_NARRATION_AUDIO_MISSING' && d.target === 'appel');
  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.equal(missing[0]!.path, '/blocks/0/props');
  assert.match(missing[0]!.message, /^Dialogue "appel-marc" \(screen "appel"\) has no narration audio in fr yet \(m1, l1, premiere-question\.a/);
  // A dialogue's speakers are its own check (E_DIALOGUE_SPEAKER), not the narration's.
  const screen = readJSON(dir, 'screens/appel.json');
  screen.blocks[0].props.nodes[0].lines[0].speaker = 'ghost';
  writeJSON(dir, 'screens/appel.json', screen);
  const found = codes(validateDir(dir).diagnostics);
  assert.ok(found.includes('E_DIALOGUE_SPEAKER') && !found.includes('E_NARRATION_SPEAKER'), found.join(', '));
});

test('translation units of a dialogue\'s lines carry their cues\' anchors and their stage directions (D28, D29), as a layer\'s lines do', (t) => {
  const dir = courseWithDialogue(t);
  const project = loadProjectFromDir(dir);
  const units = extractUnits(project);
  const m1 = units.find((unit) => unit.id === 'block.appel-marc.nodes.appel.lines.m1.text')!;
  assert.equal(m1.voice, true);
  assert.deepEqual(m1.marks?.map((mark) => mark.word), ['étage']);
  assert.match(m1.note!, /^Line m1 \(marc\) of node "appel" of dialogue "appel-marc" on screen "Signaler l'incident": shown in a bubble and said by a voice/);
  assert.match(m1.note!, /stage direction/);
  assert.equal(units.filter((unit) => unit.id === m1.id).length, 1, 'listed once, in the block\'s place');
  const l1 = units.find((unit) => unit.id === 'block.appel-marc.nodes.appel.lines.l1.text')!;
  assert.deepEqual(l1.marks?.map((mark) => mark.word), ['Bonjour']);
  // The XLIFF marks them.
  const { text } = translationExport(project, { to: 'en' });
  assert.match(text, /<mrk id="d1" type="elabora:direction">\[inquiet, au téléphone\]<\/mrk> Bonjour… plus rien ne marche au deuxième <mrk id="w-[^"]+" type="elabora:anchor">étage<\/mrk>/);
  // A cue anchors to its own line without naming it: the anchors of the screen give it its line.
  const anchors = screenAnchors(project.screens.get('appel')!.data).filter((reference) => reference.where.startsWith('appel-marc'));
  assert.deepEqual(anchors.map((reference) => [reference.anchor.line, reference.anchor.word]), [['m1', 'étage'], ['l1', 'Bonjour']]);
});

test('a character is read from its root, checked against the convention, and sanitized into the course data', (t) => {
  const marc = fs.readFileSync(path.join(ROOT, 'test/fixtures/characters/marc.svg'), 'utf8');
  assert.deepEqual(characterProblems(marc), []);
  assert.deepEqual(characterManifest(marc), { expressions: ['neutre', 'souriant', 'inquiet', 'soulage', 'agace'], defaultExpression: 'neutre', gestures: { saluer: 1.2, hocher: 0.8 }, portrait: [94, 118, 212, 212] });
  const bare = '<svg viewBox="0 0 10 10"><g><path id="m" data-mouth="closed"/><text>Marc</text></g></svg>';
  const problems = characterProblems(bare);
  assert.deepEqual(problems.map((problem) => problem.kind), ['convention', 'convention', 'convention', 'content', 'content']);
  assert.match(problems[0]!.message, /data-part="character"/);
  assert.match(problems[2]!.message, /mouths small, open, wide/);
  assert.match(problems[3]!.message, /ids? \(m\)/);
  assert.match(problems[4]!.message, /text/);

  const dir = courseWithDialogue(t);
  fs.writeFileSync(path.join(dir, 'assets/personnages/marc.svg'), marc);
  fs.writeFileSync(path.join(dir, 'assets/personnages/leila.svg'), bare.replace('<svg ', '<svg data-expressions="neutre souriante concentree" '));
  const course = readJSON(dir, 'course.json');
  course.speakers[0].look = { svg: 'personnages/marc.svg' };
  writeJSON(dir, 'course.json', course);
  const appel = readJSON(dir, 'screens/appel.json');
  appel.blocks[0].props.nodes[0].lines[0].expression = 'content';
  writeJSON(dir, 'screens/appel.json', appel);
  const found = validateDir(dir).diagnostics;
  const of = (code: string) => found.filter((d) => d.code === code);
  assert.deepEqual(of('W_CHARACTER_CONVENTION').map((d) => d.target), ['leila', 'leila']);
  assert.deepEqual(of('W_CHARACTER_CONTENT').map((d) => [d.target, d.path]), [['leila', '/speakers/1/look/svg'], ['leila', '/speakers/1/look/svg']]);
  // W_DIALOGUE_LOOK reads the manifest: Marc has no « content » expression; Leïla declares no gestures.
  assert.deepEqual(of('W_DIALOGUE_LOOK').map((d) => d.message), ['Dialogue "appel-marc": marc has no expression "content" (expressions: neutre, souriant, inquiet, soulage, agace).']);
  // The course data: the SVG sanitized with t-character, and its manifest.
  const project = loadProjectFromDir(dir);
  const data = compileCourseData(project, assignKeys(project, readLock(project)).keys, { buildId: 'test' });
  const block = data.screens.find((screen) => screen.id === 'appel')!.blocks[0]!;
  const props = block.props as unknown as DialogueData;
  assert.match(props.speakers.marc!.look!.inline!, /^<svg [^>]*class="t-character" data-t-svg="t-char-marc" aria-hidden="true" focusable="false">/);
  assert.deepEqual(props.speakers.marc!.look!.manifest!.gestures, { saluer: 1.2, hocher: 0.8 });
  assert.equal(props.speakers.marc!.look!.svg, 'assets/personnages/marc.svg');
});

test('the course data: each line\'s voice estimated without audio (src null, a mouth from the text) and each cue\'s time in its line', (t) => {
  const dir = courseWithDialogue(t);
  const project = loadProjectFromDir(dir);
  const data = compileCourseData(project, assignKeys(project, readLock(project)).keys, { buildId: 'test' });
  const props = data.screens.find((screen) => screen.id === 'appel')!.blocks[0]!.props as unknown as DialogueData;
  const m1 = props.nodes[0]!.lines[0]!;
  assert.equal(m1.voice!.src, null);
  assert.equal(m1.voice!.estimated, true);
  assert.equal(m1.voice!.words[0]![0], 'Bonjour', 'the words of what is said, stage directions left out');
  assert.match(m1.voice!.mouth!, /^[csow]+$/);
  const etage = m1.voice!.words.find(([word]) => word === 'étage')!;
  assert.equal(m1.cues![0]!.time, etage[2], 'at the end of « étage » (edge end)');
  assert.equal(props.nodes[0]!.lines[1]!.cues![0]!.time, 0, '« Bonjour » starts the line');
  assert.ok(props.nodes.find((node) => node.id === 'ticket')!.lines[0]!.voice, 'a narration without voice has its reading time all the same');
  assert.equal(props.nodes[1]!.options[0]!.voice, undefined, 'no learner voice without learnerVoice');
});

test('generated voices say a dialogue\'s lines (ELABORA_VOICE_TONES=1), with the mouth in each sidecar; the package ships one file per line and stays the same', { skip: NO_FFMPEG }, async (t) => {
  const dialogue = structuredClone(MARC_DIALOGUE);
  (dialogue.props as Record<string, unknown>).learnerVoice = true;
  const dir = courseWithDialogue(t, dialogue);
  // The CLI, as an agent runs it, with the test voices.
  const env = { ...process.env, ELABORA_VOICE_TONES: '1' };
  const elabora = (...args: string[]) => execFileSync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: dir, env, encoding: 'utf8' });
  elabora('voice', 'set', 'marc', 'tone-b');
  elabora('voice', 'set', 'leila', 'tone-a');
  const one = JSON.parse(elabora('voice', 'generate', 'appel', '--line', 'm1', '--json'));
  assert.deepEqual(one.lines.map((line: { line: string; status: string }) => `${line.line}:${line.status}`), ['m1:generated']);
  const sidecar = readJSON(dir, 'assets/narration/fr/appel/m1.json');
  assert.match(sidecar.mouth, /^[csow]+$/);
  assert.equal(sidecar.mouth.length, Math.ceil(sidecar.duration * 30));
  assert.match(sidecar.mouth, /o/, 'the tone opens the mouth while it sounds');
  // The others, in-process, the learner's answers included.
  const result = await generateNarration(dir, { screen: 'appel' });
  assert.ok(result.lines.some((line) => line.line === 'premiere-question.a' && line.status === 'generated'), JSON.stringify(result.lines));
  const project = loadProjectFromDir(dir);
  assert.ok(narrationLines(project, 'appel')!.every((line) => line.status === 'ok'), 'every line of the dialogue has its audio');
  const answer = readJSON(dir, 'assets/narration/fr/appel/premiere-question.a.json');
  assert.equal(answer.line, 'premiere-question.a');
  const checked = validateDir(dir).diagnostics.filter((d) => d.severity === 'error' || d.code === 'W_NARRATION_AUDIO_MISSING');
  assert.deepEqual(checked.map((d) => `${d.code} ${d.file}`), [], 'the sidecars follow their schema');

  // The package: one file per line at narration/<screen>.<block>/<line>.m4a, its voice in the course data.
  const a = await build(dir, { out: tmp(t, 'elabora-dv-a-'), writeLock: false });
  const b = await build(dir, { out: tmp(t, 'elabora-dv-b-'), writeLock: false });
  assert.ok(a.ok && b.ok && a.zipPath, JSON.stringify(a.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  assert.equal(a.report.package.sha256, b.report.package.sha256, 'the same inputs give the same package');
  const { files } = readZip(fs.readFileSync(a.zipPath));
  for (const line of ['m1', 'l1', 'm7', 'premiere-question.a']) assert.ok(files.has(`narration/appel.appel-marc/${line}.m4a`), line);
  assert.ok(files.get('imsmanifest.xml')!.toString().includes('narration/appel.appel-marc/m1.m4a'));
  const course = files.get('elabora/course.js')!.toString();
  const data = JSON.parse(course.slice(course.indexOf('{'), course.lastIndexOf('}') + 1));
  const props = data.screens.find((screen: { id: string }) => screen.id === 'appel').blocks[0].props as DialogueData;
  const m1 = props.nodes[0]!.lines[0]!.voice!;
  assert.equal(m1.src, 'narration/appel.appel-marc/m1.m4a');
  assert.equal(m1.mouth, sidecar.mouth);
  assert.ok(Math.abs(m1.duration - sidecar.duration) < 0.05);
  assert.equal(props.nodes[1]!.options[0]!.voice!.src, 'narration/appel.appel-marc/premiere-question.a.m4a');
  assert.equal(props.nodes.find((node) => node.id === 'ticket')!.lines[0]!.voice!.src, null, 'a narration without voice has no audio');
  assert.ok(a.report.narration?.lines?.some((line) => line.line === 'm1' && line.block === 'appel-marc' && line.bytes > 0));
  assert.ok(a.report.generatedMedia.some((entry) => entry.block === 'appel-marc' && entry.type === 'voice'), 'a generated voice is disclosed (AI Act)');

  // A sidecar without its mouth: the build measures it, the same as the node did.
  delete sidecar.mouth;
  writeJSON(dir, 'assets/narration/fr/appel/m1.json', sidecar);
  const c = await build(dir, { out: tmp(t, 'elabora-dv-c-'), writeLock: false, mediaQuality: 'low' });
  assert.ok(c.ok && c.zipPath);
  const again = readZip(fs.readFileSync(c.zipPath)).files.get('elabora/course.js')!.toString();
  assert.ok(again.includes(`"mouth":"${readJSON(dir, 'assets/narration/fr/appel/l1.json').mouth}"`));
  assert.ok(again.includes(`"src":"narration/appel.appel-marc/m1.m4a"`), 'at a lower quality too, as the other media');
});

test('recordings of a dialogue\'s lines go to their lines by name, and a recording\'s text is written back into the block', { skip: NO_FFMPEG }, async (t) => {
  const dialogue = structuredClone(MARC_DIALOGUE);
  (dialogue.props as Record<string, unknown>).learnerVoice = true;
  const dir = courseWithDialogue(t, dialogue);
  const folder = tmp(t, 'elabora-dv-rec-');
  const files = ['m4.wav', 'premiere-question-a.wav'].map((name) => path.join(folder, name));
  for (const file of files) execFileSync(process.env.ELABORA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.2', '-ac', '1', file]);
  const imported = await importNarrationFiles(dir, { screen: 'appel', files });
  assert.deepEqual(imported.files.map((file) => [file.status, file.line, file.by]), [['imported', 'm4', 'name'], ['imported', 'premiere-question.a', 'name']]);
  const sidecar = readJSON(dir, 'assets/narration/fr/appel/m4.json');
  assert.deepEqual([sidecar.provider, sidecar.generated], ['recording', false]);
  assert.match(sidecar.mouth, /^[csow]+$/, 'a recording gets its mouth too');
  // « Texte d'après l'audio » (D46): the recording's words become the line's text, in the block.
  await setNarrationTextFromAudioChange(dir, { screen: 'appel', line: 'm4', text: "Je l'ai débranché, puis rebranché." });
  const screen = readJSON(dir, 'screens/appel.json');
  assert.equal(screen.blocks[0].props.nodes[2].lines[0].text, "Je l'ai débranché, puis rebranché.");
  assert.equal(narrationLines(loadProjectFromDir(dir), 'appel')!.find((line) => line.id === 'm4')!.status, 'ok', 'the audio says the new text');
  await setNarrationTextFromAudioChange(dir, { screen: 'appel', line: 'premiere-question.a', text: 'Depuis quand ça ne marche plus ?' });
  assert.equal(readJSON(dir, 'screens/appel.json').blocks[0].props.nodes[1].options[0].text, 'Depuis quand ça ne marche plus ?', 'the learner\'s answer');
});

test('review comments on a line find it in a layer or a dialogue, voiced or not', (t) => {
  const dir = courseWithDialogue(t);
  const thread = (n: number, anchor: Record<string, unknown>) => ({ id: `cm_${n}`, number: n, parent: null, version: '0123456789abcdef', versionNumber: 1, screen: 'appel', anchor: { version: '0123456789abcdef', language: 'fr', screen: 'appel', frame: { width: 1600, height: 900 }, ...anchor }, text: `t${n}`, by: { kind: 'reviewer', name: 'R' }, mine: false, state: 'open' as const, resolvedAt: null, createdAt: '2026-10-23T10:00:00Z', editedAt: null, deleted: false, rev: n });
  const review = { id: 'rv_00000000000000000000', space: 's', publication: 'p', title: 'T', state: 'open', languages: ['fr'], latest: 1, versions: [], comments: { open: 2, resolved: 0 }, reviewers: 1, rev: 2, createdAt: '', updatedAt: '' } as unknown as CloudReview;
  const answer = { review: review.id, rev: 2, comments: [thread(1, { line: 'm1', word: 'étage' }), thread(2, { line: 'n1' })] } as unknown as CommentsAnswer;
  const [voiced, silent] = resolveComments(answer, review, { courseDir: dir, api: 'http://127.0.0.1:1', space: 's' }).comments;
  assert.equal(voiced!.place!.line!.speaker, 'marc');
  assert.match(voiced!.place!.line!.text!, /deuxième étage/);
  assert.equal(voiced!.place!.line!.word!.text, 'étage');
  assert.equal(silent!.place!.line!.text, 'Leïla ouvre un ticket pendant que Marc patiente.');
});
