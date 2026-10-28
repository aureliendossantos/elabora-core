import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContextOptions, Frame, Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { CHROMIUM_CHANNELS, launchBrowser } from '@elabora/node/emulator/browser';
import { testPackage } from '@elabora/node/emulator/run';
import { build } from '@elabora/node/build';
import { measureFit } from '@elabora/node/fit';
import { copyExample } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { addActivities, ACTIVITY_SCREENS } from '../activities-fixture.ts';

// The activities of D63 in Chrome: each answered with the keyboard only and with taps only, the names
// screen readers hear, a reload that resumes them, their SCORM interactions in the LMS emulator, no
// shift in slides, and less motion.

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function built(slides = false) {
  const dir = copyExample();
  addActivities(dir, { slides });
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-activities-'), writeLock: false, debug: true, profiles: ['moodle'] });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  return { dir, out: b.dirPath };
}

// The package in the player, every screen open; run gets the page on the given screen.
async function inPlayer(out: string, screen: string, run: (page: Page) => Promise<void>, context: BrowserContextOptions = {}) {
  const server = await startServer();
  server.addPackage('p', out);
  // A phone is an external Chromium's: Elabora's Electron (ELABORA_ELECTRON_EXECUTABLE) emulates none.
  const browser: Browser = await launchBrowser('chromium', context.hasTouch || context.isMobile ? { channels: CHROMIUM_CHANNELS } : {});
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce', ...context })).newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.base}/pkg/p/index.html`);
    await open(page, screen);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
}
async function open(page: Page, screen: string) {
  await page.waitForFunction(() => (window as PlayerWindow).__elabora);
  await page.evaluate((id) => { const t = (window as PlayerWindow).__elabora; for (const s of t.engine.screens) t.engine.st.visited.add(s.key); t.go(id); }, screen);
  await page.waitForFunction((id) => (window as PlayerWindow).__elabora.screen === id && !!document.querySelector('.t-block[data-behavior]'), screen);
}

