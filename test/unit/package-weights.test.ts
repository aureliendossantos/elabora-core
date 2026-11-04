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
const weigh = async (dir: string) => Object.fromEntries((await packageWeights(loadProjectFromDir(dir))).qualities.map((size) => [size.quality, size]));
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

test('media by media: each at each quality, its size there, where the course uses it; the package is the media and the rest', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  try {
    place(dir, 'master.mp4', 'assets/video/master.mp4');
    place(dir, 'figure.png', 'assets/images/figure.png');
    place(dir, 'figure.png', 'assets/images/unused.png');
    fs.writeFileSync(path.join(dir, 'assets/video/master.vtt'), 'WEBVTT\n');
    addBlocks(dir,
      { id: 'clip', type: 'video', props: { asset: 'video/master.mp4', captions: 'video/master.vtt', title: 'Clip', transcript: 'A test clip.' } } as Block,
      { id: 'figure', type: 'image', props: { asset: 'images/figure.png', alt: 'A test pattern with colour bars.' } } as Block);
    const weights = await packageWeights(loadProjectFromDir(dir));
    assert.equal(weights.quality, 'high', 'the course\'s quality');
    const paths = weights.media.map((media) => media.path);
    assert.deepEqual(paths.filter((rel) => rel?.includes('/master.') || rel?.includes('figure')), ['assets/video/master.mp4', 'assets/images/figure.png', 'assets/video/master.vtt'], 'heaviest first');
    assert.ok(!paths.includes('assets/images/unused.png'), 'the unused file left out');
    const high = weights.media.map((media) => media.qualities[0]!.bytes);
    assert.deepEqual(high, [...high].sort((a, b) => b - a));
    for (const size of weights.qualities) assert.equal(size.bytes, weights.rest + weights.media.reduce((sum, media) => sum + media.qualities.find((one) => one.quality === size.quality)!.bytes, 0), `${size.quality}: the media and the rest`);

    const [clip, figure, captions] = ['assets/video/master.mp4', 'assets/images/figure.png', 'assets/video/master.vtt'].map((rel) => weights.media.find((media) => media.path === rel));
    assert.deepEqual([clip!.kind, clip!.width, clip!.height, Math.round(clip!.seconds!)], ['video', 1920, 1080, 4]);
    assert.deepEqual(clip!.uses, [{ screen: 'accueil', block: 'clip' }]);
    assert.equal(clip!.master, fs.statSync(path.join(dir, 'assets/video/master.mp4')).size);
    assert.deepEqual(clip!.qualities.map(({ quality, rendition, width, height }) => [quality, rendition, width, height]), [['high', false, 1920, 1080], ['medium', true, 1280, 720], ['low', true, 854, 480]], 'the master at high, resized below');
    assert.deepEqual(clip!.qualities.map((size) => size.estimated), [false, true, true], 'renditions not made: estimated');
    assert.deepEqual(figure!.qualities.map(({ width, height }) => [width, height]), [[2400, 1350], [2400, 1350], [1600, 900]], 'an image within medium keeps its size there');
    assert.deepEqual([captions!.kind, captions!.uses, captions!.qualities.map((size) => size.bytes)], ['file', [{ screen: 'accueil', block: 'clip' }], [7, 7, 7]]);
    assert.ok(weights.media.every((media) => !media.heavy && media.why === undefined), 'nothing stands out');

    // Once a rendition is made, it is measured.
    const low = await build(dir, { out: path.join(dir, 'out', 'low'), mediaQuality: 'low', writeLock: false });
    assert.ok(low.ok, JSON.stringify(low.diagnostics.filter((d) => d.severity === 'error')));
    const made = (await packageWeights(loadProjectFromDir(dir))).media.find((media) => media.path === 'assets/video/master.mp4')!;
    assert.deepEqual(made.qualities.map((size) => size.estimated), [false, true, false]);
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
    // Each track, by its screen, the same at every quality.
    const tracks = (await packageWeights(loadProjectFromDir(dir))).media.filter((media) => media.kind === 'narration');
    assert.equal(tracks.length, high.report.narration!.tracks.length);
    assert.ok(tracks.every((track) => track.path === null && track.uses.length === 1 && track.uses[0]!.screen && (track.lines ?? 0) > 0 && (track.seconds ?? 0) > 0));
    assert.ok(tracks.every((track) => new Set(track.qualities.map((size) => size.bytes)).size === 1 && !track.qualities[0]!.estimated), 'made once, at 64 kb/s');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
