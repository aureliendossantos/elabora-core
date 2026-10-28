import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Browser, Page, Route } from 'playwright-core';
import { startLooker, findLookServer, lookFolder, lookServerFile, controlsText } from '@elabora/node/look';
import { codeVersion } from '@elabora/node/code-version';
import { preview } from '@elabora/node/preview';
import { startServer } from '@elabora/node/emulator/server';
import { build } from '@elabora/node/build';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { ROOT, copyExample, readJSON, writeFixture, writeJSON } from '../helpers.ts';
import { dialogueCourse } from '../dialogue-fixture.ts';

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

// Inspecting (elabora look --scroll, --block, --act): a long page "chemin" with a figure that stays in
// the window (sticky), an entrance driven by the scroll that finishes, and one that cannot (the last
// block, whose view() range ends once it has left the window: the page ends first); a free object of
// the DOM only on "accueil", a button that switches it on.
const INSPECT = { page: 'chemin', sticky: 'chemin-schema', done: 'chemin-regle', stuck: 'chemin-last', object: 'accueil-switch' };
function addInspectionProbes(dir: string): void {
  writeFixture(dir, 'theme/theme.css', [
    `.t-block[data-block="${INSPECT.sticky}"] { position: sticky; top: 4rem; z-index: 5; background: #fff; }`,
    '@keyframes probe-in { from { opacity: 0; rotate: -8deg; } to { opacity: 1; rotate: 0deg; } }',
    `.t-block[data-block="${INSPECT.done}"] { animation: probe-in linear both; animation-timeline: view(); animation-range: entry 0% cover 30%; }`,
    `.t-block[data-block="${INSPECT.stuck}"] { animation: probe-in linear both; animation-timeline: view(); animation-range: cover 0% cover 100%; }`,
    ''
  ].join('\n'));
  const course = readJSON(dir, 'course.json');
  course.theme.stylesheet = 'theme/theme.css';
  writeJSON(dir, 'course.json', course);
  const page = readJSON(dir, `screens/${INSPECT.page}.json`);
  for (let n = 1; n <= 8; n++) page.blocks.push({ id: `chemin-filler-${n}`, type: 'text', props: { markdown: 'Le paquet traverse le réseau. '.repeat(16) } });
  page.blocks.push({ id: INSPECT.stuck, type: 'callout', props: { variant: 'info', markdown: 'La dernière étape.' } });
  writeJSON(dir, `screens/${INSPECT.page}.json`, page);

  writeFixture(dir, 'objects/switch-probe/object.manifest.json', {
    manifestVersion: '0.1', id: 'switch-probe', version: '1.0.0', title: 'Interrupteur',
    planRefs: { objectives: ['OBJ-1'], items: ['ITEM-2'] }, pedagogicalRole: 'visualisation',
    props: { type: 'object', properties: {} },
    language: 'fr', strings: { on: { text: 'Allumer', description: 'Bouton' } },
    state: { type: 'object', properties: { on: { type: 'boolean' } } },
    events: [{ name: 'switched', description: 'Allumé.', payload: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } }], budgets: {},
    a11y: { description: 'Un interrupteur.', keyboard: 'Tab atteint son bouton.', motion: { pausable: true, respectsReducedMotion: true } },
    sandbox: { network: 'none' }
  });
  writeFixture(dir, 'objects/switch-probe/object.js', [
    'export function mount(container, ctx) {',
    '  let on = false;',
    "  const button = document.createElement('button');",
    "  button.type = 'button';",
    "  button.textContent = ctx.t('on');",
    "  button.addEventListener('click', () => { on = true; button.style.background = '#0a0'; ctx.host.emit('switched', { on }); });",
    '  container.appendChild(button);',
    '  return { getState: () => ({ on }), setState() {}, dispose() {} };',
    '}',
    ''
  ].join('\n'));
  writeFixture(dir, 'objects/switch-probe/object.notes.md', 'Sonde des tests : un bouton qui allume.\n');
  const home = readJSON(dir, 'screens/accueil.json');
  home.blocks.push({ id: INSPECT.object, type: 'free-object', props: { object: 'switch-probe', title: 'Interrupteur', aspectRatio: '16:9', textAlternative: 'Un bouton qui allume.' } });
  writeJSON(dir, 'screens/accueil.json', home);
}

const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

