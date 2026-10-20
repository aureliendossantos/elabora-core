import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ALIGNER_MODELS } from '@elabora/node/align/models';
import { TRANSCRIBER_MODELS } from '@elabora/node/transcribe/models';
import { BUNDLES, ENCODERS } from '@elabora/node/voice/pocket/models';
import { installModel, modelDir, modelInstalled, modelVersionState } from '@elabora/node/models/versions';
import type { VersionedModel } from '@elabora/node/models/versions';
import type { DownloadWording } from '@elabora/node/models/download';

// The optional local models are downloaded from Elabora's own copies of the files individuals publish
// (docs/decisions/D57.md): the same bytes, so the same sizes and SHA-256, pinned by the mirror's own
// revision. An organization's repository, open to everyone, may stay where its authors publish it.

const wording: DownloadWording = { what: 'test model', needs: 'Test needs', fail: message => new Error(message), busy: message => new Error(message), using: 'an inference is running' };
// Hugging Face accounts that are not individuals: Elabora's mirrors, and Kyutai (the tokenizers of Pocket TTS).
const ORGANIZATIONS = new Set(['elabora', 'kyutai']);

test('every downloaded model file is pinned to a revision of Elabora\'s mirror or of an organization\'s repository, never of an individual\'s', () => {
  const files = [
    ...ALIGNER_MODELS.flatMap(model => model.files),
    ...TRANSCRIBER_MODELS.flatMap(model => model.files),
    ...BUNDLES.flatMap(bundle => bundle.files),
    ...Object.values(ENCODERS)
  ];
  assert.ok(files.length >= 24,'the aligners, the transcriber and the voices are all counted');
  for (const file of files) {
    const [, owner, repository, revision] = /^([^/]+)\/([^/]+)\/resolve\/([0-9a-f]{40})\/.+$/.exec(file.url) ?? [];
    assert.ok(owner, `${file.url} is <owner>/<repository>/resolve/<revision>/<path>`);
    assert.ok(ORGANIZATIONS.has(owner), `${file.name} comes from ${owner}/${repository}: mirror it in the elabora organization first (D57)`);
    assert.match(revision, /^[0-9a-f]{40}$/);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(file.size > 0);
  }
  const outside = files.filter(file => !file.url.startsWith('elabora/'));
  assert.deepEqual([...new Set(outside.map(file => file.name))], ['tokenizer.json'], 'only Kyutai\'s tokenizers are downloaded from their authors');
});

test('moving a pin to a mirror leaves an installed model current: a file is its name, size and SHA-256, not the address it came from', async context => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-mirror-test-'));
  const body = 'the same bytes';
  const file = { name: 'model.onnx', size: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') };
  const individual: VersionedModel = { version: 'v1', model: 'model@1', files: [{ ...file, url: `someone/model/resolve/${'a'.repeat(40)}/onnx/model.onnx` }] };
  const mirror: VersionedModel = { ...individual, files: [{ ...file, url: `elabora/model/resolve/${'b'.repeat(40)}/onnx/model.onnx` }] };
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string) => { requests.push(url); return new Response(body); });
  try {
    const installed = path.join(temp, 'installed');
    await installModel('test', installed, individual, 'https://models.invalid', wording);
    assert.deepEqual(requests, [`https://models.invalid/${individual.files[0].url}`]);
    assert.equal(modelInstalled(installed, mirror), true);
    assert.deepEqual(modelVersionState(installed, mirror), { installedVersion: 'v1', desiredVersion: 'v1', update: 'current' });
    assert.equal(modelDir(installed, mirror), installed, 'in place: nothing is moved or downloaded again');
    requests.length = 0;
    await installModel('test', installed, mirror, 'https://models.invalid', wording, { updateOnly: true });
    await installModel('test', installed, mirror, 'https://models.invalid', wording);
    assert.deepEqual(requests, [], 'a model installed from the individual\'s repository is not downloaded again from the mirror');

    const fresh = path.join(temp, 'fresh');
    await installModel('test', fresh, mirror, 'https://models.invalid', wording);
    assert.deepEqual(requests, [`https://models.invalid/${mirror.files[0].url}`], 'a new installation asks the mirror');
    assert.equal(fs.readFileSync(path.join(fresh, 'model.onnx'), 'utf8'), body);

    // A mirror cannot change the bytes: the pinned SHA-256 is still checked.
    context.mock.method(globalThis, 'fetch', async () => new Response('other bytes!!'));
    await assert.rejects(installModel('test', path.join(temp, 'altered'), mirror, 'https://models.invalid', wording), /damaged|does not match/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
