import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { fitDiagnostics, measureFit } from '@elabora/node/fit';
import { copyExample, readJSON, writeJSON, writeFixture } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';

// The starter blocks of D63 in Chrome: edge to edge without a sideways scrollbar at every width (and
// within a slot, its slot), the image's presentations on a desktop and a phone, the before and after
// slider by keyboard, an opening's head (nothing above its title) and reading time, and the contrast of text over a picture.

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// A light picture (the worst case for white text) and a dark one.
const LIGHT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900"><rect width="1600" height="900" fill="#f7f2e7"/><circle cx="1200" cy="300" r="260" fill="#ffffff"/><rect y="600" width="1600" height="300" fill="#e9e2d0"/></svg>';
const DARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900"><rect width="1600" height="900" fill="#1b2233"/><circle cx="400" cy="300" r="200" fill="#2b3450"/></svg>';
const TALL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900"><rect width="600" height="900" fill="#8aa4c8"/></svg>';
const filler = 'Le paquet traverse le réseau, du poste de Marc jusqu’à l’imprimante, en passant par cinq équipements. '.repeat(6);

function starterCourse({ css = '' }: { css?: string } = {}): string {
  const dir = copyExample();
  writeFixture(dir, 'assets/images/light.svg', LIGHT);
  writeFixture(dir, 'assets/images/dark.svg', DARK);
  writeFixture(dir, 'assets/images/tall.svg', TALL);
  const course = readJSON(dir, 'course.json');
  course.navigation = { mode: 'free', lockUntilComplete: false };
  if (css) {
    writeFixture(dir, 'theme/theme.css', css);
    course.theme = { ...course.theme, stylesheet: 'theme/theme.css' };
  }
  writeJSON(dir, 'course.json', course);
  const chemin = readJSON(dir, 'screens/chemin.json');
  writeJSON(dir, 'screens/chemin.json', {
    ...chemin,
    layout: 'opening',
    layoutProps: { presentation: 'band', image: 'images/dark.svg', decorative: true, lead: 'Ce que vous saurez faire à la fin de la leçon.' },
    blocks: [
      ...chemin.blocks,
      { id: 'chemin-long', type: 'text', props: { markdown: filler } },
      { id: 'chemin-bande', type: 'image', props: { presentation: 'band', asset: 'images/light.svg', alt: 'Le réseau', caption: 'Le réseau de l’agence.' } },
      { id: 'chemin-texte-large', type: 'text', width: 'bleed', props: { markdown: 'Un texte en pleine largeur garde la largeur de lecture.' } },
      { id: 'chemin-cote', type: 'image', props: { presentation: 'beside', asset: 'images/tall.svg', alt: 'Le poste', title: 'Le poste', markdown: 'Il envoie la demande.' } },
      { id: 'chemin-dessus', type: 'image', props: { presentation: 'over', asset: 'images/light.svg', alt: 'Le réseau', title: 'Cinq équipements', markdown: 'Un seul en panne, et rien ne sort.' } },
      { id: 'chemin-enonce', type: 'statement', props: { presentation: 'image', image: 'images/light.svg', decorative: true, markdown: 'Suivez le chemin dans l’ordre, toujours.' } },
      { id: 'chemin-avant-apres', type: 'gallery', props: { presentation: 'compare', images: [{ id: 'avant', asset: 'images/dark.svg', alt: 'Avant', caption: 'Avant la panne' }, { id: 'apres', asset: 'images/light.svg', alt: 'Après', caption: 'Après la panne' }] } },
      { id: 'chemin-colonnes', type: 'columns', props: {}, blocks: [
        { id: 'chemin-col-bande', type: 'image', slot: 'first', props: { presentation: 'band', height: 'short', asset: 'images/dark.svg', decorative: true } },
        { id: 'chemin-col-texte', type: 'text', slot: 'second', props: { markdown: 'Une bande dans une colonne remplit sa colonne.' } }
      ] }
    ]
  });
  return dir;
}

