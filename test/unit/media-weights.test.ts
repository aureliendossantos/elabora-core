import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { durationText, noticedFirst, weightNotice } from '@elabora/core/media/weights';
import type { MediaWeight } from '@elabora/core/media/weights';
import { conformance, estimateBytes, isDense, needsHighRendition, renditionPlan, videoCeiling } from '@elabora/core/media/conformance';
import type { FileMedia, MediaInfo } from '@elabora/core/media/conformance';
import type { PresetName } from '@elabora/core/media/presets';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { packageWeights } from '@elabora/node/packaging/weights';
import { renditionPath } from '@elabora/node/media/renditions';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';

const MB = 1024 * 1024;
const at = (high: number, medium: number, low: number, renditions: [boolean, boolean, boolean] = [false, true, true]): MediaWeight['qualities'] =>
  ([['high', high], ['medium', medium], ['low', low]] as [PresetName, number][]).map(([quality, bytes], index) => ({ quality, bytes: Math.round(bytes * MB), estimated: index > 0, rendition: renditions[index]! }));
// A probe as the snapshot keeps it, with its verdict.
function probe(info: Partial<MediaInfo> & Pick<MediaInfo, 'kind' | 'container'>): FileMedia {
  const full: MediaInfo = {
    size: 0, duration: null, bitrate: null, videoCodec: null, profile: null, pixelFormat: null, width: null, height: null, rotation: 0, pixelAspect: 1, fps: null, videoBitrate: null,
    hdr: null, alpha: false, animated: false, audioCodec: null, audioBitrate: null, channels: null, sampleRate: null, coverArt: false, faststart: true, location: false, ...info
  };
  return { ...full, ...conformance(full) };
}
const video = (width: number, height: number, mbps: number, seconds: number, extra: Partial<MediaInfo> = {}) => probe({
  kind: 'video', container: 'mp4', videoCodec: 'h264', profile: 'High', pixelFormat: 'yuv420p', width, height, fps: 30, duration: seconds,
  videoBitrate: mbps * 1e6, bitrate: mbps * 1e6 + 128_000, audioCodec: 'aac', audioBitrate: 128_000, channels: 2, size: Math.round(((mbps * 1e6 + 128_000) * seconds) / 8), ...extra
});
const weight = (kind: MediaWeight['kind'], rel: string, qualities: MediaWeight['qualities'], extra: Partial<MediaWeight> = {}): MediaWeight => ({ kind, path: rel, uses: [{ screen: 'salle', block: 'b' }], qualities, ...extra });

test('Elabora\'s ceiling for a video of a size: the high quality\'s for 1080p at 30 fps, less for fewer pixels a second', () => {
  assert.deepEqual([videoCeiling(1920, 1080, 30), videoCeiling(1280, 720, 30), videoCeiling(640, 360, 30)].map((bits) => Math.round(bits / 1e5) / 10), [8, 4.4, 1.5]);
});

test('a long video that weighs is what it is: shipped as it is at high, no notice', () => {
  // 24 minutes of 1080p at 5 Mb/s: 900 MB at high, about 500 at medium.
  const info = video(1920, 1080, 5, 24 * 60);
  assert.equal(renditionPlan(info, 'high').action, 'reuse');
  const visit = weight('video', 'assets/video/visite.mp4', at(900, 497, 275), { seconds: 24 * 60, width: 1920, height: 1080 });
  for (const quality of ['high', 'medium', 'low'] as const) assert.equal(weightNotice(visit, info, quality), null, quality);
});

test('a video far denser than its size needs is re-encoded at every quality, at high too', () => {
  // A 720p screen recording exported at 9.5 Mb/s: more than twice the 4.4 Mb/s Elabora spends on 720p.
  const info = video(1280, 720, 9.5, 158);
  assert.ok(info.conformant && isDense(info), 'an import keeps it, but it is dense');
  assert.deepEqual(renditionPlan(info, 'high'), { action: 'encode', extension: '.mp4', video: 'encode', audio: 'copy', reasons: [] });
  assert.ok(needsHighRendition(info));
  // Estimated at most at what Elabora spends on 720p, with its sound.
  assert.ok(Math.abs(estimateBytes(info, 'high') - (158 * (videoCeiling(1280, 720, 30) + 128_000) * 1.01) / 8) < 1000, String(estimateBytes(info, 'high')));
  // At 6 Mb/s it is within twice the ceiling: the master ships.
  assert.equal(renditionPlan(video(1280, 720, 6, 158), 'high').action, 'reuse');
  // A small video whose stream fits medium's cap is re-encoded rather than copied when it is dense.
  assert.equal(renditionPlan(video(640, 360, 3.9, 300), 'medium').video, 'encode');
  assert.equal(renditionPlan(video(640, 360, 2.5, 300), 'medium').video, 'copy');
  // Under 2 MB, never dense.
  assert.equal(isDense(video(640, 360, 9, 1)), false);
  // A video with transparency ships as it is: H.264 has none.
  assert.equal(renditionPlan(video(1280, 720, 30, 20, { container: 'webm', videoCodec: 'vp9', profile: null, pixelFormat: 'yuva420p', alpha: true }), 'high').action, 'reuse');
});

