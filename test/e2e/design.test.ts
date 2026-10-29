import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { copyExample, readJSON, writeJSON, addExplorer, addLayerProbe, addViewProbe, addListProbe, LAYER_PROBE, VIEW_PROBE, LIST_PROBE } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { startCanvasHost } from '@elabora/node/canvas/host';
import { renderScreen } from '@elabora/core/render/screen';
import { screenOrder } from '@elabora/core/project/load';
import type { CanvasApi } from '@elabora/player/canvas';
import { build } from '@elabora/node/build';
import { assetsSheet } from '@elabora/node/assets-sheet';
import { capture } from '@elabora/node/capture';
import { fitDiagnostics, measureFit } from '@elabora/node/fit';
import { testObject } from '@elabora/node/objects/test';
import { startLooker } from '@elabora/node/look';
import { createRequire } from 'node:module';
import { pageStyleConflicts } from '@elabora/node/style-cascade';
import * as edit from '@elabora/node/edit';
import { replayObject } from '@elabora/node/replay';

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi };

// The reference example as slides, with a stylesheet (for the contrast and backdrop cases).
function slidesCopy({ css = '' } = {}) {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.presentation = { mode: 'slides' };
  if (css) {
    fs.mkdirSync(path.join(dir, 'theme'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme/theme.css'), css);
    course.theme.stylesheet = 'theme/theme.css';
  }
  writeJSON(dir, 'course.json', course);
  return { dir, course };
}

async function openPlayer(dir: string, run: (page: Page, errors: string[]) => Promise<void>) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-e2e-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser: Browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${server.base}/pkg/p/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; for (const s of t.engine.screens) { t.engine.st.visited.add(s.key); t.engine.st.completed.add(s.key); } });
    await run(page, errors);
  } finally {
    await browser.close();
    await server.close();
  }
}

test('slides: answering moves nothing (reserved room, concealed blocks keep their place)', { timeout: 240000 }, async () => {
  const { dir } = slidesCopy();
  const fit = await measureFit(dir, { sizes: [{ role: 'reference', size: '1600x900' }] });
  assert.ok(fit.ok);
  const shifts = fit.sizes[0].screens.filter((s) => s.shift).map((s) => `${s.screen}: ${JSON.stringify(s.shift)}`);
  assert.deepEqual(shifts, []);
  assert.ok(!fitDiagnostics(fit).some((d) => d.code === 'W_SLIDE_SHIFT'));
  // The same activity without its reserve would move the slide: fit sees it.
  await openPlayer(dir, async (page) => {
    const r = await page.evaluate(async () => {
      const t = (window as PlayerWindow).__elabora;
      t.go('evaluation');
      const node = document.querySelector<HTMLElement>('.t-block[data-behavior="quiz"], .t-block[data-type="quiz"]')!;
      const reserved = parseFloat(node.style.minHeight);
      const rooms = t.rooms(node.dataset.block!)!;
      return { reserved, initial: rooms[0], tallest: Math.max(...rooms.slice(1)) };
    });
    assert.ok(r.tallest > r.initial, 'feedback makes the quiz taller');
    assert.ok(Math.abs(r.reserved - Math.ceil(r.tallest)) <= 1, `room reserved for the tallest outcome (${JSON.stringify(r)})`);
    // Measuring again (the window changes) keeps the learner's choice.
    await page.click('.t-block[data-type="quiz"] .t-option >> nth=1');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    const kept = await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('.t-block[data-type="quiz"] .t-option input')].map((i) => i.checked));
    assert.deepEqual(kept.slice(0, 2), [false, true], 'the selected option stays selected');
  });
});

test('compact feedback: the chosen option\'s feedback without its text, which screen readers still hear; the room it saves measured', { timeout: 240000 }, async () => {
  const { dir } = slidesCopy();
  const screen = readJSON(dir, 'screens/evaluation.json');
  screen.blocks.find((block: { id: string }) => block.id === 'evaluation-q1').props.feedbackStyle = 'compact';
  writeJSON(dir, 'screens/evaluation.json', screen);
  await openPlayer(dir, async (page) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('evaluation'));
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    // Only quizzes with full feedback are measured; compact saves room on them.
    const rooms = await page.evaluate(() => (window as PlayerWindow).__elabora.feedbackRooms());
    assert.deepEqual(rooms.map((room) => room.block), ['evaluation-q2']);
    assert.ok(rooms[0].compact < rooms[0].full, JSON.stringify(rooms));
    for (const id of ['evaluation-q1', 'evaluation-q2']) {
      await page.click(`[data-block="${id}"] .t-option >> nth=1`);
      await page.click(`[data-block="${id}"] .t-quiz-submit`);
    }
    const shown = await page.evaluate(() => ['evaluation-q1', 'evaluation-q2'].map((id) => {
      const feedback = document.querySelector<HTMLElement>(`[data-block="${id}"] .t-feedback`)!;
      const option = feedback.querySelector<HTMLElement>('.t-feedback-option')!;
      const text = document.querySelectorAll<HTMLElement>(`[data-block="${id}"] .t-option-text`)[1].textContent!;
      return { live: feedback.getAttribute('aria-live'), hidden: option.classList.contains('t-sr-only'), width: Math.round(option.getBoundingClientRect().width), said: feedback.textContent!.includes(text), head: getComputedStyle(feedback.querySelector('.t-feedback-head')!).display };
    }));
    assert.deepEqual(shown.map(({ hidden, said, head }) => ({ hidden, said, head })), [{ hidden: true, said: true, head: 'inline' }, { hidden: false, said: true, head: 'block' }]);
    assert.ok(shown[0].width <= 1, 'not shown');
    assert.ok(shown[0].live, 'announced');
  });
});

test('fit measures the contrast of text against the pixels behind it', { timeout: 240000 }, async () => {
  const { dir } = slidesCopy({ css: '[data-screen="accueil"] { background: linear-gradient(#f4f6f8, #f4f6f8); } [data-screen="accueil"] .t-text { color: #e6e9ec; }' });
  const fit = await measureFit(dir, { sizes: [{ role: 'reference', size: '1600x900' }] });
  const d = fitDiagnostics(fit).filter((x) => x.code === 'W_TEXT_CONTRAST_MEASURED');
  assert.ok(d.some((x) => x.target === 'accueil'), JSON.stringify(d));
  assert.ok(!d.some((x) => x.target !== 'accueil'), JSON.stringify(d.filter((x) => x.target !== 'accueil')));
});

