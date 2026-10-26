import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { ROOT, copyExample, readJSON, writeJSON, writeFixture } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';

// Panels, characters and the gallery's carousel (D63) in Chrome: the four presentations of the same
// panels (accordion, tabs and their accordion in a narrow container, flip cards, a stack), the
// keyboard, the pointer and a swipe, the room kept (nothing below moves), reduced motion, steps that
// wait for exploration naming what is left, visits saved and resumed, the lightbox of zoomed images,
// and a character's bubbles read « Name : … » beside a portrait at rest. Scroll and slides.

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const picture = (bg: string, fg: string, w = 1200, h = 800) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${bg}"/><circle cx="${w * 0.62}" cy="${h * 0.45}" r="${Math.min(w, h) * 0.28}" fill="${fg}"/></svg>`;

const BODIES = [
  'Le routeur relie le réseau de l’agence à Internet : il choisit, pour chaque paquet, la porte de sortie. Sans lui, rien ne quitte le bâtiment.',
  'Le commutateur relie les postes d’un même étage : il envoie chaque trame au seul port qui la demande, et garde une table des adresses apprises. Il ne choisit pas de route : il connaît les prises, pas les réseaux.',
  'Le câble porte le signal jusqu’au mur.',
  'Le poste envoie la demande d’impression ; vérifiez son adresse avant d’accuser le réseau.'
];
const ITEMS = [
  { id: 'routeur', title: 'Routeur', markdown: BODIES[0], image: 'images/routeur.svg', alt: 'Un routeur' },
  { id: 'switch', title: 'Commutateur', markdown: BODIES[1] },
  { id: 'cable', title: 'Câble', markdown: BODIES[2], image: 'images/cable.svg', alt: '' },
  { id: 'poste', title: 'Poste', markdown: BODIES[3] }
];
const IMAGES = [
  { id: 'routeur', asset: 'images/routeur.svg', alt: 'Le routeur', caption: 'Le routeur de l’agence.' },
  { id: 'switch', asset: 'images/switch.svg', alt: 'Le commutateur', caption: 'Le commutateur du deuxième étage, derrière la porte du local technique, à côté de la baie.' },
  { id: 'cable', asset: 'images/cable.svg', alt: 'Le câble', caption: 'Le câble.' },
  { id: 'poste', asset: 'images/poste.svg', alt: 'Le poste', caption: 'Le poste de Marc.' }
];
const panels = (id: string, presentation: string, props: Record<string, unknown> = {}) => ({ id, type: 'accordion', props: { presentation, items: ITEMS, ...props } });
const after = (id: string) => ({ id, type: 'text', props: { markdown: 'Ce texte suit le bloc : il ne bouge pas.' } });
const explored = (id: string, block: Record<string, unknown>) => ({
  id, title: id, covers: ['ITEM-2'], steps: { 2: { opens: 'explored' } },
  blocks: [block, { id: `${id}-suite`, type: 'text', step: 2, props: { markdown: 'La suite.' } }]
});

