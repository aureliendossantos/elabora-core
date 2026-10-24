import { test, type TestContext } from 'node:test';
import { resources } from '../resources.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { build } from '@elabora/node/build';
import { capture } from '@elabora/node/preview';
import { narrationWords } from '@elabora/core/narration/words';
import { narrationSidecarPath } from '@elabora/core/narration/narration';
import { ROOT, isClosed, readJSON, writeJSON } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';
import { narrate, hasFfmpeg } from '../narration.ts';

// The fine timeline in Chrome (docs/decisions.md D28): timed blocks whose effects follow the playhead
// (Web Animations set to the time), cues on words that fire only when playback crosses them,
// seek-timeline, screens timed in seconds without narration, stacks, theme effects, reduced motion,
// the bar's bubble and its shortcuts. Voices are sine tones; word times are written in the sidecars.

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const tmp = (t: TestContext, prefix: string) => resources(t).tempDir(prefix);
const SPEAKERS = [{ id: 'narratrice', name: 'Narratrice' }, { id: 'marc', name: 'Marc' }];
const L2 = "Ni l'imprimante, ni le partage de fichiers ne marchent.";

// Word times of a line, 0.3 s a word (written as an alignment would).
function alignedWords(dir: string, screen: string, line: string, text: string) {
  const sidecar = readJSON(dir, narrationSidecarPath('fr', screen, line));
  sidecar.words = narrationWords(text, 'fr').map((word, index) => ({ text: word.text, start: Math.round(index * 300) / 1000, end: Math.round(index * 300 + 280) / 1000 }));
  writeJSON(dir, narrationSidecarPath('fr', screen, line), sidecar);
}

function slides(dir: string) {
  const data = readJSON(dir, 'course.json');
  data.presentation = { mode: 'slides' };
  writeJSON(dir, 'course.json', data);
}

// "accueil" narrated in two steps: the ticket comes on « imprimante » and goes when Marc speaks; a
// cue on « partage »; « fichiers » jumps (seek-timeline) when the event asks.
function narratedCourse(t: TestContext) {
  const dir = resources(t).copyExample();
  slides(dir);
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[1].timing = { in: { at: { line: 'l2', word: 'imprimante' }, effect: 'rise', duration: 0.8 }, out: { at: { line: 'l3' }, effect: 'fade', duration: 0.4 } };
  screen.blocks[2].step = 2;
  screen.events = [{ id: 'partage-entendu', on: { type: 'timeline.reached', at: { line: 'l2', word: 'partage' } }, do: [{ type: 'increment-variable', variable: 'bonsReflexes', by: 1 }] }];
  writeJSON(dir, 'screens/accueil.json', screen);
  narrate(dir, 'accueil', [
    { id: 'l1', text: 'Bonjour, voici le ticket de Marc.', seconds: 2 },
    { id: 'l2', text: L2, seconds: 3 },
    { id: 'l3', step: 2, speaker: 'marc', text: 'Ça bloque toute la comptabilité !', seconds: 1.5 }
  ], { speakers: SPEAKERS });
  alignedWords(dir, 'accueil', 'l2', L2);
  return dir;
}

interface Session { page: Page; browser: Browser }

async function player(t: TestContext, dir: string, run: (session: Session) => Promise<void>, { reducedMotion = 'no-preference' as 'reduce' | 'no-preference' } = {}) {
  const b = await build(dir, { emit: 'dir', out: tmp(t, 'elabora-timeline-'), writeLock: false, debug: true });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  const server = resources(t).own(await startServer(), value => value.close());
  server.addPackage('p', b.dirPath);
  const browser = resources(t).own(await launchBrowser('chromium'), value => value.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => { (window as Window & { ELABORA_TEST?: unknown }).ELABORA_TEST = { virtualTime: true }; });
  await page.goto(`${server.base}/pkg/p/index.html`);
  await page.waitForFunction(() => (window as PlayerWindow).__elabora);
  await run({ page, browser });
  assert.deepEqual(errors, []);
}

