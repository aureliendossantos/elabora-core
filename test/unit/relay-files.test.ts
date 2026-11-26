import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canvasPageHtml, relayFiles } from '@elabora/node/bundles';

test('relay files: one script for both hosts that says its version and leaves its policy to the host\'s Worker, a page script, the frames host\'s page, the canvas page and the player\'s files, each named in the script by its SHA-256', async () => {
  const built = await relayFiles();
  const files = Object.fromEntries(Object.entries(built).map(([file, body]) => [file, body.toString()]));
  assert.deepEqual(Object.keys(files).sort(), ['canvas/elabora/canvas.js', 'canvas/elabora/object-frame.js', 'canvas/elabora/player.css', 'canvas/elabora/vendor/three-r186.js', 'canvas/index.html', 'relay-page.js', 'relay.html', 'relay.js']);
  // The relay keeps the others (D131): it names each by its path on the host and the SHA-256 of its bytes, and nothing else.
  for (const [file, body] of Object.entries(built)) {
    if (file === 'relay.js') continue;
    assert.ok(files['relay.js']!.includes(`"/${file}":"${crypto.createHash('sha256').update(body).digest('hex')}"`), `the relay names /${file} by its hash`);
  }
  assert.equal((files['relay.js']!.match(/"\/[^"]+":"[0-9a-f]{64}"/g) ?? []).length, 7);
  // The version changes with the script and is the same for the same script.
  const version = /\d+\.\d+\.\d+-[0-9a-f]{12}/.exec(files['relay.js']!)?.[0];
  assert.ok(version, 'a version');
  assert.equal((await relayFiles())['relay.js'], built['relay.js']);
  // The host's policy is written before the script by the host's Worker, never by the script.
  assert.doesNotMatch(files['relay.js']!, /ELABORA_HOST\s*=/);
  assert.match(files['relay.js']!, /ELABORA_HOST/);
  assert.ok(files['relay.js']!.length < 14000 && files['relay-page.js']!.length < 12000, 'small');
  // The pages carry no inline script: the hosts' policies allow their own scripts only.
  assert.match(files['relay.html']!, /<script src="\/relay-page\.js" data-relay-role="frames"><\/script>/);
  assert.match(files['canvas/index.html']!, /<script src="\/relay-page\.js" data-relay-role="canvas"><\/script>/);
  assert.doesNotMatch(files['canvas/index.html']!, /canvas-connect/);
  assert.match(canvasPageHtml(), /canvas-connect\.js/);
  for (const html of [files['relay.html']!, files['canvas/index.html']!]) {
    const opened = html.match(/<script\b[^>]*>/g) ?? [];
    assert.ok(opened.length > 0, 'a script');
    for (const tag of opened) assert.match(tag, /^<script src="[^"]+"/, 'every script is a file, none is written in the page');
  }
});
