import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { findMediaTools, probeMedia } from '@elabora/node/media/index';
import type { MediaInfo, MediaTools } from '@elabora/node/media/index';
import { bundleForBrowser } from '../browser-bundle.ts';
import { makeMediaFixtures } from '../media-fixtures.ts';
import type { MediaFixtures } from '../media-fixtures.ts';

// The browser's probe (packages/engine/src/browser/media/probe.ts) in a Worker, against the
// desktop's (ffprobe) on files as authors bring them: the same facts, field by field.
// ELABORA_BROWSER=firefox or webkit runs it there.

const BROWSER = process.env.ELABORA_BROWSER ?? 'chromium';
const ORIGIN = 'https://media.elabora.test';
const tools: MediaTools | null = await findMediaTools().catch(() => null);

let browser: Browser;
let page: Page;
let fixtures: MediaFixtures;

before(async () => {
  if (!tools) return;
  fixtures = await makeMediaFixtures(tools);
  const worker = await bundleForBrowser({ source: `import { probeFile } from './packages/engine/src/browser/media/probe.ts';
self.onmessage = async ({ data }) => {
  try { self.postMessage({ info: await probeFile(data.file, data.name) }); }
  catch (error) { self.postMessage({ error: String(error && error.message || error) }); }
};` });
  browser = await launchBrowser(BROWSER);
  page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    if (name === 'probe.js') return route.fulfill({ contentType: 'text/javascript', body: worker.code });
    if (name === '') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>media</title>' });
    return route.fulfill({ contentType: 'application/octet-stream', body: fs.readFileSync(path.join(fixtures.dir, name)) });
  });
  page.on('pageerror', (error) => console.error('page:', error.message));
  await page.goto(`${ORIGIN}/`);
});

after(async () => {
  await browser?.close();
  fixtures?.remove();
});

const probeInBrowser = (name: string) => page.evaluate(async (file) => {
  const blob = await (await fetch(`/${encodeURIComponent(file)}`)).blob();
  const worker = new Worker('/probe.js', { type: 'module' });
  try {
    return await new Promise<{ info?: unknown; error?: string }>((resolve) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => resolve({ error: event.message || 'the Worker did not load' });
      worker.postMessage({ file: blob, name: file });
    });
  } finally {
    worker.terminate();
  }
}, name);

test(`media probe in ${BROWSER}: the desktop's facts`, async (t) => {
  if (!tools) return t.skip('ffmpeg and ffprobe not found');
  const gaps: string[] = [];
  for (const name of fixtures.files) {
    const desktop = await probeMedia(path.join(fixtures.dir, name), { tools });
    const answer = await probeInBrowser(name);
    if (answer.error) { gaps.push(`${name}: ${answer.error}`); continue; }
    const here = answer.info as MediaInfo;
    for (const key of Object.keys(desktop) as (keyof MediaInfo)[]) {
      if (JSON.stringify(desktop[key]) !== JSON.stringify(here[key])) gaps.push(`${name} ${key}: desktop ${JSON.stringify(desktop[key])}, browser ${JSON.stringify(here[key])}`);
    }
  }
  assert.deepEqual(gaps, [], `${fixtures.files.length} files`);
});
