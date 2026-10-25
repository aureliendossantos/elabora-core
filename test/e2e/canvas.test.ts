import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { Browser, Page } from 'playwright-core';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { startCanvasHost } from '@elabora/node/canvas/host';
import type { CanvasHost } from '@elabora/node/canvas/host';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { loadProject } from '@elabora/core/project/load';
import { createProjectFiles, textFile } from '@elabora/core/project/files';
import type { Project, Screen, Block } from '@elabora/core/project/model';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { RenderContext, RenderOptions } from '@elabora/core/render/screen';
import type { CanvasApi } from '@elabora/player/canvas';
import type { HostMessage, LayoutMessage } from '@elabora/player/canvas-protocol';
import { EXAMPLE, NO_MEDIA_CODECS, ROOT, copyExample, playsMedia } from '../helpers.ts';

type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi; mark?: unknown; kept?: unknown; seen?: Promise<number>; elaboraEdited?: string };
const PLANETARY = path.join(ROOT, 'examples', 'planetary-gearset');

// A screen file replaced in memory (an edit the engine applies), the rest of the project shared.
function withScreen(project: Project, id: string, edit: (screen: Screen) => void): Project {
  const file = `screens/${id}.json`;
  const screen = structuredClone(project.screens.get(id)!.data);
  edit(screen);
  return loadProject(createProjectFiles([...project.files].map(([name, content]) => [name, name === file ? textFile(`${JSON.stringify(screen, null, 2)}\n`) : content] as const)), { root: project.root });
}
const blockOf = (screen: Screen, id: string): Block => screen.blocks.find((block) => block.id === id) ?? screen.layers!.flatMap((layer) => layer.blocks).find((block) => block.id === id)!;

interface Canvas {
  host: CanvasHost;
  page: Page;
  errors: string[];
  // Frame loads of free objects (a reload of a frame counts again).
  frames: () => number;
  show(project: Project, screen: string, options?: RenderOptions, id?: number): Promise<void>;
}

async function withCanvas(root: string, context: RenderContext, run: (canvas: Canvas) => Promise<void>) {
  const host = await startCanvasHost({ root });
  const browser: Browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    let frames = 0;
    page.on('framenavigated', (frame) => { if (frame.url().includes('/frame.html')) frames++; });
    let next = 1;
    const show = async (project: Project, screen: string, options: RenderOptions = {}, id = next++) => {
      host.push(renderScreen(project, screen, options, context), { id });
      await page.waitForFunction((wanted) => (window as CanvasWindow).__elaboraCanvas?.layout().id === wanted, id);
    };
    await page.goto(host.url);
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
    await run({ host, page, errors, frames: () => frames, show });
  } finally {
    await browser.close();
    await host.close();
  }
}