// Keyboard only: Tab, or Shift+Tab when it comes before the focus, until the focus is on what the
// selector names.
async function tabTo(page: Page, selector: string) {
  for (let i = 0; i < 80; i++) {
    const where = await page.evaluate((s) => {
      const target = document.querySelector(s);
      const active = document.activeElement;
      if (!target) return 'missing';
      if (active === target) return 'here';
      return active && active !== document.body && (target.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'before' : 'after';
    }, selector);
    if (where === 'here') return;
    if (where === 'missing') throw new Error(`${selector} is not in the page`);
    await page.keyboard.press(where === 'before' ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`${selector} never got the focus`);
}
const feedbackOf = (page: Page, block: string) => page.locator(`[data-block="${block}"] [data-t-feedback]`).innerText();
// What the live regions say (the player's, emptied then filled).
const hears = (page: Page, text: string) => page.waitForFunction((words) => [...document.querySelectorAll('[aria-live]')].some((node) => node.textContent?.includes(words)), text, { timeout: 30000, polling: 50 }).catch(async (error) => { throw new Error(`${error.message}: the live regions say ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map((node) => node.textContent)))}`); });

test('fill-in: typed, menus and words to place, with the keyboard only; screen readers hear each blank; a reload resumes them', { timeout: 240000 }, async () => {
  const { out } = await built();
  await inPlayer(out, 'activites-trous', async (page) => {
    // The fields are named by the player.
    const typed = page.locator('[data-block="trous-saisie"]');
    assert.equal(await typed.getByRole('textbox', { name: 'Trou 1', exact: true }).count(), 1);
    assert.equal(await page.locator('[data-block="trous-listes"]').getByRole('combobox', { name: 'Trou 2', exact: true }).count(), 1);
    assert.equal(await page.locator('[data-block="trous-mots"]').getByRole('button', { name: 'Trou 1, vide', exact: true }).count(), 1);
    assert.equal(await page.locator('[data-block="trous-mots"]').getByRole('group', { name: 'Mots à placer' }).count(), 1);

    // Typed: case and apostrophes never count; Enter submits.
    await tabTo(page, '[data-block="trous-saisie"] [data-t-blank="1"] input');
    await page.keyboard.type('ROUTEUR d\'accès');
    await page.keyboard.press('Tab');
    await page.keyboard.type('dns');
    await page.keyboard.press('Enter');
    assert.match(await feedbackOf(page, 'trous-saisie'), /^Bonne réponse\./);
    assert.equal(await typed.locator('[data-t-group]').getAttribute('data-t-result'), 'correct');

    // Menus: type-ahead in each list.
    await tabTo(page, '[data-block="trous-listes"] [data-t-blank="1"] select');
    await page.keyboard.type('commu');
    await tabTo(page, '[data-block="trous-listes"] [data-t-blank="2"] select');
    await page.keyboard.type('rou');
    await tabTo(page, '[data-block="trous-listes"] [data-t-submit]');
    await page.keyboard.press('Enter');
    assert.match(await feedbackOf(page, 'trous-listes'), /^Bonne réponse\./);

    // Words to place: choose a word (Space), then its blank (Enter); Escape lets go of a word.
    const place = async (word: string, blank: number) => {
      await tabTo(page, `[data-block="trous-mots"] .t-word:not(.is-used)[data-test-word="${word}"]`);
      await page.keyboard.press('Space');
      await tabTo(page, `[data-block="trous-mots"] [data-t-blank="${blank}"] button`);
      await page.keyboard.press('Enter');
    };
    await page.evaluate(() => { for (const button of document.querySelectorAll<HTMLElement>('[data-block="trous-mots"] .t-word')) button.dataset.testWord = button.textContent ?? ''; });
    await tabTo(page, '[data-block="trous-mots"] .t-word[data-test-word="imprimante"]');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('[data-block="trous-mots"] .t-word[data-test-word="imprimante"]').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-block="trous-mots"] .t-word[data-test-word="imprimante"]').getAttribute('aria-pressed'), 'false');
    await place('câble', 1);
    assert.equal(await page.locator('[data-block="trous-mots"] [data-t-blank="1"] button').getAttribute('aria-label'), 'Trou 1 : câble');
    await place('imprimante', 2);
    await place('passerelle', 3);
    // The bank keeps the room of placed words: nothing moves.
    const bank = await page.locator('[data-block="trous-mots"] .t-bank').boundingBox();
    await tabTo(page, '[data-block="trous-mots"] [data-t-submit]');
    await page.keyboard.press('Enter');
    const feedback = await feedbackOf(page, 'trous-mots');
    assert.match(feedback, /Il vous reste 1 essai\.[\s\S]*Trous justes : 2 sur 3\./);
    assert.deepEqual(await page.locator('[data-block="trous-mots"] .t-blank').evaluateAll((nodes) => nodes.map((node) => node.className)), ['t-blank is-filled is-correct', 't-blank is-filled is-wrong', 't-blank is-filled is-correct']);
    assert.equal((await page.locator('[data-block="trous-mots"] .t-bank').boundingBox())!.height, bank!.height);
    // The second try: the wrong word back to the bank by its blank, the right one placed.
    await tabTo(page, '[data-block="trous-mots"] [data-t-blank="2"] button');
    await page.keyboard.press('Enter');
    await place('carte réseau', 2);
    await tabTo(page, '[data-block="trous-mots"] [data-t-submit]');
    await page.keyboard.press('Enter');
    assert.match(await feedbackOf(page, 'trous-mots'), /^Bonne réponse\./);
    // The focus the button had went to the feedback, which says it.
    assert.ok(await page.evaluate(() => !!document.activeElement?.matches('[data-block="trous-mots"] [data-t-feedback]')));

    // A reload: the answers are back, final, with their marks.
    await page.reload();
    await open(page, 'activites-trous');
    assert.equal(await page.locator('[data-block="trous-saisie"] [data-t-blank="1"] input').inputValue(), 'ROUTEUR d\'accès');
    assert.equal(await page.locator('[data-block="trous-listes"] [data-t-blank="1"] select').inputValue(), 'commutateur');
    assert.equal(await page.locator('[data-block="trous-mots"] [data-t-blank="2"] button').innerText(), 'carte réseau');
    assert.equal(await page.locator('[data-block="trous-mots"] [data-t-group]').getAttribute('data-t-final'), '');
    assert.ok(await page.locator('[data-block="trous-mots"] [data-t-submit]').isHidden());
  });
});

test('sort: pairs, categories and order with the keyboard only; names of items, targets and moves; a reload resumes them', { timeout: 240000 }, async () => {
  const { out } = await built();
  await inPlayer(out, 'activites-classer', async (page) => {
    const pairs = page.locator('[data-block="classer-paires"]');
    assert.equal(await pairs.getByRole('button', { name: 'Placer dans « Débit saturé »', exact: true }).count(), 1);
    assert.equal(await pairs.getByRole('group', { name: 'Éléments à placer' }).count(), 1);
    const order = page.locator('[data-block="classer-ordre"]');
    assert.equal(await order.getByRole('list').count(), 1);
    assert.equal(await order.getByRole('listitem').count(), 4);
    assert.equal(await order.getByRole('button', { name: 'Monter « Ouvrir un ticket »', exact: true }).count(), 1);

    // Pairs: choose an item (Enter), then the target (Enter).
    const placePair = async (block: string, item: string, target: string) => {
      await tabTo(page, `[data-block="${block}"] [data-t-sort-item="${item}"]`);
      await page.keyboard.press('Enter');
      await tabTo(page, `[data-block="${block}"] [data-t-sort-target="${target}"] [data-t-place]`);
      await page.keyboard.press('Enter');
    };
    await placePair('classer-paires', 'lent', 'debit');
    await hears(page, '« Tout est lent » placé dans « Débit saturé ».');
    assert.equal(await pairs.getByRole('button', { name: 'Tout est lent (dans « Débit saturé »)', exact: true }).count(), 1);
    await placePair('classer-paires', 'rien', 'cable');
    // A target of pairs takes one item: the one it had goes back.
    await placePair('classer-paires', 'voisin', 'cable');
    assert.equal(await page.locator('[data-block="classer-paires"] [data-t-sort-target="cable"] [data-t-sort-item]').count(), 1);
    await placePair('classer-paires', 'rien', 'dns');
    await tabTo(page, '[data-block="classer-paires"] [data-t-submit]');
    await page.keyboard.press('Enter');
    assert.match(await feedbackOf(page, 'classer-paires'), /^Bonne réponse\./);

    // Categories: a first try with one item wrong, marked and said; then right.
    for (const [item, target] of [['routeur', 'materiel'], ['pilote', 'logiciel'], ['cable', 'materiel'], ['dhcp', 'materiel']]) await placePair('classer-categories', item, target);
    await tabTo(page, '[data-block="classer-categories"] [data-t-submit]');
    await page.keyboard.press('Enter');
    assert.match(await feedbackOf(page, 'classer-categories'), /Bien placés : 3 sur 4\./);
    assert.equal(await page.locator('[data-block="classer-categories"] [data-t-sort-item="dhcp"]').getAttribute('class'), 't-sort-item is-wrong');
    assert.match(await page.locator('[data-block="classer-categories"] [data-t-sort-item="dhcp"]').innerText(), /Mal placé/);
    await placePair('classer-categories', 'dhcp', 'logiciel');
    await tabTo(page, '[data-block="classer-categories"] [data-t-submit]');
    await page.keyboard.press('Enter');
    assert.match(await feedbackOf(page, 'classer-categories'), /^Bonne réponse\./);

    // Order: move buttons and choose-then-choose, the focus kept.
    const rows = () => page.locator('[data-block="classer-ordre"] [data-t-sort-item]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-t-sort-item')));
    const wanted = ['voyant', 'ping', 'dns', 'ticket'];
    for (const [position, id] of wanted.entries()) {
      for (let guard = 0; guard < 4 && (await rows()).indexOf(id) > position; guard++) {
        await tabTo(page, `[data-block="classer-ordre"] [data-t-sort-item="${id}"] + .t-sort-moves .t-sort-move--up`);
        await page.keyboard.press('Enter');
        assert.ok(await page.evaluate((item) => !!document.activeElement?.matches(`[data-t-sort-item="${item}"] + .t-sort-moves .t-sort-move--up`), id), 'the focus stays on the button');
      }
    }
    assert.deepEqual(await rows(), wanted);
    await tabTo(page, '[data-block="classer-ordre"] [data-t-submit]');
    await page.keyboard.press('Enter');
    assert.match(await feedbackOf(page, 'classer-ordre'), /^Bonne réponse\./);

    await page.reload();
    await open(page, 'activites-classer');
    assert.equal(await page.locator('[data-block="classer-paires"] [data-t-sort-target="dns"] [data-t-sort-item="rien"]').count(), 1);
    assert.deepEqual(await rows(), wanted);
    assert.ok(await page.locator('[data-block="classer-ordre"] [data-t-sort-item="ticket"]').isDisabled());
  });
});

