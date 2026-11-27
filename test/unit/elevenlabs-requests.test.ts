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
  assert.equal(elevenLabsRequest('preview', { url: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/JBFqnCBsd6RMkjVDRZzb/e6206d1a-0721-4787-aafb-06a6e705cac5.mp3' }).keyed, false);
  // No escape (a browser would read %2e%2e as a dot segment), query or fragment in the bucket's path.
  for (const rest of ['%2e%2e/other/a.mp3', 'voices/%2E%2E/a.mp3', 'voices/a.mp3?x=1', 'voices/a.mp3#f', 'voices/./a.mp3', '.hidden', 'voices//a.mp3', 'voices/a b.mp3']) refused('preview', { url: `https://storage.googleapis.com/eleven-public-prod/${rest}` });
  // The API's preview route, which takes no key: the main host or a region's, its payload only.
  for (const url of ['https://api.elevenlabs.io/v1/voices/FvmvwvObRqIHojkEGh5N/previews/audio', 'https://api.us.elevenlabs.io/v1/voices/FvmvwvObRqIHojkEGh5N/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJjdXN0b20ifQ%3D%3D', 'https://api.eu.residency.elevenlabs.io/v1/voices/FvmvwvObRqIHojkEGh5N/previews/audio', 'https://api.in.residency.elevenlabs.io/v1/voices/FvmvwvObRqIHojkEGh5N/previews/audio', 'https://api.sg.residency.elevenlabs.io/v1/voices/FvmvwvObRqIHojkEGh5N/previews/audio']) {
    assert.deepEqual(elevenLabsRequest('preview', { url }), { method: 'GET', path: url, answer: 'bytes', keyed: false });
  }
  for (const url of ['http://api.elevenlabs.io/v1/voices/abc/previews/audio', 'https://api.elevenlabs.io.example.com/v1/voices/abc/previews/audio', 'https://evil.com/api.elevenlabs.io/v1/voices/abc/previews/audio',
    'https://api.elevenlabs.io:8443/v1/voices/abc/previews/audio', 'https://user@api.elevenlabs.io/v1/voices/abc/previews/audio', 'https://api.elevenlabs.io/v1/voices/abc/previews/audio?payload=x&delete=1',
    'https://api.elevenlabs.io/v1/voices/abc/previews/../../history', 'https://api.elevenlabs.io/v1/voices/abc/previews/%2e%2e', 'https://api.elevenlabs.io/v1/voices/abc', 'https://api.elevenlabs.io/v1/history', 'https://API.elevenlabs.io/v1/voices/abc/previews/audio',
    // Hosts named, not a pattern: another subdomain of the service is not a preview's.
    'https://api.xx.elevenlabs.io/v1/voices/abc/previews/audio', 'https://api.eu.elevenlabs.io/v1/voices/abc/previews/audio', 'https://apix.elevenlabs.io/v1/voices/abc/previews/audio']) refused('preview', { url });
});