const advance = (page: Page, seconds: number) => page.evaluate((s) => (window as PlayerWindow).__elabora.timeline.advance(s), seconds);
const seek = (page: Page, seconds: number) => page.evaluate((s) => (window as PlayerWindow).__elabora.timeline.seek(s), seconds);
// A block as the timeline shows it: hidden by its timing (before, after), out of reach, and its
// visible effect at that moment, without depending on the animation engine.
const blockAt = (page: Page, id: string) => page.evaluate((block) => {
  const node = document.querySelector<HTMLElement>(`[data-block="${block}"]`)!;
  return {
    timed: node.dataset.tTimed ?? null, inert: node.inert, visibility: getComputedStyle(node).visibility, opacity: Number(getComputedStyle(node).opacity),
    translate: getComputedStyle(node).translate, scale: getComputedStyle(node).scale,
    height: node.offsetHeight
  };
}, id);
const timeline = (page: Page) => page.evaluate(() => (window as PlayerWindow).__elabora.timeline.state()!);
const variable = (page: Page, name: string) => page.evaluate((id) => (window as PlayerWindow).__elabora.engine.getVar(id), name);

test('timed blocks follow the playhead: hidden in their place before and after, their effect set to the time, cues on words fire when crossed', { skip: NO_FFMPEG, timeout: 120000 }, async (t) => {
  await player(t, narratedCourse(t), async ({ page }) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    const words = await page.evaluate(() => (window as PlayerWindow).__elabora.engine.screens[0].narration!.lines[1].words!.map((word) => word[1]));
    const l2 = await page.evaluate(() => (window as PlayerWindow).__elabora.engine.screens[0].narration!.lines[1].start);
    const inAt = Math.round((l2 + 0.6) * 1000) / 1000;
    assert.equal(words[2], inAt, '« imprimante »: the third word of l2');
    let ticket = await blockAt(page, 'accueil-illustration');
    assert.deepEqual([ticket.timed, ticket.inert, ticket.visibility], ['before', true, 'hidden'], 'before its moment: hidden in its place, out of reach');
    const height = ticket.height;
    assert.ok(height > 50, 'its place is kept');
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    await advance(page, inAt + 0.4);
    ticket = await blockAt(page, 'accueil-illustration');
    assert.equal(ticket.timed, null);
    assert.equal(ticket.inert, false);
    assert.notEqual(ticket.translate, 'none', 'the block rises while appearing');
    assert.ok(ticket.opacity > 0.3 && ticket.opacity < 1, `halfway through its effect: ${ticket.opacity}`);
    assert.equal(ticket.height, height, 'nothing moves');
    // « partage » crossed: its cue fires once.
    await advance(page, 1.5);
    assert.equal(await variable(page, 'bonsReflexes'), 1);
    ticket = await blockAt(page, 'accueil-illustration');
    assert.deepEqual([ticket.timed, ticket.opacity, ticket.translate], [null, 1, 'none'], 'once in: fully visible at its final position');
    // A seek back before its moment hides it again and fires nothing; focus inside goes to the bar.
    await page.evaluate(() => { const node = document.querySelector<HTMLElement>('[data-block="accueil-illustration"]')!; node.tabIndex = -1; node.focus(); });
    await seek(page, inAt - 0.5);
    ticket = await blockAt(page, 'accueil-illustration');
    assert.equal(ticket.timed, 'before');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('t-timeline-seek')), true, 'the focus went to the seek bar');
    assert.equal(await variable(page, 'bonsReflexes'), 1, 'a seek crosses nothing');
    // Playing the passage again crosses « partage » again.
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    await advance(page, 10);
    let state = await timeline(page);
    assert.equal(await variable(page, 'bonsReflexes'), 2);
    assert.equal(state.playing, false, 'stopped at the end of step 1');
    assert.equal((await blockAt(page, 'accueil-illustration')).timed, null, 'still there: it goes when Marc speaks, in step 2');
    // Step 2: it leaves as l3 starts.
    await page.click('.t-continue--slot .t-continue-btn');
    await advance(page, 0.6);
    ticket = await blockAt(page, 'accueil-illustration');
    assert.ok(ticket.opacity > 0 && ticket.opacity < 1, 'fading out as l3 starts, after its pause');
    await advance(page, 0.4);
    ticket = await blockAt(page, 'accueil-illustration');
    assert.equal(ticket.timed, 'after');
    state = await timeline(page);
    assert.equal(state.line, 'l3');
  });
});

