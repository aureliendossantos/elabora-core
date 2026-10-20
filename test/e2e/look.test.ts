import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Browser, Page, Route } from 'playwright-core';
import { startLooker, findLookServer, lookFolder, lookServerFile } from '@elabora/node/look';
import { codeVersion } from '@elabora/node/code-version';
import { preview } from '@elabora/node/preview';
import { startServer } from '@elabora/node/emulator/server';
import { build } from '@elabora/node/build';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';

// Looking while designing (docs/architecture/rendering.md, Looking while designing): a warm look after an
// edit takes well under 2 s and keeps the free objects the edit did not touch; free objects show in
// browser panes that refuse frames of an opaque origin.

const OBJECT_SCREEN = 'simulation';
const OBJECT_BLOCK = 'simulation-scene';

test('look: an edit shows in well under 2 s, the free object keeps running; its code edited, it starts again', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const looker = await startLooker(dir);
  try {
    const first = await looker.look({ screen: OBJECT_SCREEN });
    assert.ok(first.ok, JSON.stringify(first));
    assert.deepEqual(first.objects, [{ block: OBJECT_BLOCK, ready: true, failed: false }]);
    assert.equal(first.started, 1);
    assert.equal(first.type, 'jpeg');
    assert.deepEqual([...first.image.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.deepEqual(first.consoleErrors.filter((error) => !/GL Driver|WebGL|PCFSoftShadowMap/.test(error)), []);
    // The player's header and footer are there, as in a package.
    assert.ok(first.blocks.some((block) => block.id === OBJECT_BLOCK));

    // A block added next to the object: shown at once, the object untouched. No screen given: the
    // screen of the last look.
    const screen = readJSON(dir, `screens/${OBJECT_SCREEN}.json`);
    screen.blocks.splice(1, 0, { id: 'look-added', type: 'text', props: { markdown: 'Added while looking.' } });
    writeJSON(dir, `screens/${OBJECT_SCREEN}.json`, screen);
    const edited = await looker.look();
    assert.ok(edited.ok, JSON.stringify(edited));
    assert.equal(edited.screen, OBJECT_SCREEN);
    assert.ok(edited.blocks.some((block) => block.id === 'look-added'), JSON.stringify(edited.blocks.map((block) => block.id)));
    assert.equal(edited.started, 0);
    assert.deepEqual(edited.objects, [{ block: OBJECT_BLOCK, ready: true, failed: false }]);
    assert.ok(edited.ms < 2000, `${edited.ms} ms`);

    // Its code edited: the object starts again with the new code.
    const code = path.join(dir, 'objects/diagnostic-reseau/object.js');
    fs.appendFileSync(code, '\n// edited while looking\n');
    const restarted = await looker.look({ full: false, type: 'png' });
    assert.ok(restarted.ok, JSON.stringify(restarted));
    assert.equal(restarted.started, 1);
    assert.equal(restarted.type, 'png');
    assert.deepEqual([...restarted.image.subarray(1, 4)], [0x50, 0x4e, 0x47]);

    // Another size, the answered state, mistakes.
    const narrow = await looker.look({ screen: 'accueil', width: 375, height: 812, state: 'answered' });
    assert.ok(narrow.ok && narrow.width === 375 && narrow.state === 'answered', JSON.stringify(narrow));
    const unknown = await looker.look({ screen: 'nowhere' });
    assert.ok(!unknown.ok && /Unknown screen "nowhere"\. Screens: accueil, /.test(unknown.error), JSON.stringify(unknown));
    const layer = await looker.look({ screen: 'accueil', layer: 'nowhere' });
    assert.ok(!layer.ok && /No layer "nowhere" on screen "accueil"/.test(layer.error), JSON.stringify(layer));
    // A screen file caught mid-write.
    fs.writeFileSync(path.join(dir, 'screens/bilan.json'), '{ "id": "bilan", ');
    const broken = await looker.look({ screen: 'bilan' });
    assert.ok(!broken.ok && /^screens\/bilan\.json: .*\(E_JSON_PARSE\)$/.test(broken.error), JSON.stringify(broken));
  } finally {
    await looker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Run { status: number | null; stdout: string; stderr: string }
function elabora(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('elabora look: the first look starts a look server, the next ones use it; --url, --stop', { timeout: 180000 }, async (t) => {
  const dir = copyExample();
  t.after(async () => { await elabora(['look', dir, '--stop']); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = await elabora(['look', dir, '--screen', OBJECT_SCREEN, '--json']);
  assert.equal(first.status, 0, first.stderr);
  const [shot] = JSON.parse(first.stdout);
  assert.equal(shot.file, path.join(lookFolder(dir), `${OBJECT_SCREEN}-1600x900.jpg`));
  assert.ok(fs.statSync(shot.file).size > 20000);
  assert.deepEqual(shot.objects, [{ block: OBJECT_BLOCK, ready: true, failed: false }]);
  const server = await findLookServer(dir);
  assert.ok(server, 'the look server answers');

  const again = await elabora(['look', dir, '--screen', OBJECT_SCREEN, '--size', '1280x720,375x812', '--out-dir', path.join(dir, 'shots')]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`✔ .*${OBJECT_SCREEN}-1280x720\\.jpg  \\d+\\.\\d\\d s — `));
  assert.ok(fs.existsSync(path.join(dir, 'shots', `${OBJECT_SCREEN}-375x812.jpg`)));
  assert.equal((await findLookServer(dir))?.pid, server.pid, 'the same server');
  assert.equal(server.version, codeVersion(), 'the server says the code it runs');

  // A server started by older code (the version in server.json is what the next command compares to
  // its own: the core's version is the same for weeks, its code is not) is stopped and replaced.
  fs.writeFileSync(lookServerFile(dir), `${JSON.stringify({ ...server, version: '0.1.0+older-code' }, null, 2)}\n`);
  const replaced = await elabora(['look', dir, '--screen', OBJECT_SCREEN]);
  assert.equal(replaced.status, 0, replaced.stderr);
  const renewed = await findLookServer(dir);
  assert.ok(renewed && renewed.pid !== server.pid, 'another server answers');
  assert.equal(renewed.version, codeVersion());
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const begin = Date.now(); Date.now() - begin < 10_000 && alive(server.pid); ) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!alive(server.pid), 'the old server is gone');

  const url = await elabora(['look', dir, '--url']);
  assert.equal(url.stdout.trim(), (await findLookServer(dir))!.url);
  assert.match(url.stdout.trim(), /\/canvas\/index\.html\?token=[0-9a-f]+&chrome=player&frames=\d+$/);

  const wrong = await elabora(['look', dir, '--screen', 'nowhere']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /✘ nowhere 1600×900: Unknown screen "nowhere"/);

  assert.deepEqual(await elabora(['look', dir, '--stop']), { status: 0, stdout: '✔ Look server stopped.\n', stderr: '' });
  assert.equal(await findLookServer(dir), null);
  assert.ok(!fs.existsSync(path.join(lookFolder(dir), 'server.json')));
  assert.deepEqual(await elabora(['look', dir, '--stop']), { status: 0, stdout: 'No look server runs for this course.\n', stderr: '' });
});

// The policy of the in-app browsers of agent apps (Claude's browser pane): a frame sandboxed without
// allow-same-origin (an opaque origin) is refused, ERR_BLOCKED_BY_CLIENT, and so is what such a frame
// asks for.
async function refuseOpaqueFrames(page: Page): Promise<string[]> {
  const refused: string[] = [];
  await page.route('**/*', async (route: Route) => {
    const frame = route.request().frame();
    const element = frame.parentFrame() ? await frame.frameElement().catch(() => null) : null;
    const sandbox = element ? await element.getAttribute('sandbox') : null;
    if (sandbox !== null && !sandbox.split(/\s+/).includes('allow-same-origin')) {
      refused.push(route.request().url());
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return refused;
}

// The screen shown, every screen open (as captures do: navigation may lock screens not visited).
async function showScreen(page: Page, screen: string): Promise<void> {
  await page.waitForFunction(() => window.__elabora);
  await page.evaluate((id) => {
    const elabora = window.__elabora;
    for (const each of elabora.engine.screens) { elabora.engine.st.visited.add(each.key); elabora.engine.st.completed.add(each.key); }
    elabora.go(id);
  }, screen);
}

test('elabora preview: free objects show in a browser pane that refuses opaque frames; pages reload after a rebuild', { timeout: 240000 }, async (t) => {
  const dir = copyExample();
  // Build the control before watching: generators may write assets and reload the preview.
  const built = await build(dir, { emit: 'dir', out: path.join(dir, '.elabora', 'plain'), writeLock: false, media: 'link' });
  assert.ok(built.ok && built.dirPath);
  let rebuilt: () => void = () => {};
  const session = await preview(dir, { port: 0, onRebuild: () => rebuilt() });
  const browser: Browser = await launchBrowser('chromium', { rendering: 'gpu' });
  // A package served as it is (not a preview): the same policy refuses its object, as the pane did.
  const plain = await startServer();
  t.after(async () => { await browser.close(); await session.close(); await plain.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  plain.addPackage('plain', built.dirPath, built.media);
  const control = await browser.newPage();
  const blocked = await refuseOpaqueFrames(control);
  await control.goto(`${plain.base}/pkg/plain/index.html`);
  await showScreen(control, OBJECT_SCREEN);
  for (const begin = Date.now(); !blocked.length && Date.now() - begin < 10000;) await control.waitForTimeout(100);
  assert.ok(blocked.some((url) => url.endsWith('/objects/diagnostic-reseau/frame.html')), JSON.stringify(blocked));
  await control.close();

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const refused = await refuseOpaqueFrames(page);
  await page.goto(session.urls.standalone);
  await showScreen(page, OBJECT_SCREEN);
  const ready = await page.evaluate(() => window.__elabora.ready());
  assert.deepEqual(ready.objects, [{ block: OBJECT_BLOCK, ready: true, failed: false }]);
  assert.deepEqual(refused, []);
  const frame = await page.evaluate(() => { const iframe = document.querySelector('.t-object-frame iframe'); return { src: iframe?.getAttribute('src'), sandbox: iframe?.getAttribute('sandbox') }; });
  assert.match(frame.src ?? '', /^http:\/\/127\.0\.0\.1:\d+\/pkg\/preview\/objects\/diagnostic-reseau\/frame\.html$/);
  assert.notEqual(new URL(frame.src ?? '').port, new URL(session.urls.standalone).port);
  assert.equal(frame.sandbox, 'allow-scripts allow-same-origin');

  // An edit: the preview rebuilds, the page reloads by itself, on the same screen.
  const reloaded = page.waitForEvent('load', { timeout: 60000 });
  const done = new Promise<void>((resolve) => { rebuilt = resolve; });
  const screen = readJSON(dir, `screens/${OBJECT_SCREEN}.json`);
  screen.title = 'Simulation (rebuilt)';
  writeJSON(dir, `screens/${OBJECT_SCREEN}.json`, screen);
  await done;
  await reloaded;
  await page.waitForFunction(() => window.__elabora);
  assert.equal(await page.evaluate(() => window.__elabora.screen), OBJECT_SCREEN);
  assert.equal(await page.evaluate(() => document.querySelector('#t-main h1')?.textContent), 'Simulation (rebuilt)');
});