test('a still image of more than a byte a pixel ships as WebP at high: a photo saved as PNG; a picture of text stays as it is', () => {
  const photo = probe({ kind: 'image', container: 'png', videoCodec: 'png', width: 2400, height: 1600, size: 6.9 * MB });
  assert.deepEqual(renditionPlan(photo, 'high'), { action: 'encode', extension: '.webp', video: 'encode', audio: null, reasons: [] });
  assert.equal(estimateBytes(photo, 'high'), 2400 * 1600 * 0.5, 'at most half a byte a pixel');
  // Without a WebP encoder, JPEG; with transparency, PNG, kept only if smaller.
  assert.equal(renditionPlan(photo, 'high', { webp: false }).extension, '.jpg');
  assert.equal(renditionPlan({ ...photo, alpha: true }, 'high').extension, '.webp');
  // A JPEG of a third of a byte a pixel, a screenshot, a detailed diagram: shipped as they are.
  const jpeg = probe({ kind: 'image', container: 'jpeg', videoCodec: 'mjpeg', width: 3200, height: 2400, size: 2.4 * MB });
  const screenshot = probe({ kind: 'image', container: 'png', videoCodec: 'png', width: 2880, height: 1800, size: 0.25 * MB });
  const diagram = probe({ kind: 'image', container: 'png', videoCodec: 'png', width: 1920, height: 1200, size: 1.6 * MB });
  for (const image of [jpeg, screenshot, diagram]) assert.equal(renditionPlan(image, 'high').action, 'reuse');
  // An animated image is never dense (its notice says what lightens it).
  assert.equal(isDense({ ...photo, animated: true }), false);
});

test('a media an import would have converted gets what the import makes of it at high; the metadata alone, without encoding', () => {
  const prores = video(1920, 1080, 9, 60, { videoCodec: 'prores', profile: null, container: 'mov', pixelFormat: 'yuv422p10le' });
  assert.deepEqual(renditionPlan(prores, 'high'), { action: 'encode', extension: '.mp4', video: 'encode', audio: 'copy', reasons: [] });
  const heic = probe({ kind: 'image', container: 'heif', videoCodec: 'hevc', width: 4032, height: 3024, size: 2.1 * MB });
  assert.equal(renditionPlan(heic, 'high').extension, '.webp');
  // A phone's photo with its GPS position: the metadata removed, the pixels kept.
  const located = probe({ kind: 'image', container: 'jpeg', videoCodec: 'mjpeg', width: 3264, height: 2448, size: 3 * MB, location: true });
  assert.deepEqual(renditionPlan(located, 'high'), { action: 'remux', extension: null, video: null, audio: null, reasons: [] });
  assert.equal(estimateBytes(located, 'high'), located.size);
  const moved = video(1920, 1080, 6, 60, { faststart: false });
  assert.equal(renditionPlan(moved, 'high').action, 'remux');
});

test('an animated image: noticed at every quality, its renditions are animated too', () => {
  const info = probe({ kind: 'image', container: 'webp', videoCodec: 'webp', width: 1280, height: 720, animated: true, duration: 12, size: 14 * MB });
  const animation = weight('image', 'assets/images/vider-la-file.webp', at(14, 9.8, 3.1));
  for (const quality of ['high', 'medium', 'low'] as const) assert.equal(weightNotice(animation, info, quality)?.reason, 'animated', quality);
  assert.equal(weightNotice(animation, info, 'high')!.why, 'An animated image of 14.0 MB (1280×720, 12 s): as a video (MP4) it would weigh several times less. Make its image block a video that loops like it: elabora media to-video <block> (MCP elabora_image_to_video).');
});