test('dragging the playhead: the screen follows, a tooltip quotes the words, playback goes on where it is let go', { skip: NO_FFMPEG, timeout: 120000 }, async (t) => {
  const dir = narratedCourse(t);
  const course = readJSON(dir, 'course.json');
  course.narration = { advance: 'learner', seek: 'free' };
  writeJSON(dir, 'course.json', course);
  await player(t, dir, async ({ page }) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    await advance(page, 0.5);
    const box = (await page.locator('.t-timeline-track').boundingBox())!;
    const duration = (await timeline(page)).duration;
    const l2 = await page.evaluate(() => (window as PlayerWindow).__elabora.engine.screens[0].narration!.lines[1].start);
    const x = (time: number) => box.x + (box.width * time) / duration;
    await page.mouse.move(x(0.5), box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x(l2 + 1.25), box.y + box.height / 2, { steps: 4 });
    const during = await page.evaluate(() => ({ state: (window as PlayerWindow).__elabora.timeline.state()! }));
    // The player's one tooltip quotes what is said there, with its speaker, never the time (Lin 27, D58).
    const bubble = await page.evaluate(() => { const node = document.querySelector<HTMLElement>('.t-tip')!; return { hidden: node.hidden, text: node.textContent }; });
    assert.equal(during.state.playing, false, 'held while dragged');
    assert.equal(during.state.dragging, true);
    assert.equal(bubble.hidden, false);
    assert.match(bubble.text ?? '', /^Narratrice : « …imprimante, ni le partage de… »$/, bubble.text ?? '');
    assert.equal((await blockAt(page, 'accueil-illustration')).timed, null, 'the screen follows: the ticket is there');
    await page.mouse.up();
    const after = await timeline(page);
    assert.equal(after.playing, true, 'playback goes on from there');
    assert.equal(await isClosed(page.locator('.t-tip')), true);
    // The shortcuts: Shift+? on the bar, Escape closes them.
    await page.focus('.t-timeline-seek');
    await page.keyboard.press('Shift+?');
    assert.equal(await page.locator('.t-timeline-keys').isVisible(), true);
    assert.match(await page.locator('.t-timeline-keys').innerText(), /Ctrl\+Alt\+P[\s\S]*Lecture ou pause/);
    await page.keyboard.press('Escape');
    assert.equal(await isClosed(page.locator('.t-timeline-keys')), true);
  });
});