test('canvas: a block edited in memory shows without a reload, the free object of the screen keeps running', { timeout: 120000 }, async (t) => {
  const project = loadProjectFromDir(PLANETARY);
  const context = createRenderContext(project);
  await withCanvas(project.root, context, async ({ host, page, errors, frames, show }) => {
    await show(project, 'lab');
    const ready = await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.ready());
    assert.deepEqual(ready, { images: 0, objects: [{ block: 'lab-bench', ready: true, failed: false }] });
    assert.equal(frames(), 1);
    // The same player, templates and stylesheets as a package: the layout and theme apply.
    const look = await page.evaluate(() => ({
      layout: document.querySelector('article.t-screen')?.getAttribute('data-layout'),
      font: getComputedStyle(document.querySelector('h1')!).fontFamily,
      sheets: [...document.querySelectorAll<HTMLStyleElement>('style[data-elabora-sheet]')].map((node) => node.dataset.elaboraSheet)
    }));
    assert.equal(look.layout, 'stage');
    assert.match(look.font, /Space Grotesk/);
    assert.deepEqual(look.sheets.slice(0, 1), ['layers']);
    assert.ok(look.sheets.includes('theme/theme.css') && look.sheets.at(-1) === 'root');

    // Marks in the page, the object's frame and its host: an update must keep all three.
    const frame = page.frames().find((candidate) => candidate.url().includes('/objects/planetary-lab/frame.html'))!;
    await frame.evaluate(() => { (window as CanvasWindow).mark = 'running'; });
    await page.evaluate(() => { const canvas = window as CanvasWindow; canvas.mark = 'page'; canvas.kept = [document.querySelector('iframe'), canvas.__elaboraCanvas.objectHost('lab-bench')]; });
    // The text of the brief, typed by an author: the core renders the edited screen with the shared
    // context, the host pushes it; the time is measured from the push to the text in the page.
    const edited = withScreen(project, 'lab', (screen) => { blockOf(screen, 'lab-brief').props.markdown = 'Choose the **held** member first.'; });
    await page.evaluate(() => {
      (window as CanvasWindow).seen = new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[data-block="lab-brief"]')?.innerHTML.includes('<strong>held</strong>')) return;
          observer.disconnect();
          resolve(performance.timeOrigin + performance.now());
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      });
    });
    const pushed = performance.timeOrigin + performance.now();
    host.push(renderScreen(edited, 'lab', {}, context), { id: 'typed' });
    const at = await page.evaluate(() => (window as CanvasWindow).seen!);
    t.diagnostic(`push to updated DOM: ${(at - pushed).toFixed(1)} ms`);
    assert.ok(at - pushed < 1000, `${at - pushed} ms`);
    const after = await page.evaluate(() => {
      const canvas = window as CanvasWindow;
      const kept = canvas.kept as unknown[];
      return { mark: canvas.mark, frame: document.querySelector('iframe') === kept[0], host: canvas.__elaboraCanvas.objectHost('lab-bench') === kept[1] };
    });
    assert.deepEqual(after, { mark: 'page', frame: true, host: true });
    assert.equal(await frame.evaluate(() => (window as CanvasWindow).mark), 'running', 'the object frame was not loaded again');
    assert.equal(frames(), 1);

    // Where every block is, for selection and handles over the canvas.
    const layout: LayoutMessage = await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout());
    assert.equal(layout.id, 'typed');
    assert.equal(layout.screen, 'lab');
    assert.deepEqual(layout.blocks.map(({ id, slot, layer, parent, hidden }) => ({ id, slot, layer, parent, hidden })), [
      { id: 'lab-brief', slot: 'brief', layer: null, parent: null, hidden: false },
      { id: 'lab-bench', slot: 'stage', layer: null, parent: null, hidden: false }
    ]);
    for (const block of layout.blocks) assert.ok(block.rect.width > 100 && block.rect.height > 10, JSON.stringify(block));
    t.diagnostic(`canvas apply: ${layout.applyMs} ms`);

    // Edits that move the object's node keep its frame too: a block added before it, the screen's
    // title (a new article: the blocks move into it), the object moved to another slot.
    const added = withScreen(edited, 'lab', (screen) => { screen.blocks.unshift({ id: 'lab-note', type: 'text', slot: 'stage', props: { markdown: 'Read the panel first.' } }); });
    await show(added, 'lab');
    const retitled = withScreen(added, 'lab', (screen) => { screen.title = 'Gearbox lab'; });
    await show(retitled, 'lab');
    assert.equal(await page.evaluate(() => document.querySelector('h1')!.textContent), 'Gearbox lab');
    const moved = withScreen(retitled, 'lab', (screen) => { blockOf(screen, 'lab-bench').slot = 'brief'; });
    await show(moved, 'lab');
    const order = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-slot] > .t-block')].map((node) => `${node.parentElement!.dataset.slot}:${node.dataset.block}`));
    assert.deepEqual(order, ['brief:lab-brief', 'brief:lab-bench', 'stage:lab-note']);
    assert.equal(await frame.evaluate(() => (window as CanvasWindow).mark), 'running', 'moved with its frame running');
    assert.equal(await page.evaluate(() => document.querySelector('iframe') === ((window as CanvasWindow).kept as unknown[])[0]), true);
    assert.equal(frames(), 1);

    // The object's own props change: its block is rendered again, with a new frame.
    const props = withScreen(moved, 'lab', (screen) => { blockOf(screen, 'lab-bench').props.title = 'Gear bench'; });
    host.push(renderScreen(props, 'lab', {}, context), { id: 'object' });
    await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('title') === 'Gear bench');
    assert.equal(await page.evaluate(() => document.querySelector('iframe') === ((window as CanvasWindow).kept as unknown[])[0]), false);
    assert.deepEqual(errors.filter((error) => !/GL Driver|WebGL|PCFSoftShadowMap/.test(error)), []);
  });
});

