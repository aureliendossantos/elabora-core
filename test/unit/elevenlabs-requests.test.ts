import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevenLabsRequest } from '@elabora/core/voice/elevenlabs/requests';

// The operations Elabora asks ElevenLabs, the only ones the page that holds a browser's key sends
// (D29): what each builds, and what is refused, whoever asks.
test('ElevenLabs requests: the list builds what the desktop sends, and refuses anything else', () => {
  assert.deepEqual(elevenLabsRequest('voices', { page_size: 100, search: 'calme et posé' }), { method: 'GET', path: '/v2/voices?page_size=100&search=calme+et+pos%C3%A9', answer: 'json', keyed: true });
  const speech = elevenLabsRequest('speech', { voice: 'JBFqnCBsd6RMkjVDRZzb', output_format: 'pcm_24000', body: { text: 'Bonjour', model_id: 'eleven_v4', language_code: 'fr', seed: 7 } });
  assert.equal(speech.path, '/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=pcm_24000');
  assert.deepEqual(speech.body, { text: 'Bonjour', model_id: 'eleven_v4', language_code: 'fr', seed: 7 });
  assert.equal(elevenLabsRequest('preview', { url: 'https://storage.googleapis.com/eleven-public-prod/voices/a.mp3' }).keyed, false);
  const refused = (op: string, params: unknown) => assert.throws(() => elevenLabsRequest(op, params), (error: Error & { code?: string }) => error.code === 'E_KEY_REQUEST', `${op} ${JSON.stringify(params)}`);
  refused('history', {});
  refused('account', { extra: 1 });
  refused('voice', { id: '../v1/api-keys' });
  refused('speech', { voice: 'JBFqnCBsd6RMkjVDRZzb', output_format: 'pcm_24000', body: { text: 'Bonjour', constructor: 1 } });
  refused('speech', { voice: 'JBFqnCBsd6RMkjVDRZzb', output_format: 'mp3_44100_128', body: { text: 'Bonjour' } });
  refused('speech', { voice: 'JBFqnCBsd6RMkjVDRZzb', output_format: 'pcm_24000', body: { text: 'x'.repeat(10_001) } });
  refused('voices', { page_size: 100, delete: 'all' });
  refused('preview', { url: 'https://storage.googleapis.com/someone-else/a.mp3' });
  refused('preview', { url: 'https://storage.googleapis.com/eleven-public-prod/../other/a.mp3' });
});
