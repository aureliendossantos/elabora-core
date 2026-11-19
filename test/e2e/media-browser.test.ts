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
import { fileMedia, masterPlan, presetDimensions } from '@elabora/core/media/conformance';
import { bundleForBrowser } from '../browser-bundle.ts';
import { makeMediaFixtures } from '../media-fixtures.ts';
import { aacEncoderModule } from '../aac-encoder.ts';
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
import { fileTarget, videoMaster } from './packages/engine/src/browser/media/video.ts';
import { provideAac } from './packages/engine/src/browser/media/encoders.ts';
const aac = provideAac('/aac.js');
self.onmessage = async ({ data }) => {
  try {
    const info = await probeFile(data.file, data.name);
    if (data.op === 'probe') return self.postMessage({ info });
    if (data.op === 'image') return self.postMessage({ master: await imageMaster(data.file, data.name, info) });
    // The origin's private file system; Playwright's WebKit has none in its throwaway profiles: in memory there.
    const handle = await navigator.storage.getDirectory().then((root) => root.getFileHandle('master-' + data.name + '.mp4', { create: true }), () => null);
    const parts = [];
    const memory = new WritableStream({ write(chunk) { if (chunk.type === 'write') parts.push(chunk); } });
    const started = performance.now();
    const made = await videoMaster(data.file, data.name, info, { target: handle ? await fileTarget(handle) : memory, aac });
    let blob = data.file;
    if (made.action !== 'copy' && handle) blob = await handle.getFile();
    else if (made.action !== 'copy') {
      const bytes = new Uint8Array(Math.max(...parts.map((p) => p.position + p.data.length)));
      for (const p of parts) bytes.set(p.data, p.position);
      blob = new Blob([bytes]);
    }
    self.postMessage({ master: { blob, extension: made.extension, action: made.action, ms: Math.round(performance.now() - started) } });
  } catch (error) { self.postMessage({ error: String(error && error.message || error), code: error && error.code }); }
};` });
  const aac = await aacEncoderModule();
  browser = await launchBrowser(BROWSER);
  page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    if (name === 'probe.js') return route.fulfill({ contentType: 'text/javascript', body: worker.code });
    if (name === 'aac.js') return route.fulfill({ contentType: 'text/javascript', body: aac });
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
const inWorker = (name: string, op: 'probe' | 'image' | 'video') => page.evaluate(async ([file, op]) => {
  const blob = await (await fetch(`/${encodeURIComponent(file)}`)).blob();
  const worker = new Worker('/probe.js', { type: 'module' });
  try {
    const answer = await new Promise<{ info?: unknown; error?: string; code?: string; master?: { blob: Blob; extension: string | null; action: string; ms?: number } }>((resolve) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => resolve({ error: event.message || 'the Worker did not load' });
      worker.postMessage({ file: blob, name: file, op });
    });
    if (!answer.master) return answer;
    const bytes = new Uint8Array(await answer.master.blob.arrayBuffer());
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return { master: { base64: btoa(text), extension: answer.master.extension, action: answer.master.action, ms: answer.master.ms } };
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
      if (!answer.master) {
        assert.match(answer.code ?? '', /^E_MEDIA_(NOT_DECODABLE_HERE|ENCODER_MISSING)$/, `${name}: ${answer.error}`);
        rows.push(`${name}: ${answer.code}`);
        continue;
      }
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

const VIDEOS = /\.(mp4|mov|webm|mkv)$/;

// WebKitGTK encodes with GStreamer: its AAC packets come out with the same times, its H.264 above the
// bitrate asked (12.6 Mb/s for 4.8 on a 1080p clip). Safari has Apple's encoders, tried on a Mac (the
// report, « Ce qui attend le local »).
const GSTREAMER = BROWSER === 'webkit' && process.platform === 'linux';

test(`video masters in ${BROWSER}: the desktop's plan, an MP4 conformant, fully decoded, without metadata nor date`, { timeout: 600_000 }, async (t) => {
  if (!tools) return t.skip('ffmpeg and ffprobe not found');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-browser-videos-'));
  const streamHash = async (file: string, stream: string): Promise<string> => (await execute(tools.ffmpeg, ['-v', 'error', '-i', file, '-map', `0:${stream}:0`, '-c', 'copy', '-f', 'hash', '-hash', 'md5', '-'])).stdout.trim();
  try {
    // One case a file: a file that fails does not stop the others.
    for (const name of fixtures.files.filter((file) => VIDEOS.test(file))) {
      const input = path.join(fixtures.dir, name);
      const source = await probeMedia(input, { tools });
      const plan = masterPlan(source, { importing: true });
      const skip = GSTREAMER && (plan.audio === 'encode' ? 'its sound is encoded to AAC by GStreamer in WebKitGTK, not by Safari\'s encoder' : plan.video === 'encode' && 'its picture is encoded to H.264 by GStreamer in WebKitGTK, above the bitrate asked, not by Safari\'s encoder');
      await t.test(name, { skip }, async (st) => {
        const answer = await inWorker(name, 'video') as { master?: { base64: string; extension: string | null; action: string; ms?: number }; error?: string; code?: string };
        if (!answer.master) {
          // What this browser cannot do, said by its code; anything else fails.
          assert.match(answer.code ?? '', /^E_MEDIA_(NOT_DECODABLE_HERE|ENCODER_MISSING)$/, `${name}: ${answer.error}`);
          st.diagnostic(`${answer.code} ${answer.error ?? ''}`);
          return;
        }
        const { action } = answer.master;
        const file = path.join(out, `${path.parse(name).name}.mp4`);
        fs.writeFileSync(file, Buffer.from(answer.master.base64, 'base64'));
        const master = await probeMedia(file, { tools });
        const colour = (await execute(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_range,color_space,color_transfer,color_primaries', '-of', 'csv=p=0', file])).stdout.trim();
        const row = `${action} → ${master.videoCodec} ${master.profile} ${master.width}×${master.height} (${colour}), ${master.audioCodec ?? 'no sound'}, ${master.size} bytes, ${answer.master.ms} ms`;
        st.diagnostic(row);
        assert.deepEqual(fileMedia(master).reasons.map((r) => r.code), [], `${name}: a conformant master, ${row}`);
        const { stderr }: { stderr: string } = await execute(tools.ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
        assert.equal(stderr, '', `${name}: fully decoded`);
        const { stdout }: { stdout: string } = await execute(tools.ffprobe, ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', file]);
        assert.doesNotMatch(stdout, /creation_time|location|title|encoder/i, `${name}: no metadata, no date`);
        assert.ok(Math.abs((master.duration ?? 0) - (source.duration ?? 0)) < 0.1, `${name}: its duration, ${master.duration} for ${source.duration}`);
        if (action === 'remux') {
          assert.equal(await streamHash(file, 'v'), await streamHash(input, 'v'), `${name}: its picture copied`);
          assert.equal(master.rotation, source.rotation, `${name}: its rotation kept`);
        } else {
          assert.equal(action, 'encode');
          if (source.videoCodec === 'h264' && fileMedia(source).reasons.every((r) => r.stream !== 'video')) assert.equal(await streamHash(file, 'v'), await streamHash(input, 'v'), `${name}: its picture copied, its sound encoded`);
          else {
            assert.deepEqual([master.width, master.height], Object.values(presetDimensions(source, 'high')!), `${name}: the high preset's size`);
            assert.equal(master.rotation, 0, `${name}: turned as it shows`);
            // Its first picture, the same as the native ffmpeg's turned the same way.
            const { stderr: compared }: { stderr: string } = await execute(tools.ffmpeg, ['-i', input, '-i', file, '-lavfi', `[0:v]scale=${master.width}:${master.height},format=rgb24[a];[1:v]format=rgb24[b];[a][b]psnr`, '-frames:v', '1', '-f', 'null', '-']);
            const psnr = Number(/average:([\d.]+|inf)/.exec(compared)?.[1].replace('inf', '99'));
            assert.ok(psnr > 20, `${name}: PSNR ${psnr} against the desktop's picture`);
            st.diagnostic(`PSNR ${psnr} dB against ffmpeg's`);
          }
        }
      });
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
