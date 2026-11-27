import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHosts } from '../relay-hosts.ts';
import { canvasFrame, launch } from '../relay-browsers.ts';
import { APP, CANVAS, FRAMES, MODULES, handlers } from '../relay-site.ts';

// A sign-out: what the player keeps on the canvas host and the frames host (its local
// and session storage, which name the modules) is emptied by each host's relay page at the window's request (relay-forget.ts); the
// relay's own files stay kept. ELABORA_RELAY_BROWSERS picks the browsers (Chromium and WebKit by default).
const wanted = (process.env.ELABORA_RELAY_BROWSERS ?? 'chromium,webkit').split(',').map((name) => name.trim()).filter(Boolean);
type Log = Array<{ type: string }>;
type App = { app: { log: Log; show(screen: string): Promise<number>; forget(): Promise<Record<string, boolean>> } };

for (const name of wanted) {
  test(`relay forget (${name}): a preview's progress and the display settings the canvas host keeps are emptied at a sign-out, the relay's files kept`, { timeout: 120000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const browser = await launch(name, hosts);
    if (!browser) { t.skip(`${name} is not here`); hosts.close(); return; }
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'allow' });
    try {
      const page = await context.newPage();
      await page.goto(`${APP}/?module=a&canvas=${encodeURIComponent(CANVAS)}&frames=${encodeURIComponent(FRAMES)}`);
      await page.waitForFunction(() => (window as unknown as Partial<App>).app?.log.filter((message) => message.type === 'relay/opened').length === 2, null, { timeout: 30000 });
      await page.evaluate((screen) => (window as unknown as App).app.show(screen), MODULES.a!.screen);
      for (let i = 0; i < 100 && !canvasFrame(page); i++) await page.waitForTimeout(100);
      const canvas = canvasFrame(page);
      await canvas.waitForFunction(() => document.readyState === 'complete');
      // What the player writes there: a preview's progress (the web adapter's key) and the display settings, by course.
      await canvas.evaluate(() => {
        localStorage.setItem('elabora:web:diagnostic-reseau', JSON.stringify({ location: 'accueil', suspend: '{"seen":["accueil","simulation"]}' }));
        localStorage.setItem('elabora.display:diagnostic-reseau', JSON.stringify({ captions: true }));
        sessionStorage.setItem('elabora:scorm:diagnostic-reseau', '{"cmi.core.lesson_location":"simulation"}');
      });
      const kept = () => canvas.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, relay: (await caches.keys()).filter((cache) => cache.startsWith('elabora-relay-')).length }));
      assert.deepEqual(await kept(), { local: 2, session: 1, relay: 1 });

      const answers = await page.evaluate(() => (window as unknown as App).app.forget());
      assert.deepEqual(answers, { [CANVAS]: true, [FRAMES]: true });
      assert.deepEqual(await kept(), { local: 0, session: 0, relay: 1 }, 'nothing of the modules left, the relay\'s files kept');
    } finally {
      await context.close();
      await browser.close();
      hosts.close();
    }
  });
}