test('canvas: steps, layers and the answered state as captures show them, kept across updates', { timeout: 120000 }, async () => {
  const project = loadProjectFromDir(PLANETARY);
  const context = createRenderContext(project);
  await withCanvas(project.root, context, async ({ page, show, host }) => {
    const pending = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-t-pending]')].map((node) => node.dataset.block));
    // Step 1 of a screen with two steps: the blocks of step 2 keep their place, hidden.
    await show(project, 'anatomy', { step: 1 });
    assert.deepEqual(await pending(), ['anatomy-rule', 'anatomy-derivation']);
    const step = withScreen(project, 'anatomy', (screen) => { blockOf(screen, 'anatomy-members').props.markdown = 'Three members turn around one axis.'; });
    await show(step, 'anatomy', { step: 1 });
    assert.deepEqual(await pending(), ['anatomy-rule', 'anatomy-derivation'], 'the step stays');
    assert.match(await page.evaluate(() => document.querySelector('[data-block="anatomy-members"]')!.textContent!), /Three members/);
    // Every step (the default, as captures).
    await show(step, 'anatomy');
    assert.deepEqual(await pending(), []);

    // A layer opened over the screen, kept while one of its blocks is edited.
    await show(project, 'lab', { layer: 'lab-debrief' });
    const open = () => page.evaluate(() => [...document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')].map((dialog) => `${dialog.dataset.layer}:${dialog.open}`));
    assert.deepEqual(await open(), ['lab-debrief:true']);
    const debrief = withScreen(project, 'lab', (screen) => { blockOf(screen, 'lab-summary').props.title = 'What you found'; });
    await show(debrief, 'lab', { layer: 'lab-debrief' });
    assert.deepEqual(await open(), ['lab-debrief:true']);
    assert.match(await page.evaluate(() => document.querySelector('dialog.t-layer')!.textContent!), /What you found/);
    const layout: LayoutMessage = await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout());
    assert.deepEqual(layout.blocks.filter((block) => block.layer).map((block) => block.id), ['lab-summary']);
    // A view message closes it without new data.
    host.view({ layer: null }, { id: 99 });
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas.layout().id === 99);
    assert.deepEqual(await open(), []);

    // The answered state: the activity shows its tallest outcome, also once rendered again.
    await show(project, 'practice', { state: 'answered' });
    const answered = () => page.evaluate(() => document.querySelector('[data-block="anatomy-your-turn"] [data-t-result]')?.getAttribute('data-t-result') ?? null);
    assert.ok(await answered());
    const numeric = withScreen(project, 'practice', (screen) => { blockOf(screen, 'anatomy-your-turn').props.unit = 'min⁻¹'; });
    await show(numeric, 'practice', { state: 'answered' });
    assert.ok(await answered(), 'the block rendered again shows its outcome');
    await show(numeric, 'practice', { state: 'initial' });
    assert.equal(await answered(), null);

    // The scroll position stays across updates.
    await page.setViewportSize({ width: 1280, height: 420 });
    const scrolled = await page.evaluate(() => { scrollTo(0, 240); return scrollY; });
    assert.ok(scrolled > 20, `${scrolled}`);
    await show(withScreen(numeric, 'practice', (screen) => { blockOf(screen, 'anatomy-example-title').props.text = 'Worked example: ring fixed'; }), 'practice');
    assert.match(await page.evaluate(() => document.querySelector('[data-block="anatomy-example-title"]')!.textContent!), /ring fixed/);
    assert.equal(await page.evaluate(() => scrollY), scrolled);
  });
});

test('canvas: a results screen shows before anything is answered (status « not attempted »)', { timeout: 120000 }, async () => {
  const project = loadProjectFromDir(path.join(ROOT, 'examples', 'diagnostic-reseau'));
  const context = createRenderContext(project);
  await withCanvas(project.root, context, async ({ page, show, errors }) => {
    await show(project, 'bilan');
    const status = await page.evaluate(() => document.querySelector('[data-block="bilan-resultat"] .t-status--not-attempted')?.textContent ?? null);
    assert.ok(status, 'the status shows, with a class name without space');
    assert.deepEqual(errors, []);
  });
});

