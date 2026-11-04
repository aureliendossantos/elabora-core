import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { durationText, noticedFirst, videoCeiling, weightNotice } from '@elabora/core/media/weights';
import type { MediaWeight } from '@elabora/core/media/weights';
import { conformance } from '@elabora/core/media/conformance';
import type { FileMedia, MediaInfo } from '@elabora/core/media/conformance';
import type { PresetName } from '@elabora/core/media/presets';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { packageWeights } from '@elabora/node/packaging/weights';
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

test('a long video that weighs is what it is: no notice', () => {
  // 24 minutes of 1080p at 5 Mb/s: 900 MB at high, about 500 at medium.
  const info = video(1920, 1080, 5, 24 * 60);
  const visit = weight('video', 'assets/video/visite.mp4', at(900, 497, 275), { seconds: 24 * 60, width: 1920, height: 1080 });
  for (const quality of ['high', 'medium', 'low'] as const) assert.equal(weightNotice(visit, info, quality), null, quality);
});

test('a video far denser than its size needs: noticed where its own stream ships', () => {
  // A 720p screen recording exported at 9.5 Mb/s: more than twice the 4.4 Mb/s Elabora spends on 720p.
  const info = video(1280, 720, 9.5, 158);
  const demo = weight('video', 'assets/video/demo.mp4', at(191, 77, 30), { seconds: 158, width: 1280, height: 720 });
  assert.deepEqual(weightNotice(demo, info, 'high'), { reason: 'dense-video', why: '9.5 Mb/s for 1280×720 at 30 fps, more than twice the 4.4 Mb/s Elabora spends at most on a video of that size: 191.0 MB for 2 min 38 s. Export it again at a lower bitrate and replace it, or choose a lower quality, which re-encodes it (at medium, about 77.0 MB).' });
  assert.equal(weightNotice(demo, info, 'medium'), null, 're-encoded at medium');
  // At 6 Mb/s it is within twice the ceiling.
  assert.equal(weightNotice(demo, video(1280, 720, 6, 158), 'high'), null);
  // A small video whose stream medium copies: noticed at medium too.
  const small = video(640, 360, 3.9, 300);
  assert.equal(weightNotice(weight('video', 'assets/video/small.mp4', at(144, 144, 56, [false, false, true])), small, 'medium')?.reason, 'dense-video');
});

test('a still image of more than a byte a pixel shipped as it is: a photo saved as PNG', () => {
  const info = probe({ kind: 'image', container: 'png', videoCodec: 'png', width: 2400, height: 1600, size: 6.9 * MB });
  const photo = weight('image', 'assets/images/imprimante.png', at(6.9, 4.8, 1.2), { width: 2400, height: 1600 });
  assert.deepEqual(weightNotice(photo, info, 'high'), { reason: 'dense-image', why: '6.9 MB for 2400×1600 px, 1.9 bytes a pixel where a photo in WebP or JPEG takes about 0.3: a photo or a detailed picture saved as PNG, most likely. As WebP or JPEG it would weigh several times less: save it again that way and replace it. The lower qualities re-encode it as WebP.' });
  assert.equal(weightNotice(photo, info, 'medium'), null, 'a rendition, Elabora\'s own encoding');
  // The same pixels as a JPEG of 1.4 MB: nothing to say.
  const jpeg = probe({ kind: 'image', container: 'jpeg', videoCodec: 'mjpeg', width: 3200, height: 2400, size: 2.4 * MB });
  assert.equal(weightNotice(weight('image', 'assets/images/salle.jpg', at(2.4, 1.6, 0.6), { width: 3200, height: 2400 }), jpeg, 'high'), null);
  // With transparency, WebP alone.
  const alpha = probe({ kind: 'image', container: 'png', videoCodec: 'png', width: 1600, height: 1200, alpha: true, size: 3 * MB });
  assert.match(weightNotice(weight('image', 'assets/images/schema.png', at(3, 2, 1)), alpha, 'high')!.why, /As WebP it would weigh/);
});

test('an animated image: noticed at every quality, its renditions are animated too', () => {
  const info = probe({ kind: 'image', container: 'webp', videoCodec: 'webp', width: 1280, height: 720, animated: true, duration: 12, size: 14 * MB });
  const animation = weight('image', 'assets/images/vider-la-file.webp', at(14, 9.8, 3.1));
  for (const quality of ['high', 'medium', 'low'] as const) assert.equal(weightNotice(animation, info, quality)?.reason, 'animated', quality);
  assert.equal(weightNotice(animation, info, 'high')!.why, 'An animated image of 14.0 MB (1280×720, 12 s): as a video (MP4) it would weigh several times less. Make it a video and show it in a video block.');
});

test('a video not in its web format, shipped as it is at high', () => {
  const info = video(1920, 1080, 9, 60, { videoCodec: 'prores', profile: null, container: 'mov', pixelFormat: 'yuv422p10le' });
  const raw = weight('video', 'assets/video/interview.mov', at(65, 25, 9));
  const notice = weightNotice(raw, info, 'high')!;
  assert.equal(notice.reason, 'not-optimized');
  assert.match(notice.why, /^Not in its web format \(Video codec prores: browsers need H\.264\): at high it ships as it is, 65\.0 MB\. `elabora media optimize assets\/video\/interview\.mov` makes it a web master/);
  assert.equal(weightNotice(raw, info, 'medium'), null, 'medium re-encodes it');
});

test('never noticed: under 2 MB, a narration, a file the qualities leave as it is', () => {
  const info = probe({ kind: 'image', container: 'png', videoCodec: 'png', width: 1000, height: 1000, size: 1.9 * MB });
  assert.equal(weightNotice(weight('image', 'assets/images/petit.png', at(1.9, 1.3, 0.5)), info, 'high'), null, '1.9 bytes a pixel, but under 2 MB');
  assert.equal(weightNotice({ kind: 'narration', path: null, uses: [{ screen: 'salle' }], qualities: at(40, 40, 40) }, undefined, 'high'), null);
  assert.equal(weightNotice(weight('file', 'assets/resources/catalogue.pdf', at(64, 64, 64, [false, false, false])), undefined, 'high'), null);
});

test('the media noticed first, then the heaviest', () => {
  const [big, noticed, small] = [weight('video', 'a.mp4', at(90, 50, 20)), weight('image', 'b.png', at(7, 5, 1), { notice: { reason: 'dense-image', why: '' } }), weight('image', 'c.jpg', at(1, 1, 1))];
  assert.deepEqual(noticedFirst([big, noticed, small]).map((media) => media.path), ['b.png', 'a.mp4', 'c.jpg']);
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
