import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';

// The primitives of D63 in Chrome, on a small course with a component per primitive
// (test/fixtures/primitives): one item at a time, flip cards, the lightbox, exclusive popovers,
// details and reveals; keyboard and pointer; visited marks saved and restored; rooms that keep the
// page still; reduced motion; and the Continue of a step that waits for exploration.

const FIXTURE = path.join(ROOT, 'test/fixtures/primitives');
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function course({ slides = false } = {}): string {
  const dir = copyExample(FIXTURE);
  if (slides) {
    const data = readJSON(dir, 'course.json');
    data.presentation = { mode: 'slides' };
    writeJSON(dir, 'course.json', data);
  }
  return dir;
}

type Reload = () => Promise<void>;
async function player(dir: string, run: (page: Page, reload: Reload) => Promise<void>, { motion = true }: { motion?: boolean } = {}) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-primitives-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: motion ? 'no-preference' : 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.base}/pkg/p/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    // The learner's progress is kept in the tab (a package outside an LMS): a reload resumes it.
    const reload = async () => {
      await page.waitForTimeout(100); // the state is saved soon after a change
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
// The vertical distance between two blocks: what must not change while the learner uses the first.
const gap = (page: Page, above: string, below: string) => page.evaluate(([a, b]) => {
  const top = (id: string) => document.querySelector(`[data-block="${id}"]`)!.getBoundingClientRect().top;
  return Math.round((top(b) - top(a)) * 10) / 10;
}, [above, below]);
const sequence = (page: Page, block: string) => page.evaluate((id) => {
  const box = document.querySelector<HTMLElement>(`[data-block="${id}"] [data-t-sequence]`)!;
  return {
    current: box.getAttribute('data-t-current'),
    shown: [...box.querySelectorAll<HTMLElement>('[data-t-item]')].filter((item) => !item.hidden).map((item) => item.getAttribute('data-t-item')),
    position: box.querySelector('[data-t-position]')?.textContent,
    goto: box.querySelector('[data-t-goto][aria-current="true"]')?.getAttribute('data-t-goto'),
    previous: box.querySelector('[data-t-prev]')?.getAttribute('aria-disabled') === 'true',
    next: box.querySelector('[data-t-next]')?.getAttribute('aria-disabled') === 'true',
    visited: [...box.querySelectorAll('[data-t-item][data-t-visited]')].map((item) => item.getAttribute('data-t-item'))
  };
}, block);
// A swipe on touch, as pointer events (Playwright's touchscreen only taps).
const swipe = (page: Page, block: string, dx: number, dy = 0) => page.evaluate(([id, x, y]) => {
  const stage = document.querySelector<HTMLElement>(`[data-block="${id}"] [data-t-item]`)!.parentElement!;
  const box = stage.getBoundingClientRect();
  const at = (type: string, offsetX: number, offsetY: number) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: box.left + box.width / 2 + offsetX, clientY: box.top + 40 + offsetY }));
  at('pointerdown', 0, 0);
  at('pointermove', Number(x) / 2, Number(y) / 2);
  at('pointerup', Number(x), Number(y));
}, [block, dx, dy] as const);

