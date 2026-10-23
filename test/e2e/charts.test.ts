import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { narrate, hasFfmpeg } from '../narration.ts';

// Charts in Chrome (D60): the entrance settles on the markup the build wrote, the pointer and the keys
// point at items softly, a trend in predict mode is drawn, revealed, kept and resumed, and narrated
// charts follow the voice (items at their beat, the others stepping back).

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const bars = { takeaway: 'Presque tout commence par la messagerie', highlight: 'mail', unit: '%', rows: [{ id: 'web', label: 'Sites piégés', value: 18 }, { id: 'mail', label: 'Messagerie', value: 62, note: 'Surtout de fausses factures' }, { id: 'usb', label: 'Clés USB', value: 6 }] };
const months = [{ x: 'janv.', y: 32 }, { x: 'mars', y: 27 }, { x: 'mai', y: 21 }, { x: 'juil.', y: 14 }, { x: 'sept.', y: 9 }, { x: 'nov.', y: 5 }];

function chartsCourse(): string {
  const dir = copyExample();
  // Free navigation: the tests go straight to the screens of the charts.
  const course = readJSON(dir, 'course.json');
  course.navigation = { mode: 'free', lockUntilComplete: false };
  writeJSON(dir, 'course.json', course);
  const chemin = readJSON(dir, 'screens/chemin.json');
  chemin.blocks.unshift(
    { id: 'origine', type: 'bars', props: bars },
    { id: 'reflexe', type: 'diagram', props: { takeaway: 'Survoler avant de cliquer', mermaid: 'flowchart LR\n  A[Un e-mail arrive] --> B{Un lien ?}\n  B -- oui --> C[Survoler le lien]\n  B -- non --> D[Lire la suite]', highlight: 'C' } }
  );
  writeJSON(dir, 'screens/chemin.json', chemin);
  const reflexe = readJSON(dir, 'screens/premier-reflexe.json');
  reflexe.blocks.push({ id: 'clics', type: 'trend', props: { takeaway: 'Les clics fondent en un an', unit: '%', mode: 'predict', points: months, predict: { from: 'mai' } } });
  writeJSON(dir, 'screens/premier-reflexe.json', reflexe);
  return dir;
}

