import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright-core';
import type { BrowserContext } from 'playwright-core';
import { readProjectFiles } from '@elabora/node/project-reader';
import { startHosts } from '../relay-hosts.ts';
import { APP, CANVAS, FRAMES, engineMedia, handlers } from '../relay-site.ts';
import { NETWORK_SAMPLE } from '../helpers.ts';

// The browser engine's Worker with its canvas live, as the web window has it: the canvas service, its renders given to the view's
// host, the relay's ports served by the engine, its media service with its own Worker. Then an edit and a read: each answered, in
// WebKit as in Chromium. CANVAS_SCREEN shows another screen; NO_WAIT edits at once, while the page still takes its files.
const wanted = (process.env.ELABORA_RELAY_BROWSERS ?? 'webkit').split(',').map((name) => name.trim()).filter(Boolean);
const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };

type Answer = { ok: boolean; result?: unknown; error?: unknown } | null;
type App = { app: { startEngine(seed: unknown, services?: string[], mediaWorker?: string): Promise<void>; engine(type: string, params: unknown, ms?: number): Promise<Answer>; log: Array<{ type: string }>; engineEvents: string[] } };

for (const name of wanted) {
  test(`the browser engine with its canvas live (${name}): an edit and a read answered`, { timeout: 300000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-engine-canvas-'));
    let context: BrowserContext | null = null;
    try {
      context = await ({ chromium, webkit } as Record<string, typeof webkit>)[name]!.launchPersistentContext(profile, { headless: true, proxy: { server: `http://127.0.0.1:${hosts.proxyPort}` }, ignoreHTTPSErrors: true, args: name === 'chromium' ? ['--ignore-certificate-errors'] : [], viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
    } catch (error) {
      hosts.close();
      fs.rmSync(profile, { recursive: true, force: true });
      return t.skip(`${name} is not here: ${String(error).split('\n')[0]}`);
    }
    try {
      const { files } = readProjectFiles(NETWORK_SAMPLE);
      for (const [rel, file] of files) if (file.kind === 'binary' && file.hash) engineMedia.set(file.hash, fs.readFileSync(path.join(NETWORK_SAMPLE, rel)));
      const page = context.pages()[0] ?? await context.newPage();
      if (process.env.RELAY_DEBUG) page.on('console', (message) => console.log('[console]', message.text().slice(0, 300)));
      await page.goto(`${APP}/?module=a&canvas=${encodeURIComponent(CANVAS)}&frames=${encodeURIComponent(FRAMES)}&engine=1`);
      await page.waitForFunction(() => !!(window as unknown as Partial<App>).app, null, { timeout: 30000 });
      await page.evaluate(([seed, services]) => (window as unknown as App).app.startEngine(seed, services as string[], `${location.origin}/media-worker.js`), [{ link, confirmed: [...files] }, (process.env.ENGINE_SERVICES ?? 'canvas,media').split(',')] as const);
      await page.waitForFunction(() => (window as unknown as App).app.log.filter((message) => message.type === 'relay/opened').length === 2, null, { timeout: 60000 });
      const ask = (type: string, params: unknown) => page.evaluate(([type, params]) => (window as unknown as App).app.engine(type as string, params), [type, params] as const);
      const summary = await ask('summary', {});
      const screens = (summary?.result as { outline: { screens: { id: string }[] }[] }).outline.flatMap((section) => section.screens.map((one) => one.id));
      const screen = process.env.CANVAS_SCREEN ?? screens[0]!;
      assert.equal((await ask('openCanvas', {}))?.ok, true);
      assert.equal((await ask('canvasView', { screen }))?.ok, true);
      if (!process.env.NO_WAIT) await page.waitForTimeout(3000);
      const edited = await ask('run', { command: 'update_screen', args: { id: screen, title: 'Retouché' } });
      const read = await ask('readScreen', { screen });
      assert.ok((await page.evaluate(() => (window as unknown as App).app.engineEvents)).filter((type) => type === 'canvasRender').length >= 2, 'the screen drawn, then drawn again after the edit');
      assert.ok(edited?.ok, `the edit is answered: ${JSON.stringify(edited)}`);
      assert.equal((read?.result as { data: { title: string } } | undefined)?.data.title, 'Retouché', `the read is answered: ${JSON.stringify(read)?.slice(0, 200)}`);
    } finally {
      await context.close();
      hosts.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