test('a screen timed in seconds, without narration: a silent timeline, its cues, seek-timeline crossing nothing, a stack whose contents follow one another', { skip: NO_FFMPEG, timeout: 120000 }, async (t) => {
  const dir = resources(t).copyExample();
  slides(dir);
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[1].timing = { in: { at: { seconds: 1 }, effect: 'zoom' } };
  screen.blocks.push({ id: 'accueil-pile', type: 'stack', props: { transition: 'crossfade' }, blocks: [
    { id: 'pile-1', type: 'text', props: { markdown: 'Imprimante hors ligne.' } },
    { id: 'pile-2', type: 'text', props: { markdown: 'Accès refusé au partage de fichiers, sur deux lignes de texte pour être plus haut que le premier contenu de la pile.' }, timing: { in: { at: { seconds: 2 } } } },
    { id: 'pile-3', type: 'text', props: { markdown: 'Schéma du deuxième étage.' }, timing: { in: { at: { seconds: 3 } } } }
  ] });
  screen.events = [
    { id: 'repere', on: { type: 'timeline.reached', at: { seconds: 1.5 } }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] },
    { id: 'saut', on: { type: 'timeline.reached', at: { seconds: 0.5 } }, if: [{ variable: 'bonsReflexes', op: 'eq', value: 0 }], do: [{ type: 'increment-variable', variable: 'bonsReflexes', by: 1 }, { type: 'seek-timeline', to: { seconds: 2.2 } }] }
  ];
  writeJSON(dir, 'screens/accueil.json', screen);
  await player(t, dir, async ({ page }) => {
    const bar = await page.evaluate(() => ({
      bar: !!document.querySelector('.t-timeline'), captions: document.querySelector<HTMLElement>('.t-timeline-captions')!.hidden, audio: !!document.querySelector('.t-timeline-audio'),
      duration: (window as PlayerWindow).__elabora.timeline.state()!.duration
    }));
    assert.deepEqual(bar, { bar: true, captions: true, audio: false, duration: 3.4 }, 'a bar without captions: no voice');
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    const heights = new Set<number>();
    heights.add((await blockAt(page, 'accueil-pile')).height);
    assert.deepEqual([(await blockAt(page, 'pile-1')).timed, (await blockAt(page, 'pile-2')).timed], [null, 'before']);
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    await advance(page, 0.5);
    // The cue at 0.5 s jumped to 2.2 s: the cue at 1.5 s was not crossed.
    let state = await timeline(page);
    assert.ok(Math.abs(state.time - 2.2) < 0.06, String(state.time));
    assert.equal(state.playing, true);
    assert.equal(await variable(page, 'indiceVu'), false);
    assert.equal((await blockAt(page, 'accueil-illustration')).timed, null, 'the screen as it is at 2.2 s');
    const second = await blockAt(page, 'pile-2');
    assert.equal(second.timed, null);
    assert.ok(second.opacity > 0 && second.opacity < 1, 'crossfading in');
    const first = await blockAt(page, 'pile-1');
    assert.ok(first.opacity > 0 && first.opacity < 1, 'the first content fades out as the second comes');
    heights.add((await blockAt(page, 'accueil-pile')).height);
    await advance(page, 2);
    assert.deepEqual([(await blockAt(page, 'pile-1')).timed, (await blockAt(page, 'pile-2')).timed, (await blockAt(page, 'pile-3')).timed], ['after', 'after', null]);
    heights.add((await blockAt(page, 'accueil-pile')).height);
    assert.equal(heights.size, 1, 'the stack keeps the size of its largest content');
    state = await timeline(page);
    assert.equal(state.time, 3.4);
    assert.equal(await page.evaluate(() => (window as PlayerWindow).__elabora.engine.screenComplete((window as PlayerWindow).__elabora.engine.screens[0])), true, 'seen to its end');
    // Played again from the start: 1.5 s is crossed this time (the jump only once).
    await seek(page, 0);
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    await advance(page, 2);
    assert.equal(await variable(page, 'indiceVu'), true);
  });
});

test('draw traces an inline SVG: the hatching of one path grows line by line, the drawing whole once drawn', { timeout: 120000 }, async (t) => {
  const dir = resources(t).copyExample();
  slides(dir);
  // An engraving's hatching is one path of many short lines: drawn with its whole length as the dash,
  // every line showed at once; each line now grows from its start, as long as the longest (100).
  fs.writeFileSync(path.join(dir, 'assets/images/gravure.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><path class="hachures" d="M0 10h10M0 20h20m-20 10h100" fill="none" stroke="black"/><circle cx="150" cy="50" r="20" fill="none" stroke="black"/></svg>');
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push({ id: 'accueil-gravure', type: 'image', props: { asset: 'images/gravure.svg', alt: 'Une gravure', inline: true }, timing: { in: { at: { seconds: 0.5 }, effect: 'draw', duration: 1 } } });
  writeJSON(dir, 'screens/accueil.json', screen);
  await player(t, dir, async ({ page }) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.ready());
    const strokes = () => page.evaluate(() => [...document.querySelectorAll<SVGElement>('[data-block="accueil-gravure"] path, [data-block="accueil-gravure"] circle')].map((shape) => ({ dash: getComputedStyle(shape).strokeDasharray, offset: parseFloat(getComputedStyle(shape).strokeDashoffset) })));
    const named = await page.evaluate(() => { const svg = document.querySelector('[data-block="accueil-gravure"] svg')!; return [svg.getAttribute('role'), svg.getAttribute('aria-label')]; });
    assert.deepEqual(named, ['img', 'Une gravure']);
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    await advance(page, 1);
    const [hatching, circle] = await strokes();
    assert.equal(hatching.dash, '100px', 'the longest line of the hatching, not the path\'s 130');
    assert.ok(hatching.offset > 0 && hatching.offset < 100, String(hatching.offset));
    assert.ok(Math.abs(parseFloat(circle.dash) - 2 * Math.PI * 20) < 1.5, circle.dash);
    await advance(page, 1);
    assert.deepEqual((await strokes()).map((stroke) => stroke.offset), [0, 0], 'drawn: every stroke is whole');
  });
});

