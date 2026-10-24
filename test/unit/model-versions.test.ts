import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireModel, desiredModelDir, holdModel, installModel, modelDir, modelInstalled, modelVersionState, removeModels } from '@elabora/node/models/versions';
import type { VersionedModel } from '@elabora/node/models/versions';
import type { DownloadWording, ModelFile } from '@elabora/node/models/download';
import { resources } from '../resources.ts';

const file = (name: string, body: string): ModelFile => ({ name, url: name, size: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') });
const wording: DownloadWording = { what: 'test model', needs: 'Test needs', fail: message => new Error(message), busy: message => Object.assign(new Error(message), { code: 'E_MODEL_BUSY' }), using: 'an inference is running' };
const old: VersionedModel = { version: 'v1', model: 'model@1', files: [file('weights', 'old'), file('vocab', 'same')] };
const next: VersionedModel = { version: 'v2', model: 'model@2', files: [file('weights', 'new'), file('vocab', 'same')], compatible: [old] };
function removed(folder: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => { if (!fs.existsSync(folder)) { clearTimeout(timer); watcher.close(); resolve(); } };
    const watcher = fs.watch(path.dirname(folder), check);
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`Model folder not removed: ${folder}`)); }, 5000);
    check();
  });
}

test('an upgrade keeps the compatible model usable during download, switches on the next call, and deletes old files after the last lease', async context => {
  const { own, tempDir } = resources(context);
  const temp = tempDir('elabora-version-test-');
  const base = path.join(temp, 'model');
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string) => { requests.push(url); return new Response(url.endsWith('vocab') ? 'same' : 'old'); });
  await installModel('test', base, old, 'https://models.invalid', wording);
  assert.equal(modelVersionState(base, next).update, 'available');
  const inFlight = own(await acquireModel(base, next, wording), value => value.release());
  assert.equal(inFlight.model, 'model@1');
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let requested!: () => void;
  const requestStarted = new Promise<void>(resolve => { requested = resolve; });
  context.mock.method(globalThis, 'fetch', async (url: string) => { requests.push(url); requested(); await waiting; return new Response('new'); });
  requests.length = 0;
  const installing = own(installModel('test', base, next, 'https://models.invalid', wording), async value => { finish(); await value; });
  await requestStarted;
  assert.equal(modelInstalled(base, next), true);
  assert.equal(modelDir(base, next), base);
  const alsoOld = own(await acquireModel(base, next, wording), value => value.release());
  assert.equal(alsoOld.version, 'v1'); alsoOld.release();
  finish(); await installing;
  assert.equal(modelVersionState(base, next).update, 'current');
  assert.equal(requests.length, 1, 'unchanged vocab reused without another request');
  assert.ok(fs.existsSync(path.join(base, 'weights')), 'download completion alone does not delete the old model');
  const now = own(await acquireModel(base, next, wording), value => value.release());
  assert.equal(now.model, 'model@2');
  assert.notEqual(now.dir, base);
  now.release();
  assert.ok(fs.existsSync(path.join(base, 'weights')), 'an outstanding call still owns the old model');
  const gone = removed(base);
  inFlight.release();
  await gone;
  assert.equal(modelVersionState(base, next).installedVersion, 'v2');
  await removeModels(base, next, wording);
  assert.equal(modelVersionState(base, next).update, 'absent');
  await installModel('test', base, next, 'https://models.invalid', wording, { updateOnly: true });
  assert.equal(modelInstalled(base, next), false, 'automatic updates never reinstall a removed element');
});

test('unknown/incompatible versions are not used; cancelling a partial upgrade preserves the compatible model', async context => {
  const { own, tempDir } = resources(context);
  const temp = tempDir('elabora-version-cancel-');
  const base = path.join(temp, 'model');
  context.mock.method(globalThis, 'fetch', async (url: string) => new Response(url.endsWith('vocab') ? 'same' : 'old'));
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
  const release = own(await holdModel(base, next, wording), value => value());
  await assert.rejects(removeModels(base, next, wording), /in use/);
  release();
  assert.throws(() => modelVersionState(base, { ...next, incompatible: ['v1'] }), /both compatible and incompatible/);
});

test('a first installation stopped partway resumes and is removed in place, not beside itself as an upgrade', async context => {
  const { tempDir } = resources(context);
  const temp = tempDir('elabora-version-first-');
  const base = path.join(temp, 'model');
  const controller = new AbortController();
  // weights comes whole and is verified, then vocab stops: the download is cancelled.
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('weights')) return new Response('new');
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  await assert.rejects(installModel('test', base, next, 'https://models.invalid', wording, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fs.readFileSync(path.join(base, 'weights'), 'utf8'), 'new', 'the completed file remains available to resume');
  assert.equal(desiredModelDir(base, next), base, 'the first installation resumes in its own layout');
  await removeModels(base, next, wording, true);
  const left = fs.existsSync(base) ? fs.readdirSync(base, { recursive: true, encoding: 'utf8' }).filter(name => fs.statSync(path.join(base, name)).isFile()) : [];
  assert.deepEqual(left, [], 'cancelled: nothing it received is left');
});

test('an upgrade that only adds files goes beside the installed release, and cancelling it keeps that release', async context => {
  const { tempDir } = resources(context);
  const temp = tempDir('elabora-version-additive-');
  const base = path.join(temp, 'model');
  const r1: VersionedModel = { version: 'v1', model: 'model@1', files: [file('weights', 'old'), file('vocab', 'same')] };
  const added = (compatible: boolean): VersionedModel => ({ version: 'v2', model: 'model@2', files: [file('weights', 'old'), file('vocab', 'same'), file('extra', 'more')], ...(compatible ? { compatible: [r1] } : {}) });
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
    await assert.rejects(installModel('test', base, r2, 'https://models.invalid', wording, { signal: controller.signal }), { name: 'AbortError' });
    await removeModels(base, r2, wording, true);
    assert.ok(fs.existsSync(path.join(base, 'weights')) && modelVersionState(base, r1).update === 'current', `cancelled (${compatible ? 'compatible' : 'incompatible'}): the installed release is still there and complete`);
  }
  // A legacy layout without a receipt, holding a release the new one only adds to: kept as earlier too.
  fs.rmSync(path.join(base, 'release.json'));
  assert.notEqual(desiredModelDir(base, added(false)), base);
  assert.equal(modelVersionState(base, added(false)).update, 'required');
});
