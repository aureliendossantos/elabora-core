import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZip } from '@elabora/node/zip';
import { copyExample } from '../helpers.ts';
import { build } from '@elabora/node/build';
import { testPackage } from '@elabora/node/emulator/run';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { rename } from '@elabora/node/edit';
import type { Browser } from 'playwright-core';
import type { PlayerWindow } from '../helpers.ts';

test('the example passes the LMS emulator in Moodle (iframe and popup), with axe-core', { timeout: 300000 }, async () => {
  const dir = copyExample();
  const b = await build(dir, { profiles: ['moodle'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')) });
  assert.ok(b.ok && b.dirPath);
  const r = await testPackage({ dir: b.dirPath, profiles: ['moodle'], accessibility: true, unloadVariants: false });
  assert.deepEqual(r.runs.filter((x) => !x.ok).map((x) => `${x.profile}/${x.launch}/${x.browser}: ${x.failures.map((f) => `${f.code} ${f.message}`).join(',')}`), []);
  assert.deepEqual(r.runs.map((x) => x.launch), ['iframe', 'popup']);
  assert.ok(r.accessibility);
  assert.equal(r.accessibility.violations, 0, JSON.stringify(r.accessibility.details));
});

// A deliberately bad SCORM 1.2 package: it only saves in unload, like many legacy wrappers.
function badPackage() {
  const manifest = `<?xml version="1.0"?><manifest identifier="bad" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata><organizations default="o"><organization identifier="o"><title>Bad</title><item identifier="i" identifierref="r"><title>Bad</title></item></organization></organizations><resources><resource identifier="r" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources></manifest>`;
  const html = `<!doctype html><html lang="en"><head><title>Bad</title></head><body><p>Legacy content</p><script>
    var api = window.parent.API; api.LMSInitialize('');
    api.LMSSetValue('cmi.core.lesson_location', 'page-2');
    window.addEventListener('unload', function () { api.LMSSetValue('cmi.core.lesson_status', 'completed'); api.LMSCommit(''); api.LMSFinish(''); });
  </script></body></html>`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-bad-')), 'bad.zip');
  fs.writeFileSync(file, createZip(new Map([['imsmanifest.xml', Buffer.from(manifest)], ['index.html', Buffer.from(html)]])).zip);
  return file;
}

// A package whose page stops answering (a script stuck in a loop): the run fails, the test ends.
test('a run that stops making progress fails with the step it stopped at, instead of hanging', { timeout: 120000 }, async () => {
  const manifest = `<?xml version="1.0"?><manifest identifier="stuck" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><organizations default="o"><organization identifier="o"><title>Stuck</title><item identifier="i" identifierref="r"><title>Stuck</title></item></organization></organizations><resources><resource identifier="r" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources></manifest>`;
  const html = '<!doctype html><html lang="en"><head><title>Stuck</title></head><body><script>window.parent.API.LMSInitialize(""); setTimeout(function () { for (;;) {} }, 1500);</script></body></html>';
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-stuck-')), 'stuck.zip');
  fs.writeFileSync(file, createZip(new Map([['imsmanifest.xml', Buffer.from(manifest)], ['index.html', Buffer.from(html)]])).zip);
  const started = Date.now();
  const r = await testPackage({ zip: file, profiles: ['moodle'], modes: ['iframe'], unloadVariants: false, stallMs: 8000 });
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.code === 'E_LMS_SCENARIO' && /no progress for 8 s at step "launch"/.test(d.message)), JSON.stringify(r.diagnostics));
  assert.ok(Date.now() - started < 60000);
});

test('the emulator flags a legacy package that relies on unload and commits nothing before close', { timeout: 120000 }, async () => {
  const r = await testPackage({ zip: badPackage(), profiles: ['moodle'], modes: ['iframe'], unloadVariants: false });
  const codes = r.diagnostics.map((d) => d.code);
  assert.ok(codes.includes('E_LMS_UNLOAD_LISTENER'));
  assert.ok(codes.includes('E_LMS_DATA_LOST_ON_CLOSE'));
});

// lesson_location holds the screen's permanent key, so a learner who left on a screen that was
// renamed since resumes on it in the new version; a location saved as an id (packages built
// before 2026-10-07) still resumes.
test('a learner who left on a screen resumes there after the screen is renamed', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const first = await build(dir, { emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')), writeLock: false });
  assert.ok(first.ok && first.dirPath);
  const server = await startServer();
  server.addPackage('v1', first.dirPath);
  const browser: Browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage();
    await page.goto(`${server.base}/pkg/v1/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    const left = await page.evaluate(() => {
      const t = (window as PlayerWindow).__elabora;
      const screen = t.engine.screens[1];
      t.go(screen.id);
      return { id: screen.id, key: screen.key, storage: `elabora:${t.course.id}` };
    });
    await page.waitForFunction(({ storage, key }) => JSON.parse(sessionStorage.getItem(storage) || '{}')['cmi.core.lesson_location'] === key, left);

    const renamed = rename(dir, { from: left.id, to: `${left.id}-renamed` });
    assert.ok(renamed.ok, JSON.stringify(renamed));
    const second = await build(dir, { emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')), writeLock: false });
    assert.ok(second.ok && second.dirPath, JSON.stringify(second.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
    server.addPackage('v2', second.dirPath);
    await page.goto(`${server.base}/pkg/v2/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    assert.equal(await page.evaluate(() => (window as PlayerWindow).__elabora.screen), `${left.id}-renamed`);

    // A location saved by an older package: the screen id.
    await page.evaluate(({ storage, id }) => {
      const data = JSON.parse(sessionStorage.getItem(storage) || '{}');
      sessionStorage.setItem(storage, JSON.stringify({ ...data, 'cmi.core.lesson_location': id }));
    }, { storage: left.storage, id: `${left.id}-renamed` });
    await page.reload();
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    assert.equal(await page.evaluate(() => (window as PlayerWindow).__elabora.screen), `${left.id}-renamed`);
  } finally {
    await browser.close();
    await server.close();
  }
});
