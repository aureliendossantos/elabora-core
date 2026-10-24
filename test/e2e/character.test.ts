import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import type { Page } from 'playwright-core';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { runtimeFiles } from '@elabora/node/bundles';
import { characterInline } from '@elabora/core/dialogue/character';
import type { DialogueSpeakerData } from '@elabora/player/dialogue/types';
import { ROOT } from '../helpers.ts';

// A dialogue's character in Chrome (docs/dialogues.md, characters; D61): @elabora/player character/
// mounts the sanitized SVG, sets the state on <g data-part="character">, shows the parts that match
// it (a mouth of the expression before the generic one), hides the blink's eyelids by default, plays
// a gesture again from its start and removes it after its duration, pauses and stops animations,
// frames the round avatar on data-portrait, and shows pictures by expression.

const marc = (): DialogueSpeakerData => {
  const drawn = characterInline(fs.readFileSync(path.join(ROOT, 'test/fixtures/characters/marc.svg'), 'utf8'), 'marc')!;
  return { name: 'Marc', look: { svg: 'assets/personnages/marc.svg', inline: drawn.inline, manifest: drawn.manifest } };
};
// No rule of its own: the player's rules alone make it work.
const bare = (): DialogueSpeakerData => ({
  name: 'Nina',
  look: { inline: characterInline('<svg viewBox="0 0 100 100" data-expressions="neutre ravie" data-gestures="lever:0.4"><g data-part="character"><circle data-expression="neutre" r="1"/><circle data-expression="ravie" r="2"/><g data-part="eyes-closed"><rect width="5" height="5"/></g><path data-mouth="closed" d="M0 0h1"/><path data-mouth="small" d="M0 0h2"/><path data-mouth="open" d="M0 0h3"/><path data-mouth="wide" d="M0 0h4"/><path data-mouth="open" data-expression="ravie" d="M0 0h5"/><rect data-gesture="lever" width="9" height="9"/></g></svg>', 'nina')!.inline }
});