for (const slides of [false, true]) {
  const presentation = slides ? 'slides' : 'scroll';
  test(`sequence (${presentation}): Previous, Next, goto, arrow keys and swipes show one item at a time in the room of the tallest`, { timeout: 300000 }, async () => {
    await player(course({ slides }), async (page) => {
      await go(page, 'sequence');
      const still = await gap(page, 'marks', 'sequence-after');
      const room = await page.$eval('[data-block="marks"] .pr-seq-items', (node) => node.getBoundingClientRect().height);
      // The tallest item (fronts, three paragraphs) fills the room it reserves.
      const tallest = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('[data-block="marks"] .pr-seq-items')!;
        return Math.max(...[...stage.querySelectorAll<HTMLElement>('[data-t-item]')].map((item) => { const hidden = item.hidden; item.hidden = false; const height = item.getBoundingClientRect().height; item.hidden = hidden; return height; }));
      });
      assert.ok(room >= tallest - 0.5, `room ${room} for the tallest item ${tallest}`);
      assert.deepEqual(await sequence(page, 'marks'), { current: 'isobars', shown: ['isobars'], position: '1 / 4', goto: 'isobars', previous: true, next: false, visited: ['isobars'] }, 'the first item, visited once its block is in view');
      assert.equal(await page.$eval('[data-block="marks"] [data-t-item="fronts"]', (node) => node.getAttribute('aria-label')), '2 of 4');
      assert.equal(await page.$eval('[data-block="marks"] [data-t-sequence]', (node) => node.getAttribute('aria-roledescription')), 'carousel');
      assert.deepEqual(await page.$$eval('[data-block="marks"] [data-t-prev], [data-block="marks"] [data-t-next]', (nodes) => nodes.map((node) => node.getAttribute('aria-label'))), ['Previous item', 'Next item'], 'icon buttons named by the labels');
      // Next with the pointer: the tallest item; nothing below moves.
      await page.click('[data-block="marks"] [data-t-next]');
      assert.deepEqual((await sequence(page, 'marks')).shown, ['fronts']);
      assert.equal(await gap(page, 'marks', 'sequence-after'), still);
      // Arrow keys inside it; Home and End; the ends keep their buttons in reach.
      await page.keyboard.press('ArrowRight');
      assert.equal((await sequence(page, 'marks')).current, 'pressure');
      await page.keyboard.press('End');
      assert.deepEqual(await sequence(page, 'marks'), { current: 'wind', shown: ['wind'], position: '4 / 4', goto: 'wind', previous: false, next: true, visited: ['isobars', 'fronts', 'pressure', 'wind'] });
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-t-next')), true, 'focus stays on Next, now at the end');
      await page.keyboard.press('Enter');
      assert.equal((await sequence(page, 'marks')).current, 'wind', 'Next at the end does nothing');
      await page.keyboard.press('Home');
      assert.equal((await sequence(page, 'marks')).current, 'isobars');
      // A goto button; arrow keys from it move the focus with the item.
      await page.click('[data-block="marks"] [data-t-goto="pressure"]');
      assert.equal((await sequence(page, 'marks')).current, 'pressure');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-t-goto')), 'fronts');
      // A swipe on touch: to the left for the next item; a mostly vertical movement scrolls instead.
      await swipe(page, 'marks', -90);
      assert.equal((await sequence(page, 'marks')).current, 'pressure');
      await swipe(page, 'marks', 90);
      assert.equal((await sequence(page, 'marks')).current, 'fronts');
      await swipe(page, 'marks', -50, 80);
      await swipe(page, 'marks', -20);
      assert.equal((await sequence(page, 'marks')).current, 'fronts', 'too vertical, or too short: not a swipe');
      assert.equal(await gap(page, 'marks', 'sequence-after'), still, 'nothing moved through it all');
      // Captures and fit checks see the tallest item.
      await page.click('[data-block="marks"] [data-t-goto="isobars"]');
      await page.evaluate(() => (window as unknown as { __elabora: { showAnswered(): unknown } }).__elabora.showAnswered());
      assert.equal((await sequence(page, 'marks')).current, 'fronts');
    });
  });
}

test('flip cards: the button turns the card, the face away is out of reach, the card keeps the room of its taller face', { timeout: 300000 }, async () => {
  for (const slides of [false, true]) {
    await player(course({ slides }), async (page) => {
      await go(page, 'sequence');
      const card = (name: string) => page.evaluate((id) => {
        const node = document.querySelector<HTMLElement>(`[data-t-card="${id}"]`)!;
        const face = (side: string) => node.querySelector<HTMLElement>(`[data-t-face="${side}"]`)!;
        return { flipped: node.hasAttribute('data-t-flipped'), frontInert: face('front').inert, backInert: face('back').inert, backHidden: face('back').getAttribute('aria-hidden'), height: Math.round(node.getBoundingClientRect().height), button: document.querySelector(`[data-t-flip="${id}"]`)?.textContent, visited: node.hasAttribute('data-t-visited') };
      }, name);
      const still = await gap(page, 'fronts-cards', 'sequence-after');
      const before = await card('warm');
      assert.deepEqual({ ...before, height: 0 }, { flipped: false, frontInert: false, backInert: true, backHidden: 'true', height: 0, button: 'Turn the card over', visited: false });
      // Its taller face (the back) sets its height from the start.
      const backHeight = await page.$eval('[data-t-card="warm"] [data-t-face="back"] .t-text', (node) => node.getBoundingClientRect().height);
      assert.ok(before.height >= backHeight, `${before.height} ≥ ${backHeight}`);
      await page.click('[data-t-flip="warm"]');
      const after = await card('warm');
      assert.deepEqual({ ...after, height: 0 }, { flipped: true, frontInert: true, backInert: false, backHidden: null, height: 0, button: 'Show the front', visited: true });
      assert.equal(after.height, before.height, 'turning moves nothing');
      assert.equal(await gap(page, 'fronts-cards', 'sequence-after'), still);
      // The keyboard turns it back; the button is described by the front.
      await page.focus('[data-t-flip="warm"]');
      await page.keyboard.press('Enter');
      assert.equal((await card('warm')).flipped, false);
      assert.equal(await page.$eval('[data-t-flip="warm"]', (button) => document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent?.trim()), 'Warm front');
    });
  }
});

