import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright-core';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { readProjectFiles } from '@elabora/node/project-reader';
import { startHosts } from '../relay-hosts.ts';
import { launch } from '../relay-browsers.ts';
import { APP, CANVAS, FRAMES, authorFiles, engineMedia, handlers } from '../relay-site.ts';
import { EXAMPLE, ROOT } from '../helpers.ts';

// The editor's miniatures in a browser (D130): a list of rows that shows each in view as a live frame of the canvas page, through createThumbs,
// the engine's requests faked (test/fixtures/thumbs-app.ts). ELABORA_RELAY_BROWSERS picks the browsers (Chromium by default). In Playwright's
// Firefox a frame of another origin shows as about:blank and a frame after the first is not controlled by the relay's worker: what is inside a
// frame is looked at in Chromium and WebKit, and in real Firefox by the WebDriver BiDi script of the web canvas report.
const wanted = (process.env.ELABORA_RELAY_BROWSERS ?? 'chromium').split(',').map((name) => name.trim()).filter(Boolean);
const PATIENT = { timeout: 90000 };

interface ThumbsApp {
  calls: Array<{ name: string; screen?: string; at: number }>;
  drawn: Map<number, boolean>;
  ports: number;
  portsDone: number;
  loads: number;
  rows: HTMLElement[];
  live: number;
  frames(): Array<{ src: string; sandbox: string | null; inert: boolean; ariaHidden: string | null; parent: string | null }>;
  bump(screen: string): void;
  refresh(index: number): void;
  release(index: number): void;
  scrollTo(top: number): void;
  setCurrent(screen: string | null): void;
  measure(screen: string, language: string | null): Promise<{ overflow: number; fields: unknown[] } | null>;
  startEngine(seed: unknown, screens: string[]): Promise<number>;
  showBlock(screen: string, mini: boolean, width: number, height: number, args?: Record<string, unknown>): Promise<{ drawn: boolean; overflow: boolean | null; transform: string | null; picture: { width: number; height: number } | null }>;
  logs: string[];
  pageLoads: number;
  pictures(): Array<string | null>;
  frameCount(): number;
  releaseBlocks(): void;
}
type Win = Window & { thumbsApp: ThumbsApp };

async function withThumbs(name: string, t: { skip(message: string): void }, query: string, run: (page: Page, context: BrowserContext) => Promise<void>): Promise<void> {
  const hosts = await startHosts(handlers());
  const browser = await launch(name, hosts);
  if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 900 }, serviceWorkers: 'allow' });
  try {
    const page = await context.newPage();
    if (process.env.RELAY_DEBUG) page.on('console', (message) => console.log('[console]', message.type(), message.text().slice(0, 200)));
    await page.goto(`${APP}/thumbs?${query}`);
    await page.waitForFunction(() => !!(window as unknown as Win).thumbsApp, null, { timeout: 30000 });
    await run(page, context);
  } finally {
    await context.close();
    await browser.close();
    hosts.close();
  }
}
const drawnCount = (page: Page) => page.evaluate(() => [...(window as unknown as Win).thumbsApp.drawn.values()].filter(Boolean).length);
const untilDrawn = (page: Page, count: number) => page.waitForFunction((wantedCount) => [...(window as unknown as Win).thumbsApp.drawn.values()].filter(Boolean).length >= wantedCount, count, { timeout: 90000 });
const thumbFrames = (page: Page): Frame[] => page.frames().filter((frame) => frame.url().startsWith(`${CANVAS}/canvas/index.html`));