async function player(dir: string, run: (page: Page, sized: (width: number, height: number) => Promise<void>) => Promise<void>) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-starter-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.base}/pkg/p/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('chemin'));
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    const sized = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      // The page's width is measured again as the window changes (ResizeObserver), then laid out.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    await run(page, sized);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

const box = (page: Page, selector: string) => page.$eval(selector, (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });

test('bleed: edge to edge at every width without a sideways scrollbar, the text kept at reading width, a slot filled', { timeout: 180000 }, async () => {
  await player(starterCourse(), async (page, sized) => {
    for (const [width, height] of [[1600, 900], [1280, 720], [1024, 768], [768, 1024], [375, 812]]) {
      await sized(width, height);
      const page_ = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, scrollbar: innerWidth - document.documentElement.clientWidth }));
      assert.equal(page_.scroll, page_.client, `${width}: no sideways scroll (${JSON.stringify(page_)})`);
      for (const block of ['chemin-bande', 'chemin-texte-large', 'chemin-dessus']) {
        const found = await box(page, `[data-block="${block}"]`);
        assert.ok(Math.abs(found.left) < 1 && Math.abs(found.right - page_.client) < 1, `${width}: ${block} from edge to edge ${JSON.stringify(found)} in ${page_.client}`);
      }
      // The band's figure goes to the edges; its caption, and a bleed text's words, keep the reading column.
      const text = await box(page, '[data-block="chemin-texte-large"] .t-text > p');
      const column = await box(page, '[data-block="chemin-long"] .t-text > p');
      assert.ok(Math.abs(text.left - column.left) < 2 && Math.abs(text.width - column.width) < 2, `${width}: bleed text at reading width ${JSON.stringify({ text, column })}`);
      const caption = await page.$eval('[data-block="chemin-bande"] figcaption', (node) => node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft));
      assert.ok(Math.abs(caption - column.left) < 2, `${width}: caption in the column (${caption}, ${column.left})`);
      // In a column, a band fills its column, not the window.
      const slot = await box(page, '[data-block="chemin-colonnes"] [data-slot="first"]');
      const inSlot = await box(page, '[data-block="chemin-col-bande"]');
      assert.ok(Math.abs(inSlot.left - slot.left) < 1 && Math.abs(inSlot.width - slot.width) < 1, `${width}: band in its slot ${JSON.stringify({ inSlot, slot })}`);
      // The opening's band, edge to edge too.
      const head = await box(page, '.t-opening-head');
      assert.ok(Math.abs(head.left) < 1 && Math.abs(head.right - page_.client) < 1, `${width}: the opening's head ${JSON.stringify(head)}`);
    }
  });
});

test('image presentations at 1280 and 375: beside side by side then stacked image first, text over its image', { timeout: 180000 }, async () => {
  await player(starterCourse(), async (page, sized) => {
    await sized(1280, 720);
    let figure = await box(page, '[data-block="chemin-cote"] .t-figure');
    let words = await box(page, '[data-block="chemin-cote"] .t-image-text');
    assert.ok(words.left >= figure.right - 1 && words.top < figure.bottom, `beside at 1280 ${JSON.stringify({ figure, words })}`);
    let over = await box(page, '[data-block="chemin-dessus"] .t-image-frame');
    let title = await box(page, '[data-block="chemin-dessus"] .t-image-title');
    assert.ok(title.top >= over.top && title.bottom <= over.bottom, 'the title over its picture');
    await sized(375, 812);
    figure = await box(page, '[data-block="chemin-cote"] .t-figure');
    words = await box(page, '[data-block="chemin-cote"] .t-image-text');
    assert.ok(words.top >= figure.bottom - 1 && Math.abs(words.left - figure.left) < 2, `beside at 375 stacked, image first ${JSON.stringify({ figure, words })}`);
    over = await box(page, '[data-block="chemin-dessus"] .t-image-frame');
    title = await box(page, '[data-block="chemin-dessus"] .t-image-title');
    assert.ok(title.top >= over.top && title.bottom <= over.bottom && title.right <= over.right, 'still over its picture on a phone');
    // Reading order: the image first, then its text, then the next block.
    const order = await page.$$eval('[data-block="chemin-cote"] :is(img, h2, h3, h4)', (nodes) => nodes.map((node) => node.tagName));
    assert.equal(order[0], 'IMG');
  });
});

