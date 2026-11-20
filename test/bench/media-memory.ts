// Measures a browser's video masters on a large file (lot 5, « la mémoire »):
//   node test/bench/media-memory.ts [--seconds 60] [--browser chromium] [--only copy|encode]
// - a 1080p H.264 video of about 200 MB, its index at the end, copied into an MP4 with its index first;
// - the same in the full range, encoded again (every picture);
// - the browser's memory (the anonymous resident memory of every process this bench started, file pages left out) before and at its
//   peak during each master, the input read from a file of the origin's private file system;
// - an encoding made twice from the same input: the same bytes or not.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findMediaTools } from '@elabora/node/media/index';
import { bundleForBrowser } from '../browser-bundle.ts';
import { aacEncoderModule } from '../aac-encoder.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1]! : fallback; };
const seconds = Number(option('seconds', '60'));
const browserName = option('browser', 'chromium');
const only = option('only', '');
const run = promisify(execFile);
const tools = await findMediaTools();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-media-memory-'));
const ORIGIN = 'https://media.elabora.test';

// About 200 MB each: under the master's 10 Mb/s for the copy (8 Mb/s, three times longer), in the full range
// for the encoding.
const make = (name: string, pixels: string, duration: number, bitrate: string) => run(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${duration}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`, '-shortest',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate, '-pix_fmt', pixels, '-c:a', 'aac', path.join(dir, name)], { maxBuffer: 1 << 20 });
await Promise.all([make('copy.mp4', 'yuv420p', seconds * 3, '8M'), ...(only === 'copy' ? [] : [make('encode.mp4', 'yuvj420p', seconds, '25M')])]);
await run(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuvj420p', path.join(dir, 'twice.mp4')]);

// The resident memory of this process's descendants: the browser and its helpers.
function browserMemory(): number {
  const parents = new Map<number, number>();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try { parents.set(Number(entry), Number(fs.readFileSync(`/proc/${entry}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1])); } catch { /* gone */ }
  }
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parents) if (!mine.has(pid) && mine.has(parent)) { mine.add(pid); grew = true; }
  }
  mine.delete(process.pid);
  let kb = 0;
  for (const pid of mine) {
    try { kb += Number(/RssAnon:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0); } catch { /* gone */ }
  }
  return kb * 1024;
}

const worker = await bundleForBrowser({ source: `import { probeFile } from './packages/engine/src/browser/media/probe.ts';
import { fileTarget, videoMaster } from './packages/engine/src/browser/media/video.ts';
import { provideAac } from './packages/engine/src/browser/media/encoders.ts';
const aac = provideAac('/aac.js');
self.onmessage = async ({ data }) => {
  try {
    const root = await navigator.storage.getDirectory();
    if (data.op === 'take') {
      const handle = await root.getFileHandle('input-' + data.name, { create: true });
      // In parts of 16 MB: a test route carries no file of 200 MB at once.
      const writable = await handle.createWritable();
      for (let part = 0; ; part++) {
        const bytes = new Uint8Array(await (await fetch('/' + data.name + '?part=' + part)).arrayBuffer());
        if (!bytes.length) break;
        await writable.write(bytes);
      }
      await writable.close();
      return self.postMessage({ size: (await handle.getFile()).size });
    }
    const file = await (await root.getFileHandle('input-' + data.name)).getFile();
    const info = await probeFile(file, data.name);
    const out = await root.getFileHandle('master-' + data.run + '-' + data.name, { create: true });
    const started = performance.now();
    const made = await videoMaster(file, data.name, info, { target: await fileTarget(out), aac });
    const master = await out.getFile();
    // Hashed only when asked: reading a large master whole would be the bench's own memory.
    const hash = data.hash ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await master.arrayBuffer()))).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('') : null;
    self.postMessage({ action: made.action, size: master.size, ms: Math.round(performance.now() - started), hash });
  } catch (error) { self.postMessage({ error: String(error && error.message || error) }); }
};` });
const aac = await aacEncoderModule();
// A profile on disk: a throwaway context keeps the origin's private file system in memory, which
// would count every byte written as the browser's memory.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-media-profile-'));
const playwright = await import('playwright-core');
const context = await playwright[browserName as 'chromium' | 'firefox' | 'webkit'].launchPersistentContext(profile, { headless: true });
const page = context.pages()[0] ?? await context.newPage();
await page.route(`${ORIGIN}/**`, (route) => {
  const url = new URL(route.request().url());
  const name = url.pathname.slice(1);
  if (name === 'media.js') return route.fulfill({ contentType: 'text/javascript', body: worker.code });
  if (name === 'aac.js') return route.fulfill({ contentType: 'text/javascript', body: aac });
  if (name === '') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>media</title>' });
  const part = Number(url.searchParams.get('part'));
  const handle = fs.openSync(path.join(dir, name), 'r');
  const body = Buffer.alloc(16 << 20);
  const read = fs.readSync(handle, body, 0, body.length, part * body.length);
  fs.closeSync(handle);
  return route.fulfill({ contentType: 'application/octet-stream', body: body.subarray(0, read) });
});
page.on('crash', () => console.error('the page crashed'));
page.on('console', (m) => console.error('page:', m.text()));
await page.goto(`${ORIGIN}/`);
await page.evaluate(() => { (window as unknown as { media: Worker }).media = new Worker('/media.js', { type: 'module' }); });
const ask = (message: object) => page.evaluate((m) => new Promise<Record<string, unknown>>((resolve) => {
  const w = (window as unknown as { media: Worker }).media;
  w.onmessage = ({ data }) => resolve(data);
  w.postMessage(m);
}), message);

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`;
for (const name of ['copy.mp4', 'encode.mp4'].filter((file) => !only || file.startsWith(only))) {
  await ask({ op: 'take', name });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const before = browserMemory();
  let peak = before;
  const sampler = setInterval(() => { peak = Math.max(peak, browserMemory()); }, 200);
  const made = await ask({ op: 'master', name, run: 1 });
  clearInterval(sampler);
  console.log(`${name}: ${mb(fs.statSync(path.join(dir, name)).size)} → ${JSON.stringify(made)}; browser ${mb(before)} before, ${mb(peak)} at its peak (+${mb(peak - before)})`);
}
if (!only) {
await ask({ op: 'take', name: 'twice.mp4' });
const first = await ask({ op: 'master', name: 'twice.mp4', run: 1, hash: true });
const second = await ask({ op: 'master', name: 'twice.mp4', run: 2, hash: true });
console.log(`the same encoding twice: ${first.hash === second.hash ? 'the same bytes' : 'other bytes'} (${first.hash}, ${second.hash})`);
}
await context.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });
