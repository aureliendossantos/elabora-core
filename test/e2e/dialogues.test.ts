import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Frame, Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import type { EmulatorServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { testPackage } from '@elabora/node/emulator/run';
import { build } from '@elabora/node/build';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { forkComponent } from '@elabora/node/edit';
import { startCanvasHost } from '@elabora/node/canvas/host';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import { loadAxe, axeViolations } from '@elabora/node/util/axe';
import { dialogueCourse } from '../dialogue-fixture.ts';
import { NO_MEDIA_CODECS, playsMedia } from '../helpers.ts';
import { voice, hasFfmpeg } from '../narration.ts';

// The dialogue in the learner's player, in Chrome (docs/dialogues.md, D61): the thread (role=log,
// bubbles inserted whole, the focus in « Votre réponse » once the learner answers, never before), a
// choice, the common way, a retry, « Reprendre d'ici », « Recommencer », the debrief, a session
// resumed in the LMS, the scored run's interactions (one per decision, once), no shift in a slide,
// the ink on the virtual clock, the characters' state during a line, reduced motion, axe, the
// transcript of a screen without narration, the canvas's view of a path, a deterministic package.
// The lines have no audio (their estimated voice); the clock is virtual.

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type DialogueWindow = Window & typeof globalThis & { __elabora: Any; inserted?: { text: string; ink: string; role: string }[] };

// open: the last decision of « appel » is not final (a final decision closes going back and starting over).
const packages = new Map<string, Promise<string>>();
function packageOf(presentation: 'slides' | 'scroll' = 'slides', { open = false }: { open?: boolean } = {}): Promise<string> {
  const key = `${presentation}${open ? '-open' : ''}`;
  if (!packages.has(key)) packages.set(key, (async () => {
    const dir = dialogueCourse({ presentation });
    if (open) {
      const file = path.join(dir, 'screens/appel.json');
      const screen = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete screen.blocks[0].props.nodes.find((node: { id: string }) => node.id === 'escalade').final;
      fs.writeFileSync(file, JSON.stringify(screen, null, 2));
    }
    const b = await build(dir, { emit: 'dir', out: tmp('elabora-dialogue-'), writeLock: false, debug: true });
    assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
    return b.dirPath;
  })());
  return packages.get(key)!;
}

let shared: { server: EmulatorServer; browser: Browser } | null = null;
async function context() {
  if (!shared) shared = { server: await startServer(), browser: await launchBrowser('chromium') };
  return shared;
}
test.after(async () => { await shared?.browser.close(); await shared?.server.close(); });

interface PlayerOptions { presentation?: 'slides' | 'scroll'; open?: boolean; width?: number; height?: number; reducedMotion?: 'reduce' | 'no-preference' }
async function player(options: PlayerOptions, run: (page: Page) => Promise<void>) {
  const { server, browser } = await context();
  const name = `d${Math.random().toString(36).slice(2, 8)}`;
  server.addPackage(name, await packageOf(options.presentation, { open: options.open }));
  const page = await browser.newPage({ viewport: { width: options.width ?? 1600, height: options.height ?? 900 }, reducedMotion: options.reducedMotion ?? 'no-preference' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    await page.goto(`${server.base}/pkg/${name}/index.html`);
    await page.waitForFunction(() => (window as DialogueWindow).__elabora);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

const state = (page: Page | Frame, block: string) => page.evaluate((id) => (window as DialogueWindow).__elabora.dialogues.state(id), block);
// The virtual clock moves until the dialogue reaches that phase (the learner reading, never hurried).
async function until(page: Page | Frame, block: string, phase: 'choosing' | 'ended' | 'playing', each?: () => Promise<void>) {
  for (let i = 0; i < 400; i++) {
    const now = await state(page, block);
    if (now?.phase === phase) return now;
    await page.evaluate(() => (window as DialogueWindow).__elabora.dialogues.advance(0.25));
    await each?.();
  }
  throw new Error(`${block} never reached ${phase}: ${JSON.stringify(await state(page, block))}`);
}
const choose = (page: Page | Frame, block: string, option: string) => page.click(`[data-block="${block}"] [data-t-options] [data-option="${option}"]`);
// Where things are, to compare from one moment to the next (a slide never shifts).
const boxes = (page: Page, block: string) => page.evaluate((id) => {
  const box = (node: Element | null) => { if (!node) return null; const r = node.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','); };
  const wrap = document.querySelector(`[data-block="${id}"]`);
  return { title: box(document.querySelector('#t-main h1')), block: box(wrap), log: box(wrap?.querySelector('[data-t-log]') ?? null), room: box(wrap?.querySelector('[data-t-options]') ?? null), overflow: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
}, block);
const watchInsertions = (page: Page) => page.evaluate(() => {
  const w = window as DialogueWindow;
  w.inserted = [];
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement) || !node.matches('.t-dialogue-row')) continue;
      w.inserted!.push({ role: node.dataset.role ?? '', text: node.querySelector('.t-sr-only')?.textContent ?? '', ink: node.querySelector('.t-dialogue-ink')?.textContent ?? node.textContent ?? '' });
    }
  }).observe(document.body, { childList: true, subtree: true });
});