test('compare: a range named by the two captions, moved by the keyboard, clips the second picture', { timeout: 180000 }, async () => {
  await player(starterCourse(), async (page) => {
    const range = page.locator('[data-block="chemin-avant-apres"] input.t-compare-range');
    assert.equal(await range.count(), 1);
    assert.equal(await range.getAttribute('aria-label'), 'Comparer : Avant la panne ou Après la panne');
    const state = () => page.evaluate(() => {
      const box = document.querySelector<HTMLElement>('[data-block="chemin-avant-apres"] [data-t-compare]')!;
      const input = box.querySelector('input')!;
      return { value: input.value, at: box.style.getPropertyValue('--t-compare'), text: input.getAttribute('aria-valuetext'), clip: getComputedStyle(box.querySelector('.t-compare-after')!).clipPath };
    });
    assert.equal((await state()).at, '50%');
    await range.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    let now = await state();
    assert.equal(now.value, '55');
    assert.equal(now.at, '55%');
    assert.match(now.text ?? '', /^Avant la panne 55\s?%, Après la panne 45\s?%$/);
    assert.match(now.clip, /inset\(0(px)? 0(px)? 0(px)? 55%\)/);
    await page.keyboard.press('Home');
    assert.equal((await state()).at, '0%');
    await page.keyboard.press('End');
    now = await state();
    assert.equal(now.at, '100%');
  });
});

test('opening: nothing above its title, the reading time named for screen readers', { timeout: 180000 }, async () => {
  const dir = starterCourse();
  await player(dir, async (page) => {
    // D63 amended: the title opens the head; no section, no « Leçon 2 sur 6 » above it.
    assert.equal(await page.$eval('.t-opening-copy', (node) => node.firstElementChild?.classList.contains('t-opening-title')), true);
    assert.doesNotMatch(await page.$eval('.t-opening-copy', (node) => node.textContent ?? ''), /Leçon \d+ sur \d+/);
    const duration = await page.$eval('[data-t-duration]', (node) => ({ text: node.textContent, hidden: node.querySelector('.t-sr-only')?.textContent }));
    assert.match(duration.text ?? '', /^Temps de lecture : \d+ min$/);
    assert.equal(duration.hidden, 'Temps de lecture : ');
    assert.equal(await page.$eval('.t-opening h1', (node) => node.classList.contains('t-screen-title')), true);
  });
});

test('fit measures the contrast of text over a band: the default scrim passes on a light and a dark picture, a scrim too light is reported', { timeout: 240000 }, async () => {
  const passing = await measureFit(starterCourse(), { screens: ['chemin'], fresh: true });
  assert.ok(passing.ok, JSON.stringify(passing));
  const ok = fitDiagnostics(passing).filter((d) => d.code === 'W_TEXT_CONTRAST_MEASURED');
  assert.deepEqual(ok.map((d) => d.message), [], 'the default scrim reads on both pictures');
  const faint = await measureFit(starterCourse({ css: '.t-screen { --t-scrim: rgb(0 0 0 / .08); }' }), { screens: ['chemin'], fresh: true });
  const reported = fitDiagnostics(faint).filter((d) => d.code === 'W_TEXT_CONTRAST_MEASURED');
  for (const block of ['chemin-dessus', 'chemin-enonce']) assert.ok(reported.some((d) => d.message.includes(block)), `${block}: ${JSON.stringify(reported.map((d) => d.message))}`);
});
