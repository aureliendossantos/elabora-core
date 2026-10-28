import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { addStarterInteractions } from '../starter-interactions-fixture.ts';

// The starter interactions of D63 in Chrome: a steps block (« Étapes ») as a carousel, a timeline and
// a scroll whose figure follows the page (replace, build, focus), and an interactive picture
// (« Image interactive ») as popovers, beside or under the picture and as a tour. Keyboard, pointer and
// touch; rooms kept (nothing below moves) at 1600 × 900, 1280 × 720 and 375 px, in scroll and slides;
// narrow places (the numbered list, the steps' own pictures, a crop that keeps its markers in view);
// less motion; visits saved and resumed; and a step that waits for them, worded with their nouns.

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function course({ slides = false, explored = false }: { slides?: boolean; explored?: boolean } = {}): string {
  const dir = copyExample();
  addStarterInteractions(dir, { slides });
  if (explored) {
    // A screen whose step 2 waits for the markers, the steps of a carousel and a timeline's events above it.
    const carousel = readJSON(dir, 'screens/etapes-carrousel.json').blocks[0];
    const timeline = readJSON(dir, 'screens/etapes-frise.json').blocks[0];
    const picture = readJSON(dir, 'screens/image-repere.json').blocks[0];
    writeJSON(dir, 'screens/image-repere.json', { ...readJSON(dir, 'screens/image-repere.json'), steps: { 2: { opens: 'explored' } }, blocks: [
      picture, { ...carousel, id: 'explore-carousel' }, { ...timeline, id: 'explore-timeline' },
      { id: 'explore-next', type: 'text', step: 2, props: { markdown: 'La suite.' } }
    ] });
  }
  return dir;
}

