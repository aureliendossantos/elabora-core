import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjectFiles } from '@elabora/node/project-reader';
import { bundleForBrowser } from '../browser-bundle.ts';
import { NETWORK_SAMPLE } from '../helpers.ts';

// The browser engine in WebKit, in a profile on disk (a throwaway one has no origin's private file system):
// a medium the app ships is taken, checked, kept, then served from what is kept, one at a time and all at
// once. WebKit moves a file of that file system only by move(folder, name).

const ORIGIN = 'https://engine.elabora.test';
const link = { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_ada', name: 'Ada' }, head: 0, epoch: null, waiting: [], journal: 0 };

test('WebKit: the media an app ships are kept and served by the engine\'s Worker', { timeout: 180_000 }, async (t) => {
  const playwright = await import('playwright-core');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-webkit-'));
  let context: Awaited<ReturnType<typeof playwright.webkit.launchPersistentContext>>;
  try {
    context = await playwright.webkit.launchPersistentContext(profile, {});
  } catch (error) {
    fs.rmSync(profile, { recursive: true, force: true });
    return t.skip(`WebKit is not installed: ${(error as Error).message.split('\n')[0]}`);
  }
  try {
    const { files } = readProjectFiles(NETWORK_SAMPLE);
    const shipped = new Map<string, Buffer>();
    for (const [rel, file] of files) if (file.kind === 'binary' && file.hash) shipped.set(file.hash, fs.readFileSync(path.join(NETWORK_SAMPLE, rel)));
    const media = [...files].filter(([, file]) => file.kind === 'binary').map(([rel]) => rel).slice(0, 4);
    const worker = await bundleForBrowser({ source: `import { provideMedia } from './packages/engine/src/browser/worker.ts';
provideMedia(async (hash) => { const response = await fetch('/media/' + hash); return response.ok ? response.blob() : null; });` });
    const page = context.pages()[0] ?? await context.newPage();
    await page.route(`${ORIGIN}/**`, (route) => {
      const name = new URL(route.request().url()).pathname;
      if (name === '/worker.js') return route.fulfill({ contentType: 'text/javascript', body: worker.code });
      const bytes = name.startsWith('/media/') ? shipped.get(name.slice('/media/'.length)) : undefined;
      if (bytes) return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>engine</title>' });
    });
    await page.goto(`${ORIGIN}/`);
    const answers = await page.evaluate(async ([seed, paths]) => {
      const w = new Worker('/worker.js', { type: 'module' });
      await new Promise((resolve) => { w.onmessage = ({ data }) => resolve(data); w.postMessage({ kind: 'open', team: 'tm_test', project: 'webkit', seed, api: 'http://localhost:1', offline: true }); });
      const { port1, port2 } = new MessageChannel();
      const opened = new Promise((resolve) => w.addEventListener('message', ({ data }) => { if (data.kind === 'response' && data.id === 'relay') resolve(data.ok); }));
      w.postMessage({ kind: 'request', id: 'relay', type: 'relayPort', params: { host: 'canvas' } }, [port1]);
      await opened;
      port2.start();
      let next = 0;
      const ask = (path: string) => new Promise<string>((resolve) => {
        const id = ++next;
        port2.addEventListener('message', function listen({ data }) { if (data.type === 'relay/answer' && data.id === id) { port2.removeEventListener('message', listen); resolve(`${data.answer.status} ${data.answer.body?.size ?? ''}`.trim()); } });
        port2.postMessage({ type: 'relay/request', id, request: { kind: 'file', path } });
      });
      const once = [];
      for (const path of paths as string[]) once.push(await ask(path));
      return { once, kept: await Promise.all((paths as string[]).map(ask)) };
    }, [{ link, confirmed: [...files] }, media] as unknown as [object, string[]]);
    const sizes = media.map((rel) => `ok ${fs.statSync(path.join(NETWORK_SAMPLE, rel)).size}`);
    assert.deepEqual(answers.once, sizes, 'taken from the app, checked, kept');
    assert.deepEqual(answers.kept, sizes, 'served from what is kept');
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