async function player(dir: string, run: (page: Page) => Promise<void>, { motion = true, virtual = false }: { motion?: boolean; virtual?: boolean } = {}) {
  const b = await build(dir, { emit: 'dir', out: tmp('elabora-charts-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = await startServer();
  server.addPackage('p', b.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: motion ? 'no-preference' : 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (virtual) await page.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
    await page.goto(`${server.base}/pkg/p/index.html`);
    await page.waitForFunction(() => (window as PlayerWindow).__elabora);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
}
const go = (page: Page, screen: string) => page.evaluate((id) => (window as PlayerWindow).__elabora.go(id), screen);
const opacity = (page: Page, selector: string) => page.$eval(selector, (element) => Number(getComputedStyle(element).opacity));

test('charts: the entrance settles on the markup; the pointer and the keys point softly at the nearest item', { timeout: 180000 }, async () => {
  await player(chartsCourse(), async (page) => {
    await go(page, 'chemin');
    const chart = page.locator('.t-block[data-block="origine"] .t-chart');
    // Played once, then at rest: no inline style left on its items, the highlight's colour pulled.
    await page.waitForFunction(() => {
      const root = document.querySelector('.t-block[data-block="origine"] .t-chart');
      return !!root && root.classList.contains('is-pulled') && !root.classList.contains('is-entering');
    }, null, { timeout: 10000 });
    const styles = await chart.locator('[data-t-item]').evaluateAll((elements) => elements.map((element) => element.getAttribute('style') ?? ''));
    assert.ok(styles.every((style) => !/opacity|translate|scale/.test(style)), JSON.stringify(styles));
    assert.equal(await chart.locator('.t-bars-value').first().textContent(), '62 %', 'the count lands on the written value');
    // The pointer: the nearest row stands, the others step back to 40 % (soothing, no bounce).
    await chart.locator('.t-bars-track[data-t-item="usb"]').hover();
    assert.equal(await chart.getAttribute('class').then((value) => value?.includes('is-focused')), true);
    await page.waitForFunction(() => {
      const label = document.querySelector('.t-block[data-block="origine"] .t-bars-label[data-t-item="web"]');
      return !!label && Math.abs(Number(getComputedStyle(label).opacity) - 0.4) < 0.02;
    }, null, { timeout: 5000 });
    assert.equal(await opacity(page, '.t-block[data-block="origine"] .t-bars-label[data-t-item="usb"]'), 1);
    // A row with a note shows it in the bubble.
    await chart.locator('.t-bars-track[data-t-item="mail"]').hover();
    await page.waitForFunction(() => document.querySelector('.t-block[data-block="origine"] .t-chart-tip.is-on')?.textContent === 'Surtout de fausses factures');
    await page.mouse.move(5, 5);
    // The keys: the arrows walk the rows and say each one.
    await chart.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await chart.locator('.t-sr-only[aria-live]').textContent(), 'Messagerie: 62\u00a0%, Surtout de fausses factures');
    // The diagram: pointing at a node lights the path that leads to it.
    const diagram = page.locator('.t-block[data-block="reflexe"] .t-chart');
    await diagram.locator('.t-diagram-wide [data-t-item="C"]').hover();
    await page.waitForTimeout(300);
    const lit = await diagram.locator('.t-diagram-wide .is-lit').evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.tItem ?? (element as HTMLElement).dataset.id));
    assert.deepEqual([...new Set(lit)].sort(), ['A', 'B', 'C', 'L_A_B_0', 'L_B_C_0'].sort());
  });
});

test('predict, then reveal: the learner draws or sets the end, the real line comes, the guess is kept and resumed', { timeout: 180000 }, async () => {
  await player(chartsCourse(), async (page) => {
    await go(page, 'premier-reflexe');
    const chart = page.locator('.t-block[data-block="clics"] .t-chart');
    await chart.scrollIntoViewIfNeeded();
    const button = chart.locator('.t-trend-reveal');
    assert.equal(await button.textContent(), 'Voir les vrais chiffres', 'the player\'s words in the course language');
    assert.equal(await button.isDisabled(), true, 'nothing drawn yet');
    // The pointer draws July to November.
    const zone = (await chart.locator('.t-trend-zone').boundingBox())!;
    await page.mouse.move(zone.x + 8, zone.y + zone.height * 0.4);
    await page.mouse.down();
    for (let k = 0; k <= 10; k++) await page.mouse.move(zone.x + 8 + (zone.width - 16) * (k / 10), zone.y + zone.height * 0.4);
    await page.mouse.up();
    assert.equal(await button.isDisabled(), false, 'every year drawn');
    assert.match(await chart.locator('.t-trend-guess').getAttribute('d') ?? '', /^M\d/);
    // The slider (keys, screen readers) sets the end; the years between follow.
    await chart.locator('.t-trend-range').fill('10');
    assert.match(await chart.locator('.t-trend-guess-label').textContent() ?? '', /Votre estimation · 10 %/);
    await button.click();
    await page.waitForFunction(() => document.querySelector('.t-block[data-block="clics"] .t-trend-feedback')?.textContent !== '', null, { timeout: 5000 });
    assert.equal(await chart.locator('.t-trend-feedback').textContent(), 'Vous aviez dit 10 % ; c’était 5 %.');
    assert.equal(await button.isHidden(), true);
    assert.match(await page.evaluate(() => (window as PlayerWindow).__elabora.state().suspendData), /"n":\{"\w+":"10\|1"\}/, 'kept like a numeric answer');
    // Back on the screen: shown revealed, with its feedback.
    await go(page, 'chemin');
    await go(page, 'premier-reflexe');
    const again = page.locator('.t-block[data-block="clics"] .t-chart');
    assert.equal(await again.getAttribute('class').then((value) => value?.includes('is-revealed')), true);
    assert.equal(await again.locator('.t-trend-feedback').textContent(), 'Vous aviez dit 10 % ; c’était 5 %.');
  });
});

test('with a voice: each item comes at its word and takes the spotlight, the others step back, then the highlight takes the colour', { skip: NO_FFMPEG, timeout: 180000 }, async () => {
  const dir = chartsCourse();
  const chemin = readJSON(dir, 'screens/chemin.json');
  chemin.blocks.find((block: { id: string }) => block.id === 'origine').props.rows = bars.rows.map((row) => (row.id === 'mail' ? { ...row, at: { line: 'l1', word: 'messagerie' } } : row.id === 'web' ? { ...row, at: { line: 'l1', word: 'sites' } } : row));
  writeJSON(dir, 'screens/chemin.json', chemin);
  narrate(dir, 'chemin', [
    { id: 'l1', text: 'Presque tout commence par la messagerie, loin devant les sites piégés.', seconds: 6 },
    { id: 'l2', text: 'Le reste compte peu.', seconds: 3 }
  ], { seek: 'free' });
  await player(dir, async (page) => {
    await go(page, 'chemin');
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    const beats = await page.evaluate(() => {
      const screen = (window as PlayerWindow).__elabora.engine.screens.find((candidate) => candidate.id === 'chemin') as unknown as { blocks: { id: string; props: { beats: Record<string, number> } }[] };
      return screen.blocks.find((block) => block.id === 'origine')!.props.beats;
    });
    assert.ok(beats.mail > 0 && beats.web > beats.mail, JSON.stringify(beats));
    // A seek jumps: what comes or goes fades in 220 ms (fades stay when less motion is asked).
    const seek = async (time: number) => { await page.evaluate((t) => (window as PlayerWindow).__elabora.timeline.seek(t), time); await page.waitForTimeout(350); };
    const label = (id: string) => opacity(page, `.t-block[data-block="origine"] .t-bars-label[data-t-item="${id}"]`);
    const classes = () => page.$eval('.t-block[data-block="origine"] .t-chart', (element) => element.className);
    await seek(0);
    assert.equal(await label('mail'), 0, 'not said yet');
    await seek(beats.mail + 0.1);
    assert.equal(await label('mail'), 1, 'at its word, at once (less motion asked)');
    assert.equal(await label('web'), 0);
    assert.match(await classes(), /is-spotlit/);
    assert.equal(await page.$eval('.t-block[data-block="origine"] .t-bars-track[data-t-item="mail"]', (element) => element.classList.contains('is-spoken')), true);
    await seek(beats.web + 0.1);
    assert.equal(await page.$eval('.t-block[data-block="origine"] .t-bars-track[data-t-item="web"]', (element) => element.classList.contains('is-spoken')), true);
    // Once the voice is done with the chart, every row stands and the highlight takes the colour.
    await seek(8.5);
    assert.doesNotMatch(await classes(), /is-spotlit/);
    assert.match(await classes(), /is-pulled/);
    // Seeking back hides what had not come yet.
    await seek(0.2);
    assert.equal(await label('web'), 0);
  }, { motion: false, virtual: true });
});