async function page(run: (page: Page) => Promise<void>) {
  const bundle = await esbuild.build({ stdin: { contents: "import * as character from './index.ts'; window.ElaboraCharacter = character;", resolveDir: path.join(ROOT, 'packages/player/src/character'), sourcefile: 'entry.ts', loader: 'ts' }, bundle: true, format: 'iife', write: false, logLevel: 'error' });
  const css = (await runtimeFiles({ debug: true }))['elabora/player.css'];
  const browser = await launchBrowser('chromium');
  try {
    const tab = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await tab.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
    const errors: string[] = [];
    tab.on('pageerror', (error) => errors.push(error.message));
    await tab.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div id="scene" style="width:400px"></div><div id="avatar" style="width:64px;height:64px;border-radius:50%;overflow:hidden"></div></body></html>`);
    await tab.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await run(tab);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

// What each part shows: the visible parts (displayed) by their attributes.
const shown = (tab: Page, host: string) => tab.evaluate((selector) => {
  const group = document.querySelector(`${selector} [data-part="character"]`)!;
  return [...group.querySelectorAll('[data-mouth],[data-expression],[data-gesture]')]
    .filter((part) => getComputedStyle(part).display !== 'none' && (part.parentElement?.closest('[style*="display: none"]') ?? null) === null)
    .map((part) => ['data-expression', 'data-mouth', 'data-gesture'].map((name) => part.getAttribute(name) ?? '').join('/'));
}, host);

test('mountCharacter: the state on the character group, the parts that match it, gestures, pause, reduced motion, avatar and pictures', async () => {
  await page(async (tab) => {
    await tab.evaluate(([speaker, nina]) => {
      const w = window as unknown as { ElaboraCharacter: typeof import('../../packages/player/src/character/index.ts'); views: Record<string, unknown> };
      w.views = {
        marc: w.ElaboraCharacter.mountCharacter(document.getElementById('scene')!, speaker),
        avatar: w.ElaboraCharacter.mountCharacter(document.getElementById('avatar')!, speaker, { portrait: true }),
        nina: w.ElaboraCharacter.mountCharacter(document.body, nina)
      };
    }, [marc(), bare()] as const);
    type View = { set(state: Record<string, unknown>): void; gesture(name: string): void; dispose(): void; element: Element };
    const call = (name: string, method: 'set' | 'gesture' | 'dispose', arg?: unknown) => tab.evaluate(([n, m, a]) => { const view = (window as unknown as { views: Record<string, View> }).views[n as string]!; (view[m as 'set'] as (x: unknown) => void)(a); }, [name, method, arg] as const);

    // Mounted: the root keeps its class and drawing, the state is on the group.
    const group = () => tab.evaluate(() => { const g = document.querySelector('#scene [data-part="character"]')!; return Object.fromEntries([...g.attributes].map((a) => [a.name, a.value])); });
    assert.deepEqual(await group(), { 'data-part': 'character', 'data-expression': 'neutre', 'data-mouth': 'closed' });
    assert.equal(await tab.evaluate(() => document.querySelector('#scene > svg')!.getAttribute('class')), 't-character');
    assert.deepEqual(await shown(tab, '#scene'), ['neutre//', '/closed/'], 'the default expression and the generic closed mouth (neutre has none of its own), no gesture');
    await call('marc', 'set', { expression: 'inquiet' });
    assert.deepEqual(await shown(tab, '#scene'), ['inquiet//', 'inquiet/closed/'], 'an expression\'s own closed mouth before the generic one');

    // Speaking: the state's flags; a generic mouth when the expression has none of that shape.
    await call('marc', 'set', { speaking: true, talking: true, mouth: 'open', expression: 'inquiet' });
    assert.deepEqual(await group(), { 'data-part': 'character', 'data-expression': 'inquiet', 'data-mouth': 'open', 'data-speaking': '', 'data-talking': '' });
    assert.deepEqual(await shown(tab, '#scene'), ['inquiet//', '/open/']);
    // A mouth that names the expression wins over the generic one.
    await call('marc', 'set', { expression: 'souriant' });
    assert.deepEqual(await shown(tab, '#scene'), ['souriant//', 'souriant/open/']);
    await call('marc', 'set', { speaking: false, talking: false, listening: true, mouth: 'closed' });
    assert.deepEqual(Object.keys(await group()).sort(), ['data-expression', 'data-listening', 'data-mouth', 'data-part']);

    // A gesture: its parts show, it plays again from its start, it goes after its duration (1.2 s).
    await call('marc', 'gesture', 'saluer');
    assert.equal((await group())['data-gesture'], 'saluer');
    assert.ok((await shown(tab, '#scene')).includes('//saluer'));
    // Halfway through (the page's clock moves only as it paints: set by hand), then played again.
    const before = await tab.evaluate(() => { const arm = document.querySelector('#scene [data-part="arm-wave"]')!; const animation = arm.getAnimations()[0]!; animation.pause(); animation.currentTime = 600; return getComputedStyle(arm).transform; });
    await call('marc', 'gesture', 'saluer');
    const after = await tab.evaluate(() => getComputedStyle(document.querySelector('#scene [data-part="arm-wave"]')!).transform);
    assert.notEqual(after, before, 'replaying resets the visible arm pose');
    await call('marc', 'gesture', 'danser');
    assert.equal((await group())['data-gesture'], 'saluer', 'a gesture the character does not declare is not played');
    await tab.clock.runFor(1300);
    assert.equal(await tab.locator('#scene [data-part="character"]').getAttribute('data-gesture'), null);
    assert.ok(!(await shown(tab, '#scene')).includes('//saluer'));

    // Paused: every animation stops; the gesture's time stops with it.
    await call('marc', 'set', { paused: true });
    assert.equal(await tab.evaluate(() => getComputedStyle(document.querySelector('#scene [data-part="breath"]')!).animationPlayState), 'paused');
    await call('marc', 'gesture', 'saluer');
    await tab.clock.runFor(1500);
    assert.equal((await group())['data-gesture'], 'saluer', 'held while paused');
    await call('marc', 'set', { paused: false });
    await tab.clock.runFor(1300);
    assert.equal(await tab.locator('#scene [data-part="character"]').getAttribute('data-gesture'), null);
    // Reduced motion: nothing plays, the parts rest in their pose.
    await call('marc', 'set', { reducedMotion: true });
    assert.equal(await tab.evaluate(() => getComputedStyle(document.querySelector('#scene [data-part="breath"]')!).animationName), 'none');
    assert.equal(await tab.evaluate(() => getComputedStyle(document.querySelector('#scene [data-part="eyes-closed"]')!).opacity), '0');

    // The avatar: the same drawing framed on data-portrait.
    assert.deepEqual(await tab.evaluate(() => { const svg = document.querySelector('#avatar > svg')!; return [svg.getAttribute('viewBox'), svg.getAttribute('class'), svg.getAttribute('preserveAspectRatio')]; }), ['94 118 212 212', 't-character t-character-portrait', 'xMidYMid slice']);
    assert.equal(await tab.evaluate(() => document.querySelectorAll('svg [id], svg[id]').length), 0, 'two copies, no id');

    // Without a rule of its own: the eyelids hidden, the parts shown by the state alone.
    assert.equal(await tab.evaluate(() => getComputedStyle(document.querySelector('body > svg [data-part="eyes-closed"]')!).opacity), '0');
    await call('nina', 'set', { expression: 'ravie', mouth: 'open' });
    assert.deepEqual(await shown(tab, 'body > svg'), ['ravie//', 'ravie/open/']);
    await call('nina', 'set', { mouth: 'wide' });
    assert.deepEqual(await shown(tab, 'body > svg'), ['ravie//', '/wide/']);
    await call('nina', 'dispose');
    assert.equal(await tab.evaluate(() => document.querySelectorAll('body > svg').length), 0);

    // Pictures: the expression's, else the portrait.
    const src = await tab.evaluate(() => {
      const w = window as unknown as { ElaboraCharacter: typeof import('../../packages/player/src/character/index.ts') };
      const view = w.ElaboraCharacter.mountCharacter(document.body, { name: 'Paul', look: { portrait: 'assets/paul.png', expressions: { ravi: 'assets/paul-ravi.png' } } });
      const out = [view.element.querySelector('img')!.getAttribute('src')];
      view.set({ expression: 'ravi', speaking: true });
      out.push(view.element.querySelector('img')!.getAttribute('src'), view.element.getAttribute('data-speaking'));
      return out;
    });
    assert.deepEqual(src, ['assets/paul.png', 'assets/paul-ravi.png', '']);
  });
});