test('measured contrast: text a 1 px box clips away (a chart\'s table for screen readers) is not read over the pixels where it would be', { timeout: 120000 }, async () => {
  const { measureContrast } = await import('@elabora/node/contrast');
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // Dark ink on a white card, over a dark ground; the table's text would lie on the ground.
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#1d2b3a">
      <div data-block="figures" style="position:relative;margin:60px;padding:24px;background:#fff;color:#222">
        <p>72 % of the readers</p>
        <table style="position:absolute;top:300px;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap"><tr><td>72 % of the readers, as a table</td></tr></table>
      </div></body></html>`);
    assert.deepEqual(await measureContrast(page), []);
    // The same text shown over the ground is read, and reported.
    await page.evaluate(() => { document.querySelector<HTMLElement>('table')!.style.cssText = 'position:absolute;top:300px;left:0;color:#222'; });
    assert.deepEqual((await measureContrast(page)).map((found) => found.text), ['72 % of the readers, as a table']);
  } finally {
    await browser.close();
  }
});

test('fit on a phone: the contrast of text down the page and a bar of the player that goes onto two lines', { timeout: 240000 }, async () => {
  // Faint text and items too wide for one line, on a phone only.
  const { dir } = slidesCopy({ css: '@media (max-width: 600px) { [data-screen="accueil"] .t-text { color: #e6e9ec; } .t-bar--bottom > * { min-width: 9rem; } }' });
  const fit = await measureFit(dir, { screens: ['accueil'] });
  assert.ok(fit.ok, JSON.stringify(fit.diagnostics));
  assert.deepEqual(fit.sizes.map((size) => [size.role, size.size]), [['reference', '1600x900'], ['minimum', '1280x720'], ['phone', '375x812']]);
  const diagnostics = fitDiagnostics(fit);
  const faint = diagnostics.filter((d) => d.code === 'W_TEXT_CONTRAST_MEASURED');
  assert.ok(faint.length && faint.every((d) => /on a phone \(375×812\)/.test(d.message)), JSON.stringify(faint));
  assert.ok(diagnostics.some((d) => d.code === 'W_PLAYER_BAR_WRAPS' && /t-bar--bottom/.test(d.message)), JSON.stringify(diagnostics));
  assert.ok(!diagnostics.some((d) => /^(W|I)_SLIDE_OVERFLOW/.test(d.code) && /375/.test(d.message)), 'a phone has no fold');
  // Sizes given: no phone, unless asked.
  const sized = await measureFit(dir, { screens: ['accueil'], sizes: [{ role: 'reference', size: '1600x900' }] });
  assert.deepEqual(sized.ok && sized.sizes.map((size) => size.role), ['reference']);
});

test('scroll pages: fit gives their length and measures contrast down the whole page, never an overflow', { timeout: 240000 }, async () => {
  const dir = copyExample();
  addViewProbe(dir);
  // The last paragraph of the long page, far below the window, is too faint.
  const css = '[data-block="chemin-filler-6"] .t-text { color: #e6e9ec; }';
  fs.mkdirSync(path.join(dir, 'theme'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme/theme.css'), css);
  const course = readJSON(dir, 'course.json');
  course.theme.stylesheet = 'theme/theme.css';
  writeJSON(dir, 'course.json', course);
  const fit = await measureFit(dir);
  assert.ok(fit.ok, JSON.stringify(fit.diagnostics));
  assert.equal(fit.mode, 'scroll');
  assert.deepEqual(fit.sizes.map((size) => size.role), ['reference', 'phone'], 'scroll pages are measured at the reference size and on a phone');
  const page = fit.sizes[0].screens.find((screen) => screen.screen === 'chemin');
  assert.ok(page && page.windows > 1.5, JSON.stringify(page));
  const diagnostics = fitDiagnostics(fit);
  assert.ok(diagnostics.some((d) => d.code === 'W_TEXT_CONTRAST_MEASURED' && d.target === 'chemin' && /chemin-filler-6/.test(d.message)), JSON.stringify(diagnostics));
  assert.ok(!diagnostics.some((d) => /^(W|I)_SLIDE_/.test(d.code)), JSON.stringify(diagnostics));
});

test('fit keeps each screen\'s measure: unchanged screens are reused, an edited one is measured again, and fresh measures all', { timeout: 240000 }, async () => {
  const dir = copyExample();
  const first = await measureFit(dir);
  assert.ok(first.ok, JSON.stringify(first.diagnostics));
  const screens = first.sizes[0].screens;
  assert.ok(screens.length > 2 && screens.every((screen) => !screen.reused));
  const again = await measureFit(dir);
  assert.ok(again.ok);
  assert.ok(again.sizes[0].screens.every((screen) => screen.reused), 'nothing changed: every measure is reused');
  assert.deepEqual(again.sizes[0].screens.map(({ reused: _reused, ...fit }) => fit), screens, 'the measures kept are those made');
  // One screen edited: it alone is measured again.
  const accueil = readJSON(dir, 'screens/accueil.json');
  accueil.blocks.find((block: { type: string }) => block.type === 'callout').props.markdown += ' Encore une phrase.';
  writeJSON(dir, 'screens/accueil.json', accueil);
  const edited = await measureFit(dir);
  assert.ok(edited.ok);
  assert.deepEqual(edited.sizes[0].screens.filter((screen) => !screen.reused).map((screen) => screen.screen), ['accueil']);
  // Only the screens asked for; fresh measures them even unchanged.
  const one = await measureFit(dir, { screens: ['chemin'], fresh: true });
  assert.ok(one.ok);
  assert.deepEqual(one.sizes[0].screens.map((screen) => [screen.screen, !!screen.reused]), [['chemin', false]]);
  const unknown = await measureFit(dir, { screens: ['nowhere'] });
  assert.ok(!unknown.ok && /Unknown screen "nowhere"\. Screens: accueil, /.test(unknown.error ?? ''), JSON.stringify(unknown));
});

test('scroll pages: a free object hears where its frame is as the learner scrolls (host.onView)', { timeout: 180000 }, async () => {
  const dir = copyExample();
  addViewProbe(dir);
  await openPlayer(dir, async (page) => {
    await page.evaluate((screen) => { const t = (window as PlayerWindow).__elabora; t.go(screen); t.revealAll(); }, VIEW_PROBE.screen);
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    type View = { visible: boolean; entry: number; seen: number };
    const state = () => page.evaluate((block) => (window as PlayerWindow).__elabora.objectHost(block)?.getState(), VIEW_PROBE.block) as Promise<View>;
    // The object hears a scroll a frame later, by a message to its frame: the test asks it again
    // until it has. (page.waitForFunction cannot wait on getState: a promise counts as true for it.)
    const heard = async (expected: (view: View) => boolean, what: string) => {
      const until = Date.now() + 10000;
      for (let view = await state(); ; view = await state()) {
        if (expected(view)) return view;
        assert.ok(Date.now() < until, `${what}: ${JSON.stringify(view)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const below = await state();
    assert.equal(below.visible, false, JSON.stringify(below));
    assert.equal(below.entry, 0);
    await page.evaluate((block) => document.querySelector(`[data-block="${block}"] .t-object-frame`)?.scrollIntoView({ block: 'center' }), VIEW_PROBE.block);
    // Wholly in the window: visible, and entered (a frame gone past the top has entry 1 too).
    const inView = await heard((view) => view.visible && view.entry === 1, 'in the window');
    assert.ok(inView.seen > below.seen, JSON.stringify({ below, inView }));
    // Scrolled back to the top: out of view again.
    await page.evaluate(() => scrollTo(0, 0));
    const back = await heard((view) => !view.visible, 'scrolled back to the top');
    assert.equal(back.entry, 0, JSON.stringify(back));
  });
});

