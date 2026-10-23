import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { capture } from '@elabora/node/preview';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { narrate, voice, hasFfmpeg } from '../narration.ts';

// Layers that speak, in Chrome (docs/decisions.md D62): a layer's own timeline and its compact bar in
// the layer, the screen's timeline held while it speaks (a dialog until it closes, a panel until it has
// spoken), its blocks at its words, its seek, the learner's Pause, its shortcuts, timeline.ended with
// layer closing it, a reopened layer starting at 0, captures at a moment of its timeline. Voices are
// sine tones; the clock is virtual.

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const SPEAKERS = [{ id: 'narratrice', name: 'Narratrice' }, { id: 'guide', name: 'La guide' }];
const REGLE = [
  { id: 'r1', speaker: 'guide', text: 'Un rappel de la règle.', seconds: 1 },
  { id: 'r2', speaker: 'guide', text: 'On vérifie toujours le poste avant le réseau.', seconds: 1.5 }
];

// Slides; accueil narrated (l1, l2); at the end of l1 the dialog « Rappel de la règle » opens and
// speaks, its schema coming at « poste », a cue at « réseau », and it closes itself once it has spoken;
// at l2 the panel « Aide » speaks over the screen, which waits for it.
function course({ seek = 'free' }: { seek?: 'seen' | 'free' } = {}) {
  const dir = copyExample();
  const data = readJSON(dir, 'course.json');
  data.presentation = { mode: 'slides' };
  writeJSON(dir, 'course.json', data);
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', seconds: 1.5 },
    { id: 'l2', text: "Il n'arrive plus à imprimer les bulletins de paie.", seconds: 2 }
  ], { speakers: SPEAKERS });
  const accueil = readJSON(dir, 'screens/accueil.json');
  accueil.layers = [
    {
      id: 'regle', title: 'Rappel de la règle', narration: { seek, lines: REGLE.map(({ seconds: _seconds, ...line }) => line) },
      blocks: [
        { id: 'consigne-texte', type: 'text', props: { markdown: 'Le poste, puis le réseau.' } },
        { id: 'consigne-schema', type: 'text', props: { markdown: 'Schéma du poste' }, timing: { in: { at: { line: 'r2', word: 'poste' } } } }
      ]
    },
    { id: 'aide', title: 'Aide', presentation: 'panel', narration: { lines: [{ id: 'a1', speaker: 'guide', text: 'Prenez votre temps.' }] }, blocks: [{ id: 'aide-texte', type: 'text', props: { markdown: 'Un indice.' } }] }
  ];
  accueil.events = [
    { id: 'ouvre-regle', on: { type: 'timeline.reached', at: { line: 'l1', edge: 'end' } }, if: [{ variable: 'indiceVu', op: 'eq', value: false }], do: [{ type: 'set-variable', variable: 'indiceVu', value: true }, { type: 'show-layer', layer: 'regle' }] },
    { id: 'ferme-regle', on: { type: 'timeline.ended', layer: 'regle' }, do: [{ type: 'hide-layer', layer: 'regle' }] },
    { id: 'repere', on: { type: 'timeline.reached', at: { line: 'r2', word: 'réseau' } }, do: [{ type: 'increment-variable', variable: 'bonsReflexes', by: 1 }] },
    { id: 'ouvre-aide', on: { type: 'timeline.reached', at: { line: 'l2' } }, do: [{ type: 'show-layer', layer: 'aide' }] }
  ];
  writeJSON(dir, 'screens/accueil.json', accueil);
  REGLE.forEach((line, index) => voice(dir, 'accueil', line, { language: 'fr', frequency: 660 + 110 * index }));
  voice(dir, 'accueil', { id: 'a1', text: 'Prenez votre temps.', seconds: 1 }, { language: 'fr', frequency: 990 });
  return dir;
}