test('canvas: the layout gives the texts of each block the author can point at (fields)', { timeout: 120000 }, async () => {
  // The frozen fixture: its first-reflex screen is still a decision block (the sample's is a dialogue).
  const project = loadProjectFromDir(EXAMPLE);
  const context = createRenderContext(project, { fields: true });
  await withCanvas(project.root, context, async ({ page, show, errors }) => {
    await show(project, 'premier-reflexe');
    const layout: LayoutMessage = await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout());
    const decision = layout.blocks.find((block) => block.id === 'reflexe-choix');
    const paths = (decision?.fields ?? []).map((field) => field.path);
    assert.deepEqual(paths, ['prompt', 'options.0.label', 'options.1.label', 'options.2.label'], JSON.stringify(decision));
    for (const field of decision!.fields!) assert.ok(field.rect.width > 0 && field.rect.height > 0, JSON.stringify(field));
    assert.deepEqual(errors, []);
  });
});

test('canvas: a wheel passed on by the host scrolls what can still go that way under the pointer, else the page; from the parent window with the token only', { timeout: 120000 }, async () => {
  const project = loadProjectFromDir(path.join(ROOT, 'examples', 'medieval-charts'));
  const context = createRenderContext(project);
  await withCanvas(project.root, context, async ({ host, page, show, errors }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await show(project, 'world');
    await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.ready());
    const wheel = (message: Extract<HostMessage, { type: 'elabora/scroll' }>) => page.evaluate((sent) => (window as CanvasWindow).__elaboraCanvas.receive(sent), message);
    const scrolled = () => page.evaluate(() => [document.getElementById('box')?.scrollTop ?? null, scrollY]);
    // The page, from a point over the screen or without one.
    await wheel({ type: 'elabora/scroll', by: { x: 0, y: 300 }, at: { x: 640, y: 300 } });
    assert.deepEqual(await scrolled(), [null, 300]);
    await wheel({ type: 'elabora/scroll', by: { x: 0, y: -120 } });
    assert.deepEqual(await scrolled(), [null, 180]);
    // A box that scrolls under the pointer goes first, the page once the box is at its end.
    await page.evaluate(() => {
      const box = document.body.appendChild(document.createElement('div'));
      box.id = 'box';
      box.style.cssText = 'position: fixed; left: 0; top: 0; width: 200px; height: 100px; overflow: auto; z-index: 2147483647';
      box.innerHTML = '<div style="height: 250px"></div>';
    });
    await wheel({ type: 'elabora/scroll', by: { x: 0, y: 100 }, at: { x: 50, y: 50 } });
    assert.deepEqual(await scrolled(), [100, 180]);
    await wheel({ type: 'elabora/scroll', by: { x: 0, y: 100 }, at: { x: 50, y: 50 } });
    assert.deepEqual(await scrolled(), [150, 180]);
    await wheel({ type: 'elabora/scroll', by: { x: 0, y: 100 }, at: { x: 50, y: 50 } });
    assert.deepEqual(await scrolled(), [150, 280]);
    assert.deepEqual(errors, []);

    // In a frame, as the app shows it: a message without the page's token scrolls nothing.
    await page.setContent(`<iframe src="${host.url}" style="width: 1000px; height: 500px; border: 0"></iframe>`);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await frame.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas?.screen === 'world');
    await frame.evaluate(() => (window as CanvasWindow).__elaboraCanvas.ready());
    await page.evaluate((token) => {
      const target = document.querySelector('iframe')!.contentWindow!;
      target.postMessage({ type: 'elabora/scroll', token: 'not-the-token', by: { x: 0, y: 500 } }, '*');
      target.postMessage({ type: 'elabora/scroll', token, by: { x: 0, y: 200 }, at: { x: 500, y: 250 } }, '*');
    }, host.token);
    await frame.waitForFunction(() => scrollY > 0);
    assert.equal(await frame.evaluate(() => scrollY), 200);
  });
});