test('reduced motion: a sequence fades without sliding, a flip card cross-fades', { timeout: 300000 }, async () => {
  const motion = async (reduce: boolean) => {
    let seen: { slide: string[]; face: { rotate: string; transition: string; opacity: string } } | null = null;
    await player(course(), async (page) => {
      await go(page, 'sequence');
      // What the item that comes does: the keyframes of its animation.
      await page.evaluate(() => {
        const original = Element.prototype.animate;
        (window as unknown as { keyframes: string[] }).keyframes = [];
        Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
          if (this.hasAttribute('data-t-item')) (window as unknown as { keyframes: string[] }).keyframes.push(...(Array.isArray(frames) ? frames.map((frame) => String(frame.translate ?? '')) : []));
          return original.call(this, frames, options);
        };
      });
      await page.click('[data-block="marks"] [data-t-next]');
      await page.click('[data-t-flip="cold"]');
      // The turn (or the fade) settled.
      await page.evaluate(() => Promise.all(document.querySelector('[data-t-card="cold"]')!.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      const slide = await page.evaluate(() => (window as unknown as { keyframes: string[] }).keyframes);
      const face = await page.$eval('[data-t-card="cold"] [data-t-face="front"]', (node) => { const style = getComputedStyle(node); return { rotate: style.rotate, transition: style.transitionProperty, opacity: style.opacity }; });
      seen = { slide, face };
    }, { motion: !reduce });
    return seen!;
  };
  const full = await motion(false);
  assert.deepEqual(full.slide, ['24px 0', '0 0'], 'Next: the item comes in from the right');
  assert.equal(full.face.rotate, 'y -180deg', 'the front turns away');
  const reduced = await motion(true);
  assert.deepEqual(reduced.slide, ['0px 0', '0 0'], 'a fade, without sliding');
  assert.equal(reduced.face.rotate, 'none');
  assert.equal(reduced.face.opacity, '0', 'the front fades out');
  assert.match(reduced.face.transition, /opacity/);
});

test('lightbox: the image at full size with its caption, focus kept in it, previous and next, Escape gives the focus back', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    await go(page, 'images');
    const lightbox = () => page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>('dialog.t-lightbox');
      return dialog && { open: dialog.open, modal: dialog.matches(':modal'), label: dialog.getAttribute('aria-label'), caption: dialog.querySelector('.t-lightbox-caption')?.textContent, position: dialog.querySelector('.t-lightbox-position')?.textContent, src: dialog.querySelector('img')?.getAttribute('src'), focus: document.activeElement?.className };
    });
    assert.equal(await page.$eval('[data-block="drawings"] [data-t-zoom]', (button) => [button.getAttribute('aria-haspopup'), button.textContent?.trim()].join(' ')), 'dialog Enlarge the image');
    await page.click('[data-block="drawings"] li:nth-child(2) [data-t-zoom]');
    const opened = await lightbox();
    assert.deepEqual({ ...opened, src: undefined }, { open: true, modal: true, label: 'A cold front, its triangles pointing east', caption: 'A cold front moving east.', position: '2 / 3', src: undefined, focus: 't-icon-btn t-lightbox-next' });
    assert.match(opened?.src ?? '', /front.*\.svg$/);
    // Arrow keys and the buttons move between the images of the block.
    await page.keyboard.press('ArrowRight');
    assert.equal((await lightbox())?.caption, 'Thirty knots from the south-west.');
    assert.equal(await page.$eval('.t-lightbox-next', (button) => button.getAttribute('aria-disabled')), 'true');
    await page.click('.t-lightbox-previous');
    await page.click('.t-lightbox-previous');
    assert.equal((await lightbox())?.position, '1 / 3');
    // Tab stays in it, both ways.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest('dialog.t-lightbox')), `Tab ${i + 1} stays in the lightbox`);
    }
    await page.keyboard.press('Shift+Tab');
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest('dialog.t-lightbox')));
    await page.keyboard.press('ArrowRight');
    // Escape closes it; focus goes back to the button of the image shown (the second).
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.t-lightbox'));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-block="drawings"] [data-t-zoom]')].indexOf(document.activeElement!)), 1);
    // Close gives it back too.
    await page.click('[data-block="drawings"] li:nth-child(3) [data-t-zoom]');
    await page.click('.t-lightbox-close');
    await page.waitForFunction(() => !document.querySelector('dialog.t-lightbox'));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-block="drawings"] [data-t-zoom]')].indexOf(document.activeElement!)), 2);
  });
});

