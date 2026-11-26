import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserElevenLabs } from '@elabora/engine/browser/voices/elevenlabs';

// A browser's session's ElevenLabs over the port to the key's page (D136): the page's state asked when
// the session knows of no key yet, and an operation stopped without waiting for the page's answer.

test('the browser\'s ElevenLabs: the key\'s state asked of the page, an operation stopped while the page has not answered', async () => {
  const eleven = new BrowserElevenLabs();
  const { port1, port2 } = new MessageChannel();
  const asked: string[] = [];
  // The page: it holds a key, and never answers for the account.
  port2.onmessage = ({ data }) => {
    asked.push(data.op);
    if (data.op === 'keyState') port2.postMessage({ v: 1, id: data.id, ok: true, key: { present: true, masked: 'sk_…cafe', kept: false } });
  };
  eleven.connect(port1);
  // No key event came: the state is asked.
  await eleven.refresh();
  assert.deepEqual(asked, ['keyState']);
  await eleven.refresh();
  assert.deepEqual(asked, ['keyState'], 'asked once, the key being known');

  const controller = new AbortController();
  const account = eleven.elevenLabs.account({ signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(asked.at(-1), 'account', 'the key known, the account is asked of the page');
  controller.abort(new Error('stopped'));
  await assert.rejects(account, /stopped/);
  eleven.close();
  port2.close();
});

test('the browser\'s ElevenLabs: a key\'s page that does not answer is taken as holding no key, within two seconds', async () => {
  const eleven = new BrowserElevenLabs();
  const { port1, port2 } = new MessageChannel();
  // The page was removed: nothing answers.
  port2.onmessage = () => {};
  eleven.connect(port1);
  const started = Date.now();
  await eleven.refresh();
  assert.ok(Date.now() - started < 2500, 'not waited for');
  await assert.rejects(eleven.elevenLabs.account(), (error: { code?: string }) => error.code === 'E_VOICE_KEY_MISSING');
  eleven.close();
  port2.close();
});
