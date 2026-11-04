import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Block } from '@elabora/format';
import { undo } from '@elabora/node/edit';
import { probeMedia } from '@elabora/node/media/probe';
import { findMediaTools } from '@elabora/node/media/tools';
import { imageToVideo } from '@elabora/node/media/to-video';
import { openProject } from '@elabora/engine';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';

const run = promisify(execFile);
const tools = await findMediaTools().catch(() => null);
const NO_FFMPEG = 'ffmpeg and ffprobe not found';
let fixtures = '';

// Animated images of odd sizes: a GIF (its palette made from the frames), an APNG, a still PNG; a
// heavy GIF.
before(async () => {
  if (!tools) return;
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-to-video-fixtures-'));
  const ffmpeg = (...args: string[]) => run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  await Promise.all([
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=301x201:rate=12:duration=3', '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', path.join(fixtures, 'spinner.gif')),
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=160x91:rate=10:duration=1', '-c:v', 'apng', '-plays', '0', '-f', 'apng', path.join(fixtures, 'pulse.png')),
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=160x90', '-frames:v', '1', path.join(fixtures, 'still.png')),
    // Noise in every frame: above the 2 MB under which no media is noticed.
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=10:duration=3,noise=alls=90:allf=t', path.join(fixtures, 'noise.gif'))
  ]);
});
after(() => { if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true }); });

function place(dir: string, name: string, rel: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.copyFileSync(path.join(fixtures, name), path.join(dir, rel));
}
function addBlocks(dir: string, ...blocks: Block[]): void {
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push(...blocks);
  writeJSON(dir, 'screens/accueil.json', screen);
}
const blockOf = (dir: string, id: string) => (readJSON(dir, 'screens/accueil.json').blocks as Block[]).find((block) => block.id === id)!;

