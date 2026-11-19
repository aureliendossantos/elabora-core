import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from '@elabora/node/emulator/browser';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findMediaTools, probeMedia, stripImageMetadata } from '@elabora/node/media/index';
import type { MediaInfo, MediaTools } from '@elabora/node/media/index';
import { fileMedia, presetDimensions } from '@elabora/core/media/conformance';
import { bundleForBrowser } from '../browser-bundle.ts';
import { makeMediaFixtures } from '../media-fixtures.ts';
import type { MediaFixtures } from '../media-fixtures.ts';

// The media of a browser's engine in a Worker (packages/engine/src/browser/media/), judged by the
// desktop on files as authors bring them: the probe's facts, the same as ffprobe's, field by field;
// the masters of images, conformant to the core, fully decoded by the native ffmpeg, without
// metadata. ELABORA_BROWSER=firefox or webkit runs it there.

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
import { imageMaster } from './packages/engine/src/browser/media/image.ts';
self.onmessage = async ({ data }) => {
  try {
    const info = await probeFile(data.file, data.name);
    if (data.op === 'probe') return self.postMessage({ info });
    const master = await imageMaster(data.file, data.name, info);
    self.postMessage({ master });
  } catch (error) { self.postMessage({ error: String(error && error.message || error), code: error && error.code }); }
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

const probeInBrowser = (name: string) => inWorker(name, 'probe') as Promise<{ info?: unknown; error?: string }>;

// What the Worker answers for a file; a master's bytes come back in base64.
const inWorker = (name: string, op: 'probe' | 'image') => page.evaluate(async ([file, op]) => {
  const blob = await (await fetch(`/${encodeURIComponent(file)}`)).blob();
  const worker = new Worker('/probe.js', { type: 'module' });
  try {
    const answer = await new Promise<{ info?: unknown; error?: string; code?: string; master?: { blob: Blob; extension: string | null; action: string } }>((resolve) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => resolve({ error: event.message || 'the Worker did not load' });
      worker.postMessage({ file: blob, name: file, op });
    });
    if (!answer.master) return answer;
    const bytes = new Uint8Array(await answer.master.blob.arrayBuffer());
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return { master: { base64: btoa(text), extension: answer.master.extension, action: answer.master.action } };
  } finally {
    worker.terminate();
  }
}, [name, op]);

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

const execute = promisify(execFile);
const IMAGES = /\.(jpg|png|gif|webp|bmp|avif)$/;

test(`image masters in ${BROWSER}: the desktop's plan, conformant, fully decoded, without metadata`, async (t) => {
  if (!tools) return t.skip('ffmpeg and ffprobe not found');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-browser-images-'));
  const rows: string[] = [];
  try {
    for (const name of fixtures.files.filter((file) => IMAGES.test(file))) {
      const input = path.join(fixtures.dir, name);
      const source = await probeMedia(input, { tools });
      const answer = await inWorker(name, 'image') as { master?: { base64: string; extension: string | null; action: string }; error?: string; code?: string };
      if (!answer.master) { rows.push(`${name}: ${answer.code ?? 'error'}`); continue; }
      const { action, extension } = answer.master;
      const file = path.join(out, `${path.parse(name).name}${extension ?? path.extname(name)}`);
      fs.writeFileSync(file, Buffer.from(answer.master.base64, 'base64'));
      const master = await probeMedia(file, { tools });
      rows.push(`${name}: ${action} → ${path.basename(file)} ${master.width}×${master.height}, ${master.size} bytes`);
      assert.deepEqual(fileMedia(master).reasons.map((r) => r.code), [], `${name}: a conformant master`);
      assert.equal(master.location, false, `${name}: no position`);
      const { stderr }: { stderr: string } = await execute(tools.ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
      assert.equal(stderr, '', `${name}: fully decoded`);
      if (action === 'remux') {
        // The core's rule, the desktop's bytes.
        const desktop = path.join(out, `desktop-${name}`);
        assert.ok(stripImageMetadata(input, desktop, source.container as 'jpeg' | 'png' | 'webp'));
        assert.ok(fs.readFileSync(desktop).equals(fs.readFileSync(file)), `${name}: the desktop's bytes`);
        assert.equal(master.rotation, source.rotation, `${name}: its orientation kept`);
      } else {
        assert.equal(action, 'encode');
        assert.deepEqual([master.width, master.height], Object.values(presetDimensions(source, 'high')!), `${name}: the high preset's size`);
        assert.equal(master.rotation, 0, `${name}: turned as it shows`);
        // The same picture as the native ffmpeg's, turned the same way: compared on its pixels.
        const { stderr: compared }: { stderr: string } = await execute(tools.ffmpeg, ['-i', input, '-i', file, '-lavfi', `[0:v]scale=${master.width}:${master.height},format=rgb24[a];[1:v]format=rgb24[b];[a][b]psnr`, '-f', 'null', '-']);
        const psnr = Number(/average:([\d.]+|inf)/.exec(compared)?.[1].replace('inf', '99'));
        assert.ok(psnr > 25, `${name}: PSNR ${psnr} against the desktop's picture`);
        rows.push(`${name}: PSNR ${psnr} dB against ffmpeg's`);
        const { stdout }: { stdout: string } = await execute(tools.ffprobe, ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', file]);
        assert.doesNotMatch(stdout, /"tags"/, `${name}: no tag`);
      }
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  for (const row of rows) t.diagnostic(row);
});