function panelsCourse({ slides = false }: { slides?: boolean } = {}): string {
  const dir = copyExample();
  writeFixture(dir, 'assets/images/routeur.svg', picture('#dbe7f3', '#12355b'));
  writeFixture(dir, 'assets/images/switch.svg', picture('#f4e6da', '#c2410c'));
  writeFixture(dir, 'assets/images/cable.svg', picture('#e5efe3', '#2f6b3a', 800, 1000));
  writeFixture(dir, 'assets/images/poste.svg', picture('#ece6f5', '#5b3c88', 1600, 900));
  // Characters: two drawn (the sample's), one without a look.
  for (const who of ['marc', 'leila']) writeFixture(dir, `assets/personnages/${who}.svg`, fs.readFileSync(path.join(ROOT, `examples/diagnostic-reseau/assets/personnages/${who}.svg`), 'utf8'));
  const course = readJSON(dir, 'course.json');
  course.speakers = [
    { id: 'guide', name: 'Claire, votre guide' },
    { id: 'marc', name: 'Marc', color: 'color.primary', look: { svg: 'personnages/marc.svg' } },
    { id: 'leila', name: 'Leïla', color: 'color.accent', look: { svg: 'personnages/leila.svg' } }
  ];
  course.navigation = { mode: 'free', lockUntilComplete: false };
  if (slides) course.presentation = { mode: 'slides' };
  const screens: Record<string, unknown>[] = [
    { id: 'panneaux', title: 'Panneaux', covers: ['ITEM-2'], blocks: [
      panels('p-acc', 'accordion', { prompt: 'Avant d’ouvrir chaque panneau, dites ce que fait cet équipement.', allowMultiple: false }),
      panels('p-tabs', 'tabs', { items: ITEMS.map(({ id, title, markdown }) => ({ id, title, markdown })) }),
      after('p-after'),
      { id: 'p-cols', type: 'columns', props: {}, blocks: [
        { ...panels('p-tabs-slot', 'tabs', { items: ITEMS.slice(0, 3).map(({ id, title, markdown }) => ({ id, title, markdown })) }), slot: 'first' },
        { id: 'p-cols-text', type: 'text', slot: 'second', props: { markdown: 'Dans une colonne, des onglets deviennent un accordéon.' } }
      ] }
    ] },
    { id: 'cartes', title: 'Cartes', covers: ['ITEM-2'], blocks: [
      panels('p-cards', 'cards', { prompt: 'Avant de retourner chaque carte, dites à quoi sert l’équipement.' }),
      after('p-cards-after'),
      panels('p-stack', 'stack', { hint: false }),
      after('p-stack-after')
    ] },
    { id: 'personnages', title: 'Personnages', covers: ['ITEM-2'], blocks: [
      { id: 's-marc', type: 'speech', props: { speaker: 'marc', lines: [{ id: 'l1', markdown: 'Bonjour ! Mon imprimante ne répond plus depuis ce matin.' }, { id: 'l2', markdown: 'J’ai déjà tout redémarré, **deux fois**.' }] } },
      { id: 's-leila', type: 'speech', props: { speaker: 'leila', side: 'end', kind: 'thought', lines: [{ id: 'l1', markdown: 'Et si c’était le câble, encore une fois ?' }] } },
      { id: 's-guide', type: 'speech', props: { speaker: 'guide', lines: [{ id: 'l1', markdown: 'Suivez le chemin du paquet, du poste à l’imprimante.' }] } }
    ] },
    { id: 'galerie', title: 'Galerie', covers: ['ITEM-2'], blocks: [
      { id: 'g-car', type: 'gallery', props: { presentation: 'carousel', zoom: true, images: IMAGES, caption: 'Les quatre équipements du chemin.' } },
      after('g-car-after'),
      { id: 'g-grid', type: 'gallery', props: { presentation: 'grid', zoom: true, images: IMAGES.slice(0, 3) } },
      { id: 'g-img', type: 'image', props: { asset: 'images/poste.svg', alt: 'Le poste', caption: 'Un poste, à agrandir.', zoom: true } }
    ] },
    explored('explore-panneaux', panels('x-acc', 'accordion')),
    explored('explore-onglets', panels('x-tabs', 'tabs')),
    explored('explore-cartes', panels('x-cards', 'cards')),
    explored('explore-pile', panels('x-stack', 'stack')),
    explored('explore-galerie', { id: 'x-car', type: 'gallery', props: { presentation: 'carousel', images: IMAGES } })
  ];
  for (const screen of screens) writeJSON(dir, `screens/${screen.id}.json`, { $schema: 'https://elabora.studio/schemas/0.1.1/screen.schema.json', ...screen });
  course.sections = [{ id: 'essai', title: 'Essai', screens: screens.map((screen) => screen.id) }, ...course.sections];
  writeJSON(dir, 'course.json', course);
  return dir;
}