test('messaging in a slide: the thread, whole bubbles, the ink on the clock, cues, a retry, the common way, going back, the focus, no shift, a final decision, the debrief', { timeout: 240000 }, async () => {
  await player({}, async (page) => {
    await watchInsertions(page);
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('appel'));
    const wrap = page.locator('[data-block="appel-marc"]');
    // The thread is a log, the options' room a permanent group that can take the focus.
    assert.deepEqual(await wrap.locator('[data-t-log]').evaluate((log) => [log.getAttribute('role'), log.getAttribute('aria-live'), log.getAttribute('aria-relevant')]), ['log', 'polite', 'additions']);
    assert.deepEqual(await wrap.locator('[data-t-options]').evaluate((room) => [room.getAttribute('role'), room.getAttribute('aria-label'), room.getAttribute('tabindex')]), ['group', 'Votre réponse', '-1']);
    assert.equal((await state(page, 'appel-marc')).phase, 'playing', 'begins on its own (begins: auto)');
    await page.evaluate(() => (window as DialogueWindow).__elabora.dialogues.advance(1.2));
    const said = await page.evaluate(() => (window as DialogueWindow).__elabora.dialogues.current());
    assert.equal(said?.block, 'appel-marc', 'the Review reads the line being said');
    assert.ok(said.line === 'm1' && said.time > 0, JSON.stringify(said));

    // The ink: a line's words lit one after the other on the clock, all readable from the start.
    let partly = false;
    const first = await boxes(page, 'appel-marc');
    const shifts: string[] = [];
    const at = await until(page, 'appel-marc', 'choosing', async () => {
      const ink = await page.evaluate(() => { const row = [...document.querySelectorAll('[data-block="appel-marc"] .t-dialogue-row[data-role="character"]')].at(-1); const words = row ? [...row.querySelectorAll('.t-w')] : []; return { said: words.filter((word) => word.classList.contains('is-said')).length, all: words.length }; });
      if (ink.said > 0 && ink.said < ink.all) partly = true;
      const now = await boxes(page, 'appel-marc');
      if (JSON.stringify(now) !== JSON.stringify(first)) shifts.push(JSON.stringify(now));
    });
    assert.equal(at.node, 'premiere-question');
    assert.ok(partly, 'a line seen half said');
    assert.deepEqual(shifts, [], `nothing moves in the slide (${JSON.stringify(first)})`);
    assert.equal(first.overflow, 0, 'the slide fits its window');
    // The cue at « étage » showed the floor plan.
    assert.equal(await page.locator('[data-block="plan-etage"]').isVisible(), true);
    // The options came without taking the focus.
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-block="appel-marc"]')), false, 'the focus is never stolen');

    // A bad option with retry: its reply, the note, then the same decision, that option greyed.
    await choose(page, 'appel-marc', 'c');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-block="appel-marc"] [data-t-options]')), true, 'the focus waits in « Votre réponse »');
    assert.equal(await page.evaluate(() => (window as DialogueWindow).__elabora.engine.getVar('indiceVu')), true, 'dialogue.chosen with its node and option');
    const again = await until(page, 'appel-marc', 'choosing');
    assert.equal(again.node, 'premiere-question');
    assert.equal(await wrap.locator('[data-option="c"]').getAttribute('aria-disabled'), 'true');
    assert.ok(await wrap.locator('.t-dialogue-row[data-role="note"]').count() >= 1, 'the trainer\'s note');
    assert.equal(await wrap.locator('.t-dialogue-row[data-role="note"] .t-dialogue-quality').first().innerText(), 'Choix à éviter', 'its quality said in words, not only in colour');

    // b, then the common way (ticket).
    await choose(page, 'appel-marc', 'b');
    assert.equal((await until(page, 'appel-marc', 'choosing')).node, 'ticket');
    assert.equal(await wrap.locator('.t-dialogue-row[data-line="m4"]').count(), 1, 'b\'s own node on the way');
    // Practice: no going back before the end.
    assert.equal(await wrap.locator('.t-dialogue-resume:not([hidden])').count(), 0);
    await choose(page, 'appel-marc', 'a');
    assert.equal((await until(page, 'appel-marc', 'choosing')).node, 'escalade');
    assert.ok(await wrap.locator('.t-dialogue-final').count(), 'a final decision says so');
    await choose(page, 'appel-marc', 'a');
    const ended = await until(page, 'appel-marc', 'ended');
    assert.equal(ended.ending, 'a-revoir', 'the scored run had c first: 2 decisions out of 3');
    assert.deepEqual(shifts, []);

    // Every bubble came whole: its text when it was inserted is the text it has.
    const inserted = await page.evaluate(() => (window as DialogueWindow).inserted!);
    const lines = inserted.filter((row) => row.role === 'character' || row.role === 'learner');
    assert.ok(lines.length >= 8, `${lines.length} bubbles`);
    const now = await wrap.locator('.t-dialogue-row[data-role="character"] .t-sr-only').evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
    for (const text of now) assert.ok(lines.some((row) => row.text === text), `inserted whole: ${text}`);
    assert.ok(inserted.filter((row) => row.role === 'character').every((row) => /^(Marc|Leïla) : /.test(row.text)), 'screen readers hear « Marc : … »');

    // The end: endings found, the debrief; past a final decision, neither going back nor starting over.
    assert.equal(await wrap.locator('.t-dialogue-count').innerText(), '1 fin découverte sur 2');
    assert.equal(await wrap.locator('.t-dialogue-endbar .t-dialogue-action').filter({ hasText: /Recommencer|Revenir/ }).count(), 0);
    assert.equal(await wrap.locator('.t-dialogue-resume:not([hidden])').count(), 0);
    // The debrief comes over the thread at the end; its toggle shows the thread again, and back.
    assert.equal(await wrap.locator('.t-dialogue-debrief-card').isVisible(), true);
    assert.equal(await wrap.locator('.t-dialogue-decision').count(), 3, 'one entry per decision of the path');
    await wrap.locator('.t-dialogue-debrief-toggle').click();
    assert.equal(await wrap.locator('.t-dialogue-debrief-card').isVisible(), false);
    assert.equal(await wrap.locator('[data-t-log]').isVisible(), true);
    await wrap.locator('.t-dialogue-debrief-toggle').click();
    assert.equal(await wrap.locator('.t-dialogue-debrief-card').isVisible(), true);
    assert.deepEqual(await boxes(page, 'appel-marc'), first, 'nothing moved either');
  });
});

