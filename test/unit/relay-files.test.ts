import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasPageHtml, relayFiles } from '@elabora/node/bundles';

test('relay files: one script for both hosts that says its version and leaves its policy to the host\'s Worker, a page script, the frames host\'s page, the canvas page', async () => {
  const files = await relayFiles();
  assert.deepEqual(Object.keys(files).sort(), ['canvas/index.html', 'relay-page.js', 'relay.html', 'relay.js']);
  // The version changes with the script and is the same for the same script.
  const version = /\d+\.\d+\.\d+-[0-9a-f]{12}/.exec(files['relay.js']!)?.[0];
  assert.ok(version, 'a version');
  assert.equal((await relayFiles())['relay.js'], files['relay.js']);
  // The host's policy is written before the script by the host's Worker, never by the script.
  assert.doesNotMatch(files['relay.js']!, /ELABORA_HOST\s*=/);
  assert.match(files['relay.js']!, /ELABORA_HOST/);
  assert.ok(files['relay.js']!.length < 12000 && files['relay-page.js']!.length < 12000, 'small');
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