async function player(dir: string, run: (page: Page) => Promise<void>) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-layer-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  assert.ok(fs.existsSync(path.join(b.dirPath, 'narration/accueil.regle.m4a')), 'the layer\'s track');
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    await page.goto(`${server.base}/pkg/p/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

const state = (page: Page) => page.evaluate(() => {
  const elabora = (window as PlayerWindow).__elabora;
  const regle = elabora.timeline.layer('regle');
  const aide = elabora.timeline.layer('aide');
  return {
    screen: elabora.timeline.state(), regle: regle?.state() ?? null, aide: aide?.state() ?? null, hidden: regle?.hiddenByTiming() ?? null,
    open: [...document.querySelectorAll('dialog.t-layer[open]')].map((dialog) => dialog.getAttribute('data-layer')),
    count: elabora.engine.getVar('bonsReflexes'),
    // The layer's compact bar and its captions are in the layer.
    bar: !!document.querySelector('dialog.t-layer[data-layer="regle"] .t-layer-timeline .t-timeline--compact .t-timeline-play'),
    tools: [...document.querySelectorAll('dialog.t-layer[data-layer="regle"] .t-timeline-tools > *')].map((node) => node.className),
    caption: document.querySelector('dialog.t-layer[data-layer="regle"] .t-timeline-band:not([hidden]) .t-timeline-caption')?.textContent ?? null
  };
});
const advanceScreen = (page: Page, seconds: number) => page.evaluate((s) => (window as PlayerWindow).__elabora.timeline.advance(s), seconds);
const advanceLayer = (page: Page, layer: string, seconds: number) => page.evaluate(([id, s]) => (window as PlayerWindow).__elabora.timeline.layer(id)?.advance(s), [layer, seconds] as const);
// The time a word of a layer's line is said, from the course data.
const wordTime = (page: Page, layer: string, line: string, word: string) => page.evaluate(([layerId, lineId, text]) => {
  const elabora = (window as PlayerWindow).__elabora;
  const screen = elabora.engine.screens.find((candidate) => candidate.id === elabora.screen) as unknown as { layers: { id: string; narration: { lines: { id: string; words: [string, number, number][] }[] } }[] };
  return screen.layers.find((candidate) => candidate.id === layerId)!.narration.lines.find((candidate) => candidate.id === lineId)!.words.find((entry) => entry[0] === text)![1];
}, [layer, line, word] as const);

test('a dialog that speaks holds the screen, brings its blocks at its words, fires its cues and closes itself at its end', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  await player(course(), async (page) => {
    let s = await state(page);
    assert.equal(s.screen?.playing, true, 'the screen\'s narration starts');
    assert.equal(s.regle, null, 'no layer timeline before the layer opens');
    await advanceScreen(page, 1.6);
    s = await state(page);
    assert.deepEqual(s.open, ['regle']);
    assert.equal(s.screen?.playing, false, 'the screen waits while the layer speaks');
    assert.equal(s.regle?.playing, true, 'the layer speaks from its opening');
    assert.equal(s.regle?.time, 0);
    assert.ok(s.bar, 'its compact bar is in the layer');
    assert.deepEqual(s.tools, ['t-timeline-btn t-timeline-captions'], 'compact: captions only, no settings, volume or transcript');
    assert.deepEqual(s.hidden, ['consigne-schema'], 'the schema waits for its word');
    // Its blocks come at its words; its cues fire when playback crosses them.
    const poste = await wordTime(page, 'regle', 'r2', 'poste');
    await advanceLayer(page, 'regle', poste - 0.05);
    assert.deepEqual((await state(page)).hidden, ['consigne-schema']);
    await advanceLayer(page, 'regle', 0.1);
    s = await state(page);
    assert.deepEqual(s.hidden, [], 'at « poste »');
    assert.equal(s.count, 0);
    // To its end: « réseau » crossed, timeline.ended with layer closes it, the screen goes on.
    await advanceLayer(page, 'regle', 5);
    await page.waitForFunction(() => !document.querySelector('dialog.t-layer[open]'));
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.timeline.state()?.playing === true);
    s = await state(page);
    assert.equal(s.count, 1, '« réseau » crossed once');
    assert.equal(s.regle, null, 'closed: its timeline stops');
    assert.equal(Math.round((s.screen?.time ?? 0) * 1000) / 1000, 1.5, 'the screen resumes where it waited');
    // A panel that speaks: the screen waits until it has spoken, then goes on (the panel stays open).
    await advanceScreen(page, 0.5);
    s = await state(page);
    assert.deepEqual(s.open, ['aide']);
    assert.equal(s.screen?.playing, false);
    assert.equal(s.aide?.playing, true);
    await advanceLayer(page, 'aide', 2);
    s = await state(page);
    assert.equal(s.aide?.playing, false);
    assert.equal(s.screen?.playing, true, 'the panel has spoken: the screen\'s voice comes back');
    assert.deepEqual(s.open, ['aide']);
  });
});

test('a layer\'s bar: seek (free) recomputes what is seen and fires nothing, the learner\'s Pause stops it, its shortcuts, reopened at 0', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  await player(course(), async (page) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.pause());
    // The screen's transcript holds each layer's lines under its title.
    await page.click('.t-timeline-transcript-btn');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.t-timeline-transcript-layer')].map((section) => [section.querySelector('h3')?.textContent, section.querySelectorAll('.t-timeline-line').length])), [['Rappel de la règle', 2], ['Aide', 1]]);
    await page.click('.t-timeline-transcript-btn');
    await page.evaluate(() => (window as PlayerWindow).__elabora.openLayer('regle'));
    let s = await state(page);
    assert.equal(s.regle?.playing, true);
    // Seeking past « poste » and « réseau »: the schema shows, no cue fires; back before it, it hides.
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.layer('regle')?.seek(2.85));
    s = await state(page);
    assert.deepEqual(s.hidden, []);
    assert.equal(s.count, 0, 'a seek crosses nothing');
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.layer('regle')?.seek(0.3));
    s = await state(page);
    assert.deepEqual(s.hidden, ['consigne-schema']);
    // Captions in the layer.
    await page.click('dialog.t-layer[data-layer="regle"] .t-timeline-captions');
    assert.equal((await state(page)).caption, 'Un rappel de la règle.');
    // The learner's Pause (the layer's own Play button), then its shortcut: the layer's, not the screen's.
    await page.click('dialog.t-layer[data-layer="regle"] .t-timeline-play');
    s = await state(page);
    assert.equal(s.regle?.playing, false);
    assert.equal(s.screen?.playing, false);
    await page.keyboard.press('Control+Alt+KeyP');
    s = await state(page);
    assert.equal(s.regle?.playing, true, 'Ctrl+Alt+P plays the layer');
    assert.equal(s.screen?.playing, false, 'the screen stays held');
    // Closed part-way, opened again: from 0.
    await advanceLayer(page, 'regle', 0.5);
    await page.click('dialog.t-layer[data-layer="regle"] .t-dialog-actions > .t-btn--primary');
    // Its close event comes with the next frame: then it is gone.
    await page.waitForFunction(() => !document.querySelector('dialog.t-layer[data-layer="regle"]'));
    assert.deepEqual(await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.layers()), [], 'closed: its timeline is gone');
    await page.evaluate(() => (window as PlayerWindow).__elabora.openLayer('regle'));
    s = await state(page);
    assert.equal(s.regle?.time, 0, 'a reopened layer starts again at 0');
    assert.deepEqual(s.hidden, ['consigne-schema']);
  });
});

test('a chart whose items come with the voice follows its layer\'s timeline, not the screen\'s (D60, D62)', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  const dir = course();
  const accueil = readJSON(dir, 'screens/accueil.json');
  accueil.layers[0].blocks.push({ id: 'ordre', type: 'bars', props: { takeaway: 'Le poste d\'abord', rows: [
    { id: 'poste', label: 'Poste', value: 70, at: { line: 'r2', word: 'poste' } },
    { id: 'reseau', label: 'Réseau', value: 30, at: { line: 'r2', word: 'réseau' } }
  ] } });
  accueil.events = accueil.events.filter((event: { id: string }) => event.id !== 'ferme-regle');
  writeJSON(dir, 'screens/accueil.json', accueil);
  await player(dir, async (page) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.pause());
    await page.evaluate(() => (window as PlayerWindow).__elabora.openLayer('regle'));
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.layer('regle')?.pause());
    const spoken = () => page.$$eval('dialog.t-layer[data-layer="regle"] .t-block[data-block="ordre"] .is-spoken[data-t-item]', (elements) => [...new Set(elements.map((element) => element.getAttribute('data-t-item')))]);
    const label = (id: string) => page.$eval(`dialog.t-layer[data-layer="regle"] .t-block[data-block="ordre"] .t-bars-label[data-t-item="${id}"]`, (element) => Number(getComputedStyle(element).opacity));
    assert.deepEqual(await spoken(), []);
    assert.equal(await label('poste'), 0, 'not said yet at the layer\'s 0');
    // The screen's playhead moves: the layer's chart stays where its own voice is.
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.seek(3));
    assert.equal(await label('poste'), 0);
    const poste = await wordTime(page, 'regle', 'r2', 'poste');
    await page.evaluate((t) => (window as PlayerWindow).__elabora.timeline.layer('regle')?.seek(t), poste + 0.05);
    await page.waitForTimeout(300);
    assert.deepEqual(await spoken(), ['poste'], 'at « poste » in the layer');
    assert.equal(await label('poste'), 1);
    assert.equal(await label('reseau'), 0);
    const reseau = await wordTime(page, 'regle', 'r2', 'réseau');
    await page.evaluate((t) => (window as PlayerWindow).__elabora.timeline.layer('regle')?.seek(t), reseau + 0.05);
    await page.waitForTimeout(300);
    assert.deepEqual(await spoken(), ['reseau']);
  });
});

test('captures of a layer at a moment of its own timeline', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  const dir = course();
  const result = await capture(dir, [{ screen: 'accueil', layer: 'regle', at: ['r2', 'r2:poste', 'r1:end'], width: 1280, height: 720 }]);
  assert.ok(result.ok, JSON.stringify(result));
  const shot = result.shots![0];
  assert.ok(shot.ok && shot.frames?.map((frame) => frame.label).join(' | ') === 'r2 | r2:poste | r1:end', JSON.stringify(shot.ok ? shot.frames?.map((frame) => frame.label) : shot));
  const wrong = await capture(dir, [{ screen: 'accueil', layer: 'regle', at: ['l2'] }]);
  const failed = wrong.ok ? null : wrong.shots?.[0];
  assert.match(failed && !failed.ok ? failed.error : '', /No line "l2" in the narration of layer "regle"/);
});

test('the editor\'s canvas: the layer shown at a moment of its timeline, its timed blocks in the layout; a look and its sheet of the layer', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  const { startCanvasHost } = await import('@elabora/node/canvas/host');
  const { loadProjectFromDir } = await import('@elabora/node/project-reader');
  const { renderScreen } = await import('@elabora/core/render/screen');
  const { screenTimeline, blockTimings } = await import('@elabora/core/narration/timeline');
  const { startLooker } = await import('@elabora/node/look');
  type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: import('@elabora/player/canvas').CanvasApi };
  const dir = course();
  const project = loadProjectFromDir(dir);
  const coming = blockTimings(screenTimeline(project, 'accueil', { layer: 'regle' })!).get('consigne-schema')!.in!;
  const host = await startCanvasHost({ root: dir });
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.setContent(`<iframe src="${host.url}" style="width: 1280px; height: 720px; border: 0"></iframe>`);
    const frame = await (await page.waitForSelector('iframe')).contentFrame();
    await frame!.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
    host.push(renderScreen(project, 'accueil', { layer: 'regle', at: { time: 0.5 } }), { id: 1 });
    const blockAt = async (id: number) => {
      await frame!.waitForFunction((wanted) => (window as CanvasWindow).__elaboraCanvas.layout().id === wanted, id);
      return frame!.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout().blocks.find((block) => block.id === 'consigne-schema')!);
    };
    let block = await blockAt(1);
    assert.deepEqual([block.timed?.state, block.hidden], ['before', true], 'at 0.5 s of the layer\'s timeline, before « poste »');
    const post = (view: Record<string, unknown>, id: number) => page.evaluate(({ view: sent, id: sentId, token }) => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'elabora/view', id: sentId, token, view: sent }, '*'), { view, id, token: host.token });
    await post({ at: { time: coming.at + 1 } }, 2);
    block = await blockAt(2);
    assert.deepEqual([block.timed?.state, block.hidden], ['shown', false]);
    assert.equal(await frame!.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout().blocks.some((entry) => entry.id === 'accueil-illustration' && entry.hidden)), false, 'the screen under it shows its end');
  } finally {
    await browser.close();
    await host.close();
  }
  const looker = await startLooker(dir, { live: false });
  try {
    const at = await looker.look({ screen: 'accueil', layer: 'regle', at: 'r2:poste', width: 1280, height: 720 });
    assert.ok(at.ok, JSON.stringify(at));
    const sheet = await looker.look({ screen: 'accueil', layer: 'regle', sheet: true, width: 1280, height: 720 });
    assert.ok(sheet.ok, JSON.stringify(sheet));
    const labels = sheet.marks!.map((mark) => mark.label);
    assert.ok(labels.some((label) => /r2 « poste » · consigne-schema comes/.test(label)), labels.join('\n'));
    assert.ok(labels.some((label) => /r2 « réseau » · repere fires/.test(label)), labels.join('\n'));
  } finally {
    await looker.close();
  }
});