interface Options { motion?: boolean; touch?: boolean; width?: number; height?: number }
type Reload = () => Promise<void>;
async function player(dir: string, run: (page: Page, reload: Reload) => Promise<void>, { motion = true, touch = false, width = 1600, height = 900 }: Options = {}) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-interactions-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion ? 'no-preference' : 'reduce', hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
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
const sized = async (page: Page, width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
// Where the text after a block starts, from the block's top: what must not change while the learner uses it.
const gap = (page: Page, block: string) => page.evaluate((id) => {
  const top = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().top;
  return Math.round((top(`[data-block="${id}-apres"]`) - top(`[data-block="${id}-bloc"]`)) * 10) / 10;
}, block);
const box = (page: Page, selector: string) => page.$eval(selector, (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });
const visited = (page: Page, block: string, hook: string) => page.$$eval(`[data-block="${block}"] [data-t-${hook}][data-t-visited]`, (nodes, name) => [...new Set(nodes.map((node) => node.getAttribute(`data-t-${name}`)))], hook);
const shown = (page: Page, block: string) => page.$eval(`[data-block="${block}"] [data-t-sequence]`, (node) => node.getAttribute('data-t-current'));

for (const slides of [false, true]) {
  test(`steps carousel (${slides ? 'slides' : 'scroll'}): the intro, the steps and the summary one at a time in the room of the tallest at 1600, 1280 and 375`, { timeout: 300000 }, async () => {
    await player(course({ slides }), async (page) => {
      await go(page, 'etapes-carrousel');
      const block = 'etapes-carrousel-bloc';
      assert.equal(await shown(page, block), 'intro');
      assert.equal(await page.$eval(`[data-block="${block}"] .t-steps-start`, (node) => node.textContent), 'Commencer');
      assert.equal(await page.$eval(`[data-block="${block}"] [data-t-position]`, (node) => node.textContent), '1 / 7');
      for (const [width, height] of [[1600, 900], [1280, 720], [375, 812]]) {
        await sized(page, width, height);
        await page.click(`[data-block="${block}"] [data-t-goto="intro"]`, { force: true }).catch(() => undefined);
        await page.evaluate((id) => document.querySelector<HTMLElement>(`[data-block="${id}"] [data-t-prev]`)!.click(), block);
        const still = await gap(page, 'etapes-carrousel');
        for (let i = 0; i < 7; i++) {
          assert.equal(await gap(page, 'etapes-carrousel'), still, `${width}: nothing below moves at item ${i + 1}`);
          await page.evaluate((id) => document.querySelector<HTMLElement>(`[data-block="${id}"] .t-steps-nav [data-t-next]`)!.click(), block);
        }
        assert.equal(await shown(page, block), 'summary', `${width}: the summary at the end`);
        for (let i = 0; i < 6; i++) await page.evaluate((id) => document.querySelector<HTMLElement>(`[data-block="${id}"] [data-t-prev]`)!.click(), block);
      }
      await sized(page, 1600, 900);
      // Start goes to the first step; arrow keys inside; the steps' buttons in the nav, named by their titles.
      await page.click(`[data-block="${block}"] .t-steps-start`);
      assert.equal(await shown(page, block), 'poste');
      assert.equal(await page.$eval(`[data-block="${block}"] [data-t-goto="routeur"]`, (node) => node.getAttribute('aria-label')), 'Le routeur oriente');
      await page.focus(`[data-block="${block}"] [data-t-goto="poste"]`);
      await page.keyboard.press('ArrowRight');
      assert.equal(await shown(page, block), 'commutateur');
      await page.keyboard.press('End');
      assert.equal(await shown(page, block), 'summary');
      assert.deepEqual((await visited(page, block, 'item')).sort(), ['commutateur', 'intro', 'pare-feu', 'poste', 'routeur', 'serveur', 'summary'], 'every item seen along the way');
      // The number of a step, decorative; the intro and the summary have none.
      assert.deepEqual(await page.$$eval(`[data-block="${block}"] .t-steps-number`, (nodes) => nodes.map((node) => node.textContent)), ['1', '2', '3', '4', '5']);
    });
  });
}

test('steps carousel on touch: a swipe moves between the steps', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    await go(page, 'etapes-carrousel');
    const block = 'etapes-carrousel-bloc';
    const swipe = (dx: number) => page.evaluate(([id, x]) => {
      const stage = document.querySelector<HTMLElement>(`[data-block="${id}"] .t-steps-items`)!;
      const r = stage.getBoundingClientRect();
      const at = (type: string, offset: number) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: r.left + r.width / 2 + offset, clientY: r.top + 40 }));
      at('pointerdown', 0);
      at('pointerup', Number(x));
    }, [block, dx] as const);
    await swipe(-120);
    assert.equal(await shown(page, block), 'poste');
    await swipe(120);
    assert.equal(await shown(page, block), 'intro');
  }, { touch: true, width: 375, height: 812 });
});

test('steps timeline: each event visited once in view, its dot filled; the date above the words on a phone', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    await sized(page, 1280, 520);
    await go(page, 'etapes-frise');
    const block = 'etapes-frise-bloc';
    const first = await visited(page, block, 'reveal');
    assert.ok(first.length >= 1 && first.length < 5, JSON.stringify(first));
    await page.$eval('[data-t-reveal="serveur"]', (node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForFunction((id) => document.querySelectorAll(`[data-block="${id}"] [data-t-reveal][data-t-visited]`).length === 5, block);
    // The dot fills once seen (a colour that changes, nothing that moves).
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-t-reveal="serveur"]')!, '::after').backgroundColor !== 'rgb(255, 255, 255)', undefined, { timeout: 30000 });
    // Wide: the date before the line; on a phone, above the title.
    const date = await box(page, '[data-t-reveal="poste"] .t-steps-date');
    const title = await box(page, '[data-t-reveal="poste"] .t-steps-title');
    assert.ok(date.right < title.left, `date before the words ${JSON.stringify({ date, title })}`);
    await sized(page, 375, 812);
    const small = await box(page, '[data-t-reveal="poste"] .t-steps-date');
    const below = await box(page, '[data-t-reveal="poste"] .t-steps-title');
    assert.ok(small.bottom <= below.top + 1 && Math.abs(small.left - below.left) < 2, `date above the title ${JSON.stringify({ small, below })}`);
    const page_ = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(page_.scroll, page_.client, 'no sideways scroll');
  });
});

