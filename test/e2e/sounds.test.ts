import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import type { BuildOptions } from '@elabora/node/build';
import * as edit from '@elabora/node/edit';
import { ROOT, copyExample as copyCourse } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { execFileSync } from 'node:child_process';
import { FFMPEG, hasFfmpeg } from '../narration.ts';

// The player's sounds (D67) in Chrome: one context made at the learner's first gesture, the interface
// sounds of a question's feedback, « Sons de l'interface » in « Affichage ».

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const copyExample = (name: string) => copyCourse(path.join(ROOT, 'examples', name));
type Played = { kind: string; role?: string; sound?: string; src: string; heard: boolean };
const soundsState = (page: Page) => page.evaluate(() => (window as PlayerWindow & { __elabora: { sounds: { state(): { context: string; interface: boolean; played: Played[] } } } }).__elabora.sounds.state());

async function player(dir: string, run: (page: Page, reload: () => Promise<void>) => Promise<void>, options: BuildOptions = {}) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-sounds-'), writeLock: false, debug: true, ...options });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    const open = async () => {
      await page.goto(`${server.base}/pkg/p/index.html`);
      await page.waitForFunction(() => (window as PlayerWindow).__elabora);
      await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    };
    await open();
    await run(page, open);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

test('interface sounds: no context before a gesture; a question answered sounds good or bad; « Sons de l\'interface » switches them off, kept for the course', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  const dir = copyExample('diagnostic-reseau');
  edit.updatePlayer(dir, { enable: ['display'] });
  await player(dir, async (page, reload) => {
    let state = await soundsState(page);
    assert.equal(state.context, 'none', 'nothing sounds, nothing is made, before the learner does something');
    assert.equal(state.interface, true, 'the module has voices: its interface sounds are on');
    const goToQuiz = () => page.evaluate(async () => { const t = (window as PlayerWindow).__elabora; for (const s of t.engine.screens) { t.engine.st.visited.add(s.key); t.engine.st.completed.add(s.key); } t.go('evaluation'); await t.ready(); });
    await goToQuiz();
    const quizzes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.t-block[data-type="quiz"]')].map((node) => node.dataset.block!));
    assert.ok(quizzes.length >= 2, 'the evaluation has questions');
    const answer = async (quiz: string) => {
      await page.click(`[data-block="${quiz}"] .t-option >> nth=1`);
      await page.click(`[data-block="${quiz}"] .t-quiz-submit`);
      return page.evaluate((id) => document.querySelector(`[data-block="${id}"] [data-t-result]`)?.getAttribute('data-t-result'), quiz);
    };
    const result = await answer(quizzes[0]);
    // Started once its file is decoded (preloaded at the first gesture).
    await page.waitForFunction(() => (window as unknown as { __elabora: { sounds: { state(): { played: { heard: boolean }[] } } } }).__elabora.sounds.state().played[0]?.heard, null, { timeout: 30000 });
    state = await soundsState(page);
    assert.equal(state.context, 'running', 'made at the first click, running');
    assert.equal(state.played.length, 1, JSON.stringify(state.played));
    assert.deepEqual({ ...state.played[0], at: undefined }, { kind: 'interface', role: result === 'correct' ? 'good' : 'bad', src: `elabora/sounds/${result === 'correct' ? 'good' : 'bad'}.m4a`, heard: true, at: undefined });

    // « Affichage »: the switch is there, and off means no sound.
    await page.click('.t-display-btn');
    const toggle = page.locator('.t-display-menu .t-switch[aria-label="Sons de l’interface"]');
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Escape');
    await answer(quizzes[1]);
    state = await soundsState(page);
    assert.equal(state.interface, false);
    assert.equal(state.played.length, 1, 'no sound once switched off');

    await reload();
    assert.equal((await soundsState(page)).interface, false, 'kept for the course');
  }, { target: 'web', web: { progress: 'local' } });
});

test('a module without sound makes none, and « Affichage » has no switch for them', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  const dir = copyExample('coffee-in-brief');
  edit.updatePlayer(dir, { enable: ['display'] });
  await player(dir, async (page) => {
    assert.equal((await soundsState(page)).interface, false);
    await page.click('.t-display-btn');
    assert.equal(await page.locator('.t-display-menu .t-switch[aria-label="Sons de l’interface"]').count(), 0);
  });
});