for (const name of wanted) {
  test(`thumbnails (${name}): a list is drawn, each row in a frame of its own with a route of its own, no frames host, no object`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=8&height=800', async (page) => {
      await untilDrawn(page, 8);
      const frames = await page.evaluate(() => (window as unknown as Win).thumbsApp.frames());
      assert.equal(frames.length, 8);
      const routes = new Set<string>();
      for (const frame of frames) {
        const address = new URL(frame.src);
        assert.equal(address.origin, CANVAS);
        assert.equal(address.searchParams.get('mode'), 'thumb');
        assert.ok(address.searchParams.get('token') && address.searchParams.get('route'));
        // A thumbnail has no frames host: no route of the frames, no address of them.
        assert.equal(address.searchParams.has('framesRoute'), false);
        assert.equal(address.searchParams.has('frames'), false);
        routes.add(address.searchParams.get('route')!);
        assert.equal(frame.sandbox, 'allow-scripts allow-same-origin allow-pointer-lock');
        assert.equal(frame.inert, true);
        assert.equal(frame.ariaHidden, 'true');
      }
      assert.equal(routes.size, 8, 'a route for each frame');
      // A port of the engine for each frame (a frame the service worker takes over on a first visit asks for its port again), none for a frames host.
      assert.ok(await page.evaluate(() => (window as unknown as Win).thumbsApp.ports) >= 8, 'a port for each frame');
      if (name === 'firefox') return;
      // Nothing of the frames host: no hidden relay page, no object.
      assert.deepEqual(page.frames().filter((frame) => frame.url().startsWith(FRAMES)).map((frame) => frame.url()), []);
      const inside = await Promise.all(thumbFrames(page).map((frame) => frame.evaluate(() => ({
        screen: (window as unknown as { __elaboraCanvas: { screen: string | null } }).__elaboraCanvas.screen,
        thumb: 'thumb' in document.documentElement.dataset,
        frames: document.querySelectorAll('iframe').length,
        box: [...document.querySelectorAll('.t-object-miniature')].map((box) => box.textContent)
      }))));
      assert.equal(inside.length, 8);
      assert.deepEqual([...new Set(inside.map((each) => each.screen))].sort(), ['accueil', 'simulation']);
      for (const each of inside) { assert.equal(each.thumb, true); assert.equal(each.frames, 0, 'no frame of an object mounted'); }
      // The screen with a free object shows its box, with the object's name.
      assert.ok(inside.filter((each) => each.screen === 'simulation').every((each) => each.box.length === 1 && /\S/.test(each.box[0] ?? '')), JSON.stringify(inside.filter((each) => each.screen === 'simulation')[0]));
    });
  });

  test(`thumbnails (${name}): at most the limit are live at once, the others wait, and a place freed is taken`, PATIENT, async (t) => {
    // Many more rows in view than places: six places, about eighteen rows in the window.
    await withThumbs(name, t, 'rows=40&limit=6&height=8000', async (page) => {
      let most = 0;
      const sample = async () => { most = Math.max(most, await page.evaluate(() => (window as unknown as Win).thumbsApp.frames().length)); };
      await untilDrawn(page, 6);
      for (let i = 0; i < 10; i++) { await sample(); await page.waitForTimeout(150); }
      assert.equal(await page.evaluate(() => (window as unknown as Win).thumbsApp.live), 6);
      assert.equal(await drawnCount(page), 6, 'the others wait');
      assert.ok(most <= 6, `never more than 6 frames: ${most}`);
      // Two rows leave: two others take their places.
      await page.evaluate(() => { const app = (window as unknown as Win).thumbsApp; for (const index of [...app.drawn.keys()].slice(0, 2)) app.release(index); });
      await untilDrawn(page, 6);
      for (let i = 0; i < 6; i++) { await sample(); await page.waitForTimeout(100); }
      assert.ok(most <= 6, `still never more than 6 frames: ${most}`);
      // (Playwright's Firefox gives a frame loaded after the first no service worker: it asks for no port.)
      if (name !== 'firefox') assert.ok(await page.evaluate(() => (window as unknown as Win).thumbsApp.ports) >= 8, 'eight frames in all, six at a time');
    });
  });

  test(`thumbnails (${name}): a list scrolled shows the rows in view; a row that left keeps its frame while a place is free, and comes back drawn`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=40&height=300&limit=16', async (page) => {
      const inView = () => page.evaluate(() => (window as unknown as Win).thumbsApp.rows.map((row, index) => ({ index, box: row.getBoundingClientRect() })).filter(({ box }) => box.bottom > 0 && box.top < 300).map(({ index }) => index));
      const framed = () => page.evaluate(() => (window as unknown as Win).thumbsApp.frames().map((frame) => Number(frame.parent)).sort((a, b) => a - b));
      const first = await inView();
      await page.waitForFunction((rows) => rows.every((index) => (window as unknown as Win).thumbsApp.drawn.get(index) === true), first, { timeout: 90000 });
      await page.waitForTimeout(400);
      assert.deepEqual(await framed(), first, 'only the rows in view are drawn: a row out of the view is shown, not drawn');
      await page.evaluate(() => (window as unknown as Win).thumbsApp.scrollTo(1500));
      const later = await inView();
      await page.waitForFunction((rows) => rows.every((index) => (window as unknown as Win).thumbsApp.drawn.get(index) === true), later, { timeout: 90000 });
      await page.waitForTimeout(400);
      assert.deepEqual(await framed(), [...first, ...later].sort((a, b) => a - b), 'the rows that left keep their frames: fewer than the limit are live');
      const loads = await page.evaluate(() => (window as unknown as Win).thumbsApp.loads);
      await page.evaluate(() => (window as unknown as Win).thumbsApp.scrollTo(0));
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => (window as unknown as Win).thumbsApp.loads), loads, 'a row that comes back is drawn in the frame it kept: nothing loads');
    });
  });

  test(`thumbnails (${name}): a refresh asked for while a row is out of the view is drawn when it comes back, not before`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=40&height=300&refresh=0&limit=16', async (page) => {
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.drawn.get(0) === true, null, { timeout: 90000 });
      await page.evaluate(() => (window as unknown as Win).thumbsApp.scrollTo(1500));
      await page.waitForTimeout(800);
      const calls = () => page.evaluate(() => (window as unknown as Win).thumbsApp.calls.length);
      const before = await calls();
      await page.evaluate(() => { const app = (window as unknown as Win).thumbsApp; app.bump('simulation'); app.bump('accueil'); app.refresh(0); });
      await page.waitForTimeout(800);
      assert.equal(await calls(), before, 'nothing is asked for a frame out of the view');
      await page.evaluate(() => (window as unknown as Win).thumbsApp.scrollTo(0));
      await page.waitForFunction((count) => (window as unknown as Win).thumbsApp.calls.length > count, before, { timeout: 15000 });
      assert.equal(await calls(), before + 1, 'its render is asked for once it is back');
    });
  });

  test(`thumbnails (${name}): when no place is free, a frame out of the view gives its place to a row in the view`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=40&height=300&limit=6', async (page) => {
      await untilDrawn(page, 1);
      await page.evaluate(() => (window as unknown as Win).thumbsApp.scrollTo(1500));
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.frames().filter((frame) => Number(frame.parent) > 15).length === 6, null, { timeout: 90000 });
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => (window as unknown as Win).thumbsApp.frames().map((frame) => Number(frame.parent)));
      assert.ok(after.length === 6 && after.every((index) => index > 12), `only the rows now in view hold a frame: ${JSON.stringify(after)}`);
      assert.equal(await page.evaluate(() => (window as unknown as Win).thumbsApp.live), 6);
    });
  });

  test(`thumbnails (${name}): a window that shows only the rows in view and releases those that leave keeps no frame out of the view`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=40&height=300&view=1', async (page) => {
      await untilDrawn(page, 1);
      await page.evaluate(() => (window as unknown as Win).thumbsApp.scrollTo(1500));
      await page.waitForFunction(() => { const keys = [...(window as unknown as Win).thumbsApp.drawn.entries()].filter(([, ok]) => ok).map(([index]) => index); return keys.length > 0 && Math.min(...keys) > 15; }, null, { timeout: 90000 });
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => (window as unknown as Win).thumbsApp.frames().map((frame) => Number(frame.parent)));
      assert.ok(after.every((index) => index > 12), `only the rows now in view hold a frame: ${JSON.stringify(after)}`);
    });
  });

  test(`thumbnails (${name}): a live thumbnail is given a new render by message, never recreated, and no more often than the contract says`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=1&refresh=700', async (page) => {
      await untilDrawn(page, 1);
      const before = await page.evaluate(() => ({ loads: (window as unknown as Win).thumbsApp.loads, calls: (window as unknown as Win).thumbsApp.calls.length }));
      const layoutId = async () => (name === 'firefox' ? null : await thumbFrames(page)[0]!.evaluate(() => (window as unknown as { __elaboraCanvas: { layout(): { id: unknown } } }).__elaboraCanvas.layout().id));
      assert.ok([1, null].includes(await layoutId() as number | null));
      // The screen did not change (the same version): asked again, nothing drawn.
      await page.evaluate(() => (window as unknown as Win).thumbsApp.refresh(0));
      await page.waitForFunction((count) => (window as unknown as Win).thumbsApp.calls.length > count, before.calls, { timeout: 30000 });
      await page.waitForTimeout(500);
      assert.ok([1, null].includes(await layoutId() as number | null), 'a render of the same version is not drawn again');
      // The screen changed: a keystroke each 50 ms for a second draws it a few times, never twice within the wait.
      const since = await page.evaluate(() => (window as unknown as Win).thumbsApp.calls.length);
      await page.evaluate(async () => { const app = (window as unknown as Win).thumbsApp; for (let i = 0; i < 20; i++) { app.bump('simulation'); app.refresh(0); await new Promise((resolve) => setTimeout(resolve, 50)); } });
      await page.waitForTimeout(2500);
      const times = (await page.evaluate((from) => (window as unknown as Win).thumbsApp.calls.slice(from).map((call) => call.at), since));
      assert.ok(times.length >= 1 && times.length <= 4, `twenty changes in a second asked ${times.length} renders`);
      for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 650, `renders ${i - 1} and ${i} are ${Math.round(times[i]! - times[i - 1]!)} ms apart (the wait is 700)`);
      if (name !== 'firefox') {
        const id = await layoutId() as number;
        assert.ok(id >= 2 && id <= 5, `redrawn by message: render ${id}`);
      }
      const after = await page.evaluate(() => ({ loads: (window as unknown as Win).thumbsApp.loads, frames: (window as unknown as Win).thumbsApp.frames().length }));
      assert.equal(after.loads, before.loads, 'the frame was not loaded again');
      assert.equal(after.frames, 1);
    });
  });

  test(`thumbnails (${name}): a released thumbnail's frame goes once its route is closed, the engine lets the route's port go, and its place is free`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=4&limit=4', async (page) => {
      await untilDrawn(page, 4);
      assert.equal(await page.evaluate(() => (window as unknown as Win).thumbsApp.portsDone), 0);
      await page.evaluate(() => (window as unknown as Win).thumbsApp.release(1));
      // The page reads the close before its frame goes, and says relay/done: the engine keeps no port of a closed route.
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.portsDone === 1, null, { timeout: 15000 });
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.frames().length === 3 && (window as unknown as Win).thumbsApp.live === 3, null, { timeout: 15000 });
      assert.deepEqual((await page.evaluate(() => (window as unknown as Win).thumbsApp.frames())).map((frame) => frame.parent).sort(), ['0', '2', '3']);
    });
  });

  test(`thumbnails (${name}): the screen of the editor is drawn first`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=30&limit=1&height=8000&current=accueil', async (page) => {
      // With one place, the first thumbnail made is the editor's screen's, whichever row is nearest.
      await untilDrawn(page, 1);
      const rows = await page.evaluate(() => [...(window as unknown as Win).thumbsApp.drawn.keys()]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]! % 2, 1, 'row 1, 3, 5…: the screen "accueil"');
    });
  });

  test(`thumbnails (${name}): what the relay gives a thumbnail is what it gives the canvas`, PATIENT, async (t) => {
    if (name === 'firefox') return t.skip('a frame of another origin shows as about:blank in Playwright\'s Firefox: the BiDi script looks inside');
    authorFiles.set('assets/poc.js', "console.log('AUTHOR-SCRIPT-RAN');");
    try {
      await withThumbs(name, t, 'rows=2&height=400', async (page) => {
        const heard: string[] = [];
        page.on('console', (message) => heard.push(message.text()));
        await untilDrawn(page, 2);
        const frame = thumbFrames(page)[0]!;
        const outcome = await frame.evaluate(async () => {
          const status = async (url: string) => (await fetch(url)).status;
          const script = await new Promise((resolve) => { const element = document.createElement('script'); element.src = '/canvas/assets/poc.js'; element.onload = () => resolve('loaded'); element.onerror = () => resolve('refused'); document.head.append(element); setTimeout(() => resolve('timeout'), 5000); });
          return { course: await status('/canvas/course.json'), frame: await status('/canvas/objects/diagnostic-reseau/frame.html'), code: await status('/canvas/objects/diagnostic-reseau/object.js'), script };
        });
        assert.deepEqual(outcome, { course: 200, frame: 403, code: 403, script: 'refused' }, 'a file is served to what reads it; an object\'s page and code, and an author\'s script, are not given to a thumbnail');
        assert.deepEqual(heard.filter((text) => text.includes('AUTHOR-SCRIPT-RAN')), []);
      });
    } finally { authorFiles.clear(); }
  });

  test(`thumbnails (${name}): a screen is measured in a frame kept in the view, whatever the browser`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=1', async (page) => {
      const first = await page.evaluate(() => (window as unknown as Win).thumbsApp.measure('accueil', null));
      assert.ok(first && typeof first.overflow === 'number' && Array.isArray(first.fields), JSON.stringify(first));
      const second = await page.evaluate(() => (window as unknown as Win).thumbsApp.measure('simulation', 'en'));
      assert.ok(second && typeof second.overflow === 'number', JSON.stringify(second));
    });
  });

  test(`thumbnails (${name}): a block's preview shows the part of the screen around the block, the block alone for the list, and says whether the slide runs past the window`, PATIENT, async (t) => {
    for (const slides of [false, true]) {
      // A slide of 1280 × 300 the screen runs past; a scrolling course never does.
      await withThumbs(name, t, `rows=1&slides=${slides ? 1 : 0}&page=300`, async (page) => {
        // The picker's preview has the course's proportions; the list's box is 48 × 32.
        const sizes = { preview: { width: 320, height: 75 }, mini: { width: 48, height: 32 } };
        const preview = await page.evaluate((size) => (window as unknown as Win).thumbsApp.showBlock('accueil', false, size.width, size.height), sizes.preview);
        const mini = await page.evaluate((size) => (window as unknown as Win).thumbsApp.showBlock('accueil', true, size.width, size.height), sizes.mini);
        assert.equal(preview.drawn, true);
        assert.equal(mini.drawn, true);
        assert.equal(preview.overflow, slides, 'the slide runs past the window');
        // Inside each frame (not in Playwright's Firefox, where a frame of another origin shows as about:blank): where the block is.
        if (name === 'firefox') return;
        for (const [shown, size, small] of [[preview, sizes.preview, false], [mini, sizes.mini, true]] as const) {
          const frame = (await Promise.all(thumbFrames(page).map(async (each) => ({ each, mine: await (await each.frameElement()).evaluate((node, wanted) => ((node as Element).closest('.block-preview') as HTMLElement | null)?.style.width === wanted, `${size.width}px`) })))).find((one) => one.mine)!.each;
          const inside = await frame.evaluate(() => {
            const box = document.querySelector('[data-block="accueil-objectifs"]')!.getBoundingClientRect();
            return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, runsPast: document.documentElement.scrollHeight - innerHeight > 4 };
          });
          assert.equal(inside.runsPast, true, 'the page runs past its window');
          const [x, y, scale] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([\d.e]+)\)/.exec(shown.transform ?? '')!.slice(1).map(Number) as [number, number, number];
          const seen = { left: inside.box.x * scale + x, top: inside.box.y * scale + y, right: (inside.box.x + inside.box.width) * scale + x, bottom: (inside.box.y + inside.box.height) * scale + y };
          if (!small) {
            // The block whole, with some of the screen around it, larger than the whole page scaled to the element would show it.
            assert.ok(seen.left > 0 && seen.top > 0 && seen.right < size.width && seen.bottom < size.height, `the block is inside its preview: ${JSON.stringify(seen)}`);
            assert.ok(scale > size.width / 1280, 'the preview is closer than the whole page');
          } else {
            // The block alone fills the list's small box (a long block its start).
            assert.ok(seen.left <= 1 && seen.top <= 1 && (seen.right >= size.width - 1 || seen.bottom >= size.height - 1), `the block fills its mini: ${JSON.stringify(seen)}`);
          }
        }
      });
    }
  });

  test(`thumbnails (${name}): a miniature at rest moves nothing: an author's animation that wins over the page's rule, an SVG's SMIL and a GIF are held still once its screen is drawn`, PATIENT, async (t) => {
    if (name === 'firefox') return t.skip('a frame of another origin shows as about:blank in Playwright\'s Firefox: what is inside is looked at in Chromium and WebKit');
    await withThumbs(name, t, 'rows=1&refresh=0', async (page) => {
      await untilDrawn(page, 1);
      const frame = thumbFrames(page)[0]!;
      // What a course could bring: a rule more specific than the page's, with !important; SMIL kept in an inline SVG; a GIF.
      await frame.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = '@keyframes turn { to { rotate: 1turn } } html body div#moving.moving { animation: turn 1s linear infinite !important }';
        const moving = Object.assign(document.createElement('div'), { id: 'moving', className: 'moving' });
        const holder = document.createElement('div');
        holder.innerHTML = '<svg id="smil" viewBox="0 0 10 10"><circle cx="2" cy="5" r="2"><animate attributeName="cx" values="2;8;2" dur="1s" repeatCount="indefinite"/></circle></svg><img id="gif" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">';
        document.head.append(style);
        document.body.append(moving, holder);
      });
      await frame.waitForFunction(() => (document.getElementById('gif') as HTMLImageElement).complete);
      const state = () => frame.evaluate(() => ({
        running: document.getAnimations().filter((animation) => animation.playState === 'running').length,
        smil: !(document.getElementById('smil') as unknown as SVGSVGElement).animationsPaused(),
        gif: (document.getElementById('gif') as HTMLImageElement).src.startsWith('data:image/gif')
      }));
      assert.deepEqual(await state(), { running: 1, smil: true, gif: true }, 'they move before a screen is drawn');
      // The screen drawn again (a new version).
      const before = await page.evaluate(() => (window as unknown as Win).thumbsApp.calls.length);
      await page.evaluate(() => { const app = (window as unknown as Win).thumbsApp; app.bump('simulation'); app.bump('accueil'); app.refresh(0); });
      await page.waitForFunction((count) => (window as unknown as Win).thumbsApp.calls.length > count, before, { timeout: 15000 });
      await frame.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'), null, { timeout: 15000 });
      assert.deepEqual(await state(), { running: 0, smil: false, gif: false }, 'held still once the screen is drawn');
    });
  });

  test(`thumbnails (${name}): a frame that does not answer is made again twice, then its place is freed and the skeleton stays until the scene is refreshed`, PATIENT, async (t) => {
    // Every answer waited for 1 ms: no frame ever says its screen is shown.
    await withThumbs(name, t, 'rows=1&timeout=1', async (page) => {
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.drawn.get(0) === false, null, { timeout: 30000 });
      const state = () => page.evaluate(() => ({ live: (window as unknown as Win).thumbsApp.live, made: (window as unknown as Win).thumbsApp.calls.length, frames: (window as unknown as Win).thumbsApp.frames().length }));
      const given = await state();
      assert.deepEqual([given.live, given.frames], [0, 0], 'its place is freed, no frame is left');
      assert.equal(given.made, 3, 'three frames made, each with its render: the first and two more');
      await page.waitForTimeout(1500);
      assert.equal((await state()).made, 3, 'then nothing more');
      // The scene refreshed: tried again.
      await page.evaluate(() => (window as unknown as Win).thumbsApp.refresh(0));
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.calls.length > 3, null, { timeout: 15000 });
    });
  });

  test(`thumbnails (${name}): in a hidden tab nothing is drawn: a refresh waits, and the tab seen again draws what changed and what waited`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=12&width=1000&height=880&row=192&limit=8&refresh=0', async (page) => {
      await untilDrawn(page, 8);
      // The tab hidden, as the browser says it (a headless page is never hidden by itself).
      const hide = (state: 'hidden' | 'visible') => page.evaluate((state) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state }); document.dispatchEvent(new Event('visibilitychange')); }, state);
      await hide('hidden');
      const calls = () => page.evaluate(() => (window as unknown as Win).thumbsApp.calls.length);
      const before = await calls();
      await page.evaluate(() => { const app = (window as unknown as Win).thumbsApp; app.bump('simulation'); app.bump('accueil'); app.refresh(0); app.release(1); });
      await page.waitForTimeout(800);
      assert.equal(await calls(), before, 'nothing asked while the tab is hidden: neither the refresh nor the place freed');
      await hide('visible');
      await page.waitForFunction((count) => (window as unknown as Win).thumbsApp.calls.length >= count + 2, before, { timeout: 15000 });
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.drawn.get(8) === true, null, { timeout: 30000 });
    });
  });

  test(`thumbnails (${name}): a view of more miniatures than places draws them in reading order, and a place freed goes to the next`, PATIENT, async (t) => {
    // A grid of five columns and four lines, all in the view (a Planche, a Storyboard).
    await withThumbs(name, t, 'rows=20&width=1000&height=880&row=192&limit=8', async (page) => {
      const drawnRows = () => page.evaluate(() => [...(window as unknown as Win).thumbsApp.drawn.entries()].filter(([, ok]) => ok).map(([index]) => index).sort((a, b) => a - b));
      await untilDrawn(page, 8);
      await page.waitForTimeout(400);
      assert.deepEqual(await drawnRows(), [0, 1, 2, 3, 4, 5, 6, 7], 'the first eight as the eye reads them');
      await page.evaluate(() => { for (const index of [0, 1, 2, 3]) (window as unknown as Win).thumbsApp.release(index); });
      await page.waitForFunction(() => [8, 9, 10, 11].every((index) => (window as unknown as Win).thumbsApp.drawn.get(index) === true), null, { timeout: 30000 });
      assert.deepEqual(await drawnRows(), [4, 5, 6, 7, 8, 9, 10, 11]);
    });
  });

  test(`thumbnails (${name}): a block's preview opened over a view whose every place is held takes the place of the last miniature in reading order, which is drawn again once the preview goes`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=8&height=800&limit=8', async (page) => {
      await untilDrawn(page, 8);
      const rowsFramed = () => page.evaluate(() => (window as unknown as Win).thumbsApp.frames().filter((frame) => frame.parent !== null).length);
      assert.equal(await rowsFramed(), 8);
      const preview = await page.evaluate(() => (window as unknown as Win).thumbsApp.showBlock('accueil', false, 320, 180));
      assert.equal(preview.drawn, true, 'the preview is drawn');
      assert.ok(await page.evaluate(() => (window as unknown as Win).thumbsApp.live) <= 8, 'never more than the limit');
      assert.equal(await rowsFramed(), 7, 'one miniature gave its place');
      await page.evaluate(() => (window as unknown as Win).thumbsApp.releaseBlocks());
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.frames().filter((frame) => frame.parent !== null).length === 8, null, { timeout: 30000 });
    });
  });

  // ── Images by a painter (D139) ──────────────────────────────────────────────────────────────────
  const pictures = (page: Page) => page.evaluate(() => (window as unknown as Win).thumbsApp.pictures());

  test(`thumbnails (${name}): with the painter, the rows in view are images drawn by one frame that loads its page once, rows of one scene share one image, and no row has a frame`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=8&height=800&images=1', async (page) => {
      await untilDrawn(page, 8);
      const shown = await pictures(page);
      assert.ok(shown.every((source) => source?.startsWith('blob:')), JSON.stringify(shown));
      // The stand-in's rows show two screens in turn: one image each.
      assert.equal(new Set(shown).size, 2);
      assert.equal((await page.evaluate(() => (window as unknown as Win).thumbsApp.frames())).length, 0, 'no frame in a row');
      assert.deepEqual(await page.evaluate(() => [(window as unknown as Win).thumbsApp.frameCount(), (window as unknown as Win).thumbsApp.pageLoads]), [1, 1], 'one painter, its page loaded once');
      assert.deepEqual(await page.evaluate(() => (window as unknown as Win).thumbsApp.logs), []);
    });
  });

  test(`thumbnails (${name}): with the painter, a retouch draws again only its screen's image, in the same painter`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=8&height=800&images=1', async (page) => {
      await untilDrawn(page, 8);
      const before = await pictures(page);
      await page.evaluate(() => { const app = (window as unknown as Win).thumbsApp; app.bump('simulation'); for (let index = 0; index < 8; index++) app.refresh(index); });
      await page.waitForFunction((first) => (window as unknown as Win).thumbsApp.pictures()[0] !== first, before[0], { timeout: 30000 });
      await page.waitForTimeout(500);
      const after = await pictures(page);
      for (let index = 0; index < 8; index++) {
        if (index % 2 === 0) assert.notEqual(after[index], before[index], `row ${index} (simulation) drawn again`);
        else assert.equal(after[index], before[index], `row ${index} (accueil) kept`);
      }
      assert.equal(await page.evaluate(() => (window as unknown as Win).thumbsApp.pageLoads), 1);
    });
  });

  test(`thumbnails (${name}): with the painter, a painter is made again after eight pictures, but in WebKit, where it lives as long as the miniatures`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=2&height=800&images=1', async (page) => {
      await untilDrawn(page, 2);
      // Two pictures, then four retouches of both screens: ten.
      for (let round = 0; round < 4; round++) {
        const before = await pictures(page);
        await page.evaluate(() => { const app = (window as unknown as Win).thumbsApp; app.bump('accueil'); app.bump('simulation'); app.refresh(0); app.refresh(1); });
        await page.waitForFunction((was) => { const now = (window as unknown as Win).thumbsApp.pictures(); return now[0] !== was[0] && now[1] !== was[1]; }, before, { timeout: 30000 });
      }
      assert.equal(await page.evaluate(() => (window as unknown as Win).thumbsApp.pageLoads), name === 'webkit' ? 1 : 2);
      assert.deepEqual(await page.evaluate(() => (window as unknown as Win).thumbsApp.logs), []);
    });
  });

  test(`thumbnails (${name}): with the painter, a block's preview is an image of the part around the block, the block alone for the list, and says whether the slide runs past the window`, PATIENT, async (t) => {
    for (const slides of [false, true]) {
      await withThumbs(name, t, `rows=1&slides=${slides ? 1 : 0}&page=300&images=1`, async (page) => {
        const preview = await page.evaluate(() => (window as unknown as Win).thumbsApp.showBlock('accueil', false, 320, 75));
        const mini = await page.evaluate(() => (window as unknown as Win).thumbsApp.showBlock('accueil', true, 48, 32));
        assert.equal(preview.drawn, true);
        assert.equal(mini.drawn, true);
        assert.equal(preview.overflow, slides, 'the slide runs past the window');
        // The preview at the window's proportions (1280 × 300), 640 px wide; the block alone, 96 px wide.
        assert.equal(preview.picture?.width, 640);
        assert.ok(Math.abs(preview.picture!.height - 150) <= 1, JSON.stringify(preview.picture));
        assert.equal(mini.picture?.width, 96);
      });
    }
  });

  test(`thumbnails (${name}): with the painter, nothing is drawn in a hidden tab, and the tab seen again draws what changed`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=2&height=800&images=1', async (page) => {
      await untilDrawn(page, 2);
      const before = await pictures(page);
      const hide = (state: 'hidden' | 'visible') => page.evaluate((state) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state }); document.dispatchEvent(new Event('visibilitychange')); }, state);
      await hide('hidden');
      await page.evaluate(() => { const app = (window as unknown as Win).thumbsApp; app.bump('simulation'); app.refresh(0); });
      await page.waitForTimeout(1000);
      assert.deepEqual(await pictures(page), before, 'nothing drawn while hidden');
      await hide('visible');
      await page.waitForFunction((first) => (window as unknown as Win).thumbsApp.pictures()[0] !== first, before[0], { timeout: 30000 });
    });
  });

  test(`thumbnails (${name}): a painter that fails twice in a row says so in the log and hands the scenes to live frames`, PATIENT, async (t) => {
    // Every answer waited for 1 ms: the painter never gives an image.
    await withThumbs(name, t, 'rows=2&height=800&images=1&timeout=1', async (page) => {
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.logs.some((line) => line.includes('live frames')), null, { timeout: 30000 });
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.calls.length > 2, null, { timeout: 30000 });
      const logs = await page.evaluate(() => (window as unknown as Win).thumbsApp.logs);
      assert.ok(logs.some((line) => /failed 2 times in a row/.test(line)), JSON.stringify(logs));
    });
  });

  test(`thumbnails (${name}): a painter whose route does not open keeps no image drawn without the module's files`, PATIENT, async (t) => {
    // The relay's port is refused: the page would draw its screens without their files.
    await withThumbs(name, t, 'rows=2&height=800&images=1&noport=1', async (page) => {
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.logs.some((line) => line.includes('live frames')), null, { timeout: 60000 });
      const logs = await page.evaluate(() => (window as unknown as Win).thumbsApp.logs);
      assert.ok(logs.some((line) => /could not have the module's files/.test(line)), JSON.stringify(logs));
      assert.ok((await pictures(page)).every((source) => source === null), 'no image kept');
    });
  });

  test(`thumbnails (${name}): a page whose policy refuses the painter's images shows no broken image: it says so and turns to live frames`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=2&height=800&images=1&policy=noblob', async (page) => {
      await page.waitForFunction(() => (window as unknown as Win).thumbsApp.logs.some((line) => line.includes('live frames')), null, { timeout: 60000 });
      const logs = await page.evaluate(() => (window as unknown as Win).thumbsApp.logs);
      assert.ok(logs.some((line) => /could not show the image/.test(line)), JSON.stringify(logs));
      await untilDrawn(page, 2);
      assert.deepEqual(await pictures(page), [null, null], 'no image in a row');
    });
  });

  test(`thumbnails (${name}): with the engine's renders, each screen of a module is drawn with its files, and measured with its fields`, { timeout: 300000 }, async (t) => {
    if (name === 'firefox') return t.skip('a frame of another origin shows as about:blank in Playwright\'s Firefox, and a frame after the first gets no relay: the BiDi script looks inside');
    const hosts = await startHosts(handlers());
    // A profile on disk: the engine keeps its copy in the origin's private file system, which a throwaway profile has none of in WebKit.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-thumbs-engine-'));
    let context: BrowserContext | null = null;
    try {
      context = await ({ chromium, chrome: chromium, webkit } as Record<string, typeof webkit>)[name]!.launchPersistentContext(profile, { headless: true, ...(name === 'chrome' ? { channel: 'chrome' } : {}), proxy: { server: `http://127.0.0.1:${hosts.proxyPort}` }, ignoreHTTPSErrors: true, args: name === 'chromium' || name === 'chrome' ? ['--ignore-certificate-errors'] : [], viewport: { width: 1000, height: 900 }, serviceWorkers: 'allow' });
    } catch (error) {
      hosts.close();
      fs.rmSync(profile, { recursive: true, force: true });
      return t.skip(`${name} is not here: ${String(error).split('\n')[0]}`);
    }
    try {
      const { files } = readProjectFiles(EXAMPLE);
      for (const [rel, file] of files) if (file.kind === 'binary' && file.hash) engineMedia.set(file.hash, fs.readFileSync(path.join(EXAMPLE, rel)));
      const screens = [...files.keys()].map((rel) => /^screens\/([^/]+)\.json$/.exec(rel)?.[1]).filter((screen): screen is string => !!screen).sort();
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(`${APP}/thumbs?engine=1&height=800`);
      await page.waitForFunction(() => !!(window as unknown as Win).thumbsApp, null, { timeout: 30000 });
      const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };
      await page.evaluate(({ seed, screens }) => (window as unknown as Win).thumbsApp.startEngine(seed, screens), { seed: { link, confirmed: [...files] }, screens });
      await untilDrawn(page, screens.length);
      assert.equal(await drawnCount(page), screens.length, 'every row drawn');
      // Inside each frame: the screen the engine rendered, and its pictures loaded through the frame's own route (the files its render named).
      const inside = await Promise.all(thumbFrames(page).map((frame) => frame.evaluate(() => ({
        screen: (window as unknown as { __elaboraCanvas: { screen: string | null } }).__elaboraCanvas.screen,
        pictures: [...document.querySelectorAll('img')].map((image) => ({ src: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0 }))
      }))));
      assert.deepEqual(inside.map((each) => each.screen).sort(), screens);
      const pictures = inside.flatMap((each) => each.pictures);
      assert.ok(pictures.length >= 2, `the module's screens show pictures: ${JSON.stringify(inside)}`);
      assert.deepEqual(pictures.filter((picture) => !picture.loaded), [], 'every picture loaded');
      // The measure: the screen's render with its fields (measureRender), measured in a frame of its own.
      const measured = await page.evaluate((screen) => (window as unknown as Win).thumbsApp.measure(screen, null), screens[0]!);
      assert.ok(measured && typeof measured.overflow === 'number' && measured.fields.length > 0, JSON.stringify(measured));
    } finally {
      engineMedia.clear();
      await context.close();
      hosts.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });

  test(`thumbnails (${name}): with the painter, a block's preview in a modal layer shows the layer, which the browser draws outside the page's root`, { timeout: 200000 }, async (t) => {
    const engines = { chromium, chrome: chromium, webkit, firefox } as Record<string, typeof webkit>;
    const hosts = await startHosts(handlers());
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-thumbs-engine-'));
    let context: BrowserContext;
    try {
      context = await engines[name]!.launchPersistentContext(profile, { headless: true, ...(name === 'chrome' ? { channel: 'chrome' } : {}), proxy: { server: `http://127.0.0.1:${hosts.proxyPort}` }, ignoreHTTPSErrors: true, args: name === 'chromium' || name === 'chrome' ? ['--ignore-certificate-errors'] : [], viewport: { width: 1000, height: 900 }, serviceWorkers: 'allow' });
    } catch (error) {
      hosts.close();
      fs.rmSync(profile, { recursive: true, force: true });
      return t.skip(`${name} is not here: ${String(error).split('\n')[0]}`);
    }
    try {
      const { files } = readProjectFiles(EXAMPLE);
      for (const [rel, file] of files) if (file.kind === 'binary' && file.hash) engineMedia.set(file.hash, fs.readFileSync(path.join(EXAMPLE, rel)));
      const page = await context.newPage();
      await page.goto(`${APP}/thumbs?engine=1&height=200&width=1000&row=40&images=1`);
      await page.waitForFunction(() => !!(window as unknown as Win).thumbsApp, null, { timeout: 30000 });
      const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };
      await page.evaluate(({ seed }) => (window as unknown as Win).thumbsApp.startEngine(seed, []), { seed: { link, confirmed: [...files] } });
      // The same block added after the screen's first, in the screen, then in its layer (diagnostic-reseau's « rappel-regle », modal).
      const block = { type: 'text', props: { text: 'Un bloc' } };
      const shots: Buffer[] = [];
      for (const args of [{ block }, { block, layer: 'rappel-regle' }]) {
        await page.evaluate(() => (window as unknown as Win).thumbsApp.releaseBlocks());
        const shown = await page.evaluate((a) => (window as unknown as Win).thumbsApp.showBlock('premier-reflexe', false, 640, 360, a), args);
        assert.ok(shown.drawn && shown.picture, JSON.stringify(shown));
        // Past the image's fade in.
        await page.waitForTimeout(300);
        shots.push(await page.locator('.block-preview').first().screenshot());
      }
      assert.deepEqual(await page.evaluate(() => (window as unknown as Win).thumbsApp.logs), []);
      // The share of pixels more than 48/255 apart: the layer and its backdrop cover most of the preview.
      const share = await page.evaluate(async ([a, b]) => {
        const pixels = async (data: string) => { const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob(), { resizeWidth: 320, resizeHeight: 180 }); const canvas = new OffscreenCanvas(320, 180); const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); return context.getImageData(0, 0, 320, 180).data; };
        const [x, y] = [await pixels(a!), await pixels(b!)];
        let apart = 0;
        for (let i = 0; i < x.length; i += 4) if (Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!)) > 48) apart++;
        return apart / (x.length / 4);
      }, [shots[0]!.toString('base64'), shots[1]!.toString('base64')]);
      assert.ok(share > 0.3, `the preview in the layer is the screen's but for ${(share * 100).toFixed(1)} % of its pixels`);
    } finally {
      engineMedia.clear();
      await context.close();
      hosts.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });

  test(`thumbnails (${name}): fidelity: each screen of three modules (photos, veils and masks; a charter's statement screens) as the painter's image is the live frame's, but for a few pixels`, { timeout: 400000 }, async (t) => {
    // Firefox's live frames show nothing in Playwright (a frame of another origin is about:blank): its images are held to Chromium's.
    const live = name === 'firefox' ? 'chromium' : name;
    const engines = { chromium, chrome: chromium, webkit, firefox } as Record<string, typeof webkit>;
    const hosts = await startHosts(handlers());
    try {
      for (const module of [EXAMPLE, path.join(ROOT, 'examples/coffee-in-brief'), path.join(ROOT, 'templates/watercolor')]) {
        engineMedia.clear();
        const { files } = readProjectFiles(module);
        for (const [rel, file] of files) if (file.kind === 'binary' && file.hash) engineMedia.set(file.hash, fs.readFileSync(path.join(module, rel)));
        const screens = [...files.keys()].map((rel) => /^screens\/([^/]+)\.json$/.exec(rel)?.[1]).filter((screen): screen is string => !!screen).sort();
        // The same screens in two lists of the same size, all in view: live frames, then images; the images' browser compares them.
        let shots: Buffer[] = [];
        for (const [browser, images] of [[live, 0], [name, 1]] as const) {
          // A profile on disk for each list: the engine keeps its copy in the origin's private file system (which a throwaway profile has
          // none of in WebKit), and a module opened again there would find the copy of the one before.
          const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-thumbs-engine-'));
          let context: BrowserContext;
          try {
            context = await engines[browser]!.launchPersistentContext(profile, { headless: true, ...(browser === 'chrome' ? { channel: 'chrome' } : {}), proxy: { server: `http://127.0.0.1:${hosts.proxyPort}` }, ignoreHTTPSErrors: true, args: browser === 'chromium' || browser === 'chrome' ? ['--ignore-certificate-errors'] : [], viewport: { width: 1000, height: 1400 }, serviceWorkers: 'allow' });
          } catch (error) {
            fs.rmSync(profile, { recursive: true, force: true });
            return t.skip(`${browser} is not here: ${String(error).split('\n')[0]}`);
          }
          try {
            const page = await context.newPage();
            // As many live frames as screens (a template has 14), so that the reference draws them all at once.
            await page.goto(`${APP}/thumbs?engine=1&height=1380&width=1000&row=320&limit=16&images=${images}`);
            await page.waitForFunction(() => !!(window as unknown as Win).thumbsApp, null, { timeout: 30000 });
            const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };
            await page.evaluate(({ seed, screens }) => (window as unknown as Win).thumbsApp.startEngine(seed, screens), { seed: { link, confirmed: [...files] }, screens });
            await untilDrawn(page, screens.length);
            await page.waitForTimeout(images ? 300 : 800);
            const rows = page.locator('.row');
            const taken = await Promise.all(screens.map((_, index) => rows.nth(index).screenshot()));
            if (!images) { shots = taken; continue; }
            // The share of pixels more than 48/255 apart on a channel, both drawn at 320 × 180 (the canvas compares them).
            const shares: number[] = [];
            for (const [index, screen] of screens.entries()) {
              const share = await page.evaluate(async ([a, b]) => {
                const pixels = async (data: string) => { const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob(), { resizeWidth: 320, resizeHeight: 180 }); const canvas = new OffscreenCanvas(320, 180); const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); return context.getImageData(0, 0, 320, 180).data; };
                const [x, y] = [await pixels(a!), await pixels(b!)];
                let apart = 0;
                for (let i = 0; i < x.length; i += 4) if (Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!)) > 48) apart++;
                return apart / (x.length / 4);
              }, [shots[index]!.toString('base64'), taken[index]!.toString('base64')]);
              assert.ok(share < 0.06, `${path.basename(module)} ${screen}: ${(share * 100).toFixed(1)} % of the pixels apart`);
              shares.push(share);
            }
            // Over a module, text lost on a plain page shows (a charter's statements without their words: 2.4 % on average, against
            // 1 % at most between engines).
            const mean = shares.reduce((sum, share) => sum + share, 0) / shares.length;
            assert.ok(mean < 0.015, `${path.basename(module)}: ${(mean * 100).toFixed(2)} % of the pixels apart on average`);
          } finally {
            await context.close();
            fs.rmSync(profile, { recursive: true, force: true });
          }
        }
      }
    } finally {
      engineMedia.clear();
      hosts.close();
    }
  });
}
