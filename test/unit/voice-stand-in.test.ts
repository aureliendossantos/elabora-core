import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pocketProvider } from '@elabora/node/voice/pocket/index';
import { standIn } from '@elabora/node/voice/tone';

test('the stand-in of a local provider (ELABORA_VOICE_FAKE): its voices and id, installed, a tone of each voice the same every time', async () => {
  process.env.ELABORA_VOICE_TONE_SECONDS = '0.1';
  const fake = standIn(pocketProvider);
  assert.equal(fake.id, pocketProvider.id);
  assert.deepEqual(fake.voices('fr'), pocketProvider.voices('fr'));
  assert.equal(fake.status('fr')?.installed, true);
  const [a, b] = fake.voices('fr');
  assert.ok(a && b, 'two French voices');
  const say = (voice: string) => fake.synthesize({ text: 'Bonjour à tous', voice, language: 'fr', settings: {}, seed: 1 });
  const first = await say(a.id);
  assert.deepEqual((await say(a.id)).samples, first.samples, 'the same text and voice, the same audio');
  assert.notDeepEqual((await say(b.id)).samples, first.samples, 'another voice, another pitch');
  assert.equal(first.credit, a.credit.fr ?? a.credit.en);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(fake.synthesize({ text: 'x', voice: a.id, language: 'fr', settings: {}, seed: 1, signal: stopped.signal }));
});