test('taps only: a fill-in, a sort and a reflection answered by touch on a phone', { timeout: 240000 }, async () => {
  const { out } = await built();
  const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  await inPlayer(out, 'activites-trous', async (page) => {
    const words = page.locator('[data-block="trous-mots"] .t-word');
    assert.equal(await words.first().getAttribute('draggable'), null, 'no drag on a coarse pointer');
    for (const [word, blank] of [['câble', 1], ['carte réseau', 2], ['passerelle', 3]] as const) {
      await page.locator('[data-block="trous-mots"] .t-word:not(.is-used)', { hasText: word }).tap();
      await page.locator(`[data-block="trous-mots"] [data-t-blank="${blank}"] button`).tap();
    }
    await page.locator('[data-block="trous-mots"] [data-t-submit]').tap();
    assert.match(await feedbackOf(page, 'trous-mots'), /^Bonne réponse\./);
    await open(page, 'activites-classer');
    for (const [item, target] of [['routeur', 'materiel'], ['pilote', 'logiciel'], ['cable', 'materiel'], ['dhcp', 'logiciel']]) {
      await page.locator(`[data-block="classer-categories"] [data-t-sort-item="${item}"]`).tap();
      await page.locator(`[data-block="classer-categories"] [data-t-sort-target="${target}"] [data-t-place]`).tap();
    }
    await page.locator('[data-block="classer-categories"] [data-t-submit]').tap();
    assert.match(await feedbackOf(page, 'classer-categories'), /^Bonne réponse\./);
    // Order by taps: an item, then the one whose place it takes.
    const rows = () => page.locator('[data-block="classer-ordre"] [data-t-sort-item]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-t-sort-item')));
    for (const [position, id] of ['voyant', 'ping', 'dns', 'ticket'].entries()) {
      const there = (await rows())[position];
      if (there === id) continue;
      await page.locator(`[data-block="classer-ordre"] [data-t-sort-item="${id}"]`).tap();
      await page.locator(`[data-block="classer-ordre"] [data-t-sort-item="${there}"]`).tap();
    }
    assert.deepEqual(await rows(), ['voyant', 'ping', 'dns', 'ticket']);
    await open(page, 'activites-reflexion');
    await page.locator('[data-block="reflexion-echelle"] .t-scale-point').nth(3).tap();
    await page.locator('[data-block="reflexion-echelle"] [data-t-submit]').tap();
    await page.waitForFunction(() => /Réponse enregistrée/.test(document.querySelector('[data-block="reflexion-echelle"] [data-t-feedback]')?.textContent ?? ''), null, { polling: 50 });
  }, phone);
});