test('the scene in a slide: the décor, the cast, the characters\' state during a line and at a cue, paging, history; on a phone it becomes a thread', { timeout: 240000 }, async () => {
  await player({}, async (page) => {
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('rencontre'));
    const wrap = page.locator('[data-block="rencontre-marc"]');
    assert.equal(await wrap.locator('.t-dialogue-root').getAttribute('data-t-look'), 'scene');
    assert.equal(await wrap.locator('.t-dialogue-actor').count(), 2);
    const actor = (speaker: string) => page.evaluate((who) => {
      const group = document.querySelector(`[data-block="rencontre-marc"] .t-dialogue-actor[data-speaker="${who}"] [data-part="character"]`);
      return group ? Object.fromEntries([...group.attributes].map((a) => [a.name, a.value])) : null;
    }, speaker);
    // r1, Marc's line: he speaks (mouth moving on the clock), Leïla listens; « saluer » at « Bonjour ».
    let seen: { speaking?: boolean; listening?: boolean; gesture?: string; mouths: Set<string>; expression?: string } = { mouths: new Set() };
    for (let i = 0; i < 80; i++) {
      const now = await state(page, 'rencontre-marc');
      if (now.line === 'r1') {
        const marc = await actor('marc');
        const leila = await actor('leila');
        if (marc && 'data-speaking' in marc) seen.speaking = true;
        if (leila && 'data-listening' in leila) seen.listening = true;
        if (marc?.['data-gesture']) seen.gesture = marc['data-gesture'];
        if (marc?.['data-mouth']) seen.mouths.add(marc['data-mouth']);
        seen.expression = marc?.['data-expression'];
      }
      if (now.line === 'r2') break;
      await page.evaluate(() => (window as DialogueWindow).__elabora.dialogues.advance(0.1));
    }
    assert.deepEqual([seen.speaking, seen.listening, seen.gesture, seen.expression], [true, true, 'saluer', 'inquiet'], JSON.stringify({ ...seen, mouths: [...seen.mouths] }));
    assert.ok(seen.mouths.size >= 2, `the mouth moves (${[...seen.mouths].join(', ')})`);
    const first = await boxes(page, 'rencontre-marc');
    const actors = () => page.evaluate(() => [...document.querySelectorAll('[data-block="rencontre-marc"] .t-dialogue-actor')].map((node) => { const r = node.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)].join(','); }));
    const placed = await actors();
    await until(page, 'rencontre-marc', 'choosing');
    assert.deepEqual(await boxes(page, 'rencontre-marc'), first, 'nothing moves in the slide');
    assert.deepEqual(await actors(), placed, 'the cast stays where it stands');
    assert.equal(first.overflow, 0);
    // History: every line so far, then closed with Escape.
    await wrap.locator('.t-dialogue-history-btn, [data-t-history-button]').first().click();
    assert.equal(await wrap.locator('.t-dialogue-root').getAttribute('data-t-history'), '');
    await page.keyboard.press('Escape');
    assert.equal(await wrap.locator('.t-dialogue-root').getAttribute('data-t-history'), null);
    await choose(page, 'rencontre-marc', 'b');
    await until(page, 'rencontre-marc', 'choosing');
    await choose(page, 'rencontre-marc', 'a');
    const ended = await until(page, 'rencontre-marc', 'ended');
    assert.equal(ended.ending, 'bien');
    // Assessment: no going back, no start over.
    assert.equal(await wrap.locator('.t-dialogue-endbar .t-dialogue-action').filter({ hasText: 'Recommencer' }).count(), 0);
  });
  await player({ width: 390, height: 844 }, async (page) => {
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('rencontre'));
    await until(page, 'rencontre-marc', 'choosing');
    const phone = await page.evaluate(() => {
      const wrap = document.querySelector('[data-block="rencontre-marc"]')!;
      return { actors: [...wrap.querySelectorAll('.t-dialogue-actor')].filter((node) => (node as HTMLElement).offsetParent !== null).length, avatars: [...wrap.querySelectorAll('.t-dialogue-avatar')].filter((node) => (node as HTMLElement).offsetParent !== null).length, wide: document.documentElement.scrollWidth > innerWidth };
    });
    assert.deepEqual(phone, { actors: 0, avatars: phone.avatars, wide: false });
    assert.ok(phone.avatars >= 1, 'a thread with avatars');
  });
});

