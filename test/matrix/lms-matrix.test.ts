import { test } from 'node:test';
import { resources } from '../resources.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers.ts';
import { build } from '@elabora/node/build';
import { testPackage } from '@elabora/node/emulator/run';

// The LMS matrix (slow; npm run test:matrix): every launch mode of the profiles with unusual
// topologies, and Chrome with unload deprecated and allowed (a browser setting, the same for every
// LMS, checked on one). The everyday suite runs Moodle once (test/e2e/lms.test.js).
test('the example passes the LMS emulator: SuccessFactors popup chain, Docebo nested iframe, Chrome with unload deprecated and allowed', { timeout: 300000 }, async (t) => {
  const dir = resources(t).copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const b = await build(dir, { profiles: ['moodle', 'successfactors', 'docebo'], emit: 'dir', out: resources(t).tempDir('elabora-e2e-') });
  assert.ok(b.ok && b.dirPath);
  const moodle = await testPackage({ dir: b.dirPath, profiles: ['moodle'] });
  const others = await testPackage({ dir: b.dirPath, profiles: ['successfactors', 'docebo'], unloadVariants: false });
  const runs = [...moodle.runs, ...others.runs];
  const failed = runs.filter((x) => !x.ok).map((x) => `${x.profile}/${x.launch}/${x.browser}: ${x.failures.map((f) => f.code).join(',')}`);
  assert.deepEqual(failed, []);
  assert.deepEqual(new Set(moodle.runs.map((x) => x.browser.replace(/^[^(]+/, ''))), new Set(['(unload deprecated)', '(unload allowed)']));
  assert.ok(moodle.runs.every(x => /^(chromium|electron)\(/.test(x.browser)));
  assert.ok(runs.some((x) => x.launch === 'popup-chain'));
  assert.ok(runs.some((x) => x.launch === 'nested-iframe'));
});
