import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Browser, Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import type { EmulatorServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { capture, measureFit } from '@elabora/node/preview';
import { startLooker } from '@elabora/node/look';
import { testPackage } from '@elabora/node/emulator/run';
import { NO_MEDIA_CODECS, copyExample, isClosed, playsMedia, readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { narrate, hasFfmpeg, toneM4a } from '../narration.ts';

// Narrated screens in Chrome (docs/decisions.md D24): the track a build makes, the player's clock and
// bar, steps as segments, seeking, cues, layers, resume, the emulator. Voices are sine tones.

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const SPEAKERS = [{ id: 'narratrice', name: 'Narratrice' }, { id: 'marc', name: 'Marc' }];

// The example as slides: "accueil" narrated in three steps (learner), with a cue that counts, a cue
// that opens a dialog, and a sound block; "chemin" narrated in two steps that go on by themselves.
function course() {
  const dir = copyExample();
  const data = readJSON(dir, 'course.json');
  data.presentation = { mode: 'slides' };
  writeJSON(dir, 'course.json', data);
  const accueil = readJSON(dir, 'screens/accueil.json');
  accueil.blocks[1].step = 2;
  accueil.blocks[2].step = 3;
  accueil.blocks.push({ id: 'accueil-son', type: 'audio', step: 3, props: { asset: 'audio/son.m4a', title: 'Un son', transcript: 'Un son.' } });
  accueil.layers = [{ id: 'detail', title: 'Détail', blocks: [{ id: 'detail-texte', type: 'text', props: { markdown: 'Un détail.' } }] }];
  accueil.events = [
    { id: 'compte-l2', on: { type: 'timeline.reached', at: { line: 'l2' } }, do: [{ type: 'increment-variable', variable: 'bonsReflexes', by: 1 }] },
    { id: 'detail-l1', on: { type: 'timeline.reached', at: { line: 'l1', edge: 'end' } }, if: [{ variable: 'indiceVu', op: 'eq', value: false }], do: [{ type: 'set-variable', variable: 'indiceVu', value: true }, { type: 'show-layer', layer: 'detail' }] },
    { id: 'son-fini', on: { type: 'media.ended', target: 'accueil-son' }, do: [{ type: 'set-variable', variable: 'bonsReflexes', value: 9 }] }
  ];
  writeJSON(dir, 'screens/accueil.json', accueil);
  toneM4a(path.join(dir, 'assets/audio/son.m4a'), 0.5, 660);
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', seconds: 1.5 },
    { id: 'l2', text: "Il n'arrive plus à imprimer les bulletins de paie.", seconds: 2 },
    { id: 'l3', step: 2, speaker: 'marc', text: 'Ça bloque toute la comptabilité !', seconds: 1.2 },
    { id: 'l4', step: 3, text: 'Voyons comment l’aider.', seconds: 1 }
  ], { speakers: SPEAKERS, credit: 'Voix de synthèse : sinusoïdes de test (domaine public).' });
  narrate(dir, 'chemin', [
    { id: 'c1', text: 'Une impression suit un chemin.', seconds: 1 },
    { id: 'c2', step: 2, text: 'Elle passe par le réseau.', seconds: 1 }
  ], { advance: 'next-screen' });
  return dir;
}

interface Session { page: Page; browser: Browser; server: EmulatorServer; dir: string }

