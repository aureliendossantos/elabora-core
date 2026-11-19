import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Sha256, sha256, sha256OfBlob } from '@elabora/core/util/sha256';

// The core's SHA-256, in one call and fed by pieces: WebCrypto's digest on every length around a
// block's edges, whatever the pieces; a large file read slice by slice, timed.

const webCrypto = async (bytes: Uint8Array) => Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)).toString('hex');

test('SHA-256 by pieces: WebCrypto\'s digest, whatever the lengths and the pieces', async () => {
  const random = crypto.randomBytes(1500);
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 1500]) {
    const bytes = new Uint8Array(random.subarray(0, length));
    const expected = await webCrypto(bytes);
    assert.equal(sha256(bytes), expected, `${length} bytes at once`);
    for (const piece of [1, 7, 64, 100]) {
      const hash = new Sha256();
      for (let at = 0; at < length; at += piece) hash.update(bytes.subarray(at, at + piece));
      assert.equal(hash.hex(), expected, `${length} bytes by ${piece}`);
    }
    assert.equal(await sha256OfBlob(new Blob([bytes]), 33), expected, `${length} bytes of a Blob`);
  }
  assert.equal(sha256('été'), await webCrypto(new TextEncoder().encode('été')));
});

test('SHA-256 of 64 MB read slice by slice', async (t) => {
  const big = new Uint8Array(64 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
  const started = performance.now();
  const ours = await sha256OfBlob(new Blob([big]));
  const ms = performance.now() - started;
  assert.equal(ours, await webCrypto(big));
  t.diagnostic(`64 MB in ${Math.round(ms)} ms (${(64 / (ms / 1000)).toFixed(0)} MB/s)`);
});