type Reload = () => Promise<void>;
async function player(dir: string, run: (page: Page, reload: Reload) => Promise<void>, { motion = false, width = 1600, height = 900 } = {}) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-panels-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion ? 'no-preference' : 'reduce', hasTouch: false });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.base}/pkg/p/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    const reload = async () => {
      await page.waitForTimeout(100);
      await page.reload();
      await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    };
    await run(page, reload);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
}
const go = async (page: Page, screen: string) => {
  await page.evaluate((id) => (window as PlayerWindow).__elabora.go(id), screen);
  await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
};
const gap = (page: Page, above: string, below: string) => page.evaluate(([a, b]) => {
  const top = (id: string) => document.querySelector(`[data-block="${id}"]`)!.getBoundingClientRect().top;
  return Math.round((top(b) - top(a)) * 10) / 10;
}, [above, below]);
// A press with the mouse where an element is (on a card, the flip button's cover takes it).
const press = async (page: Page, selector: string) => { const box = (await page.locator(selector).boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); };
const rendered = (page: Page, selector: string) => page.$eval(selector, (node) => node.getClientRects().length > 0);
const visited = (page: Page, block: string, hook: string) => page.$$eval(`[data-block="${block}"] [data-t-${hook}][data-t-visited]`, (nodes, name) => [...new Set(nodes.map((node) => node.getAttribute(`data-t-${name}`)))], hook);
const hint = (page: Page) => page.evaluate(() => {
  const node = document.querySelector('.t-continue-hint');
  return node?.hasAttribute('data-t-empty') ? '' : node?.textContent ?? null;
});

