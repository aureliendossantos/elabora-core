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
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=2400x1350', '-frames:v', '1', path.join(fixtures, 'figure.png')),
    // What Standard does not ship as it is: a photo-like PNG (noise, about 3 bytes a pixel), a 360p
    // video exported at 8 Mb/s; and an animated image.
    ffmpeg('-f', 'lavfi', '-i', "nullsrc=size=1600x1200,format=rgb24,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255'", '-frames:v', '1', path.join(fixtures, 'noise.png')),
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=10:duration=3,noise=alls=90:allf=t', path.join(fixtures, 'animation.gif')),
    // Padded to a constant 8 Mb/s, as an export at a bitrate far above what the picture needs.
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', ...h264.map((arg) => (arg === '6M' ? '8M' : arg)), '-minrate', '8M', '-maxrate', '8M', '-bufsize', '8M', ...(tools.h264[0] === 'libx264' ? ['-x264-params', 'nal-hrd=cbr'] : []), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(fixtures, 'dense.mp4'))
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
    assert.ok(weights.media.every((media) => !media.notice), 'a 1080p video at 6 Mb/s and a test pattern: nothing to notice');

    // Once a rendition is made, it is measured.
    const low = await build(dir, { out: path.join(dir, 'out', 'low'), mediaQuality: 'low', writeLock: false });
    assert.ok(low.ok, JSON.stringify(low.diagnostics.filter((d) => d.severity === 'error')));
    const made = (await packageWeights(loadProjectFromDir(dir))).media.find((media) => media.path === 'assets/video/master.mp4')!;
    assert.deepEqual(made.qualities.map((size) => size.estimated), [false, true, false]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('at high, a photo saved as PNG and a video far denser than its size ship as renditions, the project\'s files unchanged; an animated image is still noticed', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  try {
    place(dir, 'master.mp4', 'assets/video/master.mp4');
    place(dir, 'noise.png', 'assets/images/photo.png');
    place(dir, 'animation.gif', 'assets/images/animation.gif');
    place(dir, 'dense.mp4', 'assets/video/dense.mp4');
    addBlocks(dir,
      { id: 'clip', type: 'video', props: { asset: 'video/master.mp4', title: 'Clip', decorative: true } } as Block,
      { id: 'dense', type: 'video', props: { asset: 'video/dense.mp4', title: 'Dense', decorative: true } } as Block,
      { id: 'photo', type: 'image', props: { asset: 'images/photo.png', alt: 'Noise.' } } as Block,
      { id: 'animation', type: 'image', props: { asset: 'images/animation.gif', alt: 'Moving noise.' } } as Block);
    const masters = ['video/master.mp4', 'images/photo.png', 'images/animation.gif', 'video/dense.mp4'].map((name) => fs.readFileSync(path.join(dir, 'assets', name)));
    const atHigh = (weights: Awaited<ReturnType<typeof packageWeights>>) => Object.fromEntries(weights.media.filter((media) => /\/(master|dense)\.mp4|photo\.png|animation\.gif/.test(media.path ?? '')).map((media) => [media.path!.split('/').pop(), [media.qualities[0]!.rendition, media.notice?.reason ?? null]]));
    const before = await packageWeights(loadProjectFromDir(dir));
    // The GIF is not a web format: a rendition at high too (animated WebP), and still an animated image.
    assert.deepEqual(atHigh(before), { 'master.mp4': [false, null], 'dense.mp4': [true, null], 'photo.png': [true, null], 'animation.gif': [true, 'animated'] }, JSON.stringify(before.media.map((media) => [media.path, media.qualities[0]])));
    const photo = before.media.find((media) => media.path === 'assets/images/photo.png')!;
    assert.ok(photo.qualities[0]!.estimated && photo.qualities[0]!.bytes < photo.master! / 2, 'estimated, far lighter than the PNG');

    const high = await build(dir, { out: path.join(dir, 'out', 'high'), writeLock: false });
    assert.ok(high.ok, JSON.stringify(high.diagnostics.filter((d) => d.severity === 'error')));
    assert.deepEqual(high.report.media?.files.filter((file) => /photo|dense|master/.test(file.path)).map((file) => [file.path, file.rendition]), [[`assets/images/photo${tools.webp ? '.webp' : '.jpg'}`, true], ['assets/video/dense.mp4', true], ['assets/video/master.mp4', false]], 'WebP, or JPEG without a WebP encoder');
    assert.deepEqual(['video/master.mp4', 'images/photo.png', 'images/animation.gif', 'video/dense.mp4'].map((name, index) => fs.readFileSync(path.join(dir, 'assets', name)).equals(masters[index]!)), [true, true, true, true], 'the project\'s files unchanged');
    // Made: measured, lighter than the masters.
    const after = await packageWeights(loadProjectFromDir(dir));
    for (const rel of ['assets/images/photo.png', 'assets/video/dense.mp4']) {
      const made = after.media.find((media) => media.path === rel)!;
      assert.ok(!made.qualities[0]!.estimated && made.qualities[0]!.bytes < made.master!, `${rel}: ${made.qualities[0]!.bytes} of ${made.master}`);
    }
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