test('reflection and the quiz on a picture: names, the expert\'s answer, « Mes réponses » made in the page, neutral zones until final', { timeout: 240000 }, async () => {
  const { out } = await built();
  await inPlayer(out, 'activites-reflexion', async (page) => {
    const text = page.locator('[data-block="reflexion-texte"]');
    const field = text.getByRole('textbox', { name: /Pensez à la dernière panne réseau/ });
    assert.equal(await field.count(), 1);
    assert.equal(await field.getAttribute('maxlength'), '400');
    await tabTo(page, '[data-block="reflexion-texte"] [data-t-submit]');
    await page.keyboard.press('Enter');
    assert.match(await feedbackOf(page, 'reflexion-texte'), /Écrivez votre réponse/);
    await tabTo(page, '[data-block="reflexion-texte"] textarea');
    await page.keyboard.type('Le voyant, puis un ping.');
    assert.equal(await text.locator('.t-reflection-count').innerText(), '24 / 400 caractères');
    await tabTo(page, '[data-block="reflexion-texte"] [data-t-submit]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Réponse enregistrée/.test(document.querySelector('[data-block="reflexion-texte"] [data-t-feedback]')?.textContent ?? ''), null, { polling: 50 });
    assert.ok(await text.locator('.t-reflection-model').isVisible());
    assert.match(await text.locator('.t-reflection-model').innerText(), /Comparez avec la réponse d’un expert/);
    // The scale: a radio group named by its prompt, its ends described.
    const scale = page.locator('[data-block="reflexion-echelle"]');
    assert.equal(await scale.getByRole('radiogroup', { name: /Vous sentez-vous capable/ }).count(), 1);
    assert.equal(await scale.getByRole('radio', { name: '1', exact: true }).getAttribute('aria-describedby') !== null, true);
    await tabTo(page, '[data-block="reflexion-echelle"] input[value="1"]');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await tabTo(page, '[data-block="reflexion-echelle"] [data-t-submit]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Réponse enregistrée/.test(document.querySelector('[data-block="reflexion-echelle"] [data-t-feedback]')?.textContent ?? ''), null, { polling: 50 });
    // « Mes réponses »: a text file from the page, every reflection with its answer.
    const download = page.waitForEvent('download');
    await text.getByRole('button', { name: 'Mes réponses' }).click();
    const file = await download;
    assert.match(file.suggestedFilename(), /^diagnostiquer-.*-mes-reponses\.txt$/);
    const saved = fs.readFileSync((await file.path())!, 'utf8');
    assert.match(saved, /Pensez à la dernière panne réseau[\s\S]*Le voyant, puis un ping\.[\s\S]*Vous sentez-vous capable[\s\S]*3 sur une échelle de 1 à 5/);
    await page.reload();
    await open(page, 'activites-reflexion');
    assert.equal(await page.locator('[data-block="reflexion-texte"] textarea').inputValue(), 'Le voyant, puis un ping.');
    assert.ok(await page.locator('[data-block="reflexion-echelle"] input[value="3"]').isChecked());

    // The zones of the quiz on a picture: « Zone n » until the answer is final, then their words.
    await open(page, 'activites-images');
    const zones = page.locator('[data-block="images-zones"]');
    assert.deepEqual(await zones.getByRole('radio').evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))), ['Zone 1', 'Zone 2', 'Zone 3']);
    assert.equal(await zones.getByRole('radio', { name: 'Zone 1', exact: true }).count(), 1);
    assert.ok(await zones.locator('.t-zone-text').first().isHidden(), 'the words do not show before');
    const marker = await zones.locator('.t-zone').first().boundingBox();
    assert.ok(marker!.width >= 44 && marker!.height >= 44, JSON.stringify(marker));
    await tabTo(page, '[data-block="images-zones"] input[type="radio"]');
    await page.keyboard.press('Space');
    await tabTo(page, '[data-block="images-zones"] [data-t-submit]');
    await page.keyboard.press('Enter');
    assert.equal(await zones.getByRole('radio', { name: 'Le voyant du boîtier', exact: false }).count(), 1);
    assert.ok(await zones.locator('.t-zone-text').first().isVisible());
    // Picture cards: named by their words, their picture described.
    const cards = page.locator('[data-block="images-cartes"]');
    assert.equal(await cards.getByRole('radio', { name: 'Un boîtier bleu avec deux antennes Le routeur' }).count(), 1);
  });
});

