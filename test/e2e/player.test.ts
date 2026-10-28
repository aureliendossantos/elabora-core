import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { ROOT, copyExample as copyCourse, isClosed, readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { hasFfmpeg } from '../narration.ts';

// The learner's player (D58) in Chrome: its bars wherever the author puts the controls, the one
// tooltip, terms and hints inside modal dialogs, and nothing that moves from one screen to the next.

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// The sample: two narrated screens, a glossary its texts link to, a PDF among its resources.
const copyExample = () => copyCourse(path.join(ROOT, 'examples/diagnostic-reseau'));

// clock: the page's timers on Playwright's clock, which only the test moves (a loaded computer cannot
// run them out between two of its steps).
async function player(dir: string, run: (page: Page) => Promise<void>, { width = 1600, height = 900, clock = false } = {}) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-player-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    if (clock) await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    await page.goto(`${server.base}/pkg/p/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; for (const s of t.engine.screens) t.engine.st.visited.add(s.key); });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
}
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
const waitTip = (page: Page, text: string) => page.waitForFunction((value) => { const node = document.getElementById('t-tip'); return !!node && !node.hidden && node.textContent === value; }, text, { timeout: 30000 });
const tip = (page: Page) => page.evaluate(() => { const node = document.getElementById('t-tip'); return node && !node.hidden ? node.textContent : null; });
// The tooltip is what the page shows at its centre (not painted under a modal dialog).
const tipOnTop = (page: Page) => page.evaluate(() => {
  const node = document.getElementById('t-tip')!;
  const rect = node.getBoundingClientRect();
  return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === node;
});

test('the controls in the top bar: their popups open downward and the captions stay on the screen', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.player.bottom.items = course.player.bottom.items.filter((item: { id: string }) => item.id !== 'controls');
  course.player.top.items.splice(2, 0, { id: 'controls', options: { captionsByDefault: true } });
  writeJSON(dir, 'course.json', course);
  await player(dir, async (page) => {
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; t.timeline.play(); t.timeline.advance(1); });
    assert.equal(await page.locator('.t-bar--top .t-timeline').count(), 1);
    await page.click('.t-timeline-settings-btn');
    const settings = await box(page, '.t-timeline-settings');
    assert.ok(settings.y >= 0 && settings.y + settings.height <= 900, `the settings are on the screen (${settings.y})`);
    await page.keyboard.press('Escape');
    const band = await box(page, '.t-timeline-band');
    assert.ok(band.y > 450 && band.y + band.height <= 900, `the captions are over the bottom of the screen (${band.y})`);
    await page.hover('.t-timeline-mute');
    await page.waitForTimeout(250);
    const volume = await box(page, '.t-timeline-volume-pop');
    assert.ok(volume.y >= 0, `the volume opens downward (${volume.y})`);
  });
});

test('the tooltip: a refusal goes, a hint shown after it goes with the pointer, and nothing stays on the screen', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  await player(copyExample(), async (page) => {
    // A day after the clock's start: the page may take long to load on a loaded computer, and a
    // pause in its past would throw.
    await page.clock.pauseAt(new Date('2026-10-21T12:00:00Z'));
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; t.timeline.play(); t.timeline.advance(1); });
    // A greyed Next: its reason, at once.
    await page.click('.t-nav-btn--next', { force: true });
    assert.match(await tip(page) ?? '', /\S/);
    // Another control hovered within the flash's time: its hint, which goes when the pointer leaves.
    await page.hover('.t-timeline-captions');
    await page.clock.runFor(1000);
    await waitTip(page, 'Sous-titres');
    await page.mouse.move(800, 400);
    await page.clock.runFor(1000);
    await page.waitForFunction(() => !document.getElementById('t-tip') || document.getElementById('t-tip')!.hidden);
    assert.equal(await tip(page), null, 'gone with the pointer');
    // A refusal whose tooltip the pointer goes onto: it goes when the pointer leaves it.
    await page.click('.t-nav-btn--next', { force: true });
    const shown = await box(page, '#t-tip');
    await page.mouse.move(shown.x + shown.width / 2, shown.y + shown.height / 2);
    await page.clock.runFor(5400);
    assert.notEqual(await tip(page), null, 'kept while hovered');
    await page.mouse.move(800, 400);
    await page.clock.runFor(1000);
    await page.waitForFunction(() => !document.getElementById('t-tip') || document.getElementById('t-tip')!.hidden);
    assert.equal(await tip(page), null, 'gone once left');
  }, { clock: true });
});

test('a theme\'s ring on :focus-visible stays on controls: the screen\'s title the keyboard lands on draws none', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  // A theme as agents write them: a ring on everything :focus-visible, in a layer after the player's.
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.navigation = { mode: 'free', lockUntilComplete: false };
  course.theme.stylesheet = 'theme/theme.css';
  writeJSON(dir, 'course.json', course);
  fs.mkdirSync(path.join(dir, 'theme'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme/theme.css'), ':focus-visible { outline: 3px solid var(--t-focus); outline-offset: 3px; }\n');
  await player(dir, async (page) => {
    const first = await page.evaluate(() => (window as PlayerWindow).__elabora.screen);
    // Next from the keyboard: the next screen's title takes the focus, as :focus-visible.
    await page.focus('.t-nav-btn--next');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => (window as PlayerWindow).__elabora.screen !== id, first);
    const focused = () => page.evaluate(() => { const active = document.activeElement as HTMLElement; return { tag: active.tagName, visible: active.matches(':focus-visible'), outline: getComputedStyle(active).outlineStyle }; });
    assert.deepEqual(await focused(), { tag: 'H1', visible: true, outline: 'none' });
    // A control the keyboard reaches keeps the theme's ring.
    await page.focus('.t-nav-btn--next');
    assert.deepEqual(await focused(), { tag: 'BUTTON', visible: true, outline: 'solid' });
  });
});

test('a term opens the glossary at its entry, marked until the learner closes the panel, searches it or opens another term', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/premier-reflexe.json');
  screen.blocks.unshift({ id: 'termes', type: 'text', props: { markdown: 'Le [routeur](glossary:routeur) fait suivre chaque [paquet](glossary:paquet).' } });
  writeJSON(dir, 'screens/premier-reflexe.json', screen);
  await player(dir, async (page) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('premier-reflexe'));
    // Marked, and current for screen readers.
    const marked = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.t-glossary-entry[data-t-found][aria-current="true"]')].map((node) => node.dataset.term));
    await page.click('#t-main a.t-term[data-term="routeur"]');
    assert.deepEqual(await marked(), ['routeur']);
    // Time goes by while the learner reads: the entry stays marked.
    await page.clock.runFor(10000);
    assert.deepEqual(await marked(), ['routeur']);
    // Another term of the screen: the mark goes to its entry.
    await page.click('#t-main a.t-term[data-term="paquet"]');
    assert.deepEqual(await marked(), ['paquet']);
    // A search: the panel no longer shows that entry for itself.
    await page.fill('.t-glossary-input', 'rou');
    assert.deepEqual(await marked(), []);
    // Closed: nothing marked, nor when the panel opens from its button.
    await page.click('#t-main a.t-term[data-term="routeur"]');
    assert.deepEqual(await marked(), ['routeur']);
    await page.click('[data-sheet="glossary"] .t-sheet-close');
    assert.ok(await isClosed(page.locator('[data-sheet="glossary"]')));
    assert.deepEqual(await marked(), []);
    await page.click('.t-glossary-btn');
    assert.deepEqual(await marked(), []);
    assert.equal(await page.locator('.t-glossary-entry[data-t-found], .t-glossary-entry[aria-current]').count(), 0);
  }, { clock: true });
});

test('modal dialogs: a term in a layer shows its definition over it, and the PDF preview\'s buttons their names', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/premier-reflexe.json');
  screen.layers.push({ id: 'aide-routeur', title: 'Aide', blocks: [{ id: 'aide-routeur-texte', type: 'text', props: { markdown: 'Le [routeur](glossary:routeur) relie les réseaux.' } }] });
  screen.events.push({ id: 'aide', on: { type: 'screen.enter' }, do: [{ type: 'show-layer', layer: 'aide-routeur' }] });
  writeJSON(dir, 'screens/premier-reflexe.json', screen);
  await player(dir, async (page) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('premier-reflexe'));
    const term = page.locator('dialog[open] a.t-term[data-term="routeur"]');
    await term.hover();
    await page.clock.runFor(1000);
    await page.waitForFunction(() => /Équipement/.test(document.getElementById('t-tip')?.textContent ?? ''), null, { timeout: 30000 });
    assert.ok(await tipOnTop(page), 'over the dialog');
    // A click keeps the definition there (the glossary's panel would open under the dialog).
    await term.click();
    assert.match(await tip(page) ?? '', /^Routeur : Équipement/);
    assert.ok(await isClosed(page.locator('[data-sheet="glossary"]')));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // The PDF preview, a modal dialog: its icon buttons say their names.
    await page.click('.t-resources-btn');
    await page.click('.t-resource[data-resource="fiche-reflexe"]');
    await page.hover('.t-viewer-close');
    await page.clock.runFor(1000);
    await waitTip(page, 'Fermer');
    assert.ok(await tipOnTop(page), 'over the preview');
  }, { clock: true });
});

test('nothing moves between screens: the bottom bar on a phone, the outline\'s button with the screen\'s title', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  const dir = copyExample();
  await player(dir, async (page) => {
    const measure = () => page.evaluate(() => ({
      bar: Math.round(document.querySelector('.t-bar--bottom')!.getBoundingClientRect().height),
      next: Math.round(document.querySelector('.t-nav-btn--next')!.getBoundingClientRect().top)
    }));
    const narrated = await measure();
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('premier-reflexe'));
    assert.deepEqual(await measure(), narrated, 'the same bar on a screen without narration');
  }, { width: 390, height: 844 });
  const course = readJSON(dir, 'course.json');
  course.player.bottom.items = course.player.bottom.items.map((item: { id: string }) => (item.id === 'outline' ? { id: 'outline', options: { screenTitle: true } } : item));
  writeJSON(dir, 'course.json', course);
  await player(dir, async (page) => {
    const measure = () => page.evaluate(() => ({
      outline: Math.round(document.querySelector('.t-outline-btn')!.getBoundingClientRect().width),
      seek: Math.round(document.querySelector('.t-timeline-seek')!.getBoundingClientRect().left)
    }));
    const first = await measure();
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('chemin'));
    assert.deepEqual(await measure(), first);
    assert.equal(await page.locator('.t-outline-label').textContent(), 'Le chemin d\'une impression');
  });
});