for (const slides of [false, true]) {
  const presentation = slides ? 'slides' : 'scroll';
  test(`panels (${presentation}): an accordion of visited panels, tabs in the room of the tallest, an accordion in a narrow slot`, { timeout: 240000 }, async () => {
    await player(panelsCourse({ slides }), async (page) => {
      await go(page, 'panneaux');
      // Accordion: native disclosures, one open at a time (allowMultiple false), visited once opened.
      assert.equal(await page.$eval('[data-block="p-acc"] .t-panels-prompt', (node) => node.textContent), 'Avant d’ouvrir chaque panneau, dites ce que fait cet équipement.');
      await page.click('[data-block="p-acc"] [data-t-details="routeur"] summary');
      await page.click('[data-block="p-acc"] [data-t-details="switch"] summary');
      assert.deepEqual(await page.$$eval('[data-block="p-acc"] details[open]', (nodes) => nodes.map((node) => node.getAttribute('data-t-details'))), ['switch']);
      await page.waitForFunction(() => document.querySelectorAll('[data-block="p-acc"] details[data-t-visited]').length === 2);
      assert.equal(await page.$eval('[data-block="p-acc"] [data-t-details="routeur"] img', (image) => image.getAttribute('alt')), 'Un routeur');
      // Tabs: roles, the first shown and visited once in view, arrow keys; nothing below moves.
      const still = await gap(page, 'p-tabs', 'p-after');
      assert.equal(await page.$eval('[data-block="p-tabs"] .t-panels-tablist', (node) => node.getAttribute('role')), 'tablist');
      assert.deepEqual(await visited(page, 'p-tabs', 'tab'), ['routeur']);
      assert.equal(await rendered(page, '[data-block="p-tabs"] .t-panels-narrow'), false, 'the accordion of the tabs is not rendered on a wide window');
      await page.click('[data-block="p-tabs"] [data-t-tab="switch"]');
      assert.equal(await gap(page, 'p-tabs', 'p-after'), still, 'the tallest panel keeps its room');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.$eval('[data-block="p-tabs"] [aria-selected="true"]', (tab) => tab.getAttribute('data-t-tab')), 'cable');
      assert.equal(await gap(page, 'p-tabs', 'p-after'), still);
      // The hidden panels keep their room and are out of reach.
      assert.deepEqual(await page.$$eval('[data-block="p-tabs"] [data-t-panel]', (nodes) => nodes.map((node) => getComputedStyle(node).visibility)), ['hidden', 'hidden', 'visible', 'hidden']);
      assert.deepEqual(await visited(page, 'p-tabs', 'tab'), ['routeur', 'switch', 'cable']);
      // In a slot narrower than 560 px, tabs are an accordion: the tabs are not rendered (nor in the
      // accessibility tree), and the first is not visited by being in view.
      assert.equal(await rendered(page, '[data-block="p-tabs-slot"] .t-panels-tabs'), false);
      assert.equal(await rendered(page, '[data-block="p-tabs-slot"] .t-panels-narrow'), true);
      assert.deepEqual(await visited(page, 'p-tabs-slot', 'tab'), []);
      const tree = await page.locator('[data-block="p-tabs-slot"]').ariaSnapshot();
      assert.doesNotMatch(tree, /tab/, tree);
      await page.click('[data-block="p-tabs-slot"] [data-t-details="switch"] summary');
      await page.waitForFunction(() => document.querySelector('[data-block="p-tabs-slot"] [data-t-tab="switch"]')?.hasAttribute('data-t-visited'));
    });
  });

  test(`cards and stack (${presentation}): turned by a press anywhere and the keyboard, rows as tall as the tallest card, one card at a time`, { timeout: 240000 }, async () => {
    await player(panelsCourse({ slides }), async (page) => {
      await go(page, 'cartes');
      const heights = await page.$$eval('[data-block="p-cards"] .t-panels-card', (cards) => cards.map((card) => Math.round(card.getBoundingClientRect().height)));
      assert.equal(new Set(heights).size, 1, `cards as tall as the tallest: ${heights}`);
      const still = await gap(page, 'p-cards', 'p-cards-after');
      // The button covers its face: a press on the title turns the card; the hint is its words.
      assert.equal(await page.$eval('[data-block="p-cards"] [data-t-face="front"] [data-t-flip="switch"]', (button) => button.textContent), 'Retourner la carte');
      await press(page, '[data-block="p-cards"] [data-t-card="switch"] .t-panels-title');
      assert.equal(await page.$eval('[data-t-card="switch"]', (card) => card.hasAttribute('data-t-flipped')), true);
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-t-face]')?.getAttribute('data-t-face')), 'back', 'focus on the face that shows');
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval('[data-t-card="switch"]', (card) => card.hasAttribute('data-t-flipped')), false);
      assert.equal(await gap(page, 'p-cards', 'p-cards-after'), still, 'turning moves nothing');
      assert.deepEqual(await visited(page, 'p-cards', 'card'), ['switch']);
      assert.equal(await page.$eval('[data-block="p-cards"] [data-t-card="cable"] img', (image) => image.getAttribute('alt')), '', 'alt "" is decorative');
      // Stack: one card at a time; Next, the position, the room of the tallest; hint false keeps the icon only.
      const stackStill = await gap(page, 'p-stack', 'p-stack-after');
      assert.equal(await page.$eval('[data-block="p-stack"] [data-t-position]', (node) => node.textContent), '1 / 4');
      assert.equal(await page.$eval('[data-block="p-stack"] [data-t-face="front"] [data-t-flip="routeur"]', (button) => parseFloat(getComputedStyle(button).fontSize)), 0);
      await page.click('[data-block="p-stack"] [data-t-next]');
      assert.equal(await page.$eval('[data-block="p-stack"] [data-t-sequence]', (node) => node.getAttribute('data-t-current')), 'switch');
      assert.equal(await gap(page, 'p-stack', 'p-stack-after'), stackStill);
      await press(page, '[data-block="p-stack"] [data-t-item="switch"] .t-panels-title');
      assert.equal(await page.$eval('[data-block="p-stack"] [data-t-card="switch"]', (card) => card.hasAttribute('data-t-flipped')), true);
      assert.equal(await gap(page, 'p-stack', 'p-stack-after'), stackStill, 'the tallest back keeps its room');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.$eval('[data-block="p-stack"] [data-t-sequence]', (node) => node.getAttribute('data-t-current')), 'cable');
    });
  });
}

test('cards on a phone: two to a row; tabs as an accordion; reduced motion: no slide, the tab panel shows without fading', { timeout: 240000 }, async () => {
  await player(panelsCourse(), async (page) => {
    await go(page, 'cartes');
    const lefts = await page.$$eval('[data-block="p-cards"] .t-panels-cell', (cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().left)));
    assert.equal(new Set(lefts).size, 2, `two columns: ${lefts}`);
    const page_ = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.equal(page_[0], page_[1], 'no sideways scroll');
    await go(page, 'panneaux');
    assert.equal(await rendered(page, '[data-block="p-tabs"] .t-panels-tabs'), false);
    assert.equal(await page.$eval('[data-block="p-tabs"] [data-t-panel="routeur"]', (node) => getComputedStyle(node).animationName), 'none');
  }, { width: 375, height: 812 });
});