test('SCORM: the activities\' interactions in the LMS emulator are accepted, with valid patterns; the run completes with axe-core', { timeout: 420000 }, async () => {
  const { out } = await built();
  const server = await startServer();
  server.addPackage('p', out);
  const browser: Browser = await launchBrowser('chromium');
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    await page.goto(`${server.base}/lms/launch.html?pkg=p&profile=moodle&mode=iframe&reg=act`);
    await page.waitForFunction(() => (window as Window & { __lmsReady?: boolean }).__lmsReady === true);
    let frame: Frame | undefined;
    for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((candidate) => /\/pkg\//.test(candidate.url())); if (!frame) await page.waitForTimeout(100); }
    assert.ok(frame);
    const content = frame!;
    await content.waitForFunction(() => (window as PlayerWindow).__elabora);
    const go = (screen: string) => content.evaluate((id) => { const t = (window as PlayerWindow).__elabora; for (const s of t.engine.screens) t.engine.st.visited.add(s.key); t.go(id); }, screen);
    await go('activites-trous');
    await content.locator('[data-block="trous-saisie"] [data-t-blank="1"] input').fill('routeur');
    await content.locator('[data-block="trous-saisie"] [data-t-blank="2"] input').fill('NTP');
    await content.locator('[data-block="trous-saisie"] [data-t-submit]').click();
    await content.locator('[data-block="trous-listes"] [data-t-blank="1"] select').selectOption('commutateur');
    await content.locator('[data-block="trous-listes"] [data-t-blank="2"] select').selectOption('routeur');
    await content.locator('[data-block="trous-listes"] [data-t-submit]').click();
    await go('activites-classer');
    for (const [item, target] of [['lent', 'debit'], ['rien', 'dns'], ['voisin', 'cable']]) {
      await content.locator(`[data-block="classer-paires"] [data-t-sort-item="${item}"]`).click();
      await content.locator(`[data-block="classer-paires"] [data-t-sort-target="${target}"] [data-t-place]`).click();
    }
    await content.locator('[data-block="classer-paires"] [data-t-submit]').click();
    await content.locator('[data-block="classer-ordre"] [data-t-submit]').click();
    await go('activites-reflexion');
    await content.locator('[data-block="reflexion-texte"] textarea').fill('Une réponse\nsur deux lignes, avec "des guillemets".');
    await content.locator('[data-block="reflexion-texte"] [data-t-submit]').click();
    await content.locator('[data-block="reflexion-echelle"] input[value="4"]').check();
    await content.locator('[data-block="reflexion-echelle"] [data-t-submit]').click();
    await content.evaluate(() => (window as unknown as { __elabora: { quit(): void } }).__elabora.quit());
    await page.waitForTimeout(300);
    type Call = { method: string; args: string[]; result: string };
    const log: Call[] = await page.evaluate(() => (window as unknown as { __lmsLog: Call[] }).__lmsLog);
    const sets = log.filter((call) => call.method === 'LMSSetValue' && call.args[0].startsWith('cmi.interactions.'));
    assert.deepEqual(sets.filter((call) => call.result !== 'true').map((call) => call.args.join(' = ')), [], 'no interaction value refused');
    const value = (n: number, field: string) => sets.find((call) => call.args[0] === `cmi.interactions.${n}.${field}`)?.args[1];
    const recorded = [...new Set(sets.map((call) => Number(call.args[0].split('.')[2])))].map((n) => ({ id: value(n, 'id'), type: value(n, 'type'), response: value(n, 'student_response'), pattern: value(n, 'correct_responses.0.pattern'), result: value(n, 'result') }));
    assert.deepEqual(recorded, [
      { id: 'trous-saisie.1', type: 'fill-in', response: 'routeur', pattern: 'routeur', result: 'correct' },
      { id: 'trous-saisie.2', type: 'fill-in', response: 'NTP', pattern: 'DNS', result: 'wrong' },
      { id: 'trous-listes.1', type: 'choice', response: recorded[2]?.pattern, pattern: recorded[2]?.pattern, result: 'correct' },
      { id: 'trous-listes.2', type: 'choice', response: recorded[3]?.pattern, pattern: recorded[3]?.pattern, result: 'correct' },
      { id: 'classer-paires', type: 'matching', response: '1.a,2.b,3.c', pattern: '1.a,2.b,3.c', result: 'correct' },
      { id: 'classer-ordre', type: 'sequencing', response: recorded[5]?.response, pattern: 'a,b,c,d', result: 'wrong' },
      { id: 'reflexion-texte', type: 'fill-in', response: 'Une réponse sur deux lignes, avec "des guillemets".', pattern: undefined, result: 'neutral' },
      { id: 'reflexion-echelle', type: 'likert', response: '4', pattern: undefined, result: 'neutral' }
    ]);
    assert.match(recorded[2].pattern!, /^[a-c]$/);
    assert.match(recorded[5].response!, /^[a-d](,[a-d]){3}$/);
    // What the LMS stored for the learner keeps every answer.
    const cmi = server.registration('act')?.cmi as { suspend_data?: string } | undefined;
    assert.match(cmi?.suspend_data ?? '', /"f":\{[^}]*"routeur","NTP"/);
  } finally {
    await browser.close();
    await server.close();
  }
  // The whole scenario: every activity answered right through its hooks, axe-core on every screen.
  const r = await testPackage({ dir: out, profiles: ['moodle'], modes: ['iframe'], accessibility: true, unloadVariants: false });
  assert.deepEqual(r.runs.filter((x) => !x.ok).map((x) => x.failures.map((f) => `${f.code} ${f.message}`).join(', ')), []);
  assert.equal(r.accessibility?.violations, 0, JSON.stringify(r.accessibility?.details));
});