// The scroll steps: what the figure shows (the opacity of each layer or region) and which step is current.
const figure = (page: Page, block: string) => page.evaluate((id) => {
  const root = document.querySelector<HTMLElement>(`[data-block="${id}"] .t-steps--scroll`)!;
  const stage = root.querySelector<HTMLElement>('.t-steps-stage')!;
  const parts = [...root.querySelectorAll<HTMLElement>('.t-steps-frame :is(.t-steps-layer, .t-steps-region)')];
  return {
    following: root.hasAttribute('data-t-following'), current: root.getAttribute('data-t-current'), stage: getComputedStyle(stage).display !== 'none',
    stageTop: stage.getBoundingClientRect().top, shown: parts.map((part) => Math.round(Number(getComputedStyle(part).opacity) * 10) / 10),
    own: [...root.querySelectorAll<HTMLElement>('.t-steps-own')].filter((own) => own.getBoundingClientRect().height > 2).length
  };
}, block);
// Scrolls the page so that a step's top is just above the middle of the window, then waits out the fades.
// The observer tells the player soon after a scroll; the fades are then waited out (a loaded computer may be slow).
const reach = async (page: Page, step: string) => {
  await page.$eval(`[data-t-reveal="${step}"]`, (node) => window.scrollBy(0, node.getBoundingClientRect().top - innerHeight / 2 + 40));
  await page.waitForFunction((name) => document.querySelector(`[data-t-reveal="${name}"]`)?.closest('[data-t-follow]')?.getAttribute('data-t-current') === name, step, { timeout: 30000 });
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished.catch(() => undefined))));
};

test('steps scroll (replace): native scroll, the figure stays in view and shows the step crossing the middle; each step visited', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    await go(page, 'etapes-defile');
    const block = 'etapes-defile-bloc';
    let seen = await figure(page, block);
    assert.deepEqual([seen.following, seen.current, seen.stage, seen.own], [true, 'poste', true, 0]);
    assert.equal(seen.shown[0], 1);
    for (const [index, step] of ['commutateur', 'routeur', 'pare-feu', 'serveur'].entries()) {
      await reach(page, step);
      seen = await figure(page, block);
      assert.equal(seen.current, step);
      assert.deepEqual(seen.shown, [1, 1, 1, 1, 1].map((_, layer) => (layer <= index + 1 ? 1 : 0)), `${step}: the layers up to it shown, each over the one before`);
      assert.ok(seen.stageTop >= 0 && seen.stageTop < 120, `the figure stays in view (${seen.stageTop})`);
    }
    // Back up: the figure goes back with the page.
    await reach(page, 'commutateur');
    assert.equal((await figure(page, block)).current, 'commutateur');
    assert.deepEqual((await visited(page, block, 'reveal')).sort(), ['commutateur', 'pare-feu', 'poste', 'routeur', 'serveur']);
    // Screen readers keep each step's picture with its step (the figure is hidden from them).
    assert.equal(await page.$eval(`[data-block="${block}"] .t-steps-stage`, (node) => node.getAttribute('aria-hidden')), 'true');
    assert.equal(await page.$$eval(`[data-block="${block}"] .t-steps-own img[alt^="Le chemin"]`, (nodes) => nodes.length), 5);
  });
});