test('an animated image becomes a video that loops like it, in its place, lighter; undo puts the image back', async (t) => {
  if (!tools?.h264.length) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  try {
    place(dir, 'spinner.gif', 'assets/images/spinner.gif');
    addBlocks(dir, { id: 'spinner', type: 'image', step: 1, props: { presentation: 'wide', asset: 'images/spinner.gif', alt: 'The router restarts.', caption: 'A restart takes a minute.', generated: true, zoom: true } } as Block);
    const index = (readJSON(dir, 'screens/accueil.json').blocks as Block[]).findIndex((block) => block.id === 'spinner');
    const result = await imageToVideo(dir, { block: 'spinner' }, { tools });

    assert.equal(result.video, 'assets/video/spinner.mp4');
    assert.match(result.poster ?? '', /^assets\/images\/spinner-poster\.(webp|jpg)$/);
    assert.equal(result.removed, 'assets/images/spinner.gif');
    assert.equal(fs.existsSync(path.join(dir, 'assets/images/spinner.gif')), false);
    assert.deepEqual(result.lost.length, 2, 'the caption shown and the zoom');
    // Its place, id, step and width (a wide image is a wide block); its alt and generated mark.
    assert.equal((readJSON(dir, 'screens/accueil.json').blocks as Block[]).findIndex((block) => block.id === 'spinner'), index);
    assert.deepEqual(blockOf(dir, 'spinner'), {
      id: 'spinner', type: 'video', step: 1, width: 'wide',
      props: { asset: 'video/spinner.mp4', title: 'A restart takes a minute.', loop: true, alt: 'The router restarts.', poster: result.poster!.slice('assets/'.length), generated: true }
    });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);

    // What browsers need of a video that plays by itself: H.264 in yuv420p, even dimensions, its index
    // first, no sound; and lighter than the GIF.
    const video = await probeMedia(path.join(dir, result.video), { tools });
    assert.deepEqual({ codec: video.videoCodec, profile: video.profile, pixels: video.pixelFormat, width: video.width, height: video.height, faststart: video.faststart, audio: video.audioCodec },
      { codec: 'h264', profile: 'High', pixels: 'yuv420p', width: 300, height: 200, faststart: true, audio: null });
    assert.ok(video.duration! > 2.5, `the whole animation: ${video.duration} s`);
    assert.ok(result.bytes.video < result.bytes.image / 2, `${result.bytes.video} bytes as a video, ${result.bytes.image} as a GIF`);
    const poster = await probeMedia(path.join(dir, result.poster!), { tools });
    assert.deepEqual([poster.kind, poster.animated, poster.width, poster.height], ['image', false, 300, 200]);

    // One change: undone, the image and its file are back, the video and its poster gone.
    undo(dir, result.change!.seq);
    assert.equal(blockOf(dir, 'spinner').type, 'image');
    assert.equal(fs.existsSync(path.join(dir, 'assets/images/spinner.gif')), true);
    assert.equal(fs.existsSync(path.join(dir, result.video)), false);
    assert.equal(fs.existsSync(path.join(dir, result.poster!)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an animated PNG becomes a video too; a file another block still shows stays; what cannot become a video is refused', async (t) => {
  if (!tools?.h264.length) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  try {
    place(dir, 'pulse.png', 'assets/images/pulse.png');
    place(dir, 'still.png', 'assets/images/still.png');
    addBlocks(dir,
      { id: 'pulse', type: 'image', props: { asset: 'images/pulse.png', decorative: true } } as Block,
      { id: 'pulse-again', type: 'image', props: { asset: 'images/pulse.png', alt: 'A pulse.' } } as Block,
      { id: 'band', type: 'image', props: { presentation: 'band', asset: 'images/pulse.png', alt: 'A pulse.' } } as Block,
      { id: 'still', type: 'image', props: { asset: 'images/still.png', alt: 'A test card.' } } as Block);
    const result = await imageToVideo(dir, { block: 'pulse' }, { tools });
    assert.equal(result.removed, null);
    assert.equal(fs.existsSync(path.join(dir, 'assets/images/pulse.png')), true);
    // Decorative: no alt, and the file's name as title.
    assert.deepEqual(blockOf(dir, 'pulse').props, { asset: 'video/pulse.mp4', title: 'pulse', loop: true, decorative: true, poster: result.poster!.slice('assets/'.length) });
    const video = await probeMedia(path.join(dir, result.video), { tools });
    assert.deepEqual([video.width, video.height], [160, 90]);

    await assert.rejects(imageToVideo(dir, { block: 'band' }, { tools }), /a video takes the place of a centered or a wide image only/);
    await assert.rejects(imageToVideo(dir, { block: 'pulse-again', blocks: ['still'] }, { tools }), /does not show assets\/images\/pulse\.png/);
    await assert.rejects(imageToVideo(dir, { block: 'still' }, { tools }), /is not animated/);
    await assert.rejects(imageToVideo(dir, { block: 'pulse' }, { tools }), /is a video block/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the engine runs image_to_video as a change of the app, one undo; undone, the image is noticed again', async (t) => {
  if (!tools?.h264.length) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  place(dir, 'noise.gif', 'assets/images/spinner.gif');
  addBlocks(dir, { id: 'spinner', type: 'image', props: { asset: 'images/spinner.gif', alt: 'The router restarts.' } } as Block);
  const session = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 });
  try {
    const animated = async () => (await session.packageWeights()).media.find((media) => media.path === 'assets/images/spinner.gif')?.notice?.reason === 'animated';
    await session.flush();
    assert.equal(await animated(), true, 'noticed before');
    // Two blocks show it: one change makes both videos, one undo gives both back.
    addBlocks(dir, { id: 'spinner-again', type: 'image', props: { asset: 'images/spinner.gif', alt: 'Again.' } } as Block);
    await session.flush();
    const result = await session.run('image_to_video', { block: 'spinner', blocks: ['spinner-again'] }, { kind: 'human' });
    assert.equal(blockOf(dir, 'spinner-again').type, 'video');
    assert.deepEqual([...result.files].sort(), ['assets/images/spinner-poster.' + (tools.webp ? 'webp' : 'jpg'), 'assets/images/spinner.gif', 'assets/video/spinner.mp4', 'screens/accueil.json']);
    assert.equal(session.readFile('assets/video/spinner.mp4').kind, 'binary');
    assert.equal(blockOf(dir, 'spinner').type, 'video');
    const own = Object.values(session.diagnostics().screens).flat().filter((finding) => finding.target === 'spinner');
    assert.deepEqual(own.filter((finding) => finding.severity === 'error'), []);
    await session.undo();
    assert.equal(blockOf(dir, 'spinner').type, 'image');
    assert.equal(blockOf(dir, 'spinner-again').type, 'image');
    assert.equal(fs.existsSync(path.join(dir, 'assets/images/spinner.gif')), true);
    // Back as it was: its probe's verdict with it, so that its weight's notice comes back.
    await session.flush();
    assert.equal(await animated(), true, 'its notice back');
  } finally {
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
