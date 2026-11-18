import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { startCanvasHost } from '@elabora/node/canvas/host';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { CanvasApi } from '@elabora/player/canvas';
import { EXAMPLE } from '../helpers.ts';

type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi };

// A free object's frame loads from the origin the page names (?frames=<origin>), which serves it as the
// canvas host does: allow-same-origin there (a service worker answers a frame of an origin, not an opaque
// one), another origin than the page's; the page's own origin leaves it sandboxed as in a package.
test('canvas: free objects load from the origin of ?frames=, never from the page\'s own', { timeout: 120000 }, async () => {
  const project = loadProjectFromDir(EXAMPLE);
  const render = renderScreen(project, 'simulation', {}, createRenderContext(project));
  const page = await startCanvasHost({ root: project.root });
  const frames = await startCanvasHost({ root: project.root });
  const browser = await launchBrowser('chromium');
  try {
    // The frames host serves what a render lists, as the page's does.
    page.push(render, { id: 1 });
    frames.push(render, { id: 1 });
    const framesOrigin = `http://localhost:${new URL(frames.base).port}`;
    const open = async (origin: string) => {
      const tab = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      await tab.goto(`${page.url}&frames=${encodeURIComponent(origin)}`);
      await tab.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas?.layout().id === 1);
      await tab.waitForSelector('iframe[sandbox]');
      const iframe = await tab.evaluate(() => { const frame = document.querySelector('iframe[sandbox]')!; return { src: frame.getAttribute('src'), sandbox: frame.getAttribute('sandbox') }; });
      const frame = await (await tab.$('iframe[sandbox]'))!.contentFrame();
      await frame!.waitForLoadState('load');
      return { tab, iframe, frame: frame! };
    };

    const away = await open(framesOrigin);
    assert.match(away.iframe.src!, new RegExp(`^${framesOrigin}/canvas/objects/[^/]+/frame\\.html$`));
    assert.match(away.iframe.sandbox!, /allow-scripts/);
    assert.match(away.iframe.sandbox!, /allow-same-origin/);
    assert.equal(await away.frame.evaluate(() => location.origin), framesOrigin);
    assert.notEqual(await away.frame.evaluate(() => location.origin), new URL(page.base).origin);
    // Its code came from there: the object's script is the one the frames host bundled.
    assert.equal(await away.frame.evaluate(() => typeof (window as unknown as { __elaboraObject?: unknown }).__elaboraObject), 'object');

    // The page's own origin as the frames' leaves the frame next to the page, in an opaque sandbox.
    const own = await open(new URL(page.base).origin);
    assert.match(own.iframe.src!, /^objects\/[^/]+\/frame\.html$/);
    assert.doesNotMatch(own.iframe.sandbox!, /allow-same-origin/);
    assert.match(own.frame.url(), new RegExp(`^${new URL(page.base).origin}/canvas/objects/[^/]+/frame\\.html$`));
  } finally {
    await browser.close();
    await page.close();
    await frames.close();
  }
});