test('slides: answering an activity moves nothing (fit), and the room is reserved for its tallest outcome', { timeout: 300000 }, async () => {
  const { dir, out } = await built(true);
  const fit = await measureFit(dir, { sizes: [{ role: 'reference', size: '1600x900' }] });
  assert.ok(fit.ok);
  const shifts = fit.sizes[0].screens.filter((screen) => ACTIVITY_SCREENS.includes(screen.screen ?? '') && screen.shift).map((screen) => `${screen.screen}: ${JSON.stringify(screen.shift)}`);
  assert.deepEqual(shifts, []);
  await inPlayer(out, 'activites-classer', async (page) => {
    const blocks = ['classer-paires', 'classer-categories', 'classer-ordre'];
    // Where each block is in the slide (the page may scroll to what is clicked), and its height.
    const boxes = () => page.evaluate((ids) => ids.map((id) => { const top = document.querySelector('#t-main article')!.getBoundingClientRect().top; const box = document.querySelector(`[data-block="${id}"]`)!.getBoundingClientRect(); return [Math.round(box.top - top), Math.round(box.height)]; }), blocks);
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    const before = await boxes();
    // All in one category, wrong, final after two tries: the tallest the categories get.
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const item of ['routeur', 'pilote', 'cable', 'dhcp']) {
        await page.locator(`[data-block="classer-categories"] [data-t-sort-item="${item}"]`).click();
        await page.locator('[data-block="classer-categories"] [data-t-sort-target="logiciel"] [data-t-place]').click();
      }
      await page.locator('[data-block="classer-categories"] [data-t-submit]').click();
    }
    for (const [item, target] of [['lent', 'dns'], ['rien', 'cable'], ['voisin', 'debit']]) {
      await page.locator(`[data-block="classer-paires"] [data-t-sort-item="${item}"]`).click();
      await page.locator(`[data-block="classer-paires"] [data-t-sort-target="${target}"] [data-t-place]`).click();
    }
    await page.locator('[data-block="classer-paires"] [data-t-submit]').click();
    await page.locator('[data-block="classer-ordre"] [data-t-submit]').click();
    assert.deepEqual(await boxes(), before, 'every block where it was, at its height');
  });
  await inPlayer(out, 'activites-trous', async (page) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    const height = () => page.evaluate(() => Math.round(document.querySelector('[data-block="trous-mots"]')!.getBoundingClientRect().height));
    const before = await height();
    for (const [word, blank] of [['imprimante', 1], ['câble', 2], ['passerelle', 3]] as const) {
      await page.locator('[data-block="trous-mots"] .t-word:not(.is-used)', { hasText: word }).click();
      await page.locator(`[data-block="trous-mots"] [data-t-blank="${blank}"] button`).click();
    }
    await page.locator('[data-block="trous-mots"] [data-t-submit]').click();
    await page.locator('[data-block="trous-mots"] [data-t-submit]').click();
    assert.equal(await height(), before);
  });
});