test('reduced motion: whole lines at once, nothing slides; the transcript of a screen without narration has the path; going back after the end; the Review shows a line; axe finds nothing', { timeout: 240000 }, async () => {
  await player({ reducedMotion: 'reduce', open: true }, async (page) => {
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('appel'));
    const ink = await page.evaluate(() => { const words = [...document.querySelectorAll('[data-block="appel-marc"] .t-dialogue-row[data-role="character"] .t-w')]; return { said: words.filter((word) => word.classList.contains('is-said')).length, all: words.length }; });
    assert.ok(ink.all > 0 && ink.said === ink.all, `whole at once (${ink.said}/${ink.all})`);
    const moving = await page.evaluate(() => document.getAnimations().filter((animation) => (animation.effect as KeyframeEffect | null)?.target instanceof Element && ((animation.effect as KeyframeEffect).target as Element).closest('[data-block="appel-marc"]') && animation.playState === 'running').length);
    assert.equal(moving, 0, 'no animation in the dialogue');
    await until(page, 'appel-marc', 'choosing');
    await axe(page, 'appel, choosing');
    // The transcript: its own button in the controls, the path under the dialogue's title.
    await page.locator('.t-timeline-transcript-btn').first().click();
    const transcript = await page.locator('.t-timeline-transcript-dialogue').innerText();
    assert.match(transcript, /Marc[^]*plus rien ne marche/);
    assert.doesNotMatch(transcript, /\[inquiet/, 'stage directions are not read');
    await page.keyboard.press('Escape');
    await choose(page, 'appel-marc', 'a');
    await until(page, 'appel-marc', 'choosing');
    await choose(page, 'appel-marc', 'a');
    await until(page, 'appel-marc', 'choosing');
    await choose(page, 'appel-marc', 'a');
    await until(page, 'appel-marc', 'ended');
    await axe(page, 'appel, debrief');
    await page.locator('[data-block="appel-marc"] .t-dialogue-debrief-toggle').click();
    await axe(page, 'appel, ended');
    // « Reprendre d'ici » after the end (practice, no final decision): back to the first decision.
    const wrap = page.locator('[data-block="appel-marc"]');
    await wrap.locator('.t-dialogue-row[data-decision="0"] .t-dialogue-resume:not([hidden])').last().focus();
    await page.keyboard.press('Enter');
    assert.equal((await until(page, 'appel-marc', 'choosing')).node, 'premiere-question');
    await choose(page, 'appel-marc', 'b');
    assert.equal((await until(page, 'appel-marc', 'choosing')).node, 'ticket', 'the common way');
    assert.equal(await wrap.locator('.t-dialogue-row[data-line="m4"]').count(), 1, 'b\'s own node');
    assert.equal(await wrap.locator('.t-dialogue-row[data-line="m2"]').count(), 0, 'the path left is gone from the thread');
    assert.equal((await state(page, 'appel-marc')).scored?.length, 3, 'the scored run is kept apart');
    // The Review shows a line of another path: the thread after the choices that lead to it.
    assert.equal(await page.evaluate(() => (window as DialogueWindow).__elabora.dialogues.show('appel-marc', 'm3')), true);
    assert.equal(await page.locator('[data-block="appel-marc"] .t-dialogue-row[data-line="m3"]').count(), 1);
    assert.equal(await page.evaluate(() => (window as DialogueWindow).__elabora.dialogues.show('appel-marc', 'nothing')), false);
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('rencontre'));
    await until(page, 'rencontre-marc', 'choosing');
    await axe(page, 'rencontre, choosing');
  });
});