async function player(dir: string, run: (session: Session) => Promise<void>, { virtual = true, refuse = false }: { virtual?: boolean; refuse?: boolean } = {}) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-narration-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (virtual) await page.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    if (refuse) {
      // The browser refuses sound before a gesture: the first play() is refused.
      await page.addInitScript(() => {
        const play = HTMLMediaElement.prototype.play;
        let refused = false;
        HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
          if (!refused) { refused = true; return Promise.reject(new DOMException('play() needs a gesture', 'NotAllowedError')); }
          return play.call(this);
        };
      });
    }
    await page.goto(`${server.base}/pkg/p/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    await run({ page, browser, server, dir });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

const state = (page: Page) => page.evaluate(() => {
  const elabora = (window as PlayerWindow).__elabora;
  const next = document.querySelector('.t-nav-btn--next');
  const slot = document.querySelector('.t-continue--slot');
  return {
    timeline: elabora.timeline.state(), step: elabora.step.revealed, screen: elabora.screen,
    // The narrated slide's own Continue (its place kept): offered at the end of a step.
    cont: slot ? !slot.hasAttribute('data-t-waiting') : null,
    pending: [...document.querySelectorAll<HTMLElement>('#t-main [data-t-pending]')].map((node) => node.dataset.block),
    next: next?.querySelector('.t-nav-label:not([aria-hidden])')?.textContent, locked: next?.getAttribute('aria-disabled') === 'true',
    count: elabora.engine.getVar('bonsReflexes'), hint: elabora.engine.getVar('indiceVu'),
    complete: elabora.engine.screenComplete(elabora.engine.screens[elabora.engine.screens.findIndex((screen) => screen.id === elabora.screen)]),
    layer: document.querySelector('dialog.t-layer[open]')?.getAttribute('data-layer') ?? null
  };
});
const continueStep = (page: Page) => page.click('.t-continue--slot .t-continue-btn');
const advance = (page: Page, seconds: number) => page.evaluate((s) => (window as PlayerWindow).__elabora.timeline.advance(s), seconds);
// The dialog a cue opened, closed: its close event comes a moment later and lets the narration go on.
async function closeDialog(page: Page) {
  await page.click('dialog.t-layer .t-btn--primary');
  await page.waitForFunction(() => (window as PlayerWindow).__elabora.timeline.state()?.playing === true);
}

test('a narrated screen\'s track: lines and pauses laid end to end, captions with voices, sizes reported, deterministic', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  const dir = course();
  const out = tmp('elabora-narration-build-');
  const first = await build(dir, { out, writeLock: false });
  assert.ok(first.ok && first.zipPath, JSON.stringify(first.diagnostics.filter((d) => d.severity === 'error')));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(first.zipPath)).digest('hex');
  const again = await build(dir, { out: tmp('elabora-narration-build-'), writeLock: false });
  assert.ok(again.ok && again.zipPath);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(again.zipPath)).digest('hex'), hash, 'the same sources give the same bytes');
  const report = first.report;
  assert.deepEqual(report.narration?.tracks.map((track) => [track.screen, track.path, track.seconds]), [['accueil', 'narration/accueil.m4a', 6.9], ['chemin', 'narration/chemin.m4a', 2.4]]);
  assert.ok(report.narration!.bytes > 20000 && report.narration!.bytes < 120000, `${report.narration!.bytes} bytes`);
  assert.ok(report.generatedMedia.some((media) => media.screen === 'accueil' && media.type === 'voice'), 'AI Act: a generated voice is listed');
  // The track's length is the timeline's (the encoder pads a few milliseconds).
  const folder = await build(dir, { emit: 'dir', out: tmp('elabora-narration-dir-'), writeLock: false });
  assert.ok(folder.ok && folder.dirPath);
  const seconds = Number(execFileSync(process.env.ELABORA_FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(folder.dirPath, 'narration/accueil.m4a')], { encoding: 'utf8' }));
  assert.ok(Math.abs(seconds - 6.9) < 0.06, `${seconds} s`);
  const vtt = fs.readFileSync(path.join(folder.dirPath, 'narration/accueil.vtt'), 'utf8');
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:04\.300 --> 00:00:05\.500\n<v Marc>Ça bloque toute la comptabilité !/);
});

test('steps are segments: playback stops at the end of the step, Continue plays the next, cues fire when crossed', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  await player(course(), async ({ page }) => {
    let s = await state(page);
    assert.equal(s.timeline?.playing, true, 'the narration starts with the screen');
    assert.deepEqual(s.pending, ['accueil-illustration', 'accueil-objectifs', 'accueil-son']);
    assert.equal(s.cont, false, 'Continue keeps its place, hidden while the step plays');
    assert.equal(s.next, 'Suivant', 'Next goes to the next screen');
    assert.ok(s.locked, 'navigation.lockUntilComplete: Next waits for the screen to be heard');
    // l1 ends at 1.5 s: its cue opens a dialog, which holds the narration; closing it resumes.
    await advance(page, 1.6);
    s = await state(page);
    assert.equal(s.layer, 'detail');
    assert.equal(s.timeline?.playing, false);
    await closeDialog(page);
    await advance(page, 10);
    s = await state(page);
    assert.equal(s.count, 1, 'l2 crossed once');
    assert.equal(s.timeline?.time, 3.9, 'stopped at the end of step 1');
    assert.equal(s.timeline?.playing, false);
    assert.equal(s.cont, true, 'Continue shows at its kept place');
    assert.ok(s.locked, 'Next still waits for the end of the screen');
    await continueStep(page);
    s = await state(page);
    assert.equal(s.step, 2);
    assert.equal(s.timeline?.playing, true, 'Continue plays the next step');
    assert.deepEqual(s.pending, ['accueil-objectifs', 'accueil-son']);
    // Seeking back shows step 1 again and fires nothing; the step reached stays.
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.seek(0.2));
    s = await state(page);
    assert.equal(s.timeline?.step, 1);
    assert.equal(s.step, 2);
    assert.deepEqual(s.pending, ['accueil-illustration', 'accueil-objectifs', 'accueil-son']);
    assert.equal(s.count, 1);
    // Playing again crosses l2 again (a replay counts: W_TIMED_INCREMENT), then step 2, then stops.
    await advance(page, 20);
    s = await state(page);
    assert.equal(s.count, 2);
    assert.equal(s.timeline?.time, 5.5);
    // Forward seeking stops at the furthest point reached (seek "seen").
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.seek(100));
    assert.equal((await state(page)).timeline?.time, 5.5);
    // At the end of a step, Play does what Continue does.
    await page.click('.t-timeline-play');
    s = await state(page);
    assert.equal(s.step, 3);
    assert.equal(s.timeline?.playing, true);
    await advance(page, 20);
    s = await state(page);
    assert.equal(s.timeline?.time, 6.9);
    assert.ok(s.complete, 'viewed: the end of the timeline reached by playback');
    assert.equal(s.next, 'Suivant');
    assert.ok(!s.locked);
    assert.equal(s.cont, false, 'no step left: Continue hides again, its place kept');
    // A sound block that plays to its end fires media.ended.
    await page.evaluate(() => document.querySelector('[data-block="accueil-son"] audio')?.dispatchEvent(new Event('ended')));
    assert.equal((await state(page)).count, 9);
  });
});

test('the bar: an APG seek slider at the keyboard, shortcuts with modifiers, captions, speed, transcript', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  await player(course(), async ({ page }) => {
    await advance(page, 1.6);
    await closeDialog(page);
    await advance(page, 10);
    const slider = page.locator('.t-timeline-seek');
    assert.equal(await slider.getAttribute('role'), 'slider');
    await slider.focus();
    await page.keyboard.press('Home');
    assert.equal((await state(page)).timeline?.time, 0);
    assert.equal(await slider.getAttribute('aria-valuetext'), '0 seconde sur 7 secondes, étape 1 sur 3');
    await page.keyboard.press('ArrowRight');
    assert.equal((await state(page)).timeline?.time, 3.9, '+5 s, no further than what was heard');
    await page.keyboard.press('ArrowLeft');
    assert.equal((await state(page)).timeline?.time, 0);
    await page.keyboard.press('End');
    assert.equal((await state(page)).timeline?.time, 3.9);
    // Captions: Ctrl+Alt+C; the band shows the line said, with its speaker when there are several.
    await page.keyboard.press('Home');
    await page.keyboard.press('Control+Alt+KeyC');
    assert.equal(await page.locator('.t-timeline-captions').getAttribute('aria-pressed'), 'true');
    assert.equal((await state(page)).timeline?.caption, 'Narratrice : Bonjour, voici le ticket de Marc.');
    assert.ok(await page.locator('.t-timeline-band').isVisible());
    // Play, then Ctrl+Alt+P pauses anywhere.
    await page.click('.t-timeline-play');
    assert.equal((await state(page)).timeline?.playing, true);
    await page.locator('.t-screen-title').focus();
    await page.keyboard.press('Control+Alt+KeyP');
    assert.equal((await state(page)).timeline?.playing, false);
    // Speed, in the playback settings (the gear, which shows a speed other than 1×): the clock follows it.
    await page.click('.t-timeline-settings-btn');
    await page.click('.t-timeline-settings label:has(input[value="2"])');
    assert.equal(await page.locator('.t-timeline-rate-badge').textContent(), '2×');
    await page.keyboard.press('Escape');
    assert.ok(await isClosed(page.locator('.t-timeline-settings')));
    await page.keyboard.press('Control+Alt+KeyP');
    const before = (await state(page)).timeline!.time;
    await advance(page, 0.5);
    assert.equal(Math.round(((await state(page)).timeline!.time - before) * 10) / 10, 1);
    // The transcript: the script with its speakers.
    await page.click('.t-timeline-transcript-btn');
    const lines = await page.locator('.t-timeline-transcript .t-timeline-line').allTextContents();
    assert.deepEqual(lines, ['Narratrice : Bonjour, voici le ticket de Marc.', "Narratrice : Il n'arrive plus à imprimer les bulletins de paie.", 'Marc : Ça bloque toute la comptabilité !', 'Narratrice : Voyons comment l’aider.']);
    assert.deepEqual(await page.locator('.t-timeline-transcript-step h3').allTextContents(), ['Étape 1', 'Étape 2', 'Étape 3']);
    // The voice's AI mention and the credits of the screen's voices stay with the transcript; the
    // module's are in « IA et crédits » (D58).
    assert.equal(await page.locator('.t-timeline-transcript .t-timeline-generated').textContent(), 'Voix générée par IA');
    assert.deepEqual(await page.locator('.t-timeline-credits p').allTextContents(), ['Voix de synthèse : sinusoïdes de test (domaine public).']);
    await page.click('.t-about-btn');
    assert.deepEqual(await page.locator('[data-sheet="about"] .t-about-credits p').allTextContents(), ['Voix de synthèse : sinusoïdes de test (domaine public).']);
    assert.match(await page.locator('[data-sheet="about"] [data-about="ai"]').innerText(), /Voix générée par IA/);
    // One side panel at a time: « IA et crédits » took the transcript's place.
    assert.ok(await isClosed(page.locator('.t-timeline-transcript')));
    await page.keyboard.press('Escape');
    await page.click('.t-timeline-transcript-btn');
    // A line already heard takes the playhead there; one not heard yet cannot be reached.
    assert.ok(await page.locator('.t-timeline-line[data-line="l3"]').isDisabled());
    await page.click('.t-timeline-line[data-line="l2"]');
    assert.equal((await state(page)).timeline?.line, 'l2');
    // Single keys do nothing outside the bar (WCAG 2.1.4).
    await page.locator('.t-screen-title').focus();
    const playing = (await state(page)).timeline?.playing;
    await page.keyboard.press('p');
    assert.equal((await state(page)).timeline?.playing, playing);
  });
});

test('resume: a narrated screen left part-way reopens at the start of the step reached; one seen to its end waits at its end', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  await player(course(), async ({ page }) => {
    await advance(page, 1.6);
    await closeDialog(page);
    await advance(page, 10);
    await continueStep(page);
    await advance(page, 0.5);
    await page.reload();
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    let s = await state(page);
    assert.equal(s.step, 2);
    assert.equal(s.timeline?.time, 3.9, 'the start of step 2');
    assert.equal(s.timeline?.reached, 3.9);
    assert.deepEqual(s.pending, ['accueil-objectifs', 'accueil-son']);
    await advance(page, 10);
    await continueStep(page);
    await advance(page, 10);
    assert.ok((await state(page)).complete);
    await page.reload();
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    s = await state(page);
    assert.equal(s.timeline?.time, 6.9);
    assert.equal(s.timeline?.playing, false, 'a screen seen to its end does not play again by itself');
    assert.deepEqual(s.pending, []);
  });
});

test('next-screen: the steps follow each other and the course goes on; « M\'arrêter à chaque étape », in the playback settings, stops at each step', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  await player(course(), async ({ page }) => {
    await page.evaluate(() => { const elabora = (window as PlayerWindow).__elabora; for (const screen of elabora.engine.screens) elabora.engine.st.completed.add(screen.key); elabora.go('chemin'); });
    await advance(page, 1.2);
    let s = await state(page);
    assert.equal(s.step, 2, 'step 2 opened by itself');
    assert.equal(s.timeline?.playing, true);
    await advance(page, 5);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.screen === 'premier-reflexe');
    // The learner's preference: stop at each step.
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('chemin'));
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.seek(0));
    await page.click('.t-timeline-settings-btn');
    await page.check('.t-timeline-stop input');
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    await advance(page, 5);
    s = await state(page);
    assert.equal(s.screen, 'chemin');
    assert.equal(s.timeline?.playing, false);
    assert.equal(s.timeline?.time, 2.4, 'steps already reached play on; at the end, no screen change');
  });
});

test('the real clock: the timeline follows the audio and stops at the end of the step; a refused sound waits for a large Play button', { skip: NO_FFMPEG, timeout: 120000 }, async (t) => {
  await player(course(), async ({ page }) => {
    // The audio's own clock: the narration's AAC must play.
    if (!(await playsMedia(page, 'audio/mp4; codecs="mp4a.40.2"'))) return t.skip(NO_MEDIA_CODECS);
    const start = page.locator('.t-timeline-start');
    await start.waitFor({ timeout: 5000 });
    assert.equal((await state(page)).timeline?.refused, true);
    await start.click();
    await page.waitForFunction(() => ((window as PlayerWindow).__elabora.timeline.state()?.time ?? 0) > 0.3, null, { timeout: 5000 });
    assert.equal(await start.count(), 0);
    const drift = await page.evaluate(() => Math.abs(document.querySelector<HTMLAudioElement>('audio.t-timeline-audio')!.currentTime - ((window as PlayerWindow).__elabora.timeline.state()?.time ?? 0)));
    assert.ok(drift < 0.2, `the timeline reads the audio's clock (${drift} s apart)`);
    // l1 ends at 1.5 s: its dialog opens and holds the audio too.
    await page.waitForSelector('dialog.t-layer[open]', { timeout: 5000 });
    assert.ok(await page.evaluate(() => document.querySelector<HTMLAudioElement>('audio.t-timeline-audio')!.paused));
    await closeDialog(page);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.timeline.state()?.playing === false, null, { timeout: 8000 });
    const end = await page.evaluate(() => ({ time: (window as PlayerWindow).__elabora.timeline.state()?.time, audio: document.querySelector<HTMLAudioElement>('audio.t-timeline-audio')!.currentTime }));
    assert.equal(end.time, 3.9);
    assert.ok(Math.abs(end.audio - 3.9) < 0.05, `the audio stops at the step's end (${end.audio} s)`);
  }, { virtual: false, refuse: true });
});