test('canvas: a looping video plays muted with a pause button, still for reduced motion; a decorative one is hidden from assistive technologies', { timeout: 120000 }, async (t) => {
  const dir = copyExample();
  try {
    fs.mkdirSync(path.join(dir, 'assets/video'), { recursive: true });
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path.join(dir, 'assets/video/voyant.mp4')]);
    fs.copyFileSync(path.join(dir, 'assets/video/voyant.mp4'), path.join(dir, 'assets/video/lent.mp4'));
  } catch {
    return t.skip('ffmpeg with libx264 not found');
  }
  const project = withScreen(loadProjectFromDir(dir), 'chemin', (screen) => {
    screen.blocks.push(
      { id: 'chemin-voyant', type: 'video', props: { asset: 'video/voyant.mp4', title: 'Le voyant', loop: true, alt: 'Le voyant du routeur clignote en orange.' } },
      { id: 'chemin-fond', type: 'video', props: { asset: 'video/voyant.mp4', title: 'Fond', decorative: true } }
    );
  });
  const context = createRenderContext(project);
  await withCanvas(dir, context, async ({ page, show, errors }) => {
    if (!(await playsMedia(page))) return t.skip(NO_MEDIA_CODECS);
    const state = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.t-figure--loop')].map((figure) => {
      const video = figure.querySelector('video')!;
      const toggle = figure.querySelector('button')!;
      return { block: figure.closest<HTMLElement>('[data-block]')!.dataset.block, muted: video.muted, loop: video.loop, controls: video.controls, paused: video.paused, hidden: video.getAttribute('aria-hidden'), role: video.getAttribute('role'), label: video.getAttribute('aria-label'), button: toggle.getAttribute('aria-label') };
    }));
    // Reduced motion (the page asks for it): the loops wait for the learner.
    await show(project, 'chemin');
    assert.deepEqual(await state(), [
      { block: 'chemin-voyant', muted: true, loop: true, controls: false, paused: true, hidden: null, role: 'img', label: 'Le voyant du routeur clignote en orange.', button: 'Lire l’animation' },
      { block: 'chemin-fond', muted: true, loop: true, controls: false, paused: true, hidden: 'true', role: null, label: null, button: 'Lire l’animation' }
    ]);
    await page.click('[data-block="chemin-voyant"] .t-loop-toggle');
    await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>('[data-block="chemin-voyant"] video')!.paused);
    assert.equal(await page.getAttribute('[data-block="chemin-voyant"] .t-loop-toggle', 'aria-label'), 'Mettre en pause l’animation');
    // Without the preference, they start by themselves once in the window (Chrome holds a muted
    // video that plays by itself until it enters the window). The click scrolled to the first loop
    // only, to its middle or to its bottom edge depending on when the videos took their size: the
    // second one may be below the window.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // (A new render of the loops: their props changed.)
    await show(withScreen(project, 'chemin', (screen) => { for (const block of screen.blocks) if (block.type === 'video') block.props.title = `${block.props.title}.`; }), 'chemin');
    await page.evaluate(() => document.querySelector('[data-block="chemin-fond"]')!.scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('.t-figure--loop video')].every((video) => !video.paused));

    // Pressed while the loop still loads (« Mettre en pause », the video not playing yet), the
    // button keeps it still: it does not start it, and the loop does not start once loaded.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/assets/video/lent.mp4*', async (route) => { await held; await route.continue(); });
    await show(withScreen(project, 'chemin', (screen) => { blockOf(screen, 'chemin-voyant').props.asset = 'video/lent.mp4'; }), 'chemin');
    const slow = () => page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('[data-block="chemin-voyant"] video')!;
      return { paused: video.paused, ready: video.readyState, button: document.querySelector('[data-block="chemin-voyant"] .t-loop-toggle')!.getAttribute('aria-label') };
    });
    assert.deepEqual(await slow(), { paused: true, ready: 0, button: 'Mettre en pause l’animation' });
    await page.click('[data-block="chemin-voyant"] .t-loop-toggle');
    assert.deepEqual(await slow(), { paused: true, ready: 0, button: 'Lire l’animation' });
    release();
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('[data-block="chemin-voyant"] video')!.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA);
    assert.deepEqual(await slow(), { paused: true, ready: 4, button: 'Lire l’animation' });
    assert.deepEqual(errors, []);
  });
});