test('theme effects play the theme\'s keyframes; under reduced motion every effect is a short fade at the same time', { skip: NO_FFMPEG, timeout: 120000 }, async (t) => {
  const dir = narratedCourse(t);
  const course = readJSON(dir, 'course.json');
  course.theme.effects = { pop: 'Grows a little past its size, then settles' };
  course.theme.stylesheet = 'theme/theme.css';
  writeJSON(dir, 'course.json', course);
  fs.mkdirSync(path.join(dir, 'theme'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme/theme.css'), '@keyframes t-fx-pop { from { opacity: 0; scale: 0.6; } 70% { scale: 1.08; } to { opacity: 1; scale: 1; } }\n');
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[1].timing.in.effect = 'pop';
  writeJSON(dir, 'screens/accueil.json', screen);
  const inAt = async (page: Page) => (await page.evaluate(() => (window as PlayerWindow).__elabora.engine.screens[0].narration!.lines[1].start)) + 0.6;
  await player(t, dir, async ({ page }) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    await advance(page, (await inAt(page)) + 0.2);
    const ticket = await blockAt(page, 'accueil-illustration');
    assert.ok(ticket.opacity > 0 && ticket.opacity < 1, 'the custom effect fades in');
    assert.ok(Number(ticket.scale) > 0.6 && Number(ticket.scale) < 1.08, 'the custom effect grows');
    await advance(page, 0.36);
    assert.ok(Number((await blockAt(page, 'accueil-illustration')).scale) > 1, 'it overshoots before settling');
    await advance(page, 0.25);
    assert.deepEqual([(await blockAt(page, 'accueil-illustration')).opacity, (await blockAt(page, 'accueil-illustration')).scale], [1, 'none']);
  });
  await player(t, dir, async ({ page }) => {
    await page.evaluate(() => (window as PlayerWindow).__elabora.timeline.play());
    const at = await inAt(page);
    await advance(page, at + 0.1);
    const ticket = await blockAt(page, 'accueil-illustration');
    assert.ok(ticket.opacity > 0 && ticket.opacity < 1, 'a fade');
    assert.equal(ticket.scale, 'none', 'reduced motion does not grow the block');
    assert.equal(ticket.timed, null, 'at the same time');
    await advance(page, 0.15);
    assert.equal((await blockAt(page, 'accueil-illustration')).opacity, 1, 'fully visible after the short fade');
  }, { reducedMotion: 'reduce' });
});

test('captures at a word, at seconds and at a step\'s end', { skip: NO_FFMPEG, timeout: 120000 }, async (t) => {
  const dir = narratedCourse(t);
  const result = await capture(dir, [{ screen: 'accueil', at: ['l2:imprimante+0.9s', 'step1:end', 'l3'], width: 1280, height: 720 }]);
  assert.ok(result.ok, JSON.stringify(result));
  const shot = result.shots![0];
  assert.ok(shot.ok && shot.frames?.length === 3 && shot.frames.map((frame) => frame.label).join(' | ') === 'l2:imprimante+0.9s | step1:end | l3', JSON.stringify(shot.ok ? shot.frames?.map((frame) => frame.label) : shot));
  const missing = await capture(dir, [{ screen: 'accueil', at: ['l2:copieur'] }]);
  const failed = missing.ok ? null : missing.shots?.[0];
  assert.match(failed && !failed.ok ? failed.error : '', /does not say "copieur"/);
});

test('elabora look --sheet: one capture per mark of the timeline, captioned with the anchor and what happens', { skip: NO_FFMPEG, timeout: 120000 }, async (t) => {
  const { startLooker } = await import('@elabora/node/look');
  const dir = narratedCourse(t);
  const looker = resources(t).own(await startLooker(dir, { live: false }), value => value.close());
  const result = await looker.look({ screen: 'accueil', sheet: true, width: 1280, height: 720 });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.type, 'png');
  assert.deepEqual([...result.image.subarray(1, 4)].map((byte) => String.fromCharCode(byte)).join(''), 'PNG');
  const labels = result.marks!.map((mark) => mark.label);
  assert.match(labels[0], /^0:00\.0 · start$/);
  assert.ok(labels.some((label) => /l2 « imprimante » · accueil-illustration comes \(rise\)/.test(label)), labels.join('\n'));
  assert.ok(labels.some((label) => /l2 « partage » · partage-entendu fires/.test(label)), labels.join('\n'));
  assert.ok(labels.some((label) => /l3 · accueil-illustration goes \(fade\)/.test(label)), labels.join('\n'));
  assert.ok(labels.some((label) => /end of step 2/.test(label)), labels.join('\n'));
  for (let i = 1; i < result.marks!.length; i++) assert.ok(result.marks![i].time >= result.marks![i - 1].time, 'in time order');
  const plain = await looker.look({ screen: 'premier-reflexe', sheet: true });
  assert.ok(!plain.ok && /has no timeline/.test(plain.error));
});

