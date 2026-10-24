import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from 'playwright-core';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { startCanvasHost } from '@elabora/node/canvas/host';
import { launchBrowser } from '@elabora/node/emulator/browser';
import * as edit from '@elabora/node/edit';
import { renderScreen } from '@elabora/core/render/screen';
import type { CanvasApi } from '@elabora/player/canvas';
import { PLAYER_PREVIEW_PROTOCOL } from '@elabora/player/canvas-protocol';
import type { CanvasMessage, HostMessage } from '@elabora/player/canvas-protocol';
import { ROOT, copyExample } from '../helpers.ts';
import { openProject } from '@elabora/engine';

// The player's preview (the canvas with chrome=live, protocol elabora-player-preview/1): the bars
// work as in a package around the screen the host renders, the host outlines and opens what the
// editor points at, and hears what the author clicks and where Previous, Next and the outline go.

type LiveWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi; sent: CanvasMessage[] };
const protocol = PLAYER_PREVIEW_PROTOCOL;

async function withLive(dir: string, run: (live: { page: Frame; host: Page; show(screen: string, id: number): Promise<void>; send(message: HostMessage): Promise<void>; post(message: Record<string, unknown>): Promise<void>; sent(): Promise<CanvasMessage[]> }) => Promise<void>, { chrome = 'live' }: { chrome?: string } = {}) {
  const host = await startCanvasHost({ root: dir });
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // In a frame, as the app shows it: the canvas posts to its parent, which listens as a host would.
    await page.evaluate(() => {
      (window as unknown as LiveWindow).sent = [];
      addEventListener('message', (event) => { const data = event.data as CanvasMessage; if (data?.type && data.type !== 'elabora/layout') (window as unknown as LiveWindow).sent.push(data); });
    });
    await page.evaluate((url) => { document.body.style.margin = '0'; document.body.innerHTML = `<iframe id="canvas" src="${url}" style="border:0;width:1600px;height:900px"></iframe><input id="column" aria-label="Colonne">`; }, `${host.url}&chrome=${chrome}`);
    const frame = await (await page.waitForSelector('#canvas')).contentFrame();
    if (!frame) throw new Error('no frame');
    await frame.waitForFunction(() => (window as unknown as LiveWindow).__elaboraCanvas);
    const show = async (screen: string, id: number) => {
      host.push(renderScreen(loadProjectFromDir(dir), screen, {}), { id });
      await frame.waitForFunction((wanted) => (window as unknown as LiveWindow).__elaboraCanvas.layout().id === wanted, id);
      await frame.evaluate(() => (window as unknown as LiveWindow).__elaboraCanvas.ready(5000));
    };
    const send = async (message: HostMessage) => { await frame.evaluate((json) => (window as unknown as LiveWindow).__elaboraCanvas.receive(JSON.parse(json)), JSON.stringify(message)); };
    // As the app posts it: from the parent window, with the token.
    const token = new URL(host.url).searchParams.get('token');
    const post = async (message: Record<string, unknown>) => {
      await page.evaluate((json) => { (document.getElementById('canvas') as HTMLIFrameElement).contentWindow!.postMessage(JSON.parse(json), '*'); }, JSON.stringify({ ...message, token }));
      await page.waitForTimeout(50);
    };
    // Messages arrive after the event that sent them (postMessage is asynchronous).
    const sent = async () => { await page.waitForTimeout(100); return page.evaluate(() => (window as unknown as LiveWindow).sent.splice(0)); };
    await run({ page: frame, host: page, show, send, post, sent });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await host.close();
  }
}