test('the real clock: a track that runs out a little before the timeline\'s end ends the screen there', { skip: NO_FFMPEG, timeout: 120000 }, async (t) => {
  // Free navigation: straight to the screen.
  const dir = course();
  const data = readJSON(dir, 'course.json');
  data.navigation = { mode: 'free', lockUntilComplete: false };
  writeJSON(dir, 'course.json', data);
  await player(dir, async ({ page }) => {
    if (!(await playsMedia(page, 'audio/mp4; codecs="mp4a.40.2"'))) return t.skip(NO_MEDIA_CODECS);
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('chemin'));
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.screen === 'chemin');
    const start = page.locator('.t-timeline-start');
    if (await start.count()) await start.click();
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    // In the last step, the audio stops 0.3 s short of the timeline's end and says it has ended, as some
    // browsers decode an AAC track: the screen still ends, and moves on (advance next-screen).
    await page.waitForFunction(() => { const s = (window as PlayerWindow).__elabora.timeline.state(); return !!s && s.step === 2 && s.time > s.duration - 0.8; }, null, { timeout: 8000 });
    await page.evaluate(() => {
      const audio = document.querySelector<HTMLAudioElement>('audio.t-timeline-audio')!;
      audio.pause();
      audio.currentTime = ((window as PlayerWindow).__elabora.timeline.state()?.duration ?? 0) - 0.3;
      audio.dispatchEvent(new Event('ended'));
    });
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.screen === 'premier-reflexe', null, { timeout: 5000 });
  }, { virtual: false });
});