test('a video or an image that should ship as a rendition but ships as it is (no ffmpeg here): not optimized', () => {
  const prores = video(1920, 1080, 9, 60, { videoCodec: 'prores', profile: null, container: 'mov', pixelFormat: 'yuv422p10le' });
  const raw = weight('video', 'assets/video/interview.mov', at(65, 25, 9));
  const notice = weightNotice(raw, prores, 'high')!;
  assert.equal(notice.reason, 'not-optimized');
  assert.equal(notice.why, 'Not ready for the web (MOV container: the master format is MP4; Video codec prores: browsers need H.264): at high the package ships a rendition of it, which ffmpeg makes, and ffmpeg is not found here (on the PATH, or ELABORA_FFMPEG); it ships as it is, 65.0 MB.');
  const photo = probe({ kind: 'image', container: 'png', videoCodec: 'png', width: 2400, height: 1600, size: 6.9 * MB });
  assert.match(weightNotice(weight('image', 'assets/images/photo.png', at(6.9, 1.5, 0.8)), photo, 'high')!.why, /^Denser than its size needs: at high/);
  // Made as it should be: nothing to say.
  assert.equal(weightNotice(weight('video', 'assets/video/interview.mov', at(40, 25, 9, [true, true, true])), prores, 'high'), null);
  assert.equal(weightNotice(raw, prores, 'medium'), null, 'medium re-encodes it');
});

test('without ffmpeg, a package at high ships a video or an image as it is: nothing probed, nothing to encode', async () => {
  const dir = copyExample();
  try {
    fs.mkdirSync(path.join(dir, 'assets/images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets/images/photo.png'), 'not even a PNG');
    assert.equal(await renditionPath(dir, 'assets/images/photo.png', 'high', { tools: null }), path.join(dir, 'assets/images/photo.png'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('never noticed: under 2 MB, a narration, a file the qualities leave as it is', () => {
  const info = probe({ kind: 'image', container: 'png', videoCodec: 'png', width: 1000, height: 1000, size: 1.9 * MB });
  assert.equal(renditionPlan(info, 'high').action, 'reuse', '1.9 bytes a pixel, but under 2 MB');
  assert.equal(weightNotice(weight('image', 'assets/images/petit.png', at(1.9, 1.3, 0.5)), info, 'high'), null);
  assert.equal(weightNotice({ kind: 'narration', path: null, uses: [{ screen: 'salle' }], qualities: at(40, 40, 40) }, undefined, 'high'), null);
  assert.equal(weightNotice(weight('file', 'assets/resources/catalogue.pdf', at(64, 64, 64, [false, false, false])), undefined, 'high'), null);
});

test('the media noticed first, then the heaviest', () => {
  const [big, noticed, small] = [weight('video', 'a.mp4', at(90, 50, 20)), weight('image', 'b.gif', at(7, 5, 1), { notice: { reason: 'animated', why: '' } }), weight('image', 'c.jpg', at(1, 1, 1))];
  assert.deepEqual(noticedFirst([big, noticed, small]).map((media) => media.path), ['b.gif', 'a.mp4', 'c.jpg']);
});

test('durations as people say them', () => {
  assert.deepEqual([45, 270, 300, 24 * 60 + 10, 3900].map(durationText), ['45 s', '4 min 30 s', '5 min', '24 min', '1 h 05']);
});

test('a large file the qualities leave as it is is listed with where it is used, and never noticed', async () => {
  const dir = copyExample();
  try {
    fs.mkdirSync(path.join(dir, 'assets/resources'), { recursive: true });
    const pdf = path.join(dir, 'assets/resources/catalogue.pdf');
    fs.writeFileSync(pdf, '');
    fs.truncateSync(pdf, 64 * MB); // sparse: no 64 MB written
    const course = readJSON(dir, 'course.json');
    course.resources = [{ id: 'catalogue', title: 'Catalogue', asset: 'resources/catalogue.pdf' }];
    course.delivery = { ...course.delivery, mediaQuality: 'low' };
    writeJSON(dir, 'course.json', course);
    const weights = await packageWeights(loadProjectFromDir(dir));
    assert.equal(weights.quality, 'low');
    const [first] = weights.media;
    assert.equal(first!.path, 'assets/resources/catalogue.pdf');
    assert.deepEqual([first!.kind, first!.uses, first!.notice], ['file', [{ screen: null, as: 'resource' }], undefined]);
    // A file shown in a layer says its layer.
    const screen = readJSON(dir, 'screens/premier-reflexe.json');
    screen.layers[0].blocks.push({ id: 'rappel-fiche', type: 'image', props: { asset: 'images/ticket-marc.svg', alt: 'Le ticket de Marc.' } });
    writeJSON(dir, 'screens/premier-reflexe.json', screen);
    const ticket = (await packageWeights(loadProjectFromDir(dir))).media.find((media) => media.path === 'assets/images/ticket-marc.svg')!;
    assert.ok(ticket.uses.some((use) => use.screen === 'premier-reflexe' && use.block === 'rappel-fiche' && use.layer === 'rappel-regle'), JSON.stringify(ticket.uses));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