test('steps scroll (build and focus): the layers stack up to the current step; the current step\'s region alone is outlined', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    await go(page, 'etapes-construire');
    await reach(page, 'routeur');
    let seen = await figure(page, 'etapes-construire-bloc');
    assert.equal(seen.current, 'routeur');
    assert.deepEqual(seen.shown, [1, 1, 1, 0, 0]);
    // The figure sits before the text (side start).
    assert.ok((await box(page, '[data-block="etapes-construire-bloc"] .t-steps-stage')).right <= (await box(page, '[data-block="etapes-construire-bloc"] .t-steps-list')).left + 1);
    await go(page, 'etapes-zoom');
    await reach(page, 'pare-feu');
    seen = await figure(page, 'etapes-zoom-bloc');
    assert.equal(seen.current, 'pare-feu');
    assert.deepEqual(seen.shown, [0, 0, 0, 1, 0]);
    // The region outlines its part of the picture: x, y, w, h of the whole picture.
    const frame = await box(page, '[data-block="etapes-zoom-bloc"] .t-steps-frame');
    const region = await page.$$eval('[data-block="etapes-zoom-bloc"] .t-steps-frame .t-steps-region', (nodes) => { const r = nodes[3].getBoundingClientRect(); return { left: r.left, width: r.width }; });
    assert.ok(Math.abs(region.left - (frame.left + 0.6 * frame.width)) < 2 && Math.abs(region.width - 0.2 * frame.width) < 2, JSON.stringify({ frame, region }));
  });
});

for (const [name, options] of [['a phone', { width: 375, height: 812 }], ['less motion', { motion: false }]] as const) {
  test(`steps scroll with ${name}: no following figure, each step with its own picture`, { timeout: 180000 }, async () => {
    await player(course(), async (page) => {
      for (const screen of ['etapes-defile', 'etapes-construire', 'etapes-zoom']) {
        await go(page, screen);
        const seen = await figure(page, `${screen}-bloc`);
        assert.deepEqual([seen.stage, seen.own], [false, 5], screen);
      }
    }, options);
  });
}

test('steps scroll in slides: its steps one under the other, each with its picture, and a warning', { timeout: 180000 }, async () => {
  const dir = course({ slides: true });
  await player(dir, async (page) => {
    await go(page, 'etapes-construire');
    const seen = await figure(page, 'etapes-construire-bloc');
    assert.deepEqual([seen.stage, seen.own], [false, 5]);
    const stacks = await page.$$eval('[data-block="etapes-construire-bloc"] .t-steps-own .t-steps-stack', (nodes) => nodes.map((stack) => [...stack.querySelectorAll('.t-steps-layer')].map((layer) => Number(getComputedStyle(layer).opacity))));
    assert.deepEqual(stacks.map((layers) => layers.filter(Boolean).length), [1, 2, 3, 4, 5], 'step n shows layers 1 to n');
  });
});

