import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireModel, desiredModelDir, holdModel, installModel, modelDir, modelInstalled, modelVersionState, removeModels } from '@elabora/node/models/versions';
import type { VersionedModel } from '@elabora/node/models/versions';
import type { DownloadWording, ModelFile } from '@elabora/node/models/download';

const file = (name: string, body: string): ModelFile => ({ name, url: name, size: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') });
const wording: DownloadWording = { what: 'test model', needs: 'Test needs', fail: message => new Error(message), busy: message => Object.assign(new Error(message), { code: 'E_MODEL_BUSY' }), using: 'an inference is running' };
const old: VersionedModel = { version: 'v1', model: 'model@1', files: [file('weights', 'old'), file('vocab', 'same')] };
const next: VersionedModel = { version: 'v2', model: 'model@2', files: [file('weights', 'new'), file('vocab', 'same')], compatible: [old] };
const settle = async (test: () => boolean) => { for (let i = 0; !test() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(test()); };

test('an upgrade keeps the compatible model usable during download, switches on the next call, and deletes old files after the last lease', async context => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-version-test-'));
  const base = path.join(temp, 'model');
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string) => { requests.push(url); return new Response(url.endsWith('vocab') ? 'same' : 'old'); });
  try {
    await installModel('test', base, old, 'https://models.invalid', wording);
    assert.equal(modelVersionState(base, next).update, 'available');
    const inFlight = await acquireModel(base, next, wording);
    assert.equal(inFlight.model, 'model@1');
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    context.mock.method(globalThis, 'fetch', async (url: string) => { requests.push(url); await waiting; return new Response('new'); });
    requests.length = 0;
    const installing = installModel('test', base, next, 'https://models.invalid', wording);
    await settle(() => requests.length === 1);
    assert.equal(modelInstalled(base, next), true);
    assert.equal(modelDir(base, next), base);
    const alsoOld = await acquireModel(base, next, wording);
    assert.equal(alsoOld.version, 'v1'); alsoOld.release();
    finish(); await installing;
    assert.equal(modelVersionState(base, next).update, 'current');
    assert.equal(requests.length, 1, 'unchanged vocab reused without another request');
    assert.ok(fs.existsSync(path.join(base, 'weights')), 'download completion alone does not delete the old model');
    const now = await acquireModel(base, next, wording);
    assert.equal(now.model, 'model@2');
    assert.notEqual(now.dir, base);
    now.release();
    assert.ok(fs.existsSync(path.join(base, 'weights')), 'an outstanding call still owns the old model');
    inFlight.release();
    await settle(() => !fs.existsSync(base));
    assert.equal(modelVersionState(base, next).installedVersion, 'v2');
    await removeModels(base, next, wording);
    assert.equal(modelVersionState(base, next).update, 'absent');
    await installModel('test', base, next, 'https://models.invalid', wording, { updateOnly: true });
    assert.equal(modelInstalled(base, next), false, 'automatic updates never reinstall a removed element');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('unknown/incompatible versions are not used; cancelling a partial upgrade preserves the compatible model', async context => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-version-cancel-'));
  const base = path.join(temp, 'model');
  context.mock.method(globalThis, 'fetch', async (url: string) => new Response(url.endsWith('vocab') ? 'same' : 'old'));
  try {
    await installModel('test', base, old, 'https://models.invalid', wording);
    const incompatible = { ...next, compatible: [], incompatible: ['v1'] };
    assert.equal(modelInstalled(base, incompatible), false);
    assert.equal(modelVersionState(base, incompatible).update, 'required');
    await assert.rejects(acquireModel(base, incompatible, wording), /No compatible/);
    const staging = desiredModelDir(base, next);
    fs.mkdirSync(staging, { recursive: true }); fs.writeFileSync(path.join(staging, 'weights.part'), 'n');
    await removeModels(base, next, wording, true);
    assert.equal(modelDir(base, next), base);
    assert.equal(modelVersionState(base, next).update, 'available');
    const release = await holdModel(base, next, wording);
    await assert.rejects(removeModels(base, next, wording), /in use/);
    release();
    assert.throws(() => modelVersionState(base, { ...next, incompatible: ['v1'] }), /both compatible and incompatible/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('a first installation stopped partway resumes and is removed in place, not beside itself as an upgrade', async context => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-version-first-'));
  const base = path.join(temp, 'model');
  const controller = new AbortController();
  // weights comes whole and is verified, then vocab stops: the download is cancelled.
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('weights')) return new Response('new');
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  try {
    await installModel('test', base, next, 'https://models.invalid', wording, { signal: controller.signal }).catch(() => {});
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(base, 'verified.json'), 'utf8'))).includes('weights'), 'one file was verified before the stop');
    assert.equal(desiredModelDir(base, next), base, 'the first installation resumes in its own layout');
    await removeModels(base, next, wording, true);
    const left = fs.existsSync(base) ? fs.readdirSync(base, { recursive: true, encoding: 'utf8' }).filter(name => fs.statSync(path.join(base, name)).isFile()) : [];
    assert.deepEqual(left, [], 'cancelled: nothing it received is left');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('an upgrade that only adds files goes beside the installed release, and cancelling it keeps that release', async context => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-version-additive-'));
  const base = path.join(temp, 'model');
  const r1: VersionedModel = { version: 'v1', model: 'model@1', files: [file('weights', 'old'), file('vocab', 'same')] };
  const added = (compatible: boolean): VersionedModel => ({ version: 'v2', model: 'model@2', files: [file('weights', 'old'), file('vocab', 'same'), file('extra', 'more')], ...(compatible ? { compatible: [r1] } : {}) });
  try {
    for (const compatible of [false, true]) {
      fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(`${base}.versions`, { recursive: true, force: true });
      context.mock.method(globalThis, 'fetch', async (url: string) => new Response(url.endsWith('vocab') ? 'same' : 'old'));
      await installModel('test', base, r1, 'https://models.invalid', wording);
      const r2 = added(compatible);
      assert.equal(modelVersionState(base, r2).update, compatible ? 'available' : 'required', 'the earlier release is known as such');
      assert.notEqual(desiredModelDir(base, r2), base, 'the upgrade goes beside it');
      // « Télécharger maintenant », then « Annuler » while the added file comes.
      const controller = new AbortController();
      context.mock.method(globalThis, 'fetch', async (url: string) => {
        if (url.endsWith('extra')) { controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
        return new Response(url.endsWith('vocab') ? 'same' : 'old');
      });
      await installModel('test', base, r2, 'https://models.invalid', wording, { signal: controller.signal }).catch(() => {});
      await removeModels(base, r2, wording, true);
      assert.ok(fs.existsSync(path.join(base, 'weights')) && modelVersionState(base, r1).update === 'current', `cancelled (${compatible ? 'compatible' : 'incompatible'}): the installed release is still there and complete`);
    }
    // A legacy layout without a receipt, holding a release the new one only adds to: kept as earlier too.
    fs.rmSync(path.join(base, 'release.json'));
    assert.notEqual(desiredModelDir(base, added(false)), base);
    assert.equal(modelVersionState(base, added(false)).update, 'required');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