test('explored steps name what is left: panels, tabs, cards, cards to see, images; visits resume, a stack opens on its first card', { timeout: 300000 }, async () => {
  await player(panelsCourse(), async (page, reload) => {
    await go(page, 'explore-panneaux');
    assert.equal(await hint(page), 'Il reste 4 panneaux à ouvrir.');
    await page.click('[data-block="x-acc"] [data-t-details="routeur"] summary');
    await page.waitForFunction(() => document.querySelector('.t-continue-hint')?.textContent === 'Il reste 3 panneaux à ouvrir.');
    await go(page, 'explore-onglets');
    assert.equal(await hint(page), 'Il reste 3 onglets à consulter.', 'the first tab is seen');
    await go(page, 'explore-cartes');
    assert.equal(await hint(page), 'Il reste 4 cartes à retourner.');
    await press(page, '[data-block="x-cards"] [data-t-card="poste"] .t-panels-title');
    assert.equal(await hint(page), 'Il reste 3 cartes à retourner.');
    await go(page, 'explore-pile');
    assert.equal(await hint(page), 'Il reste 3 cartes à voir.');
    await page.click('[data-block="x-stack"] [data-t-next]');
    await page.click('[data-block="x-stack"] [data-t-next]');
    assert.equal(await hint(page), 'Il reste 1 carte à voir.');
    await go(page, 'explore-galerie');
    assert.equal(await hint(page), 'Il reste 3 images à voir.');
    for (const name of ['switch', 'cable', 'poste']) await page.click(`[data-block="x-car"] [data-t-goto="${name}"]`);
    assert.equal(await hint(page), '');
    await reload();
    await go(page, 'explore-pile');
    assert.equal(await page.$eval('[data-block="x-stack"] [data-t-sequence]', (node) => node.getAttribute('data-t-current')), 'routeur', 'a stack reopens on its first card');
    assert.equal(await hint(page), 'Il reste 1 carte à voir.');
    await go(page, 'explore-cartes');
    assert.equal(await hint(page), 'Il reste 3 cartes à retourner.');
    assert.equal(await page.$eval('[data-t-card="poste"]', (card) => [card.hasAttribute('data-t-visited'), card.hasAttribute('data-t-flipped')].join()), 'true,false');
    await go(page, 'explore-panneaux');
    assert.equal(await hint(page), 'Il reste 3 panneaux à ouvrir.');
  });
});

test('explored tabs in a phone: the accordion they become counts panels', { timeout: 180000 }, async () => {
  await player(panelsCourse(), async (page) => {
    await go(page, 'explore-onglets');
    assert.equal(await hint(page), 'Il reste 4 panneaux à ouvrir.');
    await page.click('[data-block="x-tabs"] .t-panels-narrow [data-t-details="cable"] summary');
    await page.waitForFunction(() => document.querySelector('.t-continue-hint')?.textContent === 'Il reste 3 panneaux à ouvrir.');
  }, { width: 375, height: 812 });
});