test('the live bars: panels, the outline, Previous and Next said to the host, the item clicked, highlight, open and close', { timeout: 180000 }, async () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  edit.updatePlayer(dir, { enable: ['display'] });
  await withLive(dir, async ({ page, show, send, post, sent }) => {
    await show('chemin', 1);
    assert.deepEqual((await sent()).find((message) => message.type === 'elabora/ready'), { type: 'elabora/ready', chrome: 'live', protocol });
    // The panels open from their buttons, between the bars.
    await page.click('.t-resources-btn');
    const sheet = await page.locator('.t-sheet[data-sheet="resources"]').boundingBox();
    assert.ok(sheet && sheet.y >= 55 && sheet.y + sheet.height <= 829, `the panel between the bars (${JSON.stringify(sheet)})`);
    await page.click('.t-glossary-btn');
    assert.equal(await page.locator('.t-sheet[data-sheet="glossary"]').isVisible(), true);
    await page.locator('.t-sheet[data-sheet="resources"]').waitFor({ state: 'hidden', timeout: 2000 }); // it fades out
    assert.equal(await page.locator('.t-sheet[data-sheet="resources"]').isVisible(), false);
    // A term of the screen shows its definition.
    await page.hover('#t-main a.t-term[data-term="paquet"]');
    await page.waitForFunction(() => { const tip = document.getElementById('t-tip'); return !!tip && !tip.hidden && /Petit morceau/.test(tip.textContent ?? ''); });
    let messages = await sent();
    assert.deepEqual(messages.filter((message) => message.type === 'elabora/item'), [{ type: 'elabora/item', protocol, id: 'resources', bar: 'top' }, { type: 'elabora/item', protocol, id: 'glossary', bar: 'top' }]);
    // Previous, Next and the outline say where they go; the host decides.
    await page.click('.t-nav-btn--next');
    await page.click('.t-nav-btn--previous');
    await page.click('.t-outline-btn');
    assert.match(await page.locator('.t-menu-where').textContent() ?? '', /2 sur 6/);
    await page.click('.t-menu-item >> text=Simulation');
    messages = await sent();
    assert.deepEqual(messages.filter((message) => message.type === 'elabora/navigate'), [
      { type: 'elabora/navigate', screen: 'premier-reflexe', by: 'next' },
      { type: 'elabora/navigate', screen: 'accueil', by: 'previous' },
      { type: 'elabora/navigate', screen: 'simulation', by: 'outline' }
    ]);
    assert.equal(await page.evaluate(() => (window as unknown as LiveWindow).__elaboraCanvas.screen), 'chemin', 'the canvas waits for the host');
    // The host renders the screen the author went to: the bars follow.
    await show('premier-reflexe', 2);
    await page.click('.t-outline-btn');
    assert.match(await page.locator('.t-menu-where').textContent() ?? '', /3 sur 6/);
    await page.press('.t-outline-btn', 'Escape');
    // Highlight: one item, a spacer of a bar.
    await post({ type: 'elabora/highlight', protocol, item: 'spacer', bar: 'bottom' });
    await page.waitForFunction(() => document.querySelectorAll('[data-t-highlight]').length === 1);
    assert.equal(await page.locator('.t-bar--bottom .t-item--spacer[data-t-highlight]').count(), 1);
    const spacer = await page.locator('.t-bar--bottom .t-item--spacer').boundingBox();
    assert.ok(spacer && spacer.width >= 31, `a highlighted spacer shows its room (${spacer?.width})`);
    await post({ type: 'elabora/highlight', protocol, item: null });
    await page.waitForFunction(() => document.querySelectorAll('[data-t-highlight]').length === 0);
    // Open and close as the editor asks: a resource's preview, a glossary entry, « Affichage ».
    await post({ type: 'elabora/open', protocol, panel: 'resources', resource: 'fiche-reflexe' });
    await page.waitForSelector('dialog.t-viewer[open][data-resource="fiche-reflexe"]');
    await post({ type: 'elabora/close', protocol });
    await page.waitForFunction(() => !document.querySelector('dialog.t-viewer[open]') && !document.querySelector('.t-sheet:not([hidden])'));
    await send({ type: 'elabora/open', protocol, panel: 'glossary', term: 'routeur' });
    assert.equal(await page.locator('.t-sheet[data-sheet="glossary"]').isVisible(), true);
    await send({ type: 'elabora/open', protocol, panel: 'display' });
    assert.equal(await page.locator('.t-display-menu').isVisible(), true);
    await page.locator('.t-sheet[data-sheet="glossary"]').waitFor({ state: 'hidden', timeout: 2000 }); // it fades out
    assert.equal(await page.locator('.t-sheet[data-sheet="glossary"]').isVisible(), false, 'one thing open at a time');
    // A version the canvas does not speak, a panel the course does not have.
    await post({ type: 'elabora/open', protocol: 'elabora-player-preview/2', panel: 'about' });
    await send({ type: 'elabora/open', protocol, panel: 'language' });
    messages = await sent();
    assert.deepEqual(messages.filter((message) => message.type === 'elabora/error').map((message) => (message as { message: string }).message), [
      'elabora/open: the canvas speaks elabora-player-preview/1, not "elabora-player-preview/2".',
      'elabora/open: the course has nothing to show in language.'
    ]);
  });
});

