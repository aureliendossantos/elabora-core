import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright-core';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { readProjectFiles } from '@elabora/node/project-reader';
import { startHosts } from '../relay-hosts.ts';
import { APP, CANVAS, FRAMES, engineMedia, handlers } from '../relay-site.ts';
import { NETWORK_SAMPLE } from '../helpers.ts';

// The browser engine's own Worker behind the relay, as the web app has it: a project's files and media kept by the engine
// (its copy in the origin's private file system), served to the canvas page through the engine's port, the route's relay
// page and the service worker, whole and by ranges. A medium the engine keeps is a file of the browser's private storage
// that travels as a Blob through two ports and out of a service worker: WebKit is where that was doubted. A profile on
// disk, which has private file storage (a throwaway one has none in WebKit). ELABORA_RELAY_BROWSERS picks the browsers (WebKit by default, where the media's passage was doubted).
const wanted = (process.env.ELABORA_RELAY_BROWSERS ?? 'webkit').split(',').map((name) => name.trim()).filter(Boolean);
const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };

const canvasFrame = (page: Page): Frame => page.frames().find((frame) => frame.url().startsWith(`${CANVAS}/canvas/index.html`))!;

for (const name of wanted) {
  test(`relay with the engine (${name}): the media it keeps reach the canvas page through the relay, whole and by ranges, and no request is answered 503`, { timeout: 300000 }, async (t) => {
    const hosts = await startHosts(handlers());
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-relay-engine-'));
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
      const media = [...files].filter(([, file]) => file.kind === 'binary').map(([rel]) => rel).slice(0, 6);
      assert.ok(media.length >= 3, 'the sample has media');
      const page = context.pages()[0] ?? await context.newPage();
      page.on('pageerror', (error) => { if (process.env.RELAY_DEBUG) console.log('[pageerror]', String(error).slice(0, 300)); });
      page.on('console', (message) => { if (process.env.RELAY_DEBUG) console.log('[console]', message.type(), message.text().slice(0, 300)); });
      // Twice: the first time the engine takes the media from the app's site and keeps them; the second, after the page is loaded
      // anew, the site has none to give (the relay is installed, the copy is what the engine kept): they come from the engine's
      // private storage, as a file of it that travels as a Blob.
      for (const visit of ['first', 'second']) {
        if (visit === 'second') { engineMedia.clear(); await page.goto('about:blank'); }
        await page.goto(`${APP}/?module=a&canvas=${encodeURIComponent(CANVAS)}&frames=${encodeURIComponent(FRAMES)}&engine=1`);
        await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app, null, { timeout: 30000 });
        await page.evaluate((seed) => (window as unknown as { app: { startEngine(seed: unknown): Promise<void> } }).app.startEngine(seed), { link, confirmed: [...files] });
        await page.waitForFunction(() => (window as unknown as { app: { log: Array<{ type: string }> } }).app.log.filter((message) => message.type === 'relay/opened').length === 2, null, { timeout: 60000 });
        const canvas = canvasFrame(page);
        const answers = await canvas.evaluate(async (paths) => {
          const out: Array<{ path: string; status: number; length: number; ranged: { status: number; length: number; contentRange: string | null } }> = [];
          for (const rel of paths) {
            const address = `/canvas/${rel.split('/').map(encodeURIComponent).join('/')}`;
            const whole = await fetch(address);
            const length = (await whole.arrayBuffer()).byteLength;
            const part = await fetch(address, { headers: { range: 'bytes=0-99' } });
            out.push({ path: rel, status: whole.status, length, ranged: { status: part.status, length: (await part.arrayBuffer()).byteLength, contentRange: part.headers.get('content-range') } });
          }
          // All at once, as a first draw does.
          const together = await Promise.all(paths.map((rel) => fetch(`/canvas/${rel.split('/').map(encodeURIComponent).join('/')}`).then((response) => response.status)));
          return { out, together };
        }, media);
        const sizes = media.map((rel) => fs.statSync(path.join(NETWORK_SAMPLE, rel)).size);
        assert.deepEqual(answers.out.map((answer) => [answer.status, answer.length]), media.map((_, index) => [200, sizes[index]]), `${visit} visit: each medium whole`);
        assert.deepEqual(answers.out.map((answer) => [answer.ranged.status, answer.ranged.length]), sizes.map((size) => [206, Math.min(100, size)]), `${visit} visit: each medium by a range`);
        assert.deepEqual(answers.together, media.map(() => 200), `${visit} visit: all at once`);
        // What the service worker said of its own failures (relay/fault): none.
        const faults = await page.evaluate(() => (window as unknown as { app: { log: Array<{ type: string }> } }).app.log.filter((message) => message.type === 'relay/fault'));
        assert.deepEqual(faults, [], `${visit} visit: no request failed in the relay`);
      }
    } finally {
      await context.close();
      hosts.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