test('less motion: what the learner moves glides in 220 ms, and not at all when less motion is asked', { timeout: 180000 }, async () => {
  const { out } = await built();
  const durations = (page: Page, selectors: string[]) => page.evaluate((list) => list.map((selector) => getComputedStyle(document.querySelector(selector)!).transitionDuration), selectors);
  for (const motion of ['no-preference', 'reduce'] as const) {
    await inPlayer(out, 'activites-trous', async (page) => {
      const measured = await durations(page, ['.t-word', '.t-blank-slot']);
      await open(page, 'activites-classer');
      measured.push(...await durations(page, ['.t-sort-item', '.t-sort-target']));
      await open(page, 'activites-images');
      measured.push(...await durations(page, ['.t-zone-number']));
      await open(page, 'activites-trous');
      for (const duration of measured) {
        if (motion === 'reduce') assert.match(duration, /^0s(, 0s)*$/, `${motion}: ${measured.join(' | ')}`);
        else assert.ok(duration.split(', ').includes('0.22s'), `${motion}: ${measured.join(' | ')}`);
      }
      // The choice still shows: by its border and background, not by a move.
      await page.locator('[data-block="trous-mots"] .t-word').first().click();
      assert.equal(await page.locator('[data-block="trous-mots"] .t-word').first().getAttribute('aria-pressed'), 'true');
    }, { reducedMotion: motion });
  }
});