test('the editor\'s canvas: the playhead posted by the app moves the timed blocks, their state in the layout; ghost fades the steps after the first', { skip: NO_FFMPEG, timeout: 120000 }, async (t) => {
  const { startCanvasHost } = await import('@elabora/node/canvas/host');
  const { loadProjectFromDir } = await import('@elabora/node/project-reader');
  const { renderScreen } = await import('@elabora/core/render/screen');
  const { screenTimeline, blockTimings } = await import('@elabora/core/narration/timeline');
  type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: import('@elabora/player/canvas').CanvasApi };
  const dir = narratedCourse(t);
  const project = loadProjectFromDir(dir);
  const coming = blockTimings(screenTimeline(project, 'accueil')!).get('accueil-illustration')!.in!;
  const host = resources(t).own(await startCanvasHost({ root: dir }), value => value.close());
  const browser = resources(t).own(await launchBrowser('chromium'), value => value.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.setContent(`<iframe src="${host.url}" style="width: 1280px; height: 720px; border: 0"></iframe>`);
  const frame = await (await page.waitForSelector('iframe')).contentFrame();
  await frame!.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
  host.push(renderScreen(project, 'accueil', {}), { id: 1 });
  await frame!.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas.layout().id === 1);
  // The app posts the playhead itself while the author drags it.
  const post = (view: Record<string, unknown>, id: number) => page.evaluate(({ view: sent, id: sentId, token }) => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'elabora/view', id: sentId, token, view: sent }, '*'), { view, id, token: host.token });
  const blockAt = async (id: number) => {
    await frame!.waitForFunction((wanted) => (window as CanvasWindow).__elaboraCanvas.layout().id === wanted, id);
    return frame!.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout().blocks.find((block) => block.id === 'accueil-illustration')!);
  };
  await post({ at: { time: coming.at + 0.4 } }, 2);
  let block = await blockAt(2);
  assert.deepEqual([block.timed?.state, block.timed?.progress, block.hidden], ['entering', 0.5, false]);
  await post({ at: { time: 0.5 } }, 3);
  block = await blockAt(3);
  assert.deepEqual([block.timed?.state, block.hidden], ['before', true], 'not there yet: hidden in its place');
  await post({ at: { time: coming.at + 2 } }, 4);
  assert.equal((await blockAt(4)).timed?.state, 'shown');
  // Ghost: every step, those after the first faded in their place.
  await post({ at: null, step: null, ghost: true }, 5);
  await blockAt(5);
  const faded = () => frame!.evaluate(() => [...document.querySelectorAll<HTMLElement>('#t-main .t-block[data-block]')].map((node) => [node.dataset.block, node.hasAttribute('data-t-ghost'), getComputedStyle(node).opacity]));
  const ghosts = await faded();
  assert.deepEqual(ghosts.filter(([, ghost]) => ghost).map(([id, , opacity]) => [id, opacity]), [['accueil-objectifs', '0.42']]);
  await post({ ghost: false }, 6);
  await blockAt(6);
  assert.ok((await faded()).every(([, ghost]) => !ghost));
  assert.equal(renderScreen(project, 'accueil', { ghost: true }).view.ghost, true);
});