test('the seek bar keeps play or pause: a click towards the end reaches it, and let go there the screen rests instead of starting over', { skip: NO_FFMPEG, timeout: 120000 }, async () => {
  const dir = course();
  const data = readJSON(dir, 'course.json');
  data.navigation = { mode: 'free', lockUntilComplete: false };
  writeJSON(dir, 'course.json', data);
  narrate(dir, 'chemin', [
    { id: 'c1', text: 'Une impression suit un chemin.', seconds: 1 },
    { id: 'c2', text: 'Elle passe par le réseau.', seconds: 1 }
  ], { seek: 'free' });
  await player(dir, async ({ page }) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('chemin'));
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.screen === 'chemin');
    const box = (await page.locator('.t-timeline-seek').boundingBox())!;
    const clickAt = (x: number) => page.mouse.click(x, box.y + box.height / 2);
    const now = async () => (await state(page)).timeline!;
    // Paused: a click moves the playhead, nothing plays.
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.pause());
    await clickAt(box.x + box.width / 2);
    let s = await now();
    assert.equal(s.playing, false, 'still paused');
    assert.ok(s.time > 0.3 && s.time < s.duration - 0.3, String(s.time));
    // A click a few pixels short of the end is the end, still paused.
    await clickAt(box.x + box.width - 4);
    s = await now();
    assert.deepEqual([s.time, s.playing], [s.duration, false]);
    // Playing: a click plays on from there…
    await clickAt(box.x + box.width * 0.2);
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    await advance(page, 0.1);
    assert.equal((await now()).playing, true);
    await clickAt(box.x + box.width * 0.5);
    assert.equal((await now()).playing, true, 'plays on from the click');
    // …and let go at the end, it rests there: no start over.
    await clickAt(box.x + box.width - 2);
    await advance(page, 0.5);
    s = await now();
    assert.deepEqual([s.time, s.playing], [s.duration, false]);
    assert.equal(await page.evaluate(() => (window as PlayerWindow).__elabora.screen), 'chemin');
  });
});

