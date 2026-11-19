import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELAY_PROTOCOL, isRoute, isStaticPath, parseAppToRelay, parseRange, parseRelayAnswer, parseRelayRequest, relayPathOf, relayRequestOf, resolveRange, serveRelayPort } from '@elabora/player/relay-protocol';
import type { EnginePortMessage, RelayAnswer, RelayRequest, RelaySource } from '@elabora/player/relay-protocol';
import { byteRange } from '@elabora/node/canvas/files';

test('relay: a URL of a relay host asks for a path of the module, nothing that leaves it', () => {
  assert.equal(relayPathOf('/canvas/assets/a.png'), 'assets/a.png');
  assert.equal(relayPathOf('/canvas/assets/Le%20r%C3%A9seau.png'), 'assets/Le réseau.png');
  assert.equal(relayPathOf('/canvas/assets/100%25.png'), 'assets/100%.png');
  for (const bad of ['/other/a.png', '/canvas/', '/canvas', '/canvas//a.png', '/canvas/a/../b.png', '/canvas/%2e%2e/a', '/canvas/a%2F..%2Fb', '/canvas/a%5Cb', '/canvas/a%00b', '/canvas/%E0%A4%A', '/canvas/a/', '/canvas/./a']) assert.equal(relayPathOf(bad), null, bad);
  assert.equal(isStaticPath('index.html'), true);
  assert.equal(isStaticPath('elabora/canvas.js'), true);
  assert.equal(isStaticPath('assets/elabora/x.png'), false);
  assert.equal(isStaticPath('assets/index.html'), false);
});

test('relay: a path of the module is a file, an object\'s frame or its code', () => {
  assert.deepEqual(relayRequestOf('assets/video/a.mp4', { start: 5 }), { kind: 'file', path: 'assets/video/a.mp4', range: { start: 5 } });
  assert.deepEqual(relayRequestOf('assets/a.png'), { kind: 'file', path: 'assets/a.png' });
  assert.deepEqual(relayRequestOf('objects/lab/frame.html'), { kind: 'object-frame', object: 'lab' });
  assert.deepEqual(relayRequestOf('objects/lab/object.js'), { kind: 'object-code', object: 'lab' });
  // Another file of an object's folder, or deeper, is a file.
  assert.deepEqual(relayRequestOf('objects/lab/models/a.glb'), { kind: 'file', path: 'objects/lab/models/a.glb' });
  assert.deepEqual(relayRequestOf('objects/lab/sub/frame.html'), { kind: 'file', path: 'objects/lab/sub/frame.html' });
});

test('relay: ranges as the desktop\'s server reads them, one range or none', () => {
  const sizes = [0, 1, 1000];
  for (const header of ['bytes=0-99', 'bytes=900-', 'bytes=-100', 'bytes=-5000', 'bytes=990-2000', 'bytes=1000-', 'bytes=5-1', 'bytes=0-1,5-9', 'bytes=-', 'bytes=-0', 'bytes=abc', undefined, '']) {
    for (const size of sizes) {
      const range = parseRange(header);
      const mine = range === null ? null : resolveRange(range, size);
      assert.deepEqual(mine, byteRange(header, size), `${header} of ${size}`);
    }
  }
  assert.deepEqual(parseRange('bytes=0-'), { start: 0 });
});