test('exclusive popovers: one open at a time, Escape and a press outside close it, nothing moves', { timeout: 180000 }, async () => {
  await player(course(), async (page) => {
    await go(page, 'images');
    const open = () => page.$$eval('[data-block="terms"] [data-t-part]', (parts) => parts.filter((part) => !(part as HTMLElement).hidden).map((part) => part.getAttribute('data-t-part')));
    const still = await gap(page, 'terms', 'images-after');
    await page.click('[data-t-toggle="low"]');
    assert.deepEqual(await open(), ['low']);
    await page.click('[data-t-toggle="high"]');
    assert.deepEqual(await open(), ['high'], 'opening one closes the other');
    assert.equal(await page.$eval('[data-t-toggle="low"]', (button) => button.getAttribute('aria-expanded')), 'false');
    assert.equal(await gap(page, 'terms', 'images-after'), still, 'the popover floats');
    await page.keyboard.press('Escape');
    assert.deepEqual(await open(), []);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-t-toggle')), 'high', 'focus back on its toggle');
    // From the keyboard, then a press outside.
    await page.focus('[data-t-toggle="ridge"]');
    await page.keyboard.press('Enter');
    assert.deepEqual(await open(), ['ridge']);
    await page.click('[data-t-part="ridge"]');
    assert.deepEqual(await open(), ['ridge'], 'a press in the popover keeps it open');
    await page.mouse.click(40, 500);
    assert.deepEqual(await open(), []);
    // Toggles stay controls: visited once opened.
    assert.deepEqual(await page.$$eval('[data-block="terms"] [data-t-toggle][data-t-visited]', (buttons) => buttons.map((button) => button.getAttribute('data-t-toggle'))), ['low', 'high', 'ridge']);
  });
});

