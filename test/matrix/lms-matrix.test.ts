import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, copyExample } from '../helpers.ts';
import { build } from '@elabora/node/build';
import { testPackage, type PackageRun } from '@elabora/node/emulator/run';

// The LMS matrix (slow; pnpm run test:matrix): every launch mode of the profiles with unusual
// topologies, and Chrome with unload deprecated and allowed (a browser setting, the same for every
// LMS, checked on one). The everyday suite runs Moodle once (test/e2e/lms.test.js). Its runs take 3 to
// 4 minutes on a Mac under load, more on GitHub's macOS runners: 10 minutes at most.
// Each run said as it is reported (in their order: one that hangs holds back those after it), with the
// time since its pass began, then each pass's whole time: once past 600 s on GitHub's macOS (13 Nov
// 2026), nothing said where the time went.
const started = new Map<string, number>();
const seconds = (pass: string) => `${((Date.now() - started.get(pass)!) / 1000).toFixed(0)} s`;
const said = (pass: string) => (run: PackageRun) => console.log(`LMS matrix, ${pass}: ${run.profile}/${run.launch}/${run.browser} ${run.ok ? 'ok' : 'failed'}${run.retried ? ' (run again alone)' : ''} at ${seconds(pass)}`);
async function timed<T>(pass: string, run: () => Promise<T>): Promise<T> {
  started.set(pass, Date.now());
  try { return await run(); } finally { console.log(`LMS matrix, ${pass}: ${seconds(pass)} in all`); }
}

test('the example passes the LMS emulator: SuccessFactors popup chain, Docebo nested iframe, Chrome with unload deprecated and allowed', { timeout: 600000 }, async () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const b = await build(dir, { profiles: ['moodle', 'successfactors', 'docebo'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')) });
  assert.ok(b.ok && b.dirPath);
  const moodle = await timed('moodle', () => testPackage({ dir: b.dirPath!, profiles: ['moodle'], onRun: said('moodle') }));
  const others = await timed('successfactors, docebo', () => testPackage({ dir: b.dirPath!, profiles: ['successfactors', 'docebo'], unloadVariants: false, onRun: said('successfactors, docebo') }));
  const runs = [...moodle.runs, ...others.runs];
  const failed = runs.filter((x) => !x.ok).map((x) => `${x.profile}/${x.launch}/${x.browser}: ${x.failures.map((f) => f.code).join(',')}`);
  assert.deepEqual(failed, []);
  assert.deepEqual(new Set(moodle.runs.map((x) => x.browser.replace(/^[^(]+/, ''))), new Set(['(unload deprecated)', '(unload allowed)']));
  assert.ok(moodle.runs.every(x => /^(chromium|electron)\(/.test(x.browser)));
  assert.ok(runs.some((x) => x.launch === 'popup-chain'));
  assert.ok(runs.some((x) => x.launch === 'nested-iframe'));
});

// SCORM 2004 where its topologies are unusual: the SuccessFactors popup chain (API_1484_11 at
// top.opener.opener, 4,000 characters of suspend data) and Docebo's nested iframe (3rd edition).
test('a SCORM 2004 package passes the emulator: SuccessFactors popup chain, Docebo nested iframe in the 3rd edition', { timeout: 300000 }, async () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-'));
  const sf = await build(dir, { profiles: ['successfactors'], emit: 'dir', out, writeLock: false });
  const docebo = await build(dir, { profiles: ['docebo'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')), writeLock: false });
  assert.ok(sf.ok && sf.dirPath && docebo.ok && docebo.dirPath);
  assert.deepEqual([sf.report.delivery?.format, sf.report.delivery?.edition, docebo.report.delivery?.edition], ['scorm2004', '4th', '3rd']);
  const runs = [
    ...(await testPackage({ dir: sf.dirPath, profiles: ['successfactors'], unloadVariants: false })).runs,
    ...(await testPackage({ dir: docebo.dirPath, profiles: ['docebo'], unloadVariants: false })).runs
  ];
  assert.deepEqual(runs.filter((x) => !x.ok).map((x) => `${x.profile}/${x.launch}/${x.browser}: ${x.failures.map((f) => f.code).join(',')}`), []);
  assert.ok(runs.some((x) => x.launch === 'popup-chain'));
  assert.ok(runs.some((x) => x.launch === 'nested-iframe'));
});