test('a free object takes a list prop from its block, then another from an event (set-object-props)', { timeout: 180000 }, async () => {
  const dir = copyExample();
  addListProbe(dir);
  const v = validateDir(dir);
  assert.equal(v.summary.errors, 0, JSON.stringify(v.diagnostics.filter((d) => d.severity === 'error')));
  await openPlayer(dir, async (page, errors) => {
    await page.evaluate((screen) => { const t = (window as PlayerWindow).__elabora; t.go(screen); t.revealAll(); }, LIST_PROBE.screen);
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    type Given = { devices: string; labels: string; tint: string };
    const state = () => page.evaluate((block) => (window as PlayerWindow).__elabora.objectHost(block)?.getState(), LIST_PROBE.block) as Promise<Given | undefined>;
    // Props reach the frame by a message: ask again until the object has them.
    const given = async (devices: string) => {
      const until = Date.now() + 10000;
      for (let seen = await state(); ; seen = await state()) {
        if (seen?.devices === devices) return seen;
        assert.ok(Date.now() < until, `${devices}: ${JSON.stringify(seen)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    assert.deepEqual(await given('parefeu,serveur'), { devices: 'parefeu,serveur', labels: 'Pare-feu,Serveur', tint: '#C79A45' });
    await page.click(`[data-block="${LIST_PROBE.button}"] button`);
    assert.deepEqual(await given('routeur'), { devices: 'routeur', labels: 'Routeur', tint: '#C79A45' });
    assert.deepEqual(errors, []);
  });
});

test('captures: a filmstrip down a scroll page, and objects below the window in a full page', { timeout: 240000 }, async () => {
  const dir = copyExample();
  addViewProbe(dir);
  const r = await capture(dir, [{ screen: 'chemin', width: 1280, height: 720, scroll: [0, '50%', '100%'] }, { screen: 'chemin', width: 1280, height: 720 }]);
  assert.ok(r.shots && r.ok, JSON.stringify(r.diagnostics ?? r.shots?.map((shot) => (shot.ok ? null : shot.error))));
  const [film, full] = r.shots;
  assert.ok(film.ok && full.ok);
  assert.equal(film.frames?.length, 3);
  assert.equal(film.scroll?.[0], 0);
  assert.ok((film.scroll?.[2] ?? 0) > (film.scroll?.[1] ?? 0), JSON.stringify(film.scroll));
  assert.ok(full.png.length > 20000);
});

test('captures: many shots in one run, the answered state and a filmstrip', { timeout: 240000 }, async () => {
  const dir = copyExample();
  const r = await capture(dir, [
    { screen: 'accueil', width: 1280, height: 720 },
    { screen: 'evaluation', width: 1280, height: 720, state: 'answered' },
    { screen: 'accueil', width: 375, height: 812 },
    { screen: 'accueil', width: 1280, height: 720, at: [0, 500, 1000], fullPage: false }
  ]);
  assert.ok(r.shots, JSON.stringify(r.diagnostics));
  assert.ok(r.ok, JSON.stringify(r.shots.map((shot) => (shot.ok ? null : shot.error))));
  const shots = r.shots.filter((shot) => shot.ok);
  assert.equal(shots.length, 4);
  assert.ok(shots.every((shot) => shot.png.length > 10000));
  assert.ok((shots[1].answered ?? []).length >= 1, 'activities answered');
  assert.deepEqual(shots[3].at, [0, 500, 1000]);
  assert.equal(shots[3].frames?.length, 3);
});

test('backdrop: layers and a decorative object follow the learner, hidden from assistive technology', { timeout: 300000 }, async () => {
  const { dir, course } = slidesCopy({ css: '.t-backdrop-layer[data-layer="sky"] { background: linear-gradient(#0b2440, #12355b); } .t-backdrop[data-section] .t-backdrop-layer { transition: opacity 1s; }' });
  const odir = path.join(dir, 'objects/glow');
  fs.mkdirSync(odir);
  writeJSON(dir, 'objects/glow/object.manifest.json', {
    manifestVersion: '0.1', id: 'glow', version: '1.0.0', title: 'Glow', pedagogicalRole: 'decoration',
    props: { type: 'object', properties: { tint: { type: 'string', format: 'color', default: '#334455', description: 'Tint', 'x-group': 'Style', 'x-control': 'color' } }, required: ['tint'] },
    state: { type: 'object', properties: { screen: { type: ['string', 'null'] } }, required: ['screen'] },
    events: [], budgets: {}, a11y: { motion: { pausable: true, respectsReducedMotion: true } }, sandbox: { network: 'none', permissions: [] }
  });
  fs.writeFileSync(path.join(odir, 'object.js'), `export function mount(container, ctx) {
  const glow = document.createElement('div');
  glow.style.cssText = 'position:absolute;inset:0;opacity:.5;background:' + ctx.props.tint;
  container.append(glow);
  let screen = ctx.context ? ctx.context.screen : null;
  let t = 0;
  const off = ctx.host.onFrame((dt) => { t += dt; glow.style.opacity = String(0.4 + 0.2 * Math.sin(t)); });
  const offContext = ctx.host.onContext((c) => { screen = c.screen; });
  return { update(p) { glow.style.background = p.tint; }, getState: () => ({ screen }), setState() {}, dispose() { off(); offContext(); glow.remove(); } };
}
`);
  writeJSON(dir, 'objects/glow/object.tests.json', { tests: [{ name: 'follows the learner', context: { screen: 'accueil', section: 'a', step: 1, variant: null }, steps: [
    { action: 'step', frames: 10 }, { action: 'expect-state', state: { screen: 'accueil' } },
    { action: 'set-context', context: { screen: 'chemin', section: 'a', step: 1, variant: null } }, { action: 'expect-state', state: { screen: 'chemin' } }
  ] }] });
  fs.writeFileSync(path.join(odir, 'object.notes.md'), 'Decorative glow behind the course.\n');
  course.theme.backdrop = { layers: ['sky'], object: { id: 'glow' }, variants: { dim: 'Darker' } };
  writeJSON(dir, 'course.json', course);
  const s = readJSON(dir, 'screens/chemin.json');
  s.backdrop = 'none';
  writeJSON(dir, 'screens/chemin.json', s);
  const v = validateDir(dir);
  assert.equal(v.summary.errors, 0, JSON.stringify(v.diagnostics.filter((d) => d.severity === 'error')));

  const g = await testObject(dir, 'glow');
  assert.ok(g.ok, JSON.stringify(g.diagnostics.filter((d) => d.severity === 'error')));

  await openPlayer(dir, async (page, errors) => {
    const look = () => page.evaluate(() => {
      const b = document.querySelector<HTMLElement>('.t-backdrop')!;
      return { screen: b.dataset.screen, hidden: b.hidden, ariaHidden: b.getAttribute('aria-hidden'), inert: b.inert, layers: b.querySelectorAll('.t-backdrop-layer').length, frame: !!b.querySelector('.t-backdrop-object iframe'), first: document.getElementById('elabora-app')!.firstElementChild === b };
    });
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('accueil'));
    let b = await look();
    assert.deepEqual(b, { screen: 'accueil', hidden: false, ariaHidden: 'true', inert: true, layers: 1, frame: true, first: true });
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('chemin'));
    b = await look();
    assert.equal(b.screen, 'chemin');
    assert.equal(b.hidden, true, 'backdrop "none" on this screen');
    assert.deepEqual(errors, []);
  });

  // The look server shows the backdrop of each screen asked for, one after the other in one page.
  const looker = await startLooker(dir, { live: false });
  try {
    const seen = [];
    for (const screen of ['accueil', 'chemin', 'accueil']) {
      const result = await looker.look({ screen, width: 1280, height: 720 });
      assert.ok(result.ok, JSON.stringify(result));
      seen.push(result.backdrop);
    }
    assert.deepEqual(seen.map((backdrop) => [backdrop?.screen, backdrop?.hidden]), [['accueil', false], ['chemin', true], ['accueil', false]]);
    assert.equal(seen[2]?.object?.id, 'glow');
  } finally {
    await looker.close();
  }
});

test('backdrop decoration: object new --decoration, its gates, where the screen stands in the course, the default variant on #elabora-app, and its replay behind the course', { timeout: 420000 }, async () => {
  const { dir, course } = slidesCopy();
  assert.throws(() => edit.createObject(dir, { id: 'drift', title: 'Drift' }), /--decoration/);
  edit.createObject(dir, { id: 'drift', title: 'Drift', decoration: true });
  const manifest = readJSON(dir, 'objects/drift/object.manifest.json');
  assert.equal(manifest.pedagogicalRole, 'decoration');
  assert.equal(manifest.planRefs, undefined);
  course.theme.backdrop = { layers: ['sky'], object: { id: 'drift' }, variants: { dusk: 'Darker', dawn: 'Lighter' }, default: 'dusk' };
  writeJSON(dir, 'course.json', course);
  const later = readJSON(dir, 'screens/chemin.json');
  later.backdrop = 'dawn';
  writeJSON(dir, 'screens/chemin.json', later);
  const v = validateDir(dir);
  assert.equal(v.summary.errors, 0, JSON.stringify(v.diagnostics.filter((d) => d.severity === 'error')));
  const broken = JSON.parse(JSON.stringify(course));
  broken.theme.backdrop.default = 'night';
  writeJSON(dir, 'course.json', broken);
  assert.ok(validateDir(dir).diagnostics.some((d) => d.code === 'E_BACKDROP_VARIANT' && d.path === '/theme/backdrop/default'));
  writeJSON(dir, 'course.json', course);

  const gates = await testObject(dir, 'drift');
  assert.ok(gates.ok, JSON.stringify(gates.diagnostics.filter((d) => d.severity === 'error')));
  assert.ok(!gates.diagnostics.some((d) => d.code === 'W_GATE_VISUAL_BLANK'), 'the template draws');

  const ids = screenOrder(loadProjectFromDir(dir)).map((entry) => entry.id);
  await openPlayer(dir, async (page, errors) => {
    const seen = () => page.evaluate(async () => {
      const b = document.querySelector<HTMLElement>('.t-backdrop')!;
      const host = (window as PlayerWindow).__elabora.backdropHost();
      return { data: { ...b.dataset }, app: document.getElementById('elabora-app')!.dataset.backdrop ?? null, state: await host?.getState(), ready: b.querySelector<HTMLElement>('.t-backdrop-object')?.dataset.state };
    });
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('accueil'));
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.t-backdrop-object')?.dataset.state === 'ready');
    const first = await seen();
    assert.equal(first.app, 'dusk', 'the default variant');
    assert.equal(first.data.variant, 'dusk');
    assert.equal(first.data.screenIndex, String(ids.indexOf('accueil')));
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('chemin'));
    await page.waitForTimeout(300);
    const next = await seen();
    assert.equal(next.app, 'dawn', 'its own variant');
    assert.equal(next.data.direction, ids.indexOf('chemin') > ids.indexOf('accueil') ? 'forward' : 'back');
    assert.deepEqual((next.state as { screenIndex: number }).screenIndex, ids.indexOf('chemin'), 'the object heard the rank of the screen');
    assert.deepEqual(errors, []);
  });

  const replay = await replayObject(dir, 'drift', { width: 1280, height: 720 });
  assert.ok(replay.ok && replay.block === 'backdrop', JSON.stringify(replay.error ?? replay.failures));
  assert.equal(replay.frames.length, 4, 'three snapshots and the end');
});

test('a click in the slide reveals the next step; back on the screen, the step reached', { timeout: 180000 }, async () => {
  const { dir } = slidesCopy();
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.splice(1, 0, { id: 'chemin-voir', type: 'button', props: { label: 'Voir le schéma' } });
  for (const b of s.blocks.slice(2)) b.step = 2;
  s.blocks.at(-1).step = 3;
  s.events = [{ id: 'voir', on: { type: 'click', target: 'chemin-voir' }, do: [{ type: 'reveal-step', step: 2 }] }];
  writeJSON(dir, 'screens/chemin.json', s);
  await openPlayer(dir, async (page) => {
    // Visited screens show every step: start this one afresh.
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; const c = t.engine.screens.find((x) => x.id === 'chemin')!; t.engine.st.visited.delete(c.key); t.engine.st.completed.delete(c.key); t.go('chemin'); });
    const look = () => page.evaluate(() => ({
      step: (window as PlayerWindow).__elabora.step.revealed,
      current: [...document.querySelectorAll<HTMLElement>('[data-t-current][data-block]')].map((n) => n.dataset.block),
      focus: document.activeElement?.closest<HTMLElement>('[data-block]')?.dataset.block || null,
      button: document.querySelector('.t-nav-btn--next .t-nav-label:not([aria-hidden])')!.textContent
    }));
    assert.deepEqual((await look()).current, ['chemin-intro', 'chemin-voir']);
    await page.click('[data-block="chemin-voir"] button');
    assert.deepEqual(await look(), { step: 2, current: ['chemin-schema', 'chemin-regle'], focus: 'chemin-schema', button: 'Continuer' });
    // Selected again: nothing more is revealed, the step takes the focus again.
    await page.focus('[data-block="chemin-voir"] button');
    await page.click('[data-block="chemin-voir"] button');
    assert.deepEqual(await look(), { step: 2, current: ['chemin-schema', 'chemin-regle'], focus: 'chemin-schema', button: 'Continuer' });
    // Left part-way, then back (and after a relaunch, from the suspend data): the step reached.
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; t.go('accueil'); t.go('chemin'); });
    assert.equal((await look()).step, 2, 'back on the screen: the step reached');
    const saved = await page.evaluate(() => JSON.parse((window as PlayerWindow).__elabora.state().suspendData).p);
    assert.deepEqual(Object.values(saved), [2]);
    await page.click('.t-nav-btn--next');
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; t.go('accueil'); t.go('chemin'); });
    assert.equal((await look()).step, 3, 'seen to the end: every step');
    assert.equal(await page.evaluate(() => JSON.parse((window as PlayerWindow).__elabora.state().suspendData).p), undefined);
  });
});

test('a screen can leave its steps to its own triggers: Continue does not reveal them', { timeout: 180000 }, async () => {
  const { dir, course } = slidesCopy();
  course.navigation.lockUntilComplete = true;
  writeJSON(dir, 'course.json', course);
  const s = readJSON(dir, 'screens/chemin.json');
  s.continueRevealsSteps = false;
  s.blocks.splice(1, 0, { id: 'chemin-voir', type: 'button', props: { label: 'Voir le schéma' } });
  for (const b of s.blocks.slice(2)) b.step = 2;
  s.events = [{ id: 'voir', on: { type: 'click', target: 'chemin-voir' }, do: [{ type: 'reveal-step', step: 2 }] }];
  writeJSON(dir, 'screens/chemin.json', s);
  await openPlayer(dir, async (page) => {
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; const c = t.engine.screens.find((x) => x.id === 'chemin')!; t.engine.st.visited.delete(c.key); t.engine.st.completed.delete(c.key); t.go('chemin'); });
    const look = () => page.evaluate(() => {
      const t = (window as PlayerWindow).__elabora;
      const b = document.querySelector('.t-nav-btn--next')!;
      // A refusal is the player's tooltip, next to Next (nothing moves).
      const tip = document.querySelector<HTMLElement>('.t-tip')!;
      return { screen: t.screen, step: t.step.revealed, button: b.querySelector('.t-nav-label:not([aria-hidden])')!.textContent, locked: b.getAttribute('aria-disabled'), hint: tip.hidden ? null : tip.textContent };
    });
    assert.deepEqual(await look(), { screen: 'chemin', step: 1, button: 'Suivant', locked: 'true', hint: null });
    await page.click('.t-nav-btn--next', { force: true }); // aria-disabled: still pressable, it says why
    assert.deepEqual(await look(), { screen: 'chemin', step: 1, button: 'Suivant', locked: 'true', hint: 'Explorez cet écran pour continuer.' });
    await page.click('[data-block="chemin-voir"] button');
    assert.deepEqual(await look(), { screen: 'chemin', step: 2, button: 'Suivant', locked: 'false', hint: null });
  });
});

test('explore in any order: named buttons and tabs are visited, saved, and unlock Next when all are', { timeout: 180000 }, async () => {
  const { dir, course } = slidesCopy();
  course.navigation.lockUntilComplete = true;
  writeJSON(dir, 'course.json', course);
  addExplorer(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.completeWhen = 'action';
  s.blocks.push(
    { id: 'chemin-marques', type: 'markers', props: { items: [{ id: 'poste', label: 'Le poste' }, { id: 'switch', label: 'Le commutateur' }] } },
    { id: 'chemin-facettes', type: 'facets', step: 2, props: { items: [{ id: 'cable', label: 'Câble', body: 'Branché ?' }, { id: 'ip', label: 'Adresse', body: 'Valide ?' }] } });
  s.layers = [{ id: 'chemin-poste', title: 'Le poste', blocks: [{ id: 'chemin-poste-t', type: 'text', props: { markdown: 'Le poste de Marc.' } }] }];
  const all = [{ visited: 'chemin-marques' }, { visited: 'chemin-facettes' }];
  s.events = [
    { id: 'poste', on: { type: 'click', target: 'chemin-marques', name: 'poste' }, do: [{ type: 'show-layer', layer: 'chemin-poste' }] },
    { id: 'switch', on: { type: 'click', target: 'chemin-marques', name: 'switch' }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] },
    { id: 'fini-m', on: { type: 'click', target: 'chemin-marques' }, if: all, do: [{ type: 'complete-screen' }] },
    { id: 'fini-f', on: { type: 'click', target: 'chemin-facettes' }, if: all, do: [{ type: 'complete-screen' }] }
  ];
  writeJSON(dir, 'screens/chemin.json', s);
  await openPlayer(dir, async (page) => {
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; const c = t.engine.screens.find((x) => x.id === 'chemin')!; t.engine.st.visited.delete(c.key); t.engine.st.completed.delete(c.key); t.go('chemin'); });
    const look = () => page.evaluate(() => ({
      visited: [...document.querySelectorAll('[data-t-visited]')].map((n) => n.getAttribute('data-t-click') || n.getAttribute('data-t-tab')),
      layer: !!document.querySelector('dialog.t-layer[open]'),
      locked: document.querySelector('.t-nav-btn--next')!.getAttribute('aria-disabled')
    }));
    // The tabs wait in step 2: their first tab is not seen yet.
    assert.deepEqual(await look(), { visited: [], layer: false, locked: 'false' });
    await page.click('[data-t-click="switch"]');
    assert.deepEqual(await look(), { visited: ['switch'], layer: false, locked: 'false' }, 'the layer listens to "poste" only');
    await page.click('[data-t-click="poste"]');
    assert.deepEqual(await look(), { visited: ['poste', 'switch'], layer: true, locked: 'false' });
    await page.keyboard.press('Escape');
    // Continue shows the tabs: the selected one counts as visited without a click.
    await page.click('.t-nav-btn--next');
    assert.deepEqual(await look(), { visited: ['poste', 'switch', 'cable'], layer: false, locked: 'true' });
    await page.focus('[data-t-tab="cable"]');
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await look(), { visited: ['poste', 'switch', 'cable', 'ip'], layer: false, locked: 'false' }, 'all visited: the screen is complete');
    // Saved with the progress and shown again on return.
    assert.equal(await page.evaluate(() => JSON.parse((window as PlayerWindow).__elabora.state().suspendData).w.split('.').length), 4);
    await page.evaluate(() => { const t = (window as PlayerWindow).__elabora; t.go('accueil'); t.go('chemin'); });
    assert.deepEqual((await look()).visited, ['poste', 'switch', 'cable', 'ip']);
  });
});

test('hide-layer without a layer closes the layer on top, and its layer.closed fires', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push({ id: 'chemin-ouvrir', type: 'button', props: { label: 'Ouvrir le panneau' } }, { id: 'chemin-replier', type: 'button', props: { label: 'Replier' } });
  // A panel that opens a dialog, which a Close button inside it closes.
  s.layers = [
    { id: 'chemin-panneau', title: 'Panneau', presentation: 'panel', blocks: [{ id: 'chemin-panneau-b', type: 'button', props: { label: 'Ouvrir le détail' } }] },
    { id: 'chemin-detail', title: 'Détail', blocks: [{ id: 'chemin-detail-t', type: 'text', props: { markdown: 'Détail.' } }, { id: 'chemin-fermer', type: 'button', props: { label: 'Fermer' } }] }
  ];
  s.events = [
    { id: 'ouvrir', on: { type: 'click', target: 'chemin-ouvrir' }, do: [{ type: 'show-layer', layer: 'chemin-panneau' }] },
    { id: 'detail', on: { type: 'click', target: 'chemin-panneau-b' }, do: [{ type: 'show-layer', layer: 'chemin-detail' }] },
    { id: 'fermer', on: { type: 'click', target: 'chemin-fermer' }, do: [{ type: 'hide-layer' }] },
    { id: 'replier', on: { type: 'click', target: 'chemin-replier' }, do: [{ type: 'hide-layer' }] },
    { id: 'detail-ferme', on: { type: 'layer.closed', target: 'chemin-detail' }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] }
  ];
  writeJSON(dir, 'screens/chemin.json', s);
  await openPlayer(dir, async (page, errors) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.go('chemin'));
    const open = () => page.evaluate(() => [...document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')].map((dialog) => `${dialog.dataset.layer}:${dialog.open}`).sort());
    const closed = () => page.evaluate(() => (window as PlayerWindow).__elabora.engine.getVar('indiceVu'));
    await page.click('[data-block="chemin-ouvrir"] button');
    await page.click('[data-block="chemin-panneau-b"] button');
    assert.deepEqual(await open(), ['chemin-detail:true', 'chemin-panneau:true']);
    assert.equal(await closed(), false);
    // Close, inside the dialog: the dialog closes (it is on top), the panel stays, layer.closed fires.
    await page.click('[data-block="chemin-fermer"] button');
    await page.waitForFunction(() => !document.querySelector('dialog.t-layer[data-layer="chemin-detail"]'));
    assert.deepEqual(await open(), ['chemin-panneau:true']);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora.engine.getVar('indiceVu') === true);
    // On the slide (a panel leaves it usable): the panel, now on top, closes; then nothing is left to close.
    await page.click('[data-block="chemin-replier"] button');
    await page.waitForFunction(() => !document.querySelector('dialog.t-layer'));
    await page.click('[data-block="chemin-replier"] button');
    assert.deepEqual(await open(), []);
    assert.deepEqual(errors, []);
  });
});

test('panel layers open over the screen without blocking it', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/premier-reflexe.json');
  const layer = s.layers[0];
  layer.presentation = 'panel';
  writeJSON(dir, 'screens/premier-reflexe.json', s);
  await openPlayer(dir, async (page) => {
    await page.evaluate((id) => { const t = (window as PlayerWindow).__elabora; t.go('premier-reflexe'); t.openLayer(id); }, layer.id);
    const r = await page.evaluate(() => {
      const d = document.querySelector('dialog.t-layer')!;
      return { panel: d.classList.contains('t-panel'), modal: d.matches(':modal'), inMain: !!d.closest('#t-main'), focus: document.activeElement === d.querySelector('h2') };
    });
    assert.deepEqual(r, { panel: true, modal: false, inMain: true, focus: true });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.t-layer'), null, { timeout: 30000 });
  });
});

test('cascade layers: each order as the package and the canvas show it, a theme upgrade keeping the look, and who overrides whom found in the page (D32)', { timeout: 240000 }, async () => {
  const probe = () => {
    const style = getComputedStyle(document.querySelector('.lp-probe')!);
    return { width: style.paddingLeft, border: style.backgroundColor, color: style.color };
  };
  const { width, component, theme } = LAYER_PROBE;
  const variant = (cascade?: string, css?: string) => {
    const dir = copyExample();
    addLayerProbe(dir);
    if (css !== undefined) fs.writeFileSync(path.join(dir, 'theme/theme.css'), css);
    const course = readJSON(dir, 'course.json');
    if (cascade) course.theme.cascade = cascade; else delete course.theme.cascade;
    writeJSON(dir, 'course.json', course);
    return dir;
  };
  // A general rule of the theme, on a player hook the component's template uses.
  const general = `.t-callout { background-color: ${theme}; color: ${theme}; }\n`;
  const overridden = ['component-overridden .lp-probe .t-callout', 'component-overridden .t-block--layer-probe .t-callout.lp-probe .t-callout'];
  const upgraded = variant(undefined, general);
  const upgrade = edit.upgradeThemeCascade(upgraded);
  assert.ok(upgrade.upgraded && upgrade.moved === 2, JSON.stringify(upgrade));
  const cases: { name: string; dir: string; expected: ReturnType<typeof probe>; conflicts: string[] }[] = [
    // Before D32 (no theme.cascade): the theme's rule beats the component's, whatever the
    // specificity, and the page says so.
    { name: 'theme over components', dir: variant(undefined, general), expected: { width, border: theme, color: theme }, conflicts: overridden },
    // A theme rule that names the component (its own class) overrides it on purpose.
    { name: 'theme over components, named', dir: variant(), expected: { width, border: theme, color: theme }, conflicts: [] },
    // D32: the theme's rules are the course's defaults, under the components.
    { name: 'components over theme', dir: variant('components-over-theme', general), expected: { width, border: component, color: component }, conflicts: [] },
    // A theme rule that names the component without @layer overrides gives way, and the page says so.
    { name: 'components over theme, named', dir: variant('components-over-theme'), expected: { width, border: component, color: component }, conflicts: ['theme-under-component .lp-probe .lp-probe', 'theme-under-component .t-block--layer-probe .t-callout.lp-probe .lp-probe'] },
    // Its @layer overrides block wins over the component on purpose: nothing to say.
    { name: 'overrides', dir: variant('components-over-theme', `@layer overrides {\n  .t-block--layer-probe .lp-probe { background-color: ${theme}; color: ${theme}; }\n}\n`), expected: { width, border: theme, color: theme }, conflicts: [] },
    // The upgrade keeps the look of the course it upgrades; its general rule, now in @layer
    // overrides, still overrides the component, and the page still says so.
    { name: 'upgraded', dir: upgraded, expected: { width, border: theme, color: theme }, conflicts: overridden }
  ];
  const browser: Browser = await launchBrowser('chromium');
  try {
    for (const { name, dir, expected, conflicts } of cases) {
      await openPlayer(dir, async (page, errors) => {
        await page.evaluate((id) => (window as PlayerWindow).__elabora.go(id), LAYER_PROBE.screen);
        assert.deepEqual(await page.evaluate(probe), expected, `${name}: package`);
        assert.deepEqual((await page.evaluate(pageStyleConflicts)).map((found) => `${found.kind} ${found.componentRule} ${found.themeRule}`).sort(), conflicts, `${name}: package conflicts`);
        assert.deepEqual(errors, []);
      });
      // The editor canvas reproduces the package: the same player stylesheet, the design layer inline.
      const host = await startCanvasHost({ root: dir });
      try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        await page.goto(host.url);
        await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
        host.push(renderScreen(loadProjectFromDir(dir), LAYER_PROBE.screen), { id: 1 });
        await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas.layout().id === 1);
        assert.deepEqual(await page.evaluate(probe), expected, `${name}: canvas`);
        assert.deepEqual((await page.evaluate(pageStyleConflicts)).map((found) => `${found.kind} ${found.componentRule} ${found.themeRule}`).sort(), conflicts, `${name}: canvas conflicts`);
        await page.close();
      } finally {
        await host.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test('scroll pages: Continue in the page, a step that opens once answered, Previous and Next at the end', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.player = { bottom: { items: [{ id: 'outline' }, { id: 'controls' }, { id: 'previous' }, { id: 'next' }], position: 'page' } };
  writeJSON(dir, 'course.json', course);
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.blocks.find((block: { id: string }) => block.id === 'chemin-regle').step = 2;
  screen.blocks.find((block: { id: string }) => block.id === 'chemin-roles').step = 3;
  screen.blocks.splice(screen.blocks.findIndex((block: { id: string }) => block.id === 'chemin-roles'), 0, { id: 'chemin-check', type: 'quiz', step: 2, props: {
    stem: 'Quel équipement relie le réseau du bureau à Internet ?', mode: 'single', scored: false, options: [
      { id: 'a', text: 'Le routeur', correct: true, feedback: 'Oui : il relie les réseaux.' },
      { id: 'b', text: 'Le switch', correct: false, feedback: 'Non : il relie les postes d’un même réseau.' },
      { id: 'c', text: 'Le câble réseau', correct: false, feedback: 'Non : il transporte seulement le signal.' }
    ] } });
  screen.steps = { 2: { label: 'Voir la règle' }, 3: { opens: 'answered' } };
  writeJSON(dir, 'screens/chemin.json', screen);
  const validation = validateDir(dir);
  assert.equal(validation.summary.errors, 0, JSON.stringify(validation.diagnostics.filter((d) => d.severity === 'error')));
  await openPlayer(dir, async (page) => {
    // A page not read yet (the helper marks every screen visited, which shows every step).
    await page.evaluate(() => {
      const t = (window as PlayerWindow).__elabora;
      const key = t.engine.screens.find((candidate) => candidate.id === 'chemin')!.key;
      t.engine.st.visited.delete(key);
      t.engine.st.completed.delete(key);
      t.go('chemin');
    });
    const look = () => page.evaluate(() => {
      const t = (window as PlayerWindow).__elabora;
      const cut = document.querySelector<HTMLElement>('.t-continue');
      return {
        step: t.step.revealed,
        continue: cut ? { label: cut.querySelector('button')?.textContent, before: (cut.nextElementSibling as HTMLElement | null)?.dataset.block } : null,
        footer: !document.querySelector<HTMLElement>('.t-bar--bottom')?.hidden,
        focus: (document.activeElement as HTMLElement | null)?.dataset?.block || null
      };
    });
    let s = await look();
    assert.deepEqual([s.step, s.continue, s.footer], [1, { label: 'Voir la règle', before: 'chemin-regle' }, false]);
    await page.click('.t-continue-btn');
    s = await look();
    assert.deepEqual([s.step, s.continue, s.footer, s.focus], [2, null, false, 'chemin-regle'], 'the step opens and takes the focus; the next one waits for the answer');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-block="chemin-roles"]')!).display), 'none');
    await page.click('[data-block="chemin-check"] [data-t-option="b"] input');
    await page.click('[data-block="chemin-check"] [data-t-submit]');
    s = await look();
    assert.deepEqual([s.step, s.footer], [3, true], 'answered (even wrong), the rest of the page opens and Previous and Next follow it');
    assert.notEqual(s.focus, 'chemin-roles', 'the focus stays with the feedback');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.t-bar--bottom')!).position), 'relative', 'in the flow of the page, not kept in the window');
    // The outline, in the bar at the end of the page, names the screens pages.
    await page.click('.t-outline-btn');
    assert.equal(await page.locator('.t-menu-where').textContent(), 'Page 2 sur 6', 'scroll presentation names its screens pages');
  });
});

test('fit on scroll pages: a second pass with animations on finds text a scroll-driven animation leaves too faint', { timeout: 240000 }, async () => {
  const dir = copyExample();
  addViewProbe(dir);
  // A paragraph kept at 20 % opacity by a scroll-driven animation: fine with reduced motion, too faint as the page scrolls.
  fs.mkdirSync(path.join(dir, 'theme'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme/theme.css'), '@keyframes faint { from, to { opacity: .2; } }\n[data-block="chemin-filler-3"] { animation: faint linear both; animation-timeline: view(); }\n');
  const course = readJSON(dir, 'course.json');
  course.theme.stylesheet = 'theme/theme.css';
  writeJSON(dir, 'course.json', course);
  const fit = await measureFit(dir);
  assert.ok(fit.ok, JSON.stringify(fit.diagnostics));
  const contrast = fit.sizes[0].screens.find((screen) => screen.screen === 'chemin')?.contrast || [];
  assert.ok(contrast.some((found) => found.block === 'chemin-filler-3' && found.scrolled), JSON.stringify(contrast));
  assert.ok(!contrast.some((found) => found.block === 'chemin-filler-3' && !found.scrolled), 'reduced motion: the paragraph is fine');
  assert.ok(fitDiagnostics(fit).some((d) => d.code === 'W_TEXT_CONTRAST_MEASURED' && /as the page scrolls/.test(d.message)));
});

test('fit on scroll pages: a scroll-driven animation that the end of the page leaves unfinished is reported, one that finishes is not', { timeout: 240000 }, async () => {
  const dir = copyExample();
  const page = readJSON(dir, 'screens/chemin.json');
  for (let n = 1; n <= 6; n++) page.blocks.push({ id: `chemin-filler-${n}`, type: 'text', props: { markdown: 'Le paquet traverse le réseau. '.repeat(14) } });
  page.blocks.push({ id: 'chemin-last', type: 'callout', props: { variant: 'info', markdown: 'La dernière étape.' } });
  writeJSON(dir, 'screens/chemin.json', page);
  // The last block's range ends once it has left the window, which the end of the page never lets it do.
  fs.mkdirSync(path.join(dir, 'theme'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme/theme.css'), ['@keyframes rise { from { opacity: 0; translate: 0 2rem; } to { opacity: 1; translate: 0 0; } }',
    '[data-block="chemin-regle"] { animation: rise linear both; animation-timeline: view(); animation-range: entry 0% cover 30%; }',
    '[data-block="chemin-last"] { animation: rise linear both; animation-timeline: view(); animation-range: cover 0% cover 100%; }', ''].join('\n'));
  const course = readJSON(dir, 'course.json');
  course.theme.stylesheet = 'theme/theme.css';
  writeJSON(dir, 'course.json', course);
  const fit = await measureFit(dir);
  assert.ok(fit.ok, JSON.stringify(fit.diagnostics));
  const unfinished = fit.sizes[0].screens.find((screen) => screen.screen === 'chemin')?.unfinished || [];
  assert.deepEqual(unfinished.map((entry) => entry.block), ['chemin-last'], JSON.stringify(unfinished));
  assert.ok((unfinished[0].atEnd ?? 0) < 1);
  const found = fitDiagnostics(fit).filter((d) => d.code === 'W_SCROLL_ANIMATION_UNFINISHED');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /chemin-last: the animation "rise" of .* stops at \d+ % when the page is scrolled to the bottom/);
});

test('assets: a contact sheet of what the generators wrote', { timeout: 120000 }, async () => {
  const sample = path.resolve(import.meta.dirname, '../../examples/medieval-charts');
  const png = await assetsSheet(sample, [{ generator: 'generators/figures.mjs', description: 'Figures', outputs: ['images/wind-rose.svg', 'images/to-ocean.svg', 'images/missing.svg'] }], { surface: '#F4EBD6' });
  assert.ok(png.length > 20000);
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
});

// A figure that draws itself (an SVG shown through <img>, with its own CSS animation) is captured
// drawn when animations are off, and as it starts when they are on. The page's own reduced-motion
// setting does not reach an SVG image: the capture browser prefers reduced motion as a whole.
const DRAWN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><style>\n'
  + '.s{fill:none;stroke:#ff00aa;stroke-width:30;stroke-dasharray:200;stroke-dashoffset:200;animation:draw 2s linear 60s forwards}\n'
  + '@keyframes draw{to{stroke-dashoffset:0}}\n@media (prefers-reduced-motion: reduce){.s{animation:none;stroke-dashoffset:0}}\n'
  + '</style><path class="s" d="M10 50H190"/></svg>\n';

function figureCourse(): string {
  const dir = copyExample();
  fs.writeFileSync(path.join(dir, 'assets/images/drawn.svg'), DRAWN);
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.find((block: { id: string }) => block.id === 'accueil-illustration').props.asset = 'images/drawn.svg';
  writeJSON(dir, 'screens/accueil.json', screen);
  return dir;
}

// Pixels of the figure's colour (#ff00aa, which Electron's colour management draws as about #ea33a7) in a PNG.
function figurePixels(png: Buffer): number {
  const { PNG } = createRequire(import.meta.url)('pngjs');
  const image = PNG.sync.read(png);
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) if (image.data[i] > 200 && image.data[i + 1] < 90 && image.data[i + 2] > 120 && image.data[i + 2] < 210) count++;
  return count;
}

test('captures: an SVG figure that draws itself is captured drawn, or at its first frame with animations on, by screenshot, the look server and the assets sheet', { timeout: 180000 }, async () => {
  const dir = figureCourse();
  try {
    const still = await capture(dir, [{ screen: 'accueil', width: 1280, height: 720 }, { screen: 'accueil', width: 1280, height: 720, motion: true }]);
    assert.ok(still.shots?.[0].ok && still.shots[1].ok, JSON.stringify(still));
    assert.ok(figurePixels(still.shots[0].png) > 4000, 'screenshot: drawn');
    assert.equal(figurePixels(still.shots[1].png), 0, 'screenshot --motion: the animation starts from nothing');

    const looker = await startLooker(dir, { live: false });
    try {
      const reduced = await looker.look({ screen: 'accueil', width: 1280, height: 720, type: 'png' });
      const moving = await looker.look({ screen: 'accueil', width: 1280, height: 720, type: 'png', motion: true });
      assert.ok(reduced.ok && moving.ok, JSON.stringify([reduced, moving]));
      assert.ok(figurePixels(reduced.image) > 4000, 'look: drawn');
      assert.equal(figurePixels(moving.image), 0, 'look --motion');
    } finally {
      await looker.close();
    }

    const sheet = await assetsSheet(dir, [{ generator: 'generators/drawn.mjs', outputs: ['images/drawn.svg'] }], { surface: '#ffffff', width: 800 });
    assert.ok(figurePixels(sheet) > 1000, 'assets --sheet: drawn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
