import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Frame, Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { startCanvasHost } from '@elabora/node/canvas/host';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { CanvasApi } from '@elabora/player/canvas';
import type { LayoutMessage } from '@elabora/player/canvas-protocol';
import { ROOT, copyExample } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';

type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi };

// Continuity between screens (D65): a free object that carries on keeps running from one screen to
// the next, gets the arriving block's props with the hint of the passage, and its events, words,
// title, description and text version follow the arriving block; a block that is not an object
// glides from where its counterpart was. The fixture: screens one, two and four share the scene,
// screen three has none; one and two share a title.

const FIXTURE = path.join(ROOT, 'test/fixtures/continuity');
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

interface Probe { mounts: number; updates: number; clicks: number; label: string; transitions: { from: { screen: string; block: string }; to: { screen: string; block: string }; direction: string; duration: number; reducedMotion: boolean; safeArea: Record<string, number> }[] }

async function course(run: (page: Page, reload: () => Promise<void>) => Promise<void>, { reducedMotion = false, prepare }: { reducedMotion?: boolean; prepare?: (dir: string) => void } = {}) {
  const dir = copyExample(FIXTURE);
  prepare?.(dir);
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-continuity-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
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

// The probe's frame, and what it says about itself (it writes it in its document's title).
const probeFrame = (page: Page): Frame => page.frames().find((frame) => frame !== page.mainFrame() && /frame\.html/.test(frame.url()))!;
const probe = async (page: Page): Promise<Probe> => {
  await page.waitForFunction(() => document.querySelectorAll('.t-keep-frame iframe').length === 1);
  return JSON.parse(await probeFrame(page).evaluate(() => document.title));
};
const go = async (page: Page, id: string) => {
  await page.evaluate((screen) => (window as PlayerWindow).__elabora.go(screen), id);
  await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
};
const lastTransition = async (page: Page, count: number) => {
  await probeFrame(page).waitForFunction((n) => JSON.parse(document.title).transitions.length >= n, count);
  return (await probe(page)).transitions[count - 1];
};

test('a free object carries on: the same frame, never loaded again, with the arriving block\'s props and the hint of the passage', { timeout: 180000 }, async () => {
  await course(async (page) => {
    // The frame is in the keep layer, over its block's frame, which reads it in place and takes no clicks.
    const marked = await page.evaluate(() => { const iframe = document.querySelector<HTMLIFrameElement & { mark?: number }>('.t-keep-frame iframe')!; iframe.mark = 7; return iframe.id; });
    assert.equal(await page.getAttribute('[data-block="one-scene"] .t-object-frame', 'aria-owns'), marked);
    const hit = await page.evaluate(() => { const box = document.querySelector('[data-block="one-scene"] .t-object-frame')!.getBoundingClientRect(); return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.tagName; });
    assert.equal(hit, 'IFRAME', 'a click on the block reaches the object');
    assert.deepEqual((await probe(page)).mounts, 1);

    await go(page, 'two');
    assert.equal(await page.evaluate(() => (document.querySelector('.t-keep-frame iframe') as HTMLIFrameElement & { mark?: number }).mark), 7, 'the same frame');
    const passage = await lastTransition(page, 1);
    assert.deepEqual({ from: passage.from, to: passage.to, direction: passage.direction, duration: passage.duration, reducedMotion: passage.reducedMotion }, { from: { screen: 'one', block: 'one-scene' }, to: { screen: 'two', block: 'two-scene' }, direction: 'forward', duration: 900, reducedMotion: false });
    const state = await probe(page);
    assert.equal(state.mounts, 1, 'never loaded again');
    assert.equal(state.label, 'two', 'the arriving block\'s props');
    assert.equal(await probeFrame(page).evaluate(() => document.querySelectorAll('p')[1].textContent), 'Hello from two', 'its words');
    // The arriving block's title, description and text version; the frame glides to its box (21:9).
    const iframe = await page.evaluate(() => { const node = document.querySelector('.t-keep-frame iframe')!; return { title: node.getAttribute('title'), described: document.getElementById(node.getAttribute('aria-describedby')!)?.textContent }; });
    assert.deepEqual(iframe, { title: 'The scene, second', described: 'The scene described on screen two.' });
    assert.match(await page.textContent('[data-block="two-scene"] .t-text-alt') ?? '', /Text version two/);
    assert.equal(await page.evaluate(() => document.querySelector('.t-keep-frame')!.getAnimations().length), 1, 'the frame glides to its new box');
    // Its events are the arriving block's.
    await probeFrame(page).click('button');
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.engine.getVar('probed') === 1);
    const done = await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; return t.engine.screens.filter((screen) => t.engine.screenComplete(screen)).map((screen) => (screen as unknown as { id: string }).id); });
    assert.ok(done.includes('two') && !done.includes('one'), `the arriving block is completed (${done})`);

    // Back: the same frame again, the way the learner went.
    await go(page, 'one');
    assert.equal((await lastTransition(page, 2)).direction, 'back');
    assert.equal((await probe(page)).label, 'one');
  });
});