async function axe(page: Page, where: string) {
  const script = loadAxe();
  if (!script) return;
  const result = await page.evaluate(`(function(){ if (!window.axe) { ${script} } return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => String(n.target)) }))); })()`);
  assert.deepEqual(axeViolations(result), [], `axe on ${where}`);
}

test('scroll: the dialogue begins when it is seen, its thread grows in the page', { timeout: 120000 }, async () => {
  await player({ presentation: 'scroll' }, async (page) => {
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('appel'));
    await until(page, 'appel-marc', 'choosing');
    const log = await page.evaluate(() => { const log = document.querySelector<HTMLElement>('[data-block="appel-marc"] [data-t-log]')!; return { scrolls: log.scrollHeight > log.clientHeight + 1, rows: log.querySelectorAll('.t-dialogue-row').length }; });
    assert.deepEqual(log, { scrolls: false, rows: log.rows });
    assert.ok(log.rows >= 2);
  });
});

// The LMS: the scored run's interactions, one per decision, sent once; the session left on a
// decision comes back with its thread at once and its options; nothing more after the end.
test('in the LMS: a session resumed on a decision, the scored run\'s interactions once, the emulator plays dialogues', { timeout: 300000 }, async () => {
  const dir = await packageOf('slides', { open: true });
  const { server, browser } = await context();
  server.addPackage('dlms', dir);
  const reg = `r${Math.random().toString(36).slice(2, 8)}`;
  async function launch() {
    const lms = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await lms.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    const page = await lms.newPage();
    await page.goto(`${server.base}/lms/launch.html?pkg=dlms&profile=moodle&mode=iframe&reg=${reg}`);
    await page.waitForFunction(() => (window as Window & { __lmsReady?: boolean }).__lmsReady === true);
    let frame: Frame | undefined;
    for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((candidate) => /\/pkg\//.test(candidate.url())); if (!frame) await page.waitForTimeout(100); }
    await frame!.waitForFunction(() => (window as DialogueWindow).__elabora);
    return { lms, page, frame: frame! };
  }
  const interactions = () => {
    const cmi = server.registration(reg)?.cmi as Any;
    const list = cmi?.interactions?.childArray ?? Object.values(cmi?.interactions ?? {}).filter((entry) => entry && typeof entry === 'object');
    return (list as Any[]).map((entry) => `${entry.id} ${entry.student_response ?? entry.learner_response} ${entry.result}`);
  };
  const close = async (session: { lms: Any; page: Page }) => { await session.page.close({ runBeforeUnload: false }); await session.lms.close(); };

  let session = await launch();
  await session.frame.evaluate(() => (window as DialogueWindow).__elabora.go('appel'));
  await until(session.frame, 'appel-marc', 'choosing');
  await choose(session.frame, 'appel-marc', 'b');
  assert.equal((await until(session.frame, 'appel-marc', 'choosing')).node, 'ticket');
  await session.frame.waitForTimeout(1500);
  await close(session);
  assert.deepEqual(interactions(), [], 'nothing before the scored run ends');

  session = await launch();
  await session.frame.evaluate(() => (window as DialogueWindow).__elabora.go('appel'));
  const resumed = await state(session.frame, 'appel-marc');
  assert.deepEqual([resumed.phase, resumed.node, resumed.path], ['choosing', 'ticket', ['premiere-question.b']]);
  assert.ok(await session.frame.locator('[data-block="appel-marc"] .t-dialogue-row[data-line="m1"]').count(), 'the thread so far, at once');
  await choose(session.frame, 'appel-marc', 'a');
  await until(session.frame, 'appel-marc', 'choosing');
  await choose(session.frame, 'appel-marc', 'a');
  await until(session.frame, 'appel-marc', 'ended');
  await session.frame.locator('[data-block="appel-marc"] .t-dialogue-endbar .t-dialogue-action').filter({ hasText: 'Recommencer' }).click();
  await until(session.frame, 'appel-marc', 'choosing');
  await choose(session.frame, 'appel-marc', 'c');
  await session.frame.waitForTimeout(1500);
  await close(session);
  assert.deepEqual(interactions().map((entry) => entry.split(' ').slice(0, 1)[0]), ['appel-marc.premiere-question', 'appel-marc.ticket', 'appel-marc.escalade']);
  assert.deepEqual(interactions().map((entry) => entry.split(' ').slice(1)), [['b', 'neutral'], ['a', 'correct'], ['a', 'correct']]);
  // Started over after the end: the scored run stays the first.
  session = await launch();
  await session.frame.evaluate(() => (window as DialogueWindow).__elabora.go('appel'));
  const again = await state(session.frame, 'appel-marc');
  assert.deepEqual([again.phase, again.scored?.length], ['choosing', 3], 'the restarted run, resumed at its first decision, the scored run kept');
  await close(session);

  // The emulator plays each dialogue to its end, with axe on every screen.
  const run = await testPackage({ dir, profiles: ['moodle'], modes: ['iframe'], accessibility: true, unloadVariants: false });
  assert.deepEqual(run.runs.filter((entry) => !entry.ok).map((entry) => entry.failures.map((failure) => `${failure.code} ${failure.message}`).join(', ')), []);
  assert.equal(run.accessibility?.violations, 0, JSON.stringify(run.accessibility?.details));
});

test('the canvas shows a dialogue after some choices, at rest, and back at its start', { timeout: 120000 }, async () => {
  const dir = dialogueCourse();
  const project = loadProjectFromDir(dir);
  const render = createRenderContext(project);
  const host = await startCanvasHost({ root: dir });
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(host.url);
    await page.waitForFunction(() => (window as Window & { __elaboraCanvas?: unknown }).__elaboraCanvas);
    host.push(renderScreen(project, 'appel', { dialogue: { block: 'appel-marc', choices: ['c', 'b'] } }, render), { id: 1 });
    await page.waitForFunction(() => document.querySelector('[data-block="appel-marc"] [data-t-options] [data-option]'));
    const shown = () => page.evaluate(() => ({ lines: [...document.querySelectorAll('[data-block="appel-marc"] .t-dialogue-row[data-line]')].map((row) => (row as HTMLElement).dataset.line), options: [...document.querySelectorAll('[data-block="appel-marc"] [data-t-options] [data-option]')].map((button) => (button as HTMLElement).dataset.option) }));
    const after = await shown();
    assert.ok(after.lines.includes('m3') && after.lines.at(-1) !== 'm1', `the path: ${after.lines.join(' ')}`);
    assert.deepEqual(after.options, ['a', 'b', 'c'], 'the options of « ticket »');
    host.view({ dialogue: null }, { id: 2 });
    await page.waitForFunction(() => !document.querySelector('[data-block="appel-marc"] .t-dialogue-row[data-line="m3"]'));
    assert.deepEqual((await shown()).lines, ['m1', 'l1'], 'at its start, its first decision');
    host.view({ dialogue: { block: 'appel-marc', node: 'escalade' } }, { id: 3 });
    await page.waitForFunction(() => document.querySelector('[data-block="appel-marc"] .t-dialogue-final'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await host.close();
  }
});

test('the package with dialogues is deterministic', { timeout: 120000 }, async () => {
  const dir = dialogueCourse();
  const a = await build(dir, { out: tmp('elabora-dialogue-a-'), writeLock: false });
  const b = await build(dir, { out: tmp('elabora-dialogue-b-'), writeLock: false });
  assert.ok(a.ok && b.ok);
  assert.equal(a.report.package.sha256, b.report.package.sha256);
});

// Real voices on the real clock: each line plays its own file, the line ends on the audio's ended
// event (not when currentTime reaches duration), « Couper les voix » mutes it, and a refused autoplay
// leaves a play button in the bubble while the line goes on, silent, at its own pace.
test('voiced lines: the audio\'s own clock and ended event, muting, a refused autoplay', { timeout: 240000, skip: !hasFfmpeg() && 'ffmpeg and ffprobe not found' }, async (t) => {
  const dir = dialogueCourse({ screens: ['rencontre'] });
  const screen = JSON.parse(fs.readFileSync(path.join(dir, 'screens/rencontre.json'), 'utf8'));
  const texts = Object.fromEntries(screen.blocks[0].props.nodes.flatMap((node: { lines: { id: string; text: string }[] }) => node.lines).map((line: { id: string; text: string }) => [line.id, line.text]));
  voice(dir, 'rencontre', { id: 'r1', text: texts.r1, seconds: 4 }, { language: 'fr', frequency: 440 });
  voice(dir, 'rencontre', { id: 'r2', text: texts.r2, seconds: 1 }, { language: 'fr', frequency: 660 });
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-dialogue-voice-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  assert.ok(fs.existsSync(path.join(b.dirPath, 'narration/rencontre.rencontre-marc/r1.m4a')));
  const { server, browser } = await context();
  server.addPackage('dvoice', b.dirPath);
  for (const refused of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      if (refused) await page.addInitScript(() => { HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException('No gesture', 'NotAllowedError')); }; });
      await page.goto(`${server.base}/pkg/dvoice/index.html`);
      await page.waitForFunction(() => (window as DialogueWindow).__elabora);
      if (!(await playsMedia(page, 'audio/mp4; codecs="mp4a.40.2"'))) return t.skip(NO_MEDIA_CODECS);
      await page.evaluate(() => (window as DialogueWindow).__elabora.go('rencontre'));
      await page.waitForFunction(() => (window as DialogueWindow).__elabora.dialogues.state('rencontre-marc')?.line === 'r1', null, { timeout: 30000 });
      if (!refused) {
        // r1 plays its file; the line's time is the audio's.
        await page.waitForFunction(() => { const audio = document.querySelector<HTMLAudioElement>('[data-block="rencontre-marc"] audio'); return !!audio && !audio.paused && audio.currentTime > 0.2; }, null, { timeout: 15000 });
        const playing = await page.evaluate(() => { const audio = document.querySelector<HTMLAudioElement>('[data-block="rencontre-marc"] audio')!; const now = (window as DialogueWindow).__elabora.dialogues.state('rencontre-marc'); return { src: audio.getAttribute('src'), time: now.time, audio: audio.currentTime }; });
        assert.match(playing.src ?? '', /narration\/rencontre\.rencontre-marc\/r1\.m4a$/);
        assert.ok(Math.abs(playing.time - playing.audio) < 0.25, JSON.stringify(playing));
        // Mute: the voice goes on, silent.
        await page.locator('[data-block="rencontre-marc"] .t-dialogue-mute').click();
        await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('[data-block="rencontre-marc"] audio')?.muted === true, null, { timeout: 3000 });
        await page.locator('[data-block="rencontre-marc"] .t-dialogue-mute').click();
        await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('[data-block="rencontre-marc"] audio')?.muted === false, null, { timeout: 3000 });
        // ended moves the dialogue on to r2, then its own file.
        const ended = page.evaluate(() => new Promise<number>((resolve) => document.querySelector('[data-block="rencontre-marc"] audio')!.addEventListener('ended', () => resolve(performance.now()), { once: true })));
        const at = await ended;
        await page.waitForFunction(() => (window as DialogueWindow).__elabora.dialogues.state('rencontre-marc')?.line === 'r2', null, { timeout: 10000 });
        const moved = await page.evaluate(() => performance.now());
        assert.ok(moved - at < 2000, `r2 ${Math.round(moved - at)} ms after r1's ended`);
      } else {
        // Refused: « Écouter » in the bubble, the line said on its own clock all the same.
        await page.waitForFunction(() => { const button = document.querySelector<HTMLElement>('[data-block="rencontre-marc"] .t-dialogue-row[data-line="r1"] .t-dialogue-listen'); return !!button && !button.hidden; }, null, { timeout: 10000 });
        await page.waitForFunction(() => (window as DialogueWindow).__elabora.dialogues.state('rencontre-marc')?.line === 'r2', null, { timeout: 15000 });
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }
});