for (const slides of [false, true]) {
  test(`gallery (${slides ? 'slides' : 'scroll'}): a carousel of whole images with thumbnails and the room of the tallest caption; zoom with previous and next`, { timeout: 240000 }, async () => {
    await player(panelsCourse({ slides }), async (page) => {
      await go(page, 'galerie');
      const still = await gap(page, 'g-car', 'g-car-after');
      const carousel = () => page.$eval('[data-block="g-car"] [data-t-sequence]', (box) => ({
        current: box.getAttribute('data-t-current'),
        shown: [...box.querySelectorAll<HTMLElement>('[data-t-item]')].filter((item) => !item.hidden).length,
        position: box.querySelector('[data-t-position]')?.textContent,
        thumb: box.querySelector('[data-t-goto][aria-current="true"]')?.getAttribute('aria-label')
      }));
      assert.deepEqual(await carousel(), { current: 'routeur', shown: 1, position: '1 / 4', thumb: '1 sur 4' });
      await page.click('[data-block="g-car"] [data-t-goto="switch"]');
      assert.deepEqual(await carousel(), { current: 'switch', shown: 1, position: '2 / 4', thumb: '2 sur 4' });
      assert.equal(await gap(page, 'g-car', 'g-car-after'), still, 'the longest caption has its room');
      await page.keyboard.press('ArrowRight');
      assert.equal((await carousel()).current, 'cable');
      // Zoom from the carousel: the lightbox goes through the gallery's four images.
      await page.click('[data-block="g-car"] [data-t-item="cable"] [data-t-zoom]');
      const lightbox = () => page.evaluate(() => {
        const dialog = document.querySelector('dialog.t-lightbox');
        return dialog && { label: dialog.getAttribute('aria-label'), caption: dialog.querySelector('.t-lightbox-caption')?.textContent, position: dialog.querySelector('.t-lightbox-position')?.textContent ?? null };
      });
      assert.deepEqual(await lightbox(), { label: 'Le câble', caption: 'Le câble.', position: '3 / 4' });
      await page.keyboard.press('ArrowRight');
      assert.equal((await lightbox())?.caption, 'Le poste de Marc.');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.t-lightbox'));
      // A grid's images, and an image block alone (no previous nor next).
      await page.click('[data-block="g-grid"] li:nth-child(2) [data-t-zoom]');
      assert.deepEqual(await lightbox(), { label: 'Le commutateur', caption: IMAGES[1].caption, position: '2 / 3' });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.t-lightbox'));
      await page.click('[data-block="g-img"] [data-t-zoom]');
      assert.deepEqual(await lightbox(), { label: 'Le poste', caption: 'Un poste, à agrandir.', position: null });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.t-lightbox'));
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-block]')?.getAttribute('data-block')), 'g-img');
    });
  });
}

test('carousel on a phone: arrows and the position without thumbnails, a swipe', { timeout: 180000 }, async () => {
  await player(panelsCourse(), async (page) => {
    await go(page, 'galerie');
    assert.equal(await rendered(page, '[data-block="g-car"] .t-gallery-thumbs'), false);
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>('[data-block="g-car"] .t-gallery-slides')!;
      const box = stage.getBoundingClientRect();
      const at = (type: string, dx: number) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: box.left + box.width / 2 + dx, clientY: box.top + 40 }));
      at('pointerdown', 0); at('pointermove', -40); at('pointerup', -90);
    });
    assert.equal(await page.$eval('[data-block="g-car"] [data-t-sequence]', (box) => box.getAttribute('data-t-current')), 'switch');
    const page_ = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.equal(page_[0], page_[1], 'no sideways scroll');
  }, { width: 375, height: 812 });
});

test('speech: the name written once and said with each line, a portrait at rest beside the bubbles, the initial without a look', { timeout: 180000 }, async () => {
  await player(panelsCourse(), async (page) => {
    await go(page, 'personnages');
    const speech = (id: string) => page.$eval(`[data-block="${id}"]`, (block) => ({
      name: block.querySelector('[data-t-speaker]')?.textContent,
      lines: [...block.querySelectorAll('[data-t-line]')].map((line) => line.textContent?.replace(/\s+/g, ' ').trim()),
      svg: !!block.querySelector('[data-t-portrait] svg.t-character-portrait'),
      initial: block.querySelector('[data-t-portrait] .t-character-initial')?.textContent ?? null,
      hidden: block.querySelector('[data-t-portrait]')?.getAttribute('aria-hidden'),
      still: !!block.querySelector('[data-part="character"][data-reduced-motion]'),
      moving: block.getAnimations({ subtree: true }).length,
      direction: getComputedStyle(block.querySelector('.t-speech')!).flexDirection
    }));
    assert.deepEqual(await speech('s-marc'), { name: 'Marc', lines: ['Marc : Bonjour ! Mon imprimante ne répond plus depuis ce matin.', 'Marc : J’ai déjà tout redémarré, deux fois.'], svg: true, initial: null, hidden: 'true', still: true, moving: 0, direction: 'row' });
    assert.equal((await speech('s-leila')).direction, 'row-reverse');
    assert.deepEqual({ ...(await speech('s-guide')), lines: [] }, { name: 'Claire, votre guide', lines: [], svg: false, initial: 'C', hidden: 'true', still: true, moving: 0, direction: 'row' });
    const tree = await page.locator('[data-block="s-marc"]').ariaSnapshot();
    assert.match(tree, /Marc : Bonjour/);
    assert.doesNotMatch(tree, /^- paragraph: Marc$/m, 'the visible name is not read twice');
  });
});