test('a screen without the key stops the object; the next one with it mounts it with the chain\'s state; a jump carries on', { timeout: 180000 }, async () => {
  await course(async (page) => {
    await go(page, 'two');
    await probeFrame(page).click('button');
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.engine.getVar('probed') === 1);
    await go(page, 'three');
    assert.equal(await page.locator('.t-keep-frame').count(), 0, 'no object on screen three');
    await go(page, 'four');
    const state = await probe(page);
    assert.deepEqual({ mounts: state.mounts, clicks: state.clicks, label: state.label }, { mounts: 2, clicks: 1, label: 'four' }, 'one state for the chain');
    assert.equal(state.transitions.length, 0, 'an object mounted again makes no passage');
    // The outline jumps from four to one: the scene carries on.
    await go(page, 'one');
    const passage = await lastTransition(page, 1);
    assert.deepEqual([passage.from.screen, passage.to.screen, passage.direction, passage.duration], ['four', 'one', 'back', 700]);
  });
});

test('an object carried on from a block the learner had not seen yet (a step to come) takes the arriving block\'s settings at once', { timeout: 180000 }, async () => {
  await course(async (page) => {
    await probe(page);
    await go(page, 'two');
    const passage = await lastTransition(page, 1);
    const state = await probe(page);
    assert.equal(state.mounts, 1, 'the same object');
    assert.equal(state.label, 'two', 'with screen two\'s props');
    assert.deepEqual([passage.from.block, passage.to.block, passage.duration], ['one-scene', 'two-scene', 0], 'a cut: the learner had not seen it');
  }, {
    prepare: (dir) => {
      const file = path.join(dir, 'screens/one.json');
      const one = JSON.parse(fs.readFileSync(file, 'utf8'));
      one.blocks[1].step = 2;
      fs.writeFileSync(file, JSON.stringify(one));
    }
  });
});

test('a session resumed in the middle of the chain mounts the object with its state, without a passage', { timeout: 180000 }, async () => {
  await course(async (page, reload) => {
    await go(page, 'two');
    await probeFrame(page).click('button');
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.engine.getVar('probed') === 1);
    // The standalone adapter keeps the data in the tab: the page is opened again on screen two.
    await reload();
    assert.equal(await page.evaluate(() => (window as PlayerWindow).__elabora.screen), 'two');
    const state = await probe(page);
    assert.deepEqual({ mounts: state.mounts, clicks: state.clicks, transitions: state.transitions.length }, { mounts: 2, clicks: 1, transitions: 0 });
  });
});

test('with less motion asked: a clean cut, the object still carries on, and nothing glides', { timeout: 180000 }, async () => {
  await course(async (page) => {
    await go(page, 'two');
    const passage = await lastTransition(page, 1);
    assert.deepEqual([passage.duration, passage.reducedMotion], [0, true]);
    assert.equal((await probe(page)).mounts, 1);
    const moving = await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').map((animation) => { const target = (animation.effect as KeyframeEffect)?.target as Element | null; return `${target?.tagName}.${target?.className} ${(animation as CSSAnimation).animationName ?? ''}`; }));
    assert.deepEqual(moving, [], 'nothing glides');
  }, { reducedMotion: true });
});

