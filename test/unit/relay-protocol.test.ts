import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELAY_PROTOCOL, hostMayAsk, isRoute, parseRelayToApp, relayResponse, isStaticPath, parseAppToRelay, parseRange, parseRelayAnswer, parseRelayRequest, relayPathOf, relayRequestOf, resolveRange, serveRelayPort } from '@elabora/player/relay-protocol';
import type { EnginePortMessage, RelayAnswer, RelayRequest, RelaySource } from '@elabora/player/relay-protocol';

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

test('relay: a Range header is read as one range or none, and resolved against the size of the file', () => {
  const read = (header: string | undefined, size: number) => { const range = parseRange(header); return range === null ? null : resolveRange(range, size); };
  assert.deepEqual(read('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(read('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(read('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(read('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(read('bytes=990-2000', 1000), { start: 990, end: 999 });
  for (const past of ['bytes=1000-', 'bytes=5-1', 'bytes=-0']) assert.equal(read(past, 1000), 'unsatisfiable', past);
  assert.equal(read('bytes=0-', 0), 'unsatisfiable');
  assert.deepEqual(read('bytes=0-', 1), { start: 0, end: 0 });
  for (const none of ['bytes=0-1,5-9', 'bytes=-', 'bytes=abc', '', undefined]) assert.equal(read(none, 1000), null, String(none));
  assert.deepEqual(parseRange('bytes=0-'), { start: 0 });
});

test('relay: the HTTP answer to a request: 200 whole, 206 for a range of the whole or of a part, 416 past the end, never 206 or 416 without a Range', () => {
  const file = (body: string, extra: object = {}): RelayAnswer => ({ status: 'ok', type: 'text/plain', size: body.length, body, ...extra });
  const whole = relayResponse(file('0123456789', { hash: 'sha256:ab' }), null);
  assert.equal(whole.status, 200);
  assert.deepEqual(whole.headers, { 'content-type': 'text/plain', 'accept-ranges': 'bytes', etag: '"sha256:ab"', 'content-length': '10' });
  const ranged = relayResponse(file('0123456789'), { start: 2, end: 4 });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-range'], 'bytes 2-4/10');
  assert.equal(ranged.headers['content-length'], '3');
  assert.equal(relayResponse(file('0123456789'), { last: 3 }).headers['content-range'], 'bytes 7-9/10');
  const past = relayResponse(file('0123456789'), { start: 10 });
  assert.deepEqual([past.status, past.headers['content-range'], past.body], [416, 'bytes */10', null]);
  // The source gave only a part of a bigger file: the range inside it is served, one outside it is not.
  const part = file('23456', { size: 100, part: { start: 2, end: 6 } });
  assert.equal(relayResponse(part, { start: 3, end: 4 }).headers['content-range'], 'bytes 3-4/100');
  assert.equal(relayResponse(part, { start: 0, end: 4 }).status, 503);
  assert.equal(relayResponse(part, null).status, 503, 'a part is never a whole answer');
  // A HEAD has its headers and no body; a refusal its status; a type that is not one is read as nothing.
  assert.equal(relayResponse(file('abc'), null, true).body, null);
  assert.deepEqual(['not-found', 'refused', 'unavailable', 'failed'].map((status) => relayResponse({ status } as RelayAnswer, null).status), [404, 403, 503, 500]);
  assert.equal(relayResponse(file('abc', { type: 'text/html\r\nx: y' }), null).headers['content-type'], 'application/octet-stream');
  assert.equal(relayResponse(file('abc', { etag: '1f-3a' }), null).headers.etag, '"1f-3a"');
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
      if (request.path === 'throws') throw new Error('disk gone');
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
    assert.deepEqual(await next(), { type: 'relay/answer', id: 4, answer: { status: 'refused', message: 'Not a request of the relay' } }, 'the canvas host\'s port asks files only');
    relay.postMessage({ type: 'relay/request', id: 8, request: { kind: 'file', path: 'throws' } });
    assert.deepEqual(await next(), { type: 'relay/answer', id: 8, answer: { status: 'failed', message: 'disk gone' } });
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

test('relay: the frames host\'s port answers what an object\'s frame asks, not the module\'s other files; what a relay page says is data', async () => {
  assert.equal(hostMayAsk('canvas', { kind: 'file', path: 'assets/a.png' }), true);
  assert.equal(hostMayAsk('canvas', { kind: 'object-code', object: 'lab' }), false, 'the canvas page asks files only');
  assert.equal(hostMayAsk('canvas', { kind: 'object-frame', object: 'lab' }), false);
  assert.equal(hostMayAsk('frames', { kind: 'file', path: 'assets/a.png' }), false);
  assert.equal(hostMayAsk('frames', { kind: 'file', path: 'objects/lab/models/a.glb' }), true);
  assert.equal(hostMayAsk('frames', { kind: 'object-code', object: 'lab' }), true);
  const { port1: relay, port2: engine } = new MessageChannel();
  const log: string[] = [];
  serveRelayPort(engine, source({ 'assets/a.png': 'x', 'objects/lab/a.txt': 'y' }, log), 'frames');
  const next = () => new Promise<EnginePortMessage>((resolve) => { relay.onmessage = (event) => { resolve(event.data as EnginePortMessage); }; });
  try {
    relay.postMessage({ type: 'relay/request', id: 1, request: { kind: 'file', path: 'assets/a.png' } });
    const refused = await next();
    assert.ok(refused.type === 'relay/answer' && refused.answer.status === 'refused');
    assert.equal(log.length, 0, 'the source never saw it');
    relay.postMessage({ type: 'relay/request', id: 2, request: { kind: 'file', path: 'objects/lab/a.txt' } });
    const served = await next();
    assert.ok(served.type === 'relay/answer' && served.answer.status === 'ok');
  } finally { relay.close(); }
  const route = 'k3J0aXq9Zr1T5mYb8WcD7g';
  assert.deepEqual(parseRelayToApp({ type: 'relay/ready', protocol: RELAY_PROTOCOL, version: '1-abc', host: 'frames', extra: 1 }), { type: 'relay/ready', protocol: RELAY_PROTOCOL, version: '1-abc', host: 'frames' });
  assert.deepEqual(parseRelayToApp({ type: 'relay/opened', protocol: RELAY_PROTOCOL, route }), { type: 'relay/opened', protocol: RELAY_PROTOCOL, route });
  assert.deepEqual(parseRelayToApp({ type: 'relay/fault', protocol: RELAY_PROTOCOL, path: 'assets/a.png', stage: 'ask', message: 'TypeError: nope', extra: 1 }), { type: 'relay/fault', protocol: RELAY_PROTOCOL, path: 'assets/a.png', stage: 'ask', message: 'TypeError: nope' });
  assert.equal(parseRelayToApp({ type: 'relay/fault', protocol: RELAY_PROTOCOL, path: 'a', stage: 'elsewhere', message: 'm' }), null);
  assert.equal(parseRelayToApp({ type: 'relay/fault', protocol: RELAY_PROTOCOL, path: 'a', stage: 'ask', message: 4 }), null);
  for (const bad of [null, 'relay/ready', { type: 'relay/ready', protocol: 'other', version: 'v', host: 'canvas' }, { type: 'relay/ready', protocol: RELAY_PROTOCOL, version: 'v'.repeat(101), host: 'canvas' }, { type: 'relay/ready', protocol: RELAY_PROTOCOL, version: 'v', host: 'elsewhere' }, { type: 'relay/opened', protocol: RELAY_PROTOCOL, route: 'x' }, { type: 'relay/refused', protocol: RELAY_PROTOCOL, reason: 'because' }, { type: 'elabora/render' }]) {
    assert.equal(parseRelayToApp(bad), null, JSON.stringify(bad));
  }
});