test('look: a block at a scroll position, a page down its length, a close-up, what moves and what cannot finish', { timeout: 180000 }, async (t) => {
  const dir = copyExample();
  addInspectionProbes(dir);
  const looker = await startLooker(dir, { live: false });
  t.after(async () => { await looker.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // The end of the page: the last entrance cannot finish, it says how it stays.
  const end = await looker.look({ screen: INSPECT.page, scroll: ['100%'] });
  assert.ok(end.ok, JSON.stringify(end));
  assert.equal(end.type, 'jpeg');
  assert.ok(end.motion && end.motion.motion, 'animations on');
  assert.equal(end.motion.scroll.top, end.motion.scroll.max);
  assert.ok(end.scrolled && end.scrolled[0].top === end.motion.scroll.max && end.scrolled[0].top > 1000, JSON.stringify(end.scrolled));
  const stuck = end.motion.blocks.find((block) => block.id === INSPECT.stuck);
  assert.ok(stuck && stuck.visibility === 'visible', JSON.stringify(end.motion.blocks));
  const [entrance] = stuck.animations;
  assert.equal(entrance.name, 'probe-in');
  assert.equal(entrance.timeline, 'view');
  assert.ok(entrance.cannotFinish && entrance.atEnd !== undefined && entrance.atEnd !== null && entrance.atEnd < 0.9, JSON.stringify(entrance));
  const opacity = entrance.stuck?.find((property) => property.property === 'opacity');
  assert.ok(opacity && Number(opacity.value) < 1 && opacity.to === '1', JSON.stringify(entrance.stuck));
  assert.deepEqual(end.motion.unfinished.map((entry) => entry.block), [INSPECT.stuck]);
  // The entrance higher up finishes.
  const done = await looker.look({ screen: INSPECT.page, scroll: [INSPECT.done] });
  assert.ok(done.ok && done.motion, JSON.stringify(done));
  const finishing = done.motion.blocks.find((block) => block.id === INSPECT.done)?.animations[0];
  assert.ok(finishing && finishing.timeline === 'view' && finishing.atEnd === 1 && !finishing.cannotFinish, JSON.stringify(finishing));
  // Blocks stay in px of the page, wherever the window is.
  assert.deepEqual(done.blocks.find((block) => block.id === INSPECT.stuck)?.rect, end.blocks.find((block) => block.id === INSPECT.stuck)?.rect);

  // The sticky figure is in the window down the whole page.
  for (const position of ['0', '50%', '100%']) {
    const shot = await looker.look({ screen: INSPECT.page, scroll: [position] });
    assert.ok(shot.ok && shot.motion, JSON.stringify(shot));
    assert.equal(shot.motion.blocks.find((block) => block.id === INSPECT.sticky)?.visibility, 'visible', `${position}: ${JSON.stringify(shot.motion.blocks.map((block) => [block.id, block.visibility]))}`);
  }

  // Down the page: one sheet, five stops by default.
  const sheet = await looker.look({ screen: INSPECT.page, sheet: true });
  assert.ok(sheet.ok, JSON.stringify(sheet));
  assert.equal(sheet.type, 'png');
  assert.deepEqual(sheet.scrolled?.map((stop) => stop.label.replace(/^\d+ px /, '')), ['(0 %)', '(25 %)', '(50 %)', '(75 %)', '(100 %)']);
  assert.deepEqual(sheet.motion?.unfinished.map((entry) => entry.block), [INSPECT.stuck]);
  // Of one block: its close-up where the window shows it, the window elsewhere.
  const blockSheet = await looker.look({ screen: INSPECT.page, sheet: true, block: INSPECT.done });
  assert.ok(blockSheet.ok && blockSheet.scrolled?.length === 5 && blockSheet.motion?.blocks.length === 1, JSON.stringify(blockSheet));

  // A close-up at twice its size, scrolled into view: its image is twice the part of the page.
  const close = await looker.look({ screen: INSPECT.page, block: INSPECT.done, scale: 2 });
  assert.ok(close.ok && close.clip, JSON.stringify(close));
  assert.equal(close.type, 'png');
  const block = close.blocks.find((each) => each.id === INSPECT.done)!.rect;
  assert.ok(close.clip.width >= block.width && close.clip.width <= block.width + 34, JSON.stringify({ clip: close.clip, block }));
  assert.deepEqual(pngSize(close.image), { width: close.clip.width * 2, height: close.clip.height * 2 });
  assert.equal(close.motion?.blocks.length, 1);
  const unknown = await looker.look({ screen: INSPECT.page, block: 'nowhere' });
  assert.ok(!unknown.ok && /No block "nowhere" on screen "chemin"\. Blocks: chemin-intro, /.test(unknown.error), JSON.stringify(unknown));
});

test('look --act: a click by text inside a free object changes its state; a missing target names what the frame offers', { timeout: 180000 }, async (t) => {
  const dir = copyExample();
  addInspectionProbes(dir);
  const looker = await startLooker(dir, { live: false });
  t.after(async () => { await looker.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const missing = await looker.look({ screen: 'accueil', block: INSPECT.object, act: ['click:Éteindre'] });
  assert.ok(!missing.ok && /^click:Éteindre: nothing in the frame matches\. The frame offers buttons: "Allumer"\.$/.test(missing.error), JSON.stringify(missing));
  const clicked = await looker.look({ screen: 'accueil', block: INSPECT.object, act: ['click:Allumer'] });
  assert.ok(clicked.ok && clicked.act, JSON.stringify(clicked));
  assert.deepEqual(clicked.act, { actions: ['click:Allumer'], state: { on: true }, events: [{ name: 'switched', payload: { on: true } }] });
  const bad = await looker.look({ screen: 'accueil', block: 'accueil-situation', act: ['key:Enter'] });
  assert.ok(!bad.ok && /is not a free object/.test(bad.error), JSON.stringify(bad));
  const alone = await looker.look({ screen: 'accueil', act: ['key:Enter'] });
  assert.ok(!alone.ok && /give block too/.test(alone.error), JSON.stringify(alone));
});

test('look --act choose: a dialogue block at rest after its choices, the end of its thread in the window; a choice not offered says which were', { timeout: 180000 }, async (t) => {
  const dir = dialogueCourse({ presentation: 'scroll' });
  const looker = await startLooker(dir, { live: false });
  t.after(async () => { await looker.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // c is retried (its first choice is the one scored), then b opens a short branch that comes back: the dialogue waits at « ticket ».
  const path = await looker.look({ screen: 'appel', block: 'appel-marc', act: ['choose:c', 'choose:b'] });
  assert.ok(path.ok && path.act, JSON.stringify(path));
  assert.deepEqual(path.act, { actions: ['choose:c', 'choose:b'], state: { waiting: 'ticket', offered: ['a', 'b', 'c'], ended: false, ending: null, score: 0 }, events: [] });
  assert.equal(path.type, 'png');
  // The thread is long: the window shows its end (the options of « ticket »), not its top.
  assert.ok(path.scrolled && path.scrolled[0].top > 0, JSON.stringify(path.scrolled));
  const ended = await looker.look({ screen: 'appel', block: 'appel-marc', act: ['choose:a', 'choose:a', 'choose:a'] });
  assert.ok(ended.ok && ended.act, JSON.stringify(ended));
  assert.deepEqual(ended.act.state, { waiting: null, offered: [], ended: true, ending: 'maitrise', score: 100 });

  const refused = await looker.look({ screen: 'appel', block: 'appel-marc', act: ['choose:d'] });
  assert.ok(!refused.ok && /« d » is not offered at premiere-question.*\(offered: a, b, c\)$/.test(refused.error), JSON.stringify(refused));
  const mixed = await looker.look({ screen: 'appel', block: 'appel-marc', act: ['choose:a', 'key:Enter'] });
  assert.ok(!mixed.ok && /^key:Enter: a dialogue block takes choose:<option>/.test(mixed.error), JSON.stringify(mixed));
  const elsewhere = await looker.look({ screen: 'appel', block: 'plan-etage', act: ['choose:a'] });
  assert.ok(!elsewhere.ok && /choose: is for a dialogue block/.test(elsewhere.error), JSON.stringify(elsewhere));
});

test('look: the controls of a free object, where they are, and what the page puts over them', { timeout: 180000 }, async (t) => {
  const dir = copyExample();
  addInspectionProbes(dir);
  const looker = await startLooker(dir, { live: false });
  t.after(async () => { await looker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const clear = await looker.look({ screen: 'accueil', width: 1280, height: 1400, full: false });
  assert.ok(clear.ok, JSON.stringify(clear));
  const button = clear.controls?.find((control) => control.name === 'Allumer');
  assert.ok(button && button.block === INSPECT.object && button.role === 'button' && button.coveredBy === null && button.box.width > 0, JSON.stringify(clear.controls));
  // In a shorter window, the player's bottom bar lies over it.
  const short = await looker.look({ screen: 'accueil', width: 1280, height: 720, full: false });
  assert.ok(short.ok, JSON.stringify(short));
  assert.match(short.controls?.find((control) => control.name === 'Allumer')?.coveredBy ?? '', /t-bar/, JSON.stringify(short.controls));
  // The theme lays a pane over the object: its button no longer gets the clicks, and the look says so.
  fs.appendFileSync(path.join(dir, 'theme/theme.css'), `[data-block="${INSPECT.object}"] { position: relative; } [data-block="${INSPECT.object}"]::after { content: ""; position: absolute; inset: 0; z-index: 9; pointer-events: auto; }\n`);
  const course = readJSON(dir, 'course.json');
  course.theme.stylesheet = 'theme/theme.css';
  writeJSON(dir, 'course.json', course);
  const covered = await looker.look({ screen: 'accueil', width: 1280, height: 1400, full: false });
  assert.ok(covered.ok, JSON.stringify(covered));
  const hidden = covered.controls?.find((control) => control.name === 'Allumer');
  assert.ok(hidden?.coveredBy && new RegExp(`block ${INSPECT.object}`).test(hidden.coveredBy), JSON.stringify(covered.controls));
  assert.match(controlsText(covered.controls ?? []).join('\n'), /✘ « Allumer » \(button, .*\) is covered by/);
});