test('the live bars: a change of the player reaches the open canvas without a reload, the panel open stays open', { timeout: 180000 }, async () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  await withLive(dir, async ({ page, show, post }) => {
    await show('accueil', 1);
    await page.evaluate(() => { (window as unknown as { kept: boolean }).kept = true; });
    await post({ type: 'elabora/open', protocol, panel: 'resources' });
    await page.waitForSelector('.t-sheet[data-sheet="resources"]:not([hidden])');
    assert.equal(await page.locator('.t-resource').count(), 2);
    // The author adds a link and moves Glossaire to the bottom bar: the engine pushes the render.
    const course = loadProjectFromDir(dir).course!;
    edit.updatePlayer(dir, { resources: [...course.resources!, { id: 'charte', title: 'Charte informatique', url: 'https://intranet.example.com/charte' }], move: [{ item: 'glossary', bar: 'bottom', index: 0 }] });
    await show('accueil', 2);
    assert.equal(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept), true, 'no reload');
    assert.equal(await page.locator('.t-sheet[data-sheet="resources"]').isVisible(), true, 'the panel stays open');
    assert.equal(await page.locator('.t-resource').count(), 3);
    assert.equal(await page.locator('.t-bar--bottom .t-glossary-btn').count(), 1);
  });
});

test('the canvas never takes focus from the host: not on an open, a push that mounts the course again, or a modal layer; a click inside does', { timeout: 180000 }, async () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const typing = (host: Page) => host.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName ?? null);
  await withLive(dir, async ({ page, host, show, post }) => {
    await show('accueil', 1);
    // The host's column has the focus (below the canvas, focused without scrolling the page).
    await host.evaluate(() => document.getElementById('column')!.focus({ preventScroll: true }));
    // The host opens the PDF's preview (a modal dialog in the canvas): the column keeps the focus.
    await post({ type: 'elabora/open', protocol, panel: 'resources', resource: 'fiche-reflexe' });
    await page.waitForSelector('dialog.t-viewer[open]');
    assert.equal(await typing(host), 'column');
    // The author renames the resource in the column: the course is mounted again, the preview with it.
    const course = loadProjectFromDir(dir).course!;
    edit.updatePlayer(dir, { resources: course.resources!.map((resource) => (resource.id === 'fiche-reflexe' ? { ...resource, title: 'Fiche réflexe (v2)' } : resource)) });
    await show('accueil', 2);
    await page.waitForSelector('dialog.t-viewer[open]');
    assert.match(await page.locator('dialog.t-viewer[open] .t-viewer-title').textContent() ?? '', /v2/);
    assert.equal(await typing(host), 'column', 'a push keeps the column focused');
    await post({ type: 'elabora/close', protocol });
    // Another screen with a modal layer asked for by the host's view.
    await show('premier-reflexe', 3);
    await post({ type: 'elabora/view', view: { state: 'initial', step: null, layer: 'rappel-regle' } });
    await page.waitForSelector('dialog.t-layer[open]');
    assert.equal(await typing(host), 'column', 'a layer opened by the host keeps the column focused');
    await post({ type: 'elabora/view', view: { state: 'initial', step: null, layer: null } });
    // The author works in the preview: the panel they open takes the focus, as in a package.
    await page.click('.t-glossary-btn');
    await page.waitForSelector('.t-sheet[data-sheet="glossary"]:not([hidden])');
    assert.equal(await typing(host), 'canvas');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.t-sheet[data-sheet="glossary"]')), true);
  });
});