// A fork changes the markup and keeps the behaviour: its own elements with the hooks, the thread, the
// options, the score and the debrief all the same.
test('a fork of dialogue with markup of its own keeps the behaviour', { timeout: 180000 }, async () => {
  const dir = dialogueCourse({ screens: ['appel'] });
  forkComponent(dir, { component: 'dialogue', id: 'dialogue-sobre' });
  fs.writeFileSync(path.join(dir, 'components/dialogue-sobre/template.html'), [
    '<article class="sobre" data-t-group aria-label="{{title}}">',
    '  <p class="sobre-kicker">{{title}}</p>',
    '  <div class="sobre-thread" data-t-log></div>',
    '  <footer class="sobre-answers" data-t-options></footer>',
    '</article>', ''
  ].join('\n'));
  const file = path.join(dir, 'screens/appel.json');
  const screen = JSON.parse(fs.readFileSync(file, 'utf8'));
  screen.blocks[0].type = 'dialogue-sobre';
  fs.writeFileSync(file, JSON.stringify(screen, null, 2));
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-dialogue-fork-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const { server, browser } = await context();
  server.addPackage('dfork', b.dirPath);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    await page.goto(`${server.base}/pkg/dfork/index.html`);
    await page.waitForFunction(() => (window as DialogueWindow).__elabora);
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('appel'));
    for (const option of ['a', 'a', 'a']) { await until(page, 'appel-marc', 'choosing'); await choose(page, 'appel-marc', option); }
    const ended = await until(page, 'appel-marc', 'ended');
    assert.equal(ended.ending, 'maitrise');
    const look = await page.evaluate(() => {
      const wrap = document.querySelector('[data-block="appel-marc"]')!;
      return { root: wrap.querySelector('.sobre')?.classList.contains('t-dialogue-root'), log: wrap.querySelector('.sobre-thread')?.getAttribute('role'), rows: wrap.querySelectorAll('.sobre-thread .t-dialogue-row').length, room: wrap.querySelector('.sobre-answers')?.getAttribute('aria-label'), end: !!wrap.querySelector('.sobre-answers .t-dialogue-endbar') };
    });
    assert.deepEqual(look, { root: true, log: 'log', rows: look.rows, room: 'Votre réponse', end: true });
    assert.ok(look.rows > 8);
    assert.equal(await page.evaluate(() => (window as DialogueWindow).__elabora.engine.getVar('bonsReflexes')), 1, 'dialogue.ended with its ending');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

// The screen drives the dialogue: begins: event waits for start-dialogue, a button moves it to a node
// (goto-dialogue), another starts it over (restart-dialogue, after the scored run: the scored run kept);
// dialogue.node fires with its node. On a new visit, what its cues showed is shown again, at once.
test('the screen\'s actions on a dialogue, and its presentation replayed on a new visit', { timeout: 180000 }, async () => {
  const dir = dialogueCourse({ screens: ['appel', 'rencontre'] });
  const file = path.join(dir, 'screens/rencontre.json');
  const screen = JSON.parse(fs.readFileSync(file, 'utf8'));
  screen.blocks[0].props.begins = 'event';
  screen.blocks.push({ id: 'rencontre-fin', type: 'button', props: { label: 'Aller à la fin' } }, { id: 'rencontre-encore', type: 'button', props: { label: 'Encore' } });
  screen.events = [
    { id: 'demarre', on: { type: 'screen.enter' }, do: [{ type: 'start-dialogue', block: 'rencontre-marc' }] },
    { id: 'saute', on: { type: 'click', target: 'rencontre-fin' }, do: [{ type: 'goto-dialogue', block: 'rencontre-marc', node: 'fin' }] },
    { id: 'encore', on: { type: 'click', target: 'rencontre-encore' }, do: [{ type: 'restart-dialogue', block: 'rencontre-marc' }] },
    { id: 'noeud', on: { type: 'dialogue.node', target: 'rencontre-marc', node: 'fin' }, do: [{ type: 'increment-variable', variable: 'bonsReflexes', by: 1 }] }
  ];
  fs.writeFileSync(file, JSON.stringify(screen, null, 2));
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-dialogue-events-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const { server, browser } = await context();
  server.addPackage('devents', b.dirPath);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    await page.goto(`${server.base}/pkg/devents/index.html`);
    await page.waitForFunction(() => (window as DialogueWindow).__elabora);
    // appel: its cue at « étage » shows the floor plan; a new visit shows it at once.
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('appel'));
    await until(page, 'appel-marc', 'choosing');
    assert.equal(await page.locator('[data-block="plan-etage"]').isVisible(), true);
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('rencontre'));
    assert.equal((await state(page, 'rencontre-marc')).phase, 'playing', 'started by the screen');
    await page.locator('[data-block="rencontre-fin"] button').click();
    const ended = await until(page, 'rencontre-marc', 'ended');
    assert.equal(ended.node, 'fin');
    assert.equal(await page.evaluate(() => (window as DialogueWindow).__elabora.engine.getVar('bonsReflexes')), 1, 'dialogue.node with its node');
    await page.locator('[data-block="rencontre-encore"] button').click();
    const again = await state(page, 'rencontre-marc');
    assert.deepEqual([again.phase, again.path.length, Array.isArray(again.scored)], ['playing', 0, true], 'started over, the scored run kept apart');
    await page.evaluate(() => (window as DialogueWindow).__elabora.go('appel'));
    assert.equal(await page.locator('[data-block="plan-etage"]').isVisible(), true, 'shown again on the new visit, at once');
    assert.equal((await state(page, 'appel-marc')).phase, 'choosing', 'the thread at its decision, at once');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
