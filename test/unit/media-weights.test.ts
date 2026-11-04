import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { durationText, heavyBytes, heavyWhy } from '@elabora/core/media/weights';
import type { MediaWeight } from '@elabora/core/media/weights';
import type { PresetName } from '@elabora/core/media/presets';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { packageWeights } from '@elabora/node/packaging/weights';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';

const MB = 1024 * 1024;
const at = (high: number, medium: number, low: number): MediaWeight['qualities'] =>
  ([['high', high], ['medium', medium], ['low', low]] as [PresetName, number][]).map(([quality, bytes]) => ({ quality, bytes: Math.round(bytes * MB), estimated: true, rendition: quality !== 'high' }));

test('a media stands out above five minutes of video at the quality\'s ceiling', () => {
  assert.deepEqual((['high', 'medium', 'low'] as const).map((quality) => Math.round(heavyBytes(quality) / 1e6)), [306, 155, 60]);
});

test('why a media is heavy, and what lightens it, in words for agents', () => {
  // A 24-minute screen recording in 1080p: resized below high, still heavy.
  const visit: MediaWeight = { kind: 'video', path: 'assets/video/visite.mp4', uses: [{ screen: 'salle', block: 'visite' }], seconds: 24 * 60 + 10, width: 1920, height: 1080, qualities: at(1010, 540, 262), heavy: true };
  assert.equal(heavyWhy(visit, 'medium'), '24 min long: 540.0 MB at medium, still 262.0 MB at low. Shorten or split it, or host it on a video platform and link to it from the course.');
  assert.equal(heavyWhy(visit, 'low'), '24 min long: even 262.0 MB at low. Shorten or split it, or host it on a video platform and link to it from the course.');
  // Already within every preset: no quality lightens it.
  const kept: MediaWeight = { ...visit, qualities: at(180, 180, 180) };
  assert.equal(heavyWhy(kept, 'medium'), '24 min long: 180.0 MB at medium, and no lower quality lightens it. Shorten or split it, or host it on a video platform and link to it from the course.');
  // Short but dense: the master at high.
  const dense: MediaWeight = { ...visit, seconds: 270, qualities: at(340, 150, 55) };
  assert.equal(heavyWhy(dense, 'high'), '340.0 MB at high (10.6 Mb/s over 4 min 30 s); 150.0 MB at medium, 55.0 MB at low. A lower quality lightens it. Shorten or split it, or host it on a video platform and link to it from the course.');
  const pdf: MediaWeight = { kind: 'file', path: 'assets/resources/catalogue.pdf', uses: [{ screen: null, as: 'resource' }], qualities: at(64, 64, 64), heavy: true };
  assert.equal(heavyWhy(pdf, 'low'), '64.0 MB: the media qualities leave such a file as it is. Make it lighter or split it, or link to it rather than ship it.');
});

test('durations as people say them', () => {
  assert.deepEqual([45, 270, 300, 24 * 60 + 10, 3900].map(durationText), ['45 s', '4 min 30 s', '5 min', '24 min', '1 h 05']);
});

test('a large file the qualities leave as it is stands out at low, with where it is used', async () => {
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
    assert.deepEqual([first!.kind, first!.uses, first!.heavy], ['file', [{ screen: null, as: 'resource' }], true]);
    assert.match(first!.why!, /^64\.0 MB: the media qualities leave such a file as it is/);
    assert.ok(weights.media.slice(1).every((media) => !media.heavy));

    course.delivery.mediaQuality = 'high';
    writeJSON(dir, 'course.json', course);
    assert.equal((await packageWeights(loadProjectFromDir(dir))).media[0]!.heavy, false, 'under the ceiling of high');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
