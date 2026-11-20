import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHosts } from '../relay-hosts.ts';
import { launch } from '../relay-browsers.ts';
import { APP, CANVAS, FRAMES, MODULES, handlers } from '../relay-site.ts';

// Several views of one module in a tab, one after the other (a layer is another view; so is the way back): each has its host,
// its canvas page and its hidden relay page, the one before closed. Each must be drawn, in every browser: the first render of a
// view waits for its relay pages (D121), and a page that never reports its relay would leave the canvas white.
// ELABORA_RELAY_BROWSERS picks the browsers (Chromium by default; Firefox is Playwright's, found in PLAYWRIGHT_BROWSERS_PATH).
const wanted = (process.env.ELABORA_RELAY_BROWSERS ?? 'chromium').split(',').map((name) => name.trim()).filter(Boolean);

for (const name of wanted) {
  test(`relay views (${name}): a second view of the module, then the way back, are each drawn`, { timeout: 300000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const browser = await launch(name, hosts);
    if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
    try {
      const page = await context.newPage();
      if (process.env.RELAY_DEBUG) page.on('console', (message) => console.log('[console]', message.type(), message.text().slice(0, 200)));
      await page.goto(`${APP}/?module=a&canvas=${encodeURIComponent(CANVAS)}&frames=${encodeURIComponent(FRAMES)}`);
      await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app, null, { timeout: 30000 });
      const screen = MODULES.a!.screen;
      const drawn = async (view: string) => {
        const id = await page.evaluate((shown) => (window as unknown as { app: { show(screen: string): Promise<number> } }).app.show(shown), screen);
        try {
          await page.waitForFunction((wanted) => (window as unknown as { app: { messages: Array<{ type: string; id?: unknown }> } }).app.messages.some((message) => message.type === 'elabora/layout' && message.id === wanted), id, { timeout: 30000 });
        } catch (error) {
          const state = await page.evaluate(() => { const app = (window as unknown as { app: { log: unknown[]; messages: unknown[]; host: { relays(): unknown } } }).app; return { log: app.log.slice(-8), relays: app.host.relays(), messages: app.messages.length }; });
          throw new Error(`${view}: not drawn (${String(error).split('\n')[0]}) ${JSON.stringify(state)}`);
        }
      };
      await drawn('the first view');
      for (const view of ['a second view', 'the way back', 'a third view']) {
        await page.evaluate(() => (window as unknown as { app: { newView(): void } }).app.newView());
        await drawn(view);
      }
      // Each relay page of the last view says where it is: open, or why it is not (Playwright's Firefox does not give a page to a service worker
      // after the first load: the page says so, and the render is not held for it for ever).
      const relays = await page.evaluate(() => (window as unknown as { app: { host: { relays(): Record<string, { opened: boolean; error: string | null }> } } }).app.host.relays());
      for (const [host, relay] of Object.entries(relays)) assert.ok(relay.opened || (relay.error && relay.error.length > 0), `${host}: neither open nor said why not: ${JSON.stringify(relay)}`);
      if (name !== 'firefox') assert.deepEqual(Object.values(relays).map((relay) => [relay.opened, relay.error]), [[true, null], [true, null]]);
    } finally {
      await context.close();
      await browser.close();
      hosts.close();
    }
  });
}
