import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUCK_ATTACK, DUCK_RELEASE, PEAK_CEILING, VOLUME_MAX, duckDbAt, duckGainAt, duckTimes, fadesOf, gainOf, gainOfDb, partOf, peakOf } from '@elabora/player/sound-mix';

// How a sound of the story is mixed (D67, schemas 0.1.7): the rules the player plays with and the
// desktop app's editor hears a cue with.

const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} ≠ ${expected}`);

test('a part of the file: start and end kept inside it; the whole file when they leave nothing', () => {
  assert.deepEqual(partOf(undefined, undefined, 4), { offset: 0, length: 4 });
  assert.deepEqual(partOf(0.5, 2, 4), { offset: 0.5, length: 1.5 });
  assert.deepEqual(partOf(1, 9, 4), { offset: 1, length: 3 }, 'an end past the file stops at its end');
  assert.deepEqual(partOf(3, 2, 4), { offset: 0, length: 4 }, 'an end before the start: the whole file');
  assert.deepEqual(partOf(5, undefined, 4), { offset: 0, length: 4 }, 'a start past the file: the whole file');
});

test('a volume above 100 %: raised no further than brings its peak to −1 dBFS, never below 100 %', () => {
  near(PEAK_CEILING, 0.891250938, '−1 dBFS');
  assert.equal(VOLUME_MAX, 2);
  assert.equal(gainOf(0.4, null), 0.4, 'up to 100 % as asked, the peak unread');
  assert.equal(gainOf(undefined, null), 1);
  assert.equal(gainOf(3, 0.1), 2, 'at most 200 %');
  assert.equal(gainOf(2, 0.25), 2, 'a quiet sound (−12 dBFS) is doubled');
  near(gainOf(2, 0.6), PEAK_CEILING / 0.6, 'a louder one stops at the ceiling');
  assert.equal(gainOf(1.5, 0.99), 1, 'a sound already at full scale stays at its own level');
  assert.equal(gainOf(1.5, null), 1, 'a peak not known keeps 100 %');
  assert.equal(gainOf(-1, 0.5), 0);
});

test('the peak of a part: the loudest sample, either sign, over the part only', () => {
  const left = new Float32Array([0, 0.2, -0.9, 0.1, 0.3, 0, 0, 0]);
  const right = new Float32Array([0, 0.1, 0.1, 0.1, -0.5, 0, 0, 0]);
  near(peakOf([left, right], 4), 0.9);
  near(peakOf([left, right], 4, { offset: 0.75, length: 1 }), 0.5, 'samples 3 to 6');
});

test('fades in and out: as asked, shortened together when they would be longer than the part', () => {
  assert.deepEqual(fadesOf(undefined, undefined, 2), { in: 0, out: 0 });
  assert.deepEqual(fadesOf(0.5, 1, 2), { in: 0.5, out: 1 });
  assert.deepEqual(fadesOf(1, 3, 2), { in: 0.5, out: 1.5 });
  assert.deepEqual(fadesOf(20, 0, 30), { in: 10, out: 0 }, 'at most 10 s');
});

test('a duck: down over 0.1 s as the sound starts, held, back over 0.5 s after it; the deepest of two wins', () => {
  const duck = { at: 10, length: 2, depth: 12 };
  assert.equal(duckDbAt(duck, 9.9), 0);
  near(duckDbAt(duck, 10 + DUCK_ATTACK / 2), 6, 'half way down');
  assert.equal(duckDbAt(duck, 11), 12);
  near(duckDbAt(duck, 12 + DUCK_RELEASE / 2), 6, 'half way back');
  assert.equal(duckDbAt(duck, 12 + DUCK_RELEASE), 0);
  near(gainOfDb(12), 0.251188643);
  near(duckGainAt([duck, { at: 11, length: 2, depth: 6 }], 11.5), gainOfDb(12));
  near(duckGainAt([duck, { at: 11, length: 2, depth: 20 }], 11.5), gainOfDb(20));
  assert.equal(duckGainAt([], 11), 1);
  assert.deepEqual(duckTimes([duck]), [10, 10 + DUCK_ATTACK, 12, 12 + DUCK_RELEASE]);
  assert.equal(duckDbAt({ at: 0, length: 1, depth: 90 }, 0.5), 30, 'at most 30 dB');
});