test('interactive picture (popover): markers named « 1. title », one panel open by its marker inside the picture, Escape and a press outside close it, nothing moves', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    await go(page, 'image-repere');
    const block = 'image-repere-bloc';
    const open = () => page.$$eval(`[data-block="${block}"] [data-t-part]`, (parts) => parts.filter((part) => !(part as HTMLElement).hidden).map((part) => part.getAttribute('data-t-part')));
    assert.deepEqual(await page.$$eval(`[data-block="${block}"] .t-hotspots-marker`, (nodes) => nodes.map((node) => node.getAttribute('aria-label'))), ['1. L’écran', '2. Le voyant', '3. Le câble', '4. L’imprimante']);
    for (const marker of await page.$$(`[data-block="${block}"] .t-hotspots-marker`)) {
      const size = await marker.boundingBox();
      assert.ok(size && size.width >= 44 && size.height >= 44, JSON.stringify(size));
    }
    const still = await gap(page, 'image-repere');
    const picture = await box(page, `[data-block="${block}"] .t-hotspots-frame`);
    for (const id of ['ecran', 'boitier', 'cable', 'imprimante']) {
      await page.click(`[data-block="${block}"] [data-t-toggle="${id}"]`);
      assert.deepEqual(await open(), [id]);
      await page.waitForTimeout(260);
      const panel = await box(page, `[data-t-part="${id}"]`);
      assert.ok(panel.left >= picture.left - 0.5 && panel.right <= picture.right + 0.5 && panel.top >= picture.top - 0.5 && panel.bottom <= picture.bottom + 0.5, `${id}: inside the picture ${JSON.stringify({ panel, picture })}`);
      assert.equal(await gap(page, 'image-repere'), still, `${id}: nothing moves`);
      // A panel may cover another marker: a marker with the focus comes over it (WCAG 2.4.11).
      if (id !== 'imprimante') await page.keyboard.press('Escape');
    }
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-t-toggle')), 'cable');
    const covered = await page.evaluate(() => { const r = document.activeElement!.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-t-toggle]')?.getAttribute('data-t-toggle'); });
    assert.equal(covered, 'cable', 'the focused marker is not hidden under the panel');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    assert.deepEqual(await open(), []);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-t-toggle')), 'imprimante', 'focus back on its marker');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    assert.deepEqual(await open(), ['cable'], 'from the keyboard');
    await page.mouse.click(30, 600);
    assert.deepEqual(await open(), [], 'a press outside closes it');
    assert.deepEqual((await visited(page, block, 'toggle')).sort(), ['boitier', 'cable', 'ecran', 'imprimante']);
    assert.equal(await page.evaluate(() => scrollY), 0, 'nothing scrolled the page');
  });
});

test('interactive picture (side, below): the texts share one place, the longest\'s room kept; the hint until one is open', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    for (const screen of ['image-cote', 'image-dessous']) {
      for (const [width, height] of [[1600, 900], [1280, 720]]) {
        await sized(page, width, height);
        await go(page, screen);
        const block = `${screen}-bloc`;
        const still = await gap(page, screen);
        assert.equal(await page.$eval(`[data-block="${block}"] .t-hotspots-hint`, (node) => [node.textContent, getComputedStyle(node).visibility].join()), 'Choisissez un repère sur l’image.,visible');
        for (const id of ['ecran', 'boitier', 'cable', 'imprimante']) {
          await page.click(`[data-block="${block}"] [data-t-toggle="${id}"]`);
          assert.equal(await gap(page, screen), still, `${screen} ${width}: nothing moves (${id})`);
        }
        assert.equal(await page.$eval(`[data-block="${block}"] .t-hotspots-hint`, (node) => getComputedStyle(node).visibility), 'hidden');
      }
    }
    // side: the text beside the picture on a wide window.
    await sized(page, 1600, 900);
    await go(page, 'image-cote');
    assert.ok((await box(page, '[data-block="image-cote-bloc"] .t-hotspots-frame')).right < (await box(page, '[data-block="image-cote-bloc"] .t-hotspots-room')).left);
  });
});

test('interactive picture (tour): the markers in order, Previous and Next, a marker goes to its text, the room of the longest', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    await go(page, 'image-visite');
    const block = 'image-visite-bloc';
    const still = await gap(page, 'image-visite');
    assert.equal(await shown(page, block), 'ecran');
    assert.equal(await page.$eval(`[data-block="${block}"] [data-t-goto="ecran"]`, (node) => node.getAttribute('aria-current')), 'true');
    await page.click(`[data-block="${block}"] [data-t-next]`);
    assert.equal(await shown(page, block), 'boitier');
    await page.click(`[data-block="${block}"] [data-t-goto="imprimante"]`);
    assert.equal(await shown(page, block), 'imprimante');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await shown(page, block), 'cable');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-t-goto')), 'cable', 'the focus goes with the marker');
    assert.equal(await gap(page, 'image-visite'), still);
    assert.deepEqual((await visited(page, block, 'item')).sort(), ['boitier', 'cable', 'ecran', 'imprimante']);
  });
});

