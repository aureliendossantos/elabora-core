import { test } from 'node:test';
import { resources } from '../resources.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import * as edit from '@elabora/node/edit';
import { readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';

// Vetted fonts added with elabora font add, in a package in Chrome: the faces load from the package,
// the tokens set the text, the heading and the code, and the licence travels next to the files; in a
// course in Polish, the latin-ext files draw its letters, loaded only where a page uses them.

test('elabora font add: the package draws its text with the fonts it carries, licence next to them', { timeout: 120000 }, async (t) => {
  const dir = resources(t).copyExample();
  edit.addFont(dir, { family: 'EB Garamond' });
  edit.addFont(dir, { family: 'JetBrains Mono' });
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push({ id: 'accueil-commande', type: 'text', props: { markdown: 'La commande `elabora font list` montre les polices.' } });
  writeJSON(dir, 'screens/accueil.json', screen);
  const built = await build(dir, { emit: 'dir', out: resources(t).tempDir('elabora-fonts-e2e-'), writeLock: false });
  assert.ok(built.ok && built.dirPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = resources(t).own(await startServer(), value => value.close());
  server.addPackage('p', built.dirPath);
  const browser: Browser = resources(t).own(await launchBrowser('chromium'), value => value.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${server.base}/pkg/p/index.html`);
  await page.waitForFunction(() => (window as PlayerWindow).__elabora && document.querySelector('[data-block="accueil-commande"] code'));
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    // Faces the page does not use yet load on demand: ask for each.
    const loaded = async (font: string) => (await document.fonts.load(font)).map((face) => `${face.family.replace(/"/g, '')} ${face.style} ${face.weight} ${face.status}`);
    const family = (selector: string) => getComputedStyle(document.querySelector(selector)!).fontFamily;
    return {
      body: family('[data-block="accueil-commande"] .t-text, [data-block="accueil-commande"]'),
      title: family('.t-screen-title'),
      code: family('[data-block="accueil-commande"] code'),
      regular: await loaded('400 16px "EB Garamond"'),
      italic: await loaded('italic 600 16px "EB Garamond"'),
      mono: await loaded('400 16px "JetBrains Mono"'),
      drawn: document.fonts.check('16px "EB Garamond"') && document.fonts.check('16px "JetBrains Mono"')
    };
  });
  assert.match(fonts.body, /^"EB Garamond", Garamond/);
  assert.match(fonts.title, /^"EB Garamond", Garamond/);
  assert.match(fonts.code, /^"JetBrains Mono", ui-monospace/, 'the player sets code in the font.mono token');
  assert.deepEqual(fonts.regular, ['EB Garamond normal 400 800 loaded']);
  assert.deepEqual(fonts.italic, ['EB Garamond italic 400 800 loaded']);
  assert.deepEqual(fonts.mono, ['JetBrains Mono normal 100 800 loaded']);
  assert.ok(fonts.drawn);
  const license = await page.evaluate(async () => (await fetch('theme/fonts/eb-garamond/OFL.txt')).text());
  assert.match(license, /^Copyright 2017 The EB Garamond Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
  assert.deepEqual(errors, []);
});

test('a course in Polish: its letters are drawn by the latin-ext files it embeds, loaded only where used', { timeout: 120000 }, async (t) => {
  const dir = resources(t).copyExample();
  writeJSON(dir, 'course.json', { ...readJSON(dir, 'course.json'), language: 'pl' });
  // The body face in latin and latin-ext (what the course language needs), the heading face in
  // latin alone: the screen title shows what the next fonts of the stack draw without latin-ext.
  edit.addFont(dir, { family: 'Lora', for: ['body'] });
  edit.addFont(dir, { family: 'Inter', for: ['heading'], subsets: ['latin'] });
  const words = 'Zażółć gęślą jaźń';
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.title = words;
  screen.blocks.push({ id: 'accueil-polski', type: 'text', props: { markdown: words } });
  writeJSON(dir, 'screens/accueil.json', screen);
  const built = await build(dir, { emit: 'dir', out: resources(t).tempDir('elabora-fonts-e2e-'), writeLock: false });
  assert.ok(built.ok && built.dirPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = resources(t).own(await startServer(), value => value.close());
  server.addPackage('p', built.dirPath);
  const browser: Browser = resources(t).own(await launchBrowser('chromium'), value => value.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${server.base}/pkg/p/index.html`);
  await page.waitForFunction(() => (window as PlayerWindow).__elabora && document.querySelector('[data-block="accueil-polski"] p'));
  await page.evaluate(() => document.fonts.ready);
  // The fonts Chrome drew each text with (DevTools protocol): web fonts are custom fonts.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const drawnWith = async (selector: string) => {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    assert.ok(nodeId, selector);
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.map((font) => ({ family: font.familyName, custom: font.isCustomFont, glyphs: font.glyphCount }));
  };
  const body = await drawnWith('[data-block="accueil-polski"] p');
  assert.deepEqual(body.map((font) => [font.family, font.custom]), [['Lora', true]], `every letter of "${words}" from the embedded Lora: ${JSON.stringify(body)}`);
  assert.equal(body[0].glyphs, [...words].length);
  const title = await drawnWith('.t-screen-title');
  assert.ok(title.some((font) => font.family === 'Inter' && font.custom), JSON.stringify(title));
  assert.ok(title.some((font) => !font.custom), `Inter without latin-ext leaves Polish letters to another font: ${JSON.stringify(title)}`);
  // One face per file: latin-ext loaded for the upright text that uses it, never for italics.
  // Chrome gives ranges without leading zeros: latin-ext starts at U+100.
  const faces = await page.evaluate(() => [...document.fonts].filter((face) => face.family.replace(/"/g, '') === 'Lora')
    .map((face) => `${face.style} ${face.unicodeRange.startsWith('U+100-') ? 'latin-ext' : 'latin'} ${face.status}`).sort());
  assert.deepEqual(faces.filter((face) => face.includes('latin-ext')), ['italic latin-ext unloaded', 'normal latin-ext loaded']);
  const fetched = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name.split('/').pop()).filter((name) => name?.startsWith('lora-')).sort());
  assert.deepEqual(fetched, ['lora-latin-ext-wght-normal.woff2', 'lora-latin-wght-normal.woff2']);
  assert.deepEqual(errors, []);
});