test('relay: what a port says is checked: a request names a path of the module or an object, an answer is a file or a refusal', () => {
  assert.deepEqual(parseRelayRequest({ kind: 'file', path: 'assets/a.png', range: { start: 1, end: 9 } }), { kind: 'file', path: 'assets/a.png', range: { start: 1, end: 9 } });
  assert.deepEqual(parseRelayRequest({ kind: 'object-code', object: 'lab', extra: 1 }), { kind: 'object-code', object: 'lab' });
  for (const bad of [null, 'file', {}, { kind: 'file' }, { kind: 'file', path: '../a' }, { kind: 'file', path: '/a' }, { kind: 'file', path: 'a/../b' }, { kind: 'file', path: 'a', range: { start: -1 } }, { kind: 'file', path: 'a', range: { start: 1.5 } }, { kind: 'file', path: 'a', range: 'bytes=0-' }, { kind: 'object-frame', object: '../x' }, { kind: 'object-frame', object: 'a/b' }, { kind: 'object-frame', object: '..' }, { kind: 'object-code' }, { kind: 'other', object: 'x' }]) {
    assert.equal(parseRelayRequest(bad), null, JSON.stringify(bad));
  }
  const blob = new Blob(['abc']);
  assert.deepEqual(parseRelayAnswer({ status: 'ok', type: 'text/plain', size: 3, body: 'abc' }), { status: 'ok', type: 'text/plain', size: 3, body: 'abc' });
  assert.equal(parseRelayAnswer({ status: 'ok', type: 'video/mp4', size: 100, body: blob, part: { start: 0, end: 2 }, hash: 'sha256:x' })?.status, 'ok');
  for (const bad of [{ status: 'ok', type: 'a', size: 3 }, { status: 'ok', type: 'a', size: 3, body: 1 }, { status: 'ok', type: 'a', size: 3, body: 'x', part: { start: 2, end: 1 } }, { status: 'ok', type: 'a', size: 3, body: 'x', part: { start: 0, end: 3 } }, { status: 'maybe' }, null]) {
    assert.equal(parseRelayAnswer(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseRelayAnswer({ status: 'not-found', message: 'x'.repeat(900) })!, { status: 'not-found', message: 'x'.repeat(500) });
});

test('relay: what the app\'s page says to a relay page: its protocol, a route of 128 bits or more', () => {
  const route = 'k3J0aXq9Zr1T5mYb8WcD7g';
  assert.equal(isRoute(route), true);
  for (const bad of ['', 'short', 'a'.repeat(65), 'has space aaaaaaaaaaaaaaaa', '../aaaaaaaaaaaaaaaaaaaaa', 5, null]) assert.equal(isRoute(bad), false, String(bad));
  assert.deepEqual(parseAppToRelay({ type: 'relay/open', protocol: RELAY_PROTOCOL, route }), { type: 'relay/open', protocol: RELAY_PROTOCOL, route });
  assert.deepEqual(parseAppToRelay({ type: 'relay/update', protocol: RELAY_PROTOCOL }), { type: 'relay/update', protocol: RELAY_PROTOCOL });
  assert.equal(parseAppToRelay({ type: 'relay/open', protocol: 'elabora-relay/0', route }), 'protocol');
  assert.equal(parseAppToRelay({ type: 'relay/close', protocol: RELAY_PROTOCOL, route: 'x' }), 'route');
  assert.equal(parseAppToRelay({ type: 'elabora/render' }), null);
  assert.equal(parseAppToRelay('relay/open'), null);
});

// A source that answers from a table, slowly when told to.
function source(files: Record<string, string>, log: string[] = []): RelaySource {
  return {
    async get(request: RelayRequest, signal?: AbortSignal): Promise<RelayAnswer> {
      log.push(JSON.stringify(request));
      if (request.kind === 'object-frame') return { status: 'ok', type: 'text/html', size: 4, body: '<p/>' };
      if (request.kind === 'object-code') throw new Error('no bundler here');
      if (request.path === 'slow') await new Promise<void>((resolve) => signal?.addEventListener('abort', () => { log.push('aborted'); resolve(); }));
      if (request.path === 'bad') return { status: 'ok', size: -1 } as unknown as RelayAnswer;
      const text = files[request.path];
      return text === undefined ? { status: 'not-found' } : { status: 'ok', type: 'text/plain', size: text.length, body: new Blob([text]) };
    }
  };
}

test('relay: the engine\'s end of a port answers each request from its source, refuses what is not one, cancels, and says bye', async () => {
  const { port1: relay, port2: engine } = new MessageChannel();
  const log: string[] = [];
  const end = serveRelayPort(engine, source({ 'a.txt': 'hello' }, log));
  const heard: EnginePortMessage[] = [];
  const next = () => new Promise<EnginePortMessage>((resolve) => { const hold = heard.shift(); if (hold) resolve(hold); else relay.onmessage = (event) => { resolve(event.data as EnginePortMessage); }; });
  try {
    relay.postMessage({ type: 'relay/request', id: 1, request: { kind: 'file', path: 'a.txt' } });
    const one = await next();
    assert.ok(one.type === 'relay/answer' && one.id === 1 && one.answer.status === 'ok' && one.answer.body instanceof Blob);
    assert.equal(await (one.type === 'relay/answer' && one.answer.status === 'ok' ? (one.answer.body as Blob).text() : ''), 'hello');
    relay.postMessage({ type: 'relay/request', id: 2, request: { kind: 'file', path: 'missing' } });
    assert.deepEqual(await next(), { type: 'relay/answer', id: 2, answer: { status: 'not-found' } });
    relay.postMessage({ type: 'relay/request', id: 3, request: { kind: 'file', path: '../secret' } });
    const refused = await next();
    assert.ok(refused.type === 'relay/answer' && refused.id === 3 && refused.answer.status === 'refused');
    assert.equal(log.some((line) => line.includes('secret')), false, 'a path outside the module never reaches the source');
    relay.postMessage({ type: 'relay/request', id: 4, request: { kind: 'object-code', object: 'lab' } });
    assert.deepEqual(await next(), { type: 'relay/answer', id: 4, answer: { status: 'failed', message: 'no bundler here' } });
    relay.postMessage({ type: 'relay/request', id: 5, request: { kind: 'file', path: 'bad' } });
    const notAnswer = await next();
    assert.ok(notAnswer.type === 'relay/answer' && notAnswer.answer.status === 'failed');
    // A request the browser gave up: the source is told, nothing comes back, the one after is answered.
    relay.postMessage({ type: 'relay/request', id: 6, request: { kind: 'file', path: 'slow' } });
    relay.postMessage({ type: 'relay/cancel', id: 6 });
    relay.postMessage({ type: 'relay/request', id: 7, request: { kind: 'file', path: 'a.txt' } });
    const after = await next();
    assert.ok(after.type === 'relay/answer' && after.id === 7);
    assert.ok(log.includes('aborted'));
    // Not messages of the protocol: ignored.
    relay.postMessage('relay/request');
    relay.postMessage({ type: 'relay/request', request: {} });
    end();
    assert.deepEqual(await next(), { type: 'relay/bye' });
  } finally {
    relay.close();
  }
});
