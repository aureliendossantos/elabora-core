import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { startHosts } from '../relay-hosts.ts';
import { launch } from '../relay-browsers.ts';
import { APP, CANVAS, FRAMES, authorFiles, handlers } from '../relay-site.ts';

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
  loads: number;
  live: number;
  frames(): Array<{ src: string; sandbox: string | null; inert: boolean; ariaHidden: string | null; parent: string | null }>;
  bump(screen: string): void;
  refresh(index: number): void;
  release(index: number): void;
  scrollTo(top: number): void;
  setCurrent(screen: string | null): void;
  measure(screen: string, language: string | null): Promise<{ overflow: number; fields: unknown[] } | null>;
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

  test(`thumbnails (${name}): a list scrolled shows the rows in view, and frees the rows that left`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=40&height=300', async (page) => {
      await untilDrawn(page, 1);
      const first = await page.evaluate(() => [...(window as unknown as Win).thumbsApp.drawn.keys()].sort((a, b) => a - b));
      assert.ok(first.length >= 1 && first.length <= 16 && Math.max(...first) < 20, JSON.stringify(first));
      await page.evaluate(() => (window as unknown as Win).thumbsApp.scrollTo(1500));
      await page.waitForFunction(() => { const keys = [...(window as unknown as Win).thumbsApp.drawn.entries()].filter(([, ok]) => ok).map(([index]) => index); return keys.length > 0 && Math.min(...keys) > 15; }, null, { timeout: 90000 });
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => ({ drawn: [...(window as unknown as Win).thumbsApp.drawn.keys()], frames: (window as unknown as Win).thumbsApp.frames().map((frame) => Number(frame.parent)) }));
      assert.ok(after.frames.every((index) => index > 12), `only the rows now in view hold a frame: ${JSON.stringify(after)}`);
      assert.ok(after.frames.length <= 16);
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

  test(`thumbnails (${name}): a released thumbnail's frame goes, and its place is free`, PATIENT, async (t) => {
    await withThumbs(name, t, 'rows=4&limit=4', async (page) => {
      await untilDrawn(page, 4);
      await page.evaluate(() => (window as unknown as Win).thumbsApp.release(1));
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
}
