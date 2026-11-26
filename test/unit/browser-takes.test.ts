import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTakes, takeAudio } from '@elabora/engine/browser/voices/takes';

// A browser's takes where the origin has no private file system (a private window of Safari or
// Firefox; here, Node, which has none): kept in memory for the session's life, listed and read back.

test('a browser\'s takes without a private file system: kept in memory, listed in order, their audio read back', async () => {
  const takes = browserTakes('tm.prj');
  const meta = (take: number) => ({ take, seed: 7 + take, provider: 'elevenlabs', voice: 'v', model: 'm', text: 'Hello', duration: 0.5, createdAt: '2026-11-26T22:00:00Z' }) as never;
  const samples = Float32Array.from({ length: 12000 }, (_, i) => Math.sin(i / 10) * 0.2);
  const second = await takes.keep({ language: 'en', screen: 's1', line: 'l1', take: 2, samples, sampleRate: 24000, speed: 1, meta: meta(2) });
  const first = await takes.keep({ language: 'en', screen: 's1', line: 'l1', take: 1, samples, sampleRate: 24000, speed: 1.25, meta: meta(1) });
  assert.match(first, /^memory:elabora-takes\/tm\.prj\/en\/s1\/l1\/take-1\.wav$/);
  const listed = await takes.list('en', 's1', 'l1');
  assert.deepEqual(listed.map((take) => [take.take, take.file]), [[1, first], [2, second]]);
  assert.deepEqual(await takes.list('en', 's1', 'l2'), [], 'another line has none');
  const audio = await takeAudio(second);
  assert.equal(audio?.size, 44 + 12000 * 2, 'its WAV');
  assert.ok((await takeAudio(first))!.size < audio!.size, 'said faster, shorter');
  assert.equal(await takeAudio('memory:elabora-takes/none.wav'), null);
});