test('captures and fit see narrated screens still: a line\'s moment on a contact sheet, slides measured with the bar', { skip: NO_FFMPEG, timeout: 240000 }, async () => {
  const dir = course();
  const shots = await capture(dir, [{ screen: 'accueil', at: ['l1', 'l3:end'] }]);
  assert.ok(shots.ok, JSON.stringify(shots));
  const shot = shots.shots![0];
  assert.ok(shot.ok && shot.frames?.map((frame) => frame.label).join() === 'l1,l3:end');
  const missing = await capture(dir, [{ screen: 'accueil', at: ['l9'] }]);
  assert.match(missing.shots?.[0].ok === false ? missing.shots[0].error : '', /No line "l9" in the narration of "accueil". Lines: l1, l2, l3, l4/);
  const fit = await measureFit(dir, { sizes: [{ role: 'reference', size: '1600x900' }] });
  assert.ok(fit.ok);
  // The look server shows a line's moment in the canvas: its step, its caption and the bar.
  const looker = await startLooker(dir, { live: false });
  try {
    const look = await looker.look({ screen: 'accueil', at: 'l3' });
    assert.ok(look.ok, look.ok ? '' : look.error);
    const shown = look.ok ? look.blocks.filter((block) => !block.hidden).map((block) => block.id) : [];
    assert.ok(shown.includes('accueil-illustration') && !shown.includes('accueil-objectifs'), JSON.stringify(shown));
    const wrong = await looker.look({ screen: 'accueil', at: 'l9' });
    assert.ok(!wrong.ok && /Lines: l1, l2, l3, l4/.test(wrong.error));
  } finally {
    await looker.close();
  }
});

test('the LMS emulator plays narrated screens to their end and completes the course', { skip: NO_FFMPEG, timeout: 240000 }, async () => {
  const dir = course();
  const b = await build(dir, { profiles: ['moodle'], emit: 'dir', out: tmp('elabora-narration-lms-'), writeLock: false });
  assert.ok(b.ok && b.dirPath);
  const r = await testPackage({ dir: b.dirPath, profiles: ['moodle'], accessibility: true, unloadVariants: false });
  assert.deepEqual(r.runs.filter((x) => !x.ok).map((x) => `${x.profile}/${x.launch}/${x.browser}: ${x.failures.map((f) => `${f.code} ${f.message}`).join(',')}`), []);
  assert.equal(r.accessibility?.violations, 0, JSON.stringify(r.accessibility?.details));
});