test('the live bars: « Langue » lists the languages a package of every language holds, and a choice goes to the host', { timeout: 180000 }, async () => {
  const dir = copyExample(path.join(ROOT, 'examples/orbital-rendezvous'));
  edit.updatePlayer(dir, { enable: ['language'] });
  await withLive(dir, async ({ page, show, sent }) => {
    await show('intro', 1);
    await page.click('.t-language-btn');
    assert.deepEqual(await page.locator('.t-language-menu [role="menuitemradio"]').allTextContents(), ['English', 'Français']);
    await page.click('.t-language-menu [lang="fr"]');
    const messages = await sent();
    assert.deepEqual(messages.filter((message) => message.type === 'elabora/language'), [{ type: 'elabora/language', protocol, language: 'fr' }]);
    // The host shows the canvas in French (the engine's canvas view language): the bars follow.
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  });
});

test('an event that goes to the next screen names the screen after the one shown, when the canvas has shown others before', { timeout: 180000 }, async () => {
  // The frozen fixture: its first-reflex screen is still a decision block (the sample's is a dialogue).
  const dir = copyExample();
  const file = path.join(dir, 'screens/premier-reflexe.json');
  const screen = JSON.parse(fs.readFileSync(file, 'utf8'));
  screen.events = [...(screen.events ?? []), { id: 'reflexe-suite', on: { type: 'decision.selected', target: 'reflexe-choix', option: 'a' }, do: [{ type: 'go-to', screen: 'next' }] }];
  fs.writeFileSync(file, `${JSON.stringify(screen, null, 2)}\n`);
  await withLive(dir, async ({ page, show, sent }) => {
    // The view mounted on accueil, then updated in place for premier-reflexe.
    await show('accueil', 1);
    await show('premier-reflexe', 2);
    await sent();
    await page.click('[data-block="reflexe-choix"] [data-t-choice="a"]');
    const messages = await sent();
    assert.deepEqual(messages.filter((message) => message.type === 'elabora/navigate'), [{ type: 'elabora/navigate', screen: 'simulation' }]);
  });
});

test('the engine pushes the screen shown again when another screen changes what the bars show (a title in the outline)', { timeout: 180000 }, async () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const session = await openProject(dir, { backups: { enabled: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 });
  const browser = await launchBrowser('chromium');
  try {
    const canvas = await session.openCanvas();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(`${canvas.url}&chrome=live`);
    await page.waitForFunction(() => (window as unknown as LiveWindow).__elaboraCanvas);
    const view = await session.canvasView({ screen: 'accueil' });
    await page.waitForFunction((id) => (window as unknown as LiveWindow).__elaboraCanvas.layout().id === id, view.id);
    await page.evaluate((json) => (window as unknown as LiveWindow).__elaboraCanvas.receive(JSON.parse(json)), JSON.stringify({ type: 'elabora/open', protocol, panel: 'outline' }));
    assert.match(await page.locator('.t-menu').textContent() ?? '', /Le chemin d'une impression/);
    const renamed = await session.run('update_screen', { id: 'chemin', title: 'Le trajet d\'une impression' });
    await page.waitForFunction((id) => (window as unknown as LiveWindow).__elaboraCanvas.layout().id === id, renamed.change?.seq);
    assert.match(await page.locator('.t-menu').textContent() ?? '', /Le trajet d'une impression/);
  } finally {
    await browser.close();
    await session.close();
  }
});
