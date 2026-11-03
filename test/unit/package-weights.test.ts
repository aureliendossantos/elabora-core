import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Block } from '@elabora/format';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { build } from '@elabora/node/build';
import { packageWeights } from '@elabora/node/packaging/weights';
import { findMediaTools } from '@elabora/node/media/tools';
import { copyExample, readJSON, writeJSON, ROOT } from '../helpers.ts';

const run = promisify(execFile);
const tools = await findMediaTools().catch(() => null);
const NO_FFMPEG = 'ffmpeg and ffprobe not found';
let fixtures = '';

// A 4 s 1080p MP4 master and a PNG.
before(async () => {
  if (!tools) return;
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-weights-fixtures-'));
  const ffmpeg = (...args: string[]) => run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const h264 = tools.h264[0] === 'libx264' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '6M'] : ['-c:v', tools.h264[0], '-b:v', '6M'];
  await Promise.all([
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-shortest', ...h264, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.join(fixtures, 'master.mp4')),
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=2400x1350', '-frames:v', '1', path.join(fixtures, 'figure.png'))
  ]);
});
after(() => { if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true }); });

const longAgo = new Date(Date.now() - 60_000);
function place(dir: string, name: string, rel: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.copyFileSync(path.join(fixtures, name), path.join(dir, rel));
  fs.utimesSync(path.join(dir, rel), longAgo, longAgo);
}
function addBlocks(dir: string, ...blocks: Block[]): void {
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push(...blocks);
  writeJSON(dir, 'screens/accueil.json', screen);
}
const weigh = async (dir: string) => Object.fromEntries((await packageWeights(loadProjectFromDir(dir))).map((size) => [size.quality, size]));
// Within 2 % of the package, or 16 KB for a small one: the ZIP's headers and the compiled course data.
const near = (weight: number, zip: number, what: string) => assert.ok(Math.abs(weight - zip) <= Math.max(zip * 0.02, 16 * 1024), `${what}: weighed ${weight}, the ZIP has ${zip}`);

test('a package weighed before it is built: the masters at high, renditions estimated below, then measured once made', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  try {
    const empty = await weigh(dir);
    assert.deepEqual([empty.high!.bytes, empty.medium!.bytes], [empty.low!.bytes, empty.low!.bytes], 'no media: one weight');
    assert.equal(empty.high!.estimated, false);
    const plain = await build(dir, { out: path.join(dir, 'out', 'plain'), writeLock: false });
    assert.ok(plain.ok, JSON.stringify(plain.diagnostics.filter((d) => d.severity === 'error')));
    near(empty.high!.bytes, plain.report.package.bytes, 'without media');

    place(dir, 'master.mp4', 'assets/video/master.mp4');
    place(dir, 'figure.png', 'assets/images/figure.png');
    place(dir, 'figure.png', 'assets/images/unused.png');
    fs.writeFileSync(path.join(dir, 'assets/video/master.vtt'), 'WEBVTT\n');
    addBlocks(dir,
      { id: 'clip', type: 'video', props: { asset: 'video/master.mp4', captions: 'video/master.vtt', title: 'Clip', transcript: 'A test clip.' } } as Block,
      { id: 'figure', type: 'image', props: { asset: 'images/figure.png', alt: 'A test pattern with colour bars.' } } as Block);
    const masters = ['video/master.mp4', 'video/master.vtt', 'images/figure.png'].reduce((sum, name) => sum + fs.statSync(path.join(dir, 'assets', name)).size, 0);

    const before = await weigh(dir);
    assert.equal(before.high!.estimated, true, 'renditions not made yet');
    // The masters, and the player's interface sounds a course with sound plays (D67), not the unused file.
    const added = before.high!.bytes - empty.high!.bytes;
    assert.ok(added >= masters && added < masters + fs.statSync(path.join(dir, 'assets/images/unused.png')).size, `${added} bytes added for ${masters} of media`);
    assert.ok(before.high!.bytes > before.medium!.bytes && before.medium!.bytes > before.low!.bytes, 'lower quality, lighter');
    assert.equal(fs.existsSync(path.join(dir, '.elabora')) && fs.readdirSync(path.join(dir, '.elabora')).some((name) => name.endsWith('.mp4')), false, 'nothing encoded');

    const high = await build(dir, { out: path.join(dir, 'out', 'high'), writeLock: false });
    const low = await build(dir, { out: path.join(dir, 'out', 'low'), mediaQuality: 'low', writeLock: false });
    const medium = await build(dir, { out: path.join(dir, 'out', 'medium'), mediaQuality: 'medium', writeLock: false });
    if (!high.ok || !low.ok || !medium.ok) return assert.fail(JSON.stringify([high, low, medium].flatMap((made) => made.diagnostics.filter((d) => d.severity === 'error'))));
    near(before.high!.bytes, high.report.package.bytes, 'high, before any build');

    const after = await weigh(dir);
    assert.equal(after.low!.estimated, false, 'every rendition made: measured');
    near(after.high!.bytes, high.report.package.bytes, 'high');
    near(after.medium!.bytes, medium.report.package.bytes, 'medium');
    near(after.low!.bytes, low.report.package.bytes, 'low');
    // The estimate is an order of magnitude, never far from the rendition.
    assert.ok(before.low!.bytes < after.low!.bytes * 4 && before.low!.bytes > after.low!.bytes / 4, `low estimated ${before.low!.bytes}, made ${after.low!.bytes}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a narrated course: its tracks estimated at 64 kb/s before they are made, then measured', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  try {
    const before = await weigh(dir);
    assert.equal(before.high!.estimated, true, 'tracks not made yet');
    const high = await build(dir, { out: path.join(dir, 'out', 'high'), writeLock: false });
    assert.ok(high.ok, JSON.stringify(high.diagnostics.filter((d) => d.severity === 'error')));
    assert.ok((high.report.narration?.tracks.length ?? 0) > 0, 'the example is narrated');
    near(before.high!.bytes, high.report.package.bytes, 'tracks estimated');
    near((await weigh(dir)).high!.bytes, high.report.package.bytes, 'tracks made');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