test('canvas: a sound plays named by its title, with its transcript; a decorative one shows none', { timeout: 120000 }, async (t) => {
  const dir = copyExample();
  try {
    fs.mkdirSync(path.join(dir, 'assets/audio'), { recursive: true });
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', path.join(dir, 'assets/audio/son.m4a')]);
  } catch {
    return t.skip('ffmpeg not found');
  }
  // The decorative one keeps a transcript in its props: the player leaves it out all the same.
  const project = withScreen(loadProjectFromDir(dir), 'chemin', (screen) => {
    screen.blocks.push(
      { id: 'chemin-recit', type: 'audio', props: { asset: 'audio/son.m4a', title: 'Le récit de Marc', transcript: 'Marc raconte la panne.' } },
      { id: 'chemin-ambiance', type: 'audio', props: { asset: 'audio/son.m4a', title: 'Ambiance du bureau', transcript: 'Un bruit de fond.', decorative: true } }
    );
  });
  await withCanvas(dir, createRenderContext(project), async ({ page, show, errors }) => {
    await show(project, 'chemin');
    const sounds = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.t-block--audio')].map((block) => {
      const audio = block.querySelector('audio')!;
      return { block: block.dataset.block, controls: audio.controls, title: audio.getAttribute('title'), hidden: audio.getAttribute('aria-hidden'), caption: block.querySelector('figcaption')?.textContent, transcript: block.querySelector('.t-transcript .t-text')?.textContent?.trim() ?? null };
    }));
    assert.deepEqual(sounds, [
      { block: 'chemin-recit', controls: true, title: 'Le récit de Marc', hidden: null, caption: 'Le récit de Marc', transcript: 'Marc raconte la panne.' },
      { block: 'chemin-ambiance', controls: true, title: 'Ambiance du bureau', hidden: null, caption: 'Ambiance du bureau', transcript: null }
    ]);
    assert.deepEqual(errors, []);
  });
});

test('canvas: an image replaced at the same path and an edited object.js load again', { timeout: 120000 }, async () => {
  const dir = copyExample(PLANETARY);
  const project = loadProjectFromDir(dir);
  const context = createRenderContext(project);
  await withCanvas(dir, context, async ({ page, show, frames }) => {
    const image = () => page.evaluate(() => { const node = document.querySelector<HTMLImageElement>('[data-block="practice-figure"] img')!; return { src: node.getAttribute('src'), size: `${node.naturalWidth}x${node.naturalHeight}` }; });
    await show(project, 'practice');
    await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.ready());
    assert.equal((await image()).src, 'assets/images/anatomy-planetary.svg', 'the URL of a package first');
    // An agent writes another figure at the same path: the engine reads the folder again.
    fs.writeFileSync(path.join(dir, 'assets/images/anatomy-planetary.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100" aria-hidden="true"><rect width="400" height="100" fill="#C2571A"/></svg>\n');
    await show(loadProjectFromDir(dir), 'practice');
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('[data-block="practice-figure"] img')?.naturalWidth === 400);
    const replaced = await image();
    assert.match(replaced.src ?? '', /^assets\/images\/anatomy-planetary\.svg\?v=[0-9a-f]{12}$/);
    assert.equal(replaced.size, '400x100');

    // object.js edited: the object restarts with its new code.
    await show(loadProjectFromDir(dir), 'lab');
    await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.ready());
    const loads = frames();
    fs.appendFileSync(path.join(dir, 'objects/planetary-lab/object.js'), "\nglobalThis.elaboraEdited = 'yes';\n");
    await show(loadProjectFromDir(dir), 'lab');
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas.objectHost('lab-bench'));
    await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.ready());
    assert.equal(frames(), loads + 1, 'one new frame');
    const frame = page.frames().find((candidate) => candidate.url().includes('/objects/planetary-lab/frame.html'))!;
    assert.equal(await frame.evaluate(() => (window as CanvasWindow).elaboraEdited), 'yes');
  });
});

// The large course of scripts/make-large-course.ts (ELABORA_LARGE_COURSE, or a small one made here).
function largeCourse(): string | null {
  if (process.env.ELABORA_LARGE_COURSE) return process.env.ELABORA_LARGE_COURSE;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { return null; }
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-canvas-large-')), 'course');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-large-course.ts'), dir, '--screens', '12', '--video-mb', '6', '--videos', '1'], { stdio: 'ignore' });
  return dir;
}

function request(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const call = http.request(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    call.on('error', reject);
    call.end();
  });
}

test('canvas host: videos of a large course stream from the project folder with range requests', { timeout: 300000 }, async (t) => {
  const dir = largeCourse();
  if (!dir) { t.skip('ffmpeg is not installed'); return; }
  const project = loadProjectFromDir(dir);
  const context = createRenderContext(project);
  const screen = [...project.screens.keys()].find((id) => /^lecture-\d+-screen$/.test(id))!;
  const render = renderScreen(project, screen, {}, context);
  const video = render.files.find((file) => file.path.endsWith('.mp4'))!;
  assert.equal(video.kind, 'asset');
  const file = path.join(dir, video.path);
  const bytes = fs.readFileSync(file);
  await withCanvas(dir, context, async ({ host, page }) => {
    const url = `${host.base}/canvas/${video.path}`;
    assert.equal((await request(url)).status, 404, 'not served before a render lists it');
    host.push(render, { id: 'video' });
    const whole = await request(url, {}, 'HEAD');
    assert.equal(whole.status, 200);
    assert.equal(whole.headers['content-type'], 'video/mp4');
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.equal(Number(whole.headers['content-length']), bytes.length);
    const middle = await request(url, { range: 'bytes=1000-1999' });
    assert.equal(middle.status, 206);
    assert.equal(middle.headers['content-range'], `bytes 1000-1999/${bytes.length}`);
    assert.ok(middle.body.equals(bytes.subarray(1000, 2000)));
    const tail = await request(url, { range: 'bytes=-500' });
    assert.equal(tail.status, 206);
    assert.ok(tail.body.equals(bytes.subarray(bytes.length - 500)));
    const open = await request(url, { range: `bytes=${bytes.length - 10}-` });
    assert.ok(open.body.equals(bytes.subarray(bytes.length - 10)));
    assert.equal((await request(url, { range: `bytes=${bytes.length}-` })).status, 416);
    assert.equal((await request(url, { 'if-none-match': String(whole.headers.etag) })).status, 304);
    // Captions and fonts with their types; nothing outside what renders list; local names only.
    const captions = render.files.find((candidate) => candidate.path.endsWith('.vtt'))!;
    assert.match(String((await request(`${host.base}/canvas/${captions.path}`)).headers['content-type']), /^text\/vtt/);
    const font = render.files.find((candidate) => candidate.kind === 'font')!;
    assert.equal((await request(`${host.base}/canvas/${font.path}`)).headers['content-type'], 'font/woff2');
    assert.equal((await request(`${host.base}/canvas/course.json`)).status, 404);
    assert.equal((await request(`${host.base}/canvas/assets/../course.json`)).status, 404);
    assert.equal((await request(url, { host: 'rebound.example.com' })).status, 403);

    // In Chrome: the video plays from the project folder and seeks. A media error (a codec the
    // browser lacks, a refused range) fails at once instead of leaving the test to its timeout.
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas.layout().id === 'video');
    if (!(await playsMedia(page))) return t.skip(`served with range requests; playback not checked: ${NO_MEDIA_CODECS}`);
    const played = await page.evaluate(async () => {
      const media = document.querySelector('video')!;
      const event = (name: string) => new Promise((resolve, reject) => {
        media.addEventListener(name, resolve, { once: true });
        media.addEventListener('error', () => reject(new Error(`video error ${media.error?.code}: ${media.error?.message}`)), { once: true });
      });
      if (media.readyState < 1) await event('loadedmetadata');
      media.currentTime = media.duration * 0.8;
      await event('seeked');
      return { duration: media.duration, time: media.currentTime };
    });
    assert.ok(played.duration > 1 && played.time > played.duration * 0.7, JSON.stringify(played));
  });
});
