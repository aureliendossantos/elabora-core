import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { startHosts } from '../relay-hosts.ts';
import { canvasFrame, launch } from '../relay-browsers.ts';
import { APP, CANVAS, FRAMES, MODULES, SPACE, handlers } from '../relay-site.ts';

// The Lecteur's preview in a browser (chrome=live): the canvas page with the player's bars working, in a frame whose sandbox lets a link
// of the course open in a tab of its own, out of the sandbox, and a file download; the editor's canvas opens no window. ELABORA_RELAY_BROWSERS
// picks the browsers (Chromium alone by default; Playwright's Firefox does not show what is inside such a frame).
const wanted = (process.env.ELABORA_RELAY_BROWSERS ?? 'chromium').split(',').map((name) => name.trim()).filter(Boolean);

async function open(page: Page, live: boolean): Promise<void> {
  await page.goto(`${APP}/?module=a&canvas=${encodeURIComponent(CANVAS)}&frames=${encodeURIComponent(FRAMES)}${live ? '&chrome=live' : ''}`);
  await page.waitForFunction(() => (window as unknown as { app?: { log: Array<{ type: string }> } }).app?.log.filter((message) => message.type === 'relay/opened').length === 2, null, { timeout: 30000 });
  const id = await page.evaluate((screen) => (window as unknown as { app: { show(screen: string): Promise<number> } }).app.show(screen), MODULES.a!.screen);
  for (let i = 0; i < 100 && !canvasFrame(page); i++) await page.waitForTimeout(100);
  await canvasFrame(page).waitForFunction((wanted) => (window as unknown as { __elaboraCanvas: { layout(): { id: unknown } } }).__elaboraCanvas.layout().id === wanted, id, { timeout: 30000 });
}
// A link of the course, clicked in the canvas page: the address of the tab it opened, and that tab's origin (null when it is sandboxed).
async function follow(page: Page): Promise<{ opened: boolean; origin: string | null }> {
  const popup = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await canvasFrame(page).evaluate((href) => { const link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'lien'; document.body.append(link); link.click(); }, `${SPACE}/`);
  const opened = await popup;
  if (!opened) return { opened: false, origin: null };
  await opened.waitForLoadState('load').catch(() => undefined);
  const origin = await opened.evaluate(() => origin).catch(() => null);
  await opened.close();
  return { opened: true, origin };
}

for (const name of wanted) {
  test(`relay preview (${name}): the Lecteur's frame shows the player's bars and opens a link of the course in a tab of its own, out of the sandbox; the editor's canvas opens none`, { timeout: 300000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const browser = await launch(name, hosts);
    if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
    try {
      const live = await context.newPage();
      await open(live, true);
      const frame = await live.evaluate(() => { const element = document.getElementById('canvas')!; return { sandbox: element.getAttribute('sandbox'), chrome: new URL((element as HTMLIFrameElement).src).searchParams.get('chrome') }; });
      assert.deepEqual(frame, { sandbox: 'allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-downloads', chrome: 'live' });
      const ready = await live.evaluate(() => (window as unknown as { app: { messages: Array<{ type: string; chrome?: string; protocol?: string }> } }).app.messages.filter((message) => message.type === 'elabora/ready').at(-1));
      assert.deepEqual({ chrome: ready?.chrome, protocol: ready?.protocol }, { chrome: 'live', protocol: 'elabora-player-preview/1' });
      assert.deepEqual(await follow(live), { opened: true, origin: SPACE }, 'a link of the course opens in a tab of its own, not sandboxed');

      const editor = await context.newPage();
      await open(editor, false);
      assert.equal(await editor.evaluate(() => document.getElementById('canvas')!.getAttribute('sandbox')), 'allow-scripts allow-same-origin allow-pointer-lock');
      assert.deepEqual(await follow(editor), { opened: false, origin: null }, 'the editor\'s canvas opens no window');
    } finally {
      await context.close();
      await browser.close();
      hosts.close();
    }
  });
}