test('the editor\'s canvas renders a timed screen again as the first time: a block edited keeps the timed blocks where the view puts them', { timeout: 120000 }, async (t) => {
  const { startCanvasHost } = await import('@elabora/node/canvas/host');
  const { loadProjectFromDir } = await import('@elabora/node/project-reader');
  const { renderScreen } = await import('@elabora/core/render/screen');
  type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: import('@elabora/player/canvas').CanvasApi };
  // The example: on « accueil » the ticket comes on « impression », the aims on « trajet ».
  const dir = resources(t).copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const host = resources(t).own(await startCanvasHost({ root: dir }), value => value.close());
  const browser = resources(t).own(await launchBrowser('chromium'), value => value.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(host.url);
  await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
  const states = async (id: number) => {
    await page.waitForFunction((wanted) => (window as CanvasWindow).__elaboraCanvas.layout().id === wanted, id);
    return page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout().blocks.filter((block) => block.timed).map((block) => [block.id, block.timed!.state, block.hidden]));
  };
  host.push(renderScreen(loadProjectFromDir(dir), 'accueil', { fields: true }), { id: 1 });
  const first = await states(1);
  assert.deepEqual(first, [['accueil-illustration', 'shown', false], ['accueil-objectifs', 'shown', false]]);
  // The callout edited: the screen rendered again, the same view.
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks[2].props.title = 'Dans ce module, en bref';
  writeJSON(dir, 'screens/accueil.json', screen);
  host.push(renderScreen(loadProjectFromDir(dir), 'accueil', { fields: true }), { id: 2 });
  assert.deepEqual(await states(2), first);
  // At a moment of the playhead, rendered again: still that moment.
  host.push(renderScreen(loadProjectFromDir(dir), 'accueil', { fields: true, at: { time: 1 } }), { id: 3 });
  const early = await states(3);
  assert.deepEqual(early.map(([, state]) => state), ['before', 'before']);
  host.push(renderScreen(loadProjectFromDir(dir), 'accueil', { fields: true, at: { time: 1 } }), { id: 4 });
  assert.deepEqual(await states(4), early);
});

test('the editor\'s canvas: the contents of a stack share one place, the size of the largest, at any moment and at a phone\'s width', { timeout: 120000 }, async (t) => {
  const { startCanvasHost } = await import('@elabora/node/canvas/host');
  const { loadProjectFromDir } = await import('@elabora/node/project-reader');
  const { renderScreen } = await import('@elabora/core/render/screen');
  type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: import('@elabora/player/canvas').CanvasApi };
  const dir = resources(t).copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const host = resources(t).own(await startCanvasHost({ root: dir }), value => value.close());
  const browser = resources(t).own(await launchBrowser('chromium'), value => value.close());
  for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 812 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(host.url);
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
    let id = 0;
    const rects = async (at?: { time: number }) => {
      id += 1;
      host.push(renderScreen(loadProjectFromDir(dir), 'chemin', { fields: true, ...(at ? { at } : {}) }), { id });
      await page.waitForFunction((wanted) => (window as CanvasWindow).__elaboraCanvas.layout().id === wanted, id);
      return page.evaluate(() => {
        const blocks = (window as CanvasWindow).__elaboraCanvas.layout().blocks;
        const rect = (name: string) => blocks.find((block) => block.id === name)!.rect;
        return { floor: rect('chemin-etage'), servers: rect('chemin-serveurs'), stack: rect('chemin-reseaux-pile') };
      });
    };
    // The stack's contents come one after the other (0:02.8, 0:07.5): before, between, after and at the end.
    const heights = new Set<number>();
    for (const at of [{ time: 1 }, { time: 5 }, { time: 10 }, undefined]) {
      const { floor, servers, stack } = await rects(at);
      const label = `${viewport.width} px at ${at ? at.time : 'the end'}`;
      assert.equal(floor.y, servers.y, `the contents start at the same height (${label})`);
      assert.equal(floor.x, servers.x, `the contents start at the same left (${label})`);
      assert.ok(stack.height >= Math.max(floor.height, servers.height) - 1, `the stack is the size of the largest (${label})`);
      assert.ok(Math.abs(stack.y - floor.y) < 2, `the content is at the stack's top (${label})`);
      heights.add(Math.round(stack.height));
    }
    assert.equal(heights.size, 1, `the stack never changes size (${viewport.width} px)`);
    await page.close();
  }
});