test('a block that is not an object glides from where its counterpart was; nothing else moves', { timeout: 180000 }, async () => {
  await course(async (page) => {
    const before = await page.evaluate(() => document.querySelector('[data-block="one-title"]')!.getBoundingClientRect().top);
    // Looked at as soon as the screen changes (the glides start in a microtask), not after ready(),
    // which may outlast a glide of 500 ms.
    const glide = await page.evaluate(async () => {
      (window as PlayerWindow).__elabora.go('two');
      await Promise.resolve();
      const node = document.querySelector<HTMLElement>('[data-block="two-title"]')!;
      const animations = node.getAnimations();
      const others = document.getAnimations().filter((animation) => animation.playState === 'running' && !((animation.effect as KeyframeEffect)?.target as Element | null)?.closest('.t-keep, [data-block="two-title"]')).length;
      const animation = animations[0];
      if (!animation) return { count: 0, duration: 0, start: 0, end: 0, others };
      const duration = animation.effect?.getTiming().duration as number;
      animation.pause();
      animation.currentTime = 0;
      const start = node.getBoundingClientRect().top;
      animation.finish();
      return { count: animations.length, duration, start, end: node.getBoundingClientRect().top, others };
    });
    assert.equal(glide.count, 1);
    assert.equal(glide.duration, 500, 'the arriving block\'s duration');
    assert.ok(Math.abs(glide.start - before) < 1, `it starts where the title was (${glide.start} vs ${before})`);
    assert.ok(glide.end - before > 20, `and ends at its own place, lower (${glide.end})`);
    assert.equal(glide.others, 0, 'nothing else moves');
  });
});

test('the editor\'s canvas measures a gliding block again once it has landed, so a click finds it where it is', { timeout: 180000 }, async () => {
  // Without the scenes, whose frames would have the canvas measure again anyway once they load.
  const root = copyExample(FIXTURE);
  for (const id of ['one', 'two']) {
    const file = path.join(root, 'screens', `${id}.json`);
    const screen = JSON.parse(fs.readFileSync(file, 'utf8'));
    screen.blocks = screen.blocks.filter((block: { type: string }) => block.type !== 'free-object');
    fs.writeFileSync(file, JSON.stringify(screen));
  }
  const project = loadProjectFromDir(root);
  const context = createRenderContext(project);
  const host = await startCanvasHost({ root: project.root });
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(host.url);
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
    const posted: LayoutMessage[] = [];
    await page.exposeFunction('tell', (message: LayoutMessage) => { if (message.type === 'elabora/layout') posted.push(message); });
    await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.onMessage((message) => (window as unknown as { tell: (m: unknown) => void }).tell(message)));
    const show = async (screen: string, id: number) => {
      host.push(renderScreen(project, screen, {}, context), { id });
      await page.waitForFunction((wanted) => (window as CanvasWindow).__elaboraCanvas.layout().id === wanted, id);
    };
    await show('one', 1);
    await show('two', 2);
    const landed = await page.evaluate(async () => {
      const node = document.querySelector<HTMLElement>('[data-block="two-title"]')!;
      await Promise.all(node.getAnimations().map((animation) => animation.finished));
      return node.getBoundingClientRect().top;
    });
    const reported = () => posted.filter((message) => message.id === 2).at(-1)?.blocks.find((block) => block.id === 'two-title')?.rect.y;
    for (let i = 0; i < 50 && Math.abs((reported() ?? 0) - landed) > 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(Math.abs((reported() ?? 0) - landed) <= 1, `the last layout gives the title where it landed (${reported()} vs ${landed})`);
  } finally {
    await browser.close();
    await host.close();
  }
});