test('visited marks: items, cards, details and reveals are saved and restored on resume', { timeout: 180000 }, async () => {
  const dir = course();
  // The details block of the explore screen is optional; it is still a control that is saved.
  await player(dir, async (page, reload) => {
    await go(page, 'sequence');
    await page.click('[data-block="marks"] [data-t-goto="wind"]');
    await page.click('[data-t-flip="cold"]');
    await go(page, 'explore');
    await page.click('[data-block="explore-more"] summary');
    // The details' toggle event comes with the next task.
    await page.waitForFunction(() => document.querySelector('[data-block="explore-more"] details')?.hasAttribute('data-t-visited'));
    await go(page, 'timeline');
    // Reveals: the first events are in view at once; the others once scrolled to.
    const revealed = () => page.$$eval('[data-block="day"] [data-t-reveal][data-t-visited]', (nodes) => nodes.map((node) => node.getAttribute('data-t-reveal')));
    const first = await revealed();
    assert.ok(first.length >= 1 && first.length < 5, JSON.stringify(first));
    await page.$eval('[data-t-reveal="e1500"]', (node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => document.querySelectorAll('[data-block="day"] [data-t-reveal][data-t-visited]').length === 5);
    await reload();
    await go(page, 'sequence');
    assert.deepEqual((await sequence(page, 'marks')).visited, ['isobars', 'wind'], 'the first item and the one shown');
    assert.equal((await sequence(page, 'marks')).current, 'isobars', 'the sequence starts again at its first item');
    assert.equal(await page.$eval('[data-t-card="cold"]', (node) => [node.hasAttribute('data-t-visited'), node.hasAttribute('data-t-flipped')].join()), 'true,false');
    assert.equal(await page.$eval('[data-t-flip="cold"]', (node) => node.hasAttribute('data-t-visited')), true);
    await go(page, 'explore');
    assert.equal(await page.$eval('[data-block="explore-more"] details', (node) => node.hasAttribute('data-t-visited')), true);
    await go(page, 'timeline');
    assert.equal((await revealed()).length, 5);
    assert.equal(await page.evaluate(() => {
      const state = (window as unknown as { __elabora: { engine: { controlVisited(block: string, name: string): boolean } } }).__elabora.engine;
      return ['marks:wind', 'fronts-cards:cold', 'explore-more:units', 'day:e1500'].every((key) => state.controlVisited(...(key.split(':') as [string, string])));
    }), true);
  });
});

test('explored step: Continue is locked and says what is left, optional blocks aside; it unlocks once all is explored and answered; resume restores it', { timeout: 180000 }, async () => {
  await player(course(), async (page, reload) => {
    await go(page, 'explore');
    const cont = () => page.evaluate(() => {
      const control = document.querySelector('.t-continue');
      const button = control?.querySelector('.t-continue-btn');
      const hint = control?.querySelector('.t-continue-hint');
      return control && { locked: button?.getAttribute('aria-disabled') === 'true', label: button?.textContent, hint: hint?.hasAttribute('data-t-empty') ? '' : hint?.textContent, described: !!button?.getAttribute('aria-describedby'), revealed: (window as PlayerWindow).__elabora.step.revealed };
    });
    // Two items of the sequence and two cards to see, a question to answer; the optional details do not count.
    assert.deepEqual(await cont(), { locked: true, label: 'I have read the chart', hint: '1 question left to answer. 4 items left to explore.', described: true, revealed: 1 });
    const hintTop = await page.$eval('.t-continue-hint', (node) => node.getBoundingClientRect().top - document.querySelector('.t-continue-btn')!.getBoundingClientRect().top);
    // Pressed while locked, it says why where it is, and opens nothing.
    await page.click('.t-continue-btn', { force: true });
    assert.equal(await page.locator('.t-tip').textContent(), '1 question left to answer. 4 items left to explore.');
    assert.equal((await cont())?.revealed, 1);
    await page.click('[data-block="explore-marks"] [data-t-next]');
    await page.click('[data-block="explore-marks"] [data-t-next]');
    assert.equal((await cont())?.hint, '1 question left to answer. 2 cards left to turn over.');
    await page.click('[data-t-flip="cold"]');
    // Resume: what was explored stays explored, and the lock says the same.
    await reload();
    await go(page, 'explore');
    assert.deepEqual(await cont(), { locked: true, label: 'I have read the chart', hint: '1 question left to answer. 1 card left to turn over.', described: true, revealed: 1 });
    await page.click('[data-t-flip="warm"]');
    assert.equal((await cont())?.hint, '1 question left to answer.');
    await page.click('[data-block="explore-check"] [data-t-option="b"]');
    await page.click('[data-block="explore-check"] [data-t-submit]');
    // Answered, right or wrong: unlocked; the hint's line stays (nothing moves).
    assert.deepEqual(await cont(), { locked: false, label: 'I have read the chart', hint: '', described: false, revealed: 1 });
    assert.equal(await page.$eval('.t-continue-hint', (node) => node.getBoundingClientRect().top - document.querySelector('.t-continue-btn')!.getBoundingClientRect().top), hintTop);
    await page.click('.t-continue-btn');
    assert.equal((await page.evaluate(() => (window as PlayerWindow).__elabora.step)).revealed, 2);
    await reload();
    await go(page, 'explore');
    assert.equal((await page.evaluate(() => (window as PlayerWindow).__elabora.step)).revealed, 2, 'the step reached, after a reload');
  });
});

test('explored step in slides: Next is locked the same way and says what is left', { timeout: 180000 }, async () => {
  await player(course({ slides: true }), async (page) => {
    const next = () => page.$eval('.t-nav-btn--next', (button) => ({ locked: button.getAttribute('aria-disabled') === 'true', continues: button.getAttribute('data-label') === 'continue' }));
    await go(page, 'explore');
    assert.deepEqual(await next(), { locked: true, continues: true });
    await page.click('.t-nav-btn--next', { force: true });
    assert.equal(await page.locator('.t-tip').textContent(), '1 question left to answer. 4 items left to explore.');
    assert.equal((await page.evaluate(() => (window as PlayerWindow).__elabora.step)).revealed, 1);
    await page.click('[data-block="explore-marks"] [data-t-goto="fronts"]');
    await page.click('[data-block="explore-marks"] [data-t-goto="pressure"]');
    await page.click('[data-t-flip="cold"]');
    await page.click('[data-t-flip="warm"]');
    await page.click('[data-block="explore-check"] [data-t-option="a"]');
    await page.click('[data-block="explore-check"] [data-t-submit]');
    assert.deepEqual(await next(), { locked: false, continues: true });
    await page.click('.t-nav-btn--next');
    assert.equal((await page.evaluate(() => (window as PlayerWindow).__elabora.step)).revealed, 2);
  });
});
