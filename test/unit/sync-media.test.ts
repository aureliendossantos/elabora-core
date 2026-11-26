import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_FACTS_VERSION, mediaFacts, readKnownMedia, readMediaFacts, type MediaFacts } from '@elabora/core/sync/index';
import type { MediaInfo } from '@elabora/core/media/conformance';

// A medium's facts as a room and a copy read them (D125): checked as data, bounded; a room keeps
// only what it can check, a copy takes from a newer room what it knows of.

const probe: MediaInfo = {
  kind: 'video', container: 'mp4', size: 4_200_000, duration: 20.02, bitrate: 1_680_000, videoCodec: 'h264', profile: 'High', pixelFormat: 'yuv420p',
  width: 1920, height: 1080, rotation: 0, pixelAspect: 1, fps: 29.97, videoBitrate: 1_520_000, hdr: null, alpha: false, animated: false,
  audioCodec: 'aac', audioBitrate: 160_000, channels: 2, sampleRate: 48_000, coverArt: false, faststart: true, location: false,
};
const facts = mediaFacts(probe);

test('a probe gives facts without its size, which both readers take as they are', () => {
  assert.equal(facts.version, MEDIA_FACTS_VERSION);
  assert.equal('size' in facts, false);
  assert.deepEqual(readMediaFacts(JSON.parse(JSON.stringify(facts)), 'strict'), facts);
  assert.deepEqual(readMediaFacts(facts, 'tolerant'), facts);
});

test('facts out of shape or bounds hold for no reader', () => {
  const broken: Array<Partial<Record<keyof MediaFacts, unknown>>> = [
    { kind: 'document' }, { duration: -1 }, { duration: Infinity }, { width: 1.5 }, { width: 70_000 }, { videoCodec: 'H.264 <script>' },
    { container: '' }, { profile: 'x'.repeat(65) }, { hdr: 'dolby' }, { alpha: 'no' }, { channels: 65 }, { version: 0 }, { version: 1.5 },
  ];
  for (const change of broken) {
    for (const mode of ['strict', 'tolerant'] as const) assert.equal(readMediaFacts({ ...facts, ...change }, mode), null, `${mode} ${JSON.stringify(change)}`);
  }
  const { duration: _, ...missing } = facts;
  assert.equal(readMediaFacts(missing, 'tolerant'), null);
  assert.equal(readMediaFacts([facts], 'strict'), null);
});

test('a room keeps only facts it can check; a copy reads a newer room\'s and keeps what it knows', () => {
  const newer = { ...facts, version: MEDIA_FACTS_VERSION + 1, chapters: 3 };
  // A copy newer than the room: its facts are left out there (the room cannot check them).
  assert.equal(readMediaFacts(newer, 'strict'), null);
  assert.equal(readMediaFacts({ ...facts, chapters: 3 }, 'strict'), null);
  // A room newer than the copy: the copy keeps the version, and the keys it knows.
  assert.deepEqual(readMediaFacts(newer, 'tolerant'), { ...facts, version: MEDIA_FACTS_VERSION + 1 });
});

test('a room\'s media map is read entry by entry: a bad entry or bad facts are left out, never the rest', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const other = `sha256:${'b'.repeat(64)}`;
  const known = readKnownMedia({
    [hash]: { size: 4_200_000, facts }, [other]: { size: 12, facts: { ...facts, kind: 'document' } },
    'sha256:short': { size: 1 }, [`sha256:${'c'.repeat(64)}`]: { size: -1 },
  });
  assert.deepEqual([...known], [[hash, { size: 4_200_000, facts }], [other, { size: 12 }]]);
  assert.equal(readKnownMedia(null).size, 0);
});