// ── Sounds of the story, music and ambiences ──

const flac = (file: string, seconds: number, frequency = 660) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}:sample_rate=44100`, '-ac', '1', '-c:a', 'flac', file]);
};
const sound = (dir: string, id: string, seconds: number, extra: Record<string, unknown> = {}) => {
  flac(path.join(dir, `assets/sounds/${id}.flac`), seconds);
  fs.writeFileSync(path.join(dir, `assets/sounds/${id}.json`), `${JSON.stringify({ license: 'CC0-1.0', duration: seconds, ...extra }, null, 2)}\n`);
};
type FullState = { context: string; music: boolean; ducked: boolean; playing: { sound: string; kind: string }[]; played: Played[] };
const fullState = (page: Page) => page.evaluate(() => (window as unknown as { __elabora: { sounds: { state(): FullState } } }).__elabora.sounds.state());

test('sounds of the story, ambiences and music: played after the first gesture, stopped at the end of their screen or range, « Musique et ambiances » off', { skip: NO_FFMPEG, timeout: 240000 }, async () => {
  const dir = copyExample('coffee-in-brief');
  sound(dir, 'ring', 1.5);
  sound(dir, 'cafe', 6, { loop: true });
  sound(dir, 'theme', 6, { loop: true });
  const course = JSON.parse(fs.readFileSync(path.join(dir, 'course.json'), 'utf8'));
  course.sounds = { background: [{ sound: 'theme', from: 'the-cherry', to: 'picking-and-processing', volume: 0.3, fade: 0.5 }] };
  fs.writeFileSync(path.join(dir, 'course.json'), `${JSON.stringify(course, null, 2)}\n`);
  const screen = JSON.parse(fs.readFileSync(path.join(dir, 'screens/green-coffee.json'), 'utf8'));
  screen.events = [...(screen.events ?? []), { id: 'ambience', on: { type: 'screen.enter' }, do: [{ type: 'play-sound', sound: 'cafe', loop: true, fade: 0.3 }, { type: 'play-sound', sound: 'ring', caption: 'The phone rings.' }] }];
  fs.writeFileSync(path.join(dir, 'screens/green-coffee.json'), `${JSON.stringify(screen, null, 2)}\n`);
  edit.updatePlayer(dir, { enable: ['display'] });
  await player(dir, async (page) => {
    let state = await fullState(page);
    assert.equal(state.context, 'none');
    assert.deepEqual(state.playing, [{ sound: 'theme', kind: 'background' }], 'the music of the first screen waits for a gesture');
    await page.mouse.click(5, 450);
    await page.waitForFunction(() => (window as unknown as { __elabora: { sounds: { state(): FullState } } }).__elabora.sounds.state().played.some((entry) => entry.sound === 'theme' && entry.heard), null, { timeout: 30000 });
    // The next screen of its range: it plays on, not again.
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('picking-and-processing'));
    state = await fullState(page);
    assert.equal(state.played.filter((entry) => entry.sound === 'theme').length, 1);
    // Out of its range: it stops; the screen's ambience and its sound of the story play, the caption is said.
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('green-coffee'));
    state = await fullState(page);
    assert.deepEqual(state.playing.map((entry) => `${entry.kind}:${entry.sound}`).sort(), ['ambience:cafe'], JSON.stringify(state.playing));
    await page.waitForFunction(() => (window as unknown as { __elabora: { sounds: { state(): FullState } } }).__elabora.sounds.state().played.some((entry) => entry.sound === 'ring' && entry.heard), null, { timeout: 30000 });
    assert.equal(await page.locator('.t-sr-only[aria-live]').textContent(), 'The phone rings.');
    assert.equal(await page.locator('.t-sound-caption').textContent(), 'The phone rings.', 'no way to choose captions in this course: shown');
    // « Musique et ambiances » off.
    await page.click('.t-display-btn');
    const music = page.locator('.t-display-menu .t-switch[aria-label="Music and ambience"]');
    assert.equal(await music.getAttribute('aria-checked'), 'true');
    await music.click();
    assert.equal((await fullState(page)).music, false);
    await page.keyboard.press('Escape');
    // The ambience of the screen stops with it.
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('roasting'));
    assert.deepEqual((await fullState(page)).playing, []);
  });
});