test('interactive picture on a phone: a numbered list under the picture, entries visited once seen, markers kept in the cropped picture; touch', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    await go(page, 'image-repere');
    const block = 'image-repere-bloc';
    const frame = await box(page, `[data-block="${block}"] .t-hotspots-frame`);
    const picture = await box(page, `[data-block="${block}"] .t-hotspots-picture`);
    assert.ok(Math.abs(picture.width - 1.5 * frame.width) < 2, `a focal point: half as large again ${JSON.stringify({ picture, frame })}`);
    for (const marker of await page.$$(`[data-block="${block}"] .t-hotspots-marker`)) {
      const at = (await marker.boundingBox())!;
      assert.ok(at.x >= frame.left - 0.5 && at.x + at.width <= frame.right + 0.5, `a marker the crop would leave out stays at the edge ${JSON.stringify({ at, frame })}`);
    }
    // Every text shows as a list under the picture.
    const entries = await page.$$eval(`[data-block="${block}"] .t-hotspots-panel`, (nodes) => nodes.map((node) => node.getBoundingClientRect().height > 20));
    assert.deepEqual(entries, [true, true, true, true]);
    assert.ok((await box(page, `[data-t-part="ecran"]`)).top >= frame.bottom - 0.5);
    await page.$eval('[data-t-part="imprimante"]', (node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForFunction((id) => document.querySelectorAll(`[data-block="${id}"] [data-t-reveal][data-t-visited]`).length === 4, block);
    // A tap on a marker lights its entry.
    await page.$eval(`[data-block="${block}"] .t-hotspots-frame`, (node) => node.scrollIntoView({ block: 'center' }));
    await page.tap(`[data-block="${block}"] [data-t-toggle="cable"]`);
    assert.equal(await page.$eval('[data-t-part="cable"]', (node) => getComputedStyle(node).boxShadow.includes('inset')), true);
    const page_ = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(page_.scroll, page_.client, 'no sideways scroll');
  }, { width: 375, height: 812, touch: true });
});

test('explored step: Continue says what is left in markers, steps and events; visits resume', { timeout: 180000 }, async () => {
  await player(course({ explored: true }), async (page, reload) => {
    await sized(page, 1600, 600);
    await go(page, 'image-repere');
    const hint = () => page.$eval('.t-continue-hint', (node) => (node.hasAttribute('data-t-empty') ? '' : node.textContent));
    const first = await hint();
    assert.match(first ?? '', /^Il reste 6 étapes à voir\. Il reste \d événements? à voir\. Il reste 4 repères à ouvrir\.$/);
    for (const id of ['ecran', 'boitier', 'cable']) await page.click(`[data-block="image-repere-bloc"] [data-t-toggle="${id}"]`);
    await page.keyboard.press('Escape');
    assert.match((await hint()) ?? '', /^Il reste 6 étapes à voir\..* Il reste 1 repère à ouvrir\.$/);
    await reload();
    await go(page, 'image-repere');
    assert.match((await hint()) ?? '', /Il reste 1 repère à ouvrir\.$/, 'the markers opened are kept');
    await page.click('[data-block="image-repere-bloc"] [data-t-toggle="imprimante"]');
    await page.keyboard.press('Escape');
    await page.$eval('[data-block="explore-carousel"]', (node) => node.scrollIntoView({ block: 'center' }));
    await page.click('[data-block="explore-carousel"] [data-t-goto="summary"]');
    assert.match((await hint()) ?? '', /^Il reste 5 étapes à voir\./, 'the steps jumped over are still to see');
    for (const id of ['poste', 'commutateur', 'routeur', 'pare-feu', 'serveur']) await page.click(`[data-block="explore-carousel"] [data-t-goto="${id}"]`);
    await page.$eval('[data-block="explore-timeline"] [data-t-reveal="serveur"]', (node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => document.querySelector('.t-continue-hint')?.hasAttribute('data-t-empty'));
    assert.equal(await page.$eval('.t-continue-btn', (node) => node.getAttribute('aria-disabled')), null);
  });
});
