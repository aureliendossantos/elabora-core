import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Browser, Page } from 'playwright-core';
import type { Block, Diagnostic, Screen } from '@elabora/format';
import { getRegistry } from '@elabora/core/components/registry';
import { build } from './build.ts';
import { startServer } from './emulator/server.ts';
import { browserIdentity, launchMotionBrowsers } from './emulator/browser.ts';
import type { BrowserIdentity } from './emulator/electron.ts';
import type { ReadyReport } from './emulator/page-globals.ts';
import { loadProjectFromDir } from './project-reader.ts';
import { errorMessage, fieldOf } from './util/values.ts';
import { lineAnchor } from '@elabora/core/narration/narration';
import { resolveAt } from '@elabora/core/narration/anchor-text';
import type { Project } from '@elabora/core/project/model';
import { scrollFilmstrip, scrollStops } from './scroll-strip.ts';
import { packageFolder, openAllScreens } from './package-folder.ts';

// One capture: a screen at a window size, in a state.
export interface Shot {
  screen?: string; // default: the first screen
  width?: number; // default 1600
  height?: number; // default 900
  step?: number; // steps revealed up to this one (default: all, the complete view)
  layer?: string; // a layer opened
  // 'answered': every activity shows its tallest outcome and concealed blocks are shown (the slide
  // once everything is answered: what must not move or overflow)
  state?: string;
  // A filmstrip on one contact sheet: frames at these times (ms) with animations on, and, on a
  // narrated screen, as it is when these lines start ("l2") or end ("l2:end"), captions shown.
  at?: (number | string)[];
  // A filmstrip down the page: the window scrolled to each position (px from the top, or "40%" of
  // the scrollable length), animations on, on one contact sheet: scroll-driven animations and
  // objects that follow the scroll (host.onView). Takes precedence over at.
  scroll?: (number | string)[];
  motion?: boolean; // animations on (default off: reduced motion, so steps and transitions are settled)
  // With at: the passage from this screen to the one shot. The page shows it first, then goes to the
  // screen; the times count from that move (continuity, D65; the backdrop; the screen's entrances).
  from?: string;
  fullPage?: boolean; // default true (not with a layer)
}

export interface ShotFrame {
  ms: number;
  png: Buffer;
  label?: string; // caption on the contact sheet (default: the time)
}

export type ShotSuccess = {
  ok: true;
  screen: string;
  width: number;
  height: number;
  state: string;
  objects: ReadyReport['objects'];
  answered?: (string | undefined)[]; // the blocks shown answered
  png: Buffer; // the screen, or the contact sheet of a filmstrip
  consoleErrors: string[];
  browser?: BrowserIdentity;
  scroll?: number[]; // px from the top of each frame of a scroll filmstrip
} & ({ at?: undefined; frames?: undefined } | { at: number[]; frames: ShotFrame[] });

export type ShotResult = ShotSuccess | { ok: false; error: string; diagnostics?: undefined };

export type CaptureResult =
  | { ok: boolean; shots: ShotResult[]; diagnostics?: undefined }
  | { ok: false; diagnostics: Diagnostic[]; shots?: undefined };

// Captures for agents (visual checks) and reviews: one build and one browser for any number of
// shots (see Shot). Free objects run in real time; CSS animations (theme and components) are set
// to each time.
export async function capture(dir: string | null, shots: Shot[], { pkgDir }: { pkgDir?: string } = {}): Promise<CaptureResult> {
  const folder = await packageFolder(dir, pkgDir, 'elabora-shot-');
  if ('diagnostics' in folder) return { ok: false, diagnostics: folder.diagnostics };
  const server = await startServer();
  server.addPackage('shot', folder.root, folder.files);
  const browsers = launchMotionBrowsers({ rendering: 'gpu' });
  const results: ShotResult[] = [];
  // Moments other than a line (a word, seconds, a step) resolve against the course's timeline.
  let project: Project | null | undefined;
  const momentAt = (screen: string, anchor: string, layer?: string | null): number => {
    project ??= dir ? loadProjectFromDir(dir) : null;
    if (!project) throw new Error(`"${anchor}": a word, seconds or a step need the course folder (a line works with a package).`);
    const found = resolveAt(project, screen, anchor, { layer: layer ?? null });
    if ('error' in found) throw new Error(found.error);
    return found.time;
  };
  try {
    // One page per window size and motion setting; screens are visited in it one after the other.
    const groups = new Map<string, ShotGroup>();
    for (const [index, shot] of shots.entries()) {
      const motion = !!(shot.motion || timesOf(shot).length || shot.scroll?.length);
      const key = `${shot.width || 1600}x${shot.height || 900}${motion ? 'm' : ''}`;
      let group = groups.get(key);
      if (!group) { group = { width: shot.width || 1600, height: shot.height || 900, motion, items: [] }; groups.set(key, group); }
      group.items.push([index, shot]);
    }
    for (const group of groups.values()) {
      const browser = await browsers.for(group.motion);
      const page = await browser.newPage({ viewport: { width: group.width, height: group.height }, reducedMotion: group.motion ? 'no-preference' : 'reduce' });
      const errors: string[] = [];
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('pageerror', (error) => errors.push(error.message));
      // Narrated screens hold still (a virtual clock): captures show a time, they never play.
      await page.addInitScript(() => { window.ELABORA_TEST = { virtualTime: true }; });
      await page.goto(`${server.base}/pkg/shot/index.html`);
      await page.waitForFunction(() => window.__elabora);
      // Every screen reachable, as in fit checks; the preview banner does not exist in an LMS.
      const ids = await page.evaluate(openAllScreens);
      for (const [index, shot] of group.items) {
        const target = shot.screen || ids[0];
        const unknown = [target, shot.from].find((id) => id !== undefined && !ids.includes(id));
        if (unknown) { results[index] = { ok: false, error: `Unknown screen "${unknown}". Screens: ${ids.join(', ')}` }; continue; }
        errors.length = 0;
        try { results[index] = { ok: true, ...(await shoot(browser, page, target, shot, group, momentAt)), browser: browserIdentity(browser), consoleErrors: [...errors] }; } catch (error) { results[index] = { ok: false, error: errorMessage(error).split('\n')[0] }; }
      }
      await page.close();
    }
    return { ok: results.every((result) => result.ok), shots: results };
  } finally {
    await browsers.close();
    await server.close();
    if (folder.temporary) fs.rmSync(folder.temporary, { recursive: true, force: true });
  }
}

// The times (ms) and the narration lines ("l2", "l2:end") of a filmstrip.
const timesOf = (shot: Shot): number[] => (shot.at ?? []).map((value) => (typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN)).filter((value) => Number.isFinite(value));
const linesOf = (shot: Shot): string[] => (shot.at ?? []).filter((value): value is string => typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim()));

interface ShotGroup {
  width: number;
  height: number;
  motion: boolean;
  items: [number, Shot][];
}

async function shoot(browser: Browser, page: Page, screen: string, shot: Shot, group: ShotGroup, momentAt: (screen: string, anchor: string, layer?: string | null) => number) {
  const passage = !!shot.from && !!shot.at?.length;
  if (passage) {
    // The learner's progress as they leave it (the screens before it done).
    await page.evaluate((from) => {
      const elabora = window.__elabora;
      const order = elabora.engine.screens;
      elabora.engine.st.visited.clear();
      elabora.engine.st.completed.clear();
      for (const before of order.slice(0, Math.max(0, order.findIndex((candidate) => candidate.id === from)))) { elabora.engine.st.visited.add(before.key); elabora.engine.st.completed.add(before.key); }
      elabora.go(from);
      elabora.revealAll();
    }, shot.from!);
    await page.evaluate(() => window.__elabora.ready());
    await page.waitForTimeout(400);
  }
  const moved = Date.now();
  await page.evaluate(({ screen, step, passage }) => {
    const elabora = window.__elabora;
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')) dialog.close();
    // The learner's progress when they reach this screen: the screens before it done, not the others
    // (the bar and the outline show where a learner would be, not a course already finished).
    const order = elabora.engine.screens;
    const reached = order.findIndex((candidate) => candidate.id === screen);
    for (const [index, candidate] of order.entries()) {
      // A passage from a later screen keeps what the learner had done.
      if (index < reached) { elabora.engine.st.visited.add(candidate.key); elabora.engine.st.completed.add(candidate.key); }
      else if (!passage) { elabora.engine.st.visited.delete(candidate.key); elabora.engine.st.completed.delete(candidate.key); }
    }
    elabora.go(screen);
    if (step) elabora.reveal(step); else elabora.revealAll();
    const active = document.activeElement;
    if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
  }, { screen, step: shot.step || 0, passage });
  // Wait for images and free objects (not a fixed delay), then let objects render a few frames.
  const ready = await page.evaluate(() => window.__elabora.ready());
  const answered = shot.state === 'answered' ? await page.evaluate(() => window.__elabora.showAnswered()) : null;
  if (shot.layer) {
    await page.evaluate((id) => {
      const elabora = window.__elabora;
      const current = elabora.engine.screens[elabora.engine.screenIndex.get(elabora.screen ?? '') ?? -1];
      if (!(current.layers || []).some((layer) => layer.id === id)) throw new Error(`No layer "${id}" on screen "${elabora.screen}"`);
      elabora.openLayer(id);
      // A layer with a timeline of its own (D62) shows its end, as a screen shows its last step.
      elabora.timeline.layer(id)?.atTime(Number.MAX_SAFE_INTEGER, { captions: false });
    }, shot.layer);
    await page.evaluate(() => window.__elabora.ready());
  }
  const layered = shot.layer ? await page.evaluate((id) => !!window.__elabora.timeline.layer(id), shot.layer) : false;
  // A passage counts from the move; a screen, from once it is ready.
  const begin = passage ? moved : Date.now();
  if (!passage) await page.waitForTimeout(ready.objects.length ? 1500 : 120); // auto-height objects resize after their first frames
  const fullPage = shot.fullPage !== false && !shot.layer && !shot.scroll?.length && !linesOf(shot).length;

  // In a full-page capture the footer sits at the end of the page, not over the content.
  const restore = fullPage ? await page.addStyleTag({ content: '.t-bar { position: static !important; }' }) : null;
  const base = { screen, width: group.width, height: group.height, state: shot.state || 'initial', objects: ready.objects, ...(answered ? { answered: answered.changed } : {}) };
  try {
    if (fullPage && !shot.at?.length && !shot.scroll?.length) return { ...base, png: await fullPageWithObjects(page, ready.objects.length > 0) };
    if (shot.scroll?.length) {
      // Down the page: each position resolved against the scrollable length, captured once the
      // scroll-driven animations and the objects (one frame to hear where they are, a few to draw) follow.
      const stops = await scrollStops(page, shot.scroll);
      const tops = stops.map((stop) => stop.top);
      const frames = await scrollFilmstrip(page, stops, { settleMs: ready.objects.length ? 450 : 120 });
      await page.evaluate(() => { scrollTo(0, 0); });
      return { ...base, scroll: tops, at: frames.map((frame) => frame.ms), frames, png: await contactSheet(browser, frames, `${screen} — ${group.width}×${group.height} — scrolled`) };
    }
    if (!shot.at?.length) return { ...base, png: await page.screenshot({ fullPage }) };
    const frames: ShotFrame[] = [];
    for (const ms of [...timesOf(shot)].sort((a, b) => a - b)) {
      const wait = ms - (Date.now() - begin);
      if (wait > 0) await page.waitForTimeout(wait);
      await page.evaluate((time) => { for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = time; } }, ms);
      frames.push({ ms, png: await page.screenshot({ fullPage: false }) });
      await page.evaluate(() => { for (const animation of document.getAnimations()) animation.play(); });
    }
    // A narrated screen as it is when each line starts or ends: its step, its caption, the bar.
    for (const anchor of linesOf(shot)) {
      // A line as phase 1 shows it (its caption on); any other moment at its time.
      const cue = lineAnchor(anchor);
      let shown: boolean;
      if (layered && shot.layer) {
        // On the open layer's own timeline (D62).
        const layer = shot.layer;
        shown = !!cue && await page.evaluate(([id, at]) => window.__elabora.timeline.layer(id)?.at(at.line, { edge: at.edge, captions: true }) ?? false, [layer, cue] as const);
        if (!shown) shown = await page.evaluate(([id, time]) => window.__elabora.timeline.layer(id)?.atTime(time, { captions: true }) ?? false, [layer, momentAt(screen, anchor, layer)] as const);
        if (!shown) throw new Error(`Layer "${layer}" of screen "${screen}" has no timeline: ${anchor} names a moment of one.`);
      } else {
        shown = !!cue && await page.evaluate((at) => window.__elabora.timeline.at(at.line, { edge: at.edge, captions: true }), cue);
        if (!shown) shown = await page.evaluate((time) => window.__elabora.timeline.atTime(time, { captions: true }), momentAt(screen, anchor));
        if (!shown) throw new Error(`Screen "${screen}" has no timeline: ${anchor} names a moment of one.`);
      }
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      frames.push({ ms: 0, png: await page.screenshot({ fullPage: false }), label: anchor });
    }
    return { ...base, at: frames.map((frame) => frame.ms), frames, png: await contactSheet(browser, frames, `${passage ? `${shot.from} → ` : ''}${screen} — ${group.width}×${group.height}`) };
  } finally {
    await restore?.evaluate((node) => { node.parentNode?.removeChild(node); });
  }
}

// A full page with its free objects. Below the window, the frame of an object neither draws
// (browsers do not run frames out of view, and objects that follow the scroll wait to be reached)
// nor appears in a capture beyond the window. Each object out of the window is scrolled into view,
// given time to draw (settleMs) and captured where it stands; the captures are laid over their
// frames, in the page, for the one capture of the whole page.
export type ImageType = 'png' | 'jpeg';
export async function fullPageWithObjects(page: Page, objects: boolean, { settleMs = 900, type = 'png' }: { settleMs?: number; type?: ImageType } = {}): Promise<Buffer> {
  const encoding = type === 'jpeg' ? { type, quality: 90 } as const : { type } as const;
  const frames = objects ? await page.evaluate(() => [...document.querySelectorAll('#t-main .t-object-frame')]
    .map((frame) => { const box = frame.getBoundingClientRect(); return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }; })
    .filter((box) => box.width > 0 && box.height > 0 && box.y + box.height > innerHeight)) : [];
  if (!frames.length) return page.screenshot({ fullPage: true, ...encoding });
  const patches: { x: number; y: number; width: number; height: number; data: string }[] = [];
  for (const frame of frames) {
    const top = await page.evaluate((box) => {
      const y = Math.max(0, Math.round(box.y + box.height / 2 - innerHeight / 2));
      scrollTo(0, y);
      return new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(scrollY))));
    }, frame);
    await page.waitForTimeout(settleMs);
    const clip = { x: frame.x, y: Math.max(0, frame.y - top), width: frame.width, height: Math.min(frame.height, await page.evaluate(() => innerHeight)) };
    patches.push({ x: frame.x, y: top + clip.y, width: clip.width, height: clip.height, data: `data:image/${type};base64,${(await page.screenshot({ clip, ...encoding })).toString('base64')}` });
  }
  await page.evaluate(async (pictures) => {
    scrollTo(0, 0);
    const laid = pictures.map((picture) => {
      const image = new Image();
      image.src = picture.data;
      image.dataset.elaboraCapture = '';
      image.style.cssText = `position:absolute;left:${picture.x}px;top:${picture.y}px;width:${picture.width}px;height:${picture.height}px;z-index:2147483647;pointer-events:none;margin:0;max-width:none`;
      document.documentElement.append(image);
      return image.decode();
    });
    await Promise.all(laid);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, patches);
  try {
    return await page.screenshot({ fullPage: true, ...encoding });
  } finally {
    await page.evaluate(() => { for (const image of document.querySelectorAll('img[data-elabora-capture]')) image.remove(); });
  }
}

// Frames side by side with their time, as one PNG (rendered by the browser: no image library).
export async function contactSheet(browser: Browser, frames: ShotFrame[], title: string): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const columns = frames.length === 1 ? 1 : frames.length <= 4 ? 2 : 3;
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const mime = (png: Buffer) => (png[0] === 0xff && png[1] === 0xd8 ? 'image/jpeg' : 'image/png');
  const cells = frames.map((frame) => `<figure><img src="data:${mime(frame.png)};base64,${frame.png.toString('base64')}"><figcaption>${escape(frame.label ?? `${(frame.ms / 1000).toFixed(1)} s`)}</figcaption></figure>`).join('');
  await page.setContent(`<!doctype html><style>body{margin:0;padding:16px;background:#111;color:#ddd;font:14px system-ui}h1{font-size:15px;margin:0 0 12px}main{display:grid;grid-template-columns:repeat(${columns},1fr);gap:12px}figure{margin:0}img{display:block;width:100%;border:1px solid #333}figcaption{padding:4px 2px}</style><h1>${title.replace(/</g, '&lt;')}</h1><main>${cells}</main>`);
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  const png = await page.screenshot({ fullPage: true });
  await page.close();
  return png;
}

// One shot (the former single-screenshot API, used by component previews and the MCP tool).
export async function screenshot(dir: string, { screen, width = 1600, height = 900, fullPage = true, layer, step, state, at, scroll, motion }: Shot = {}): Promise<ShotResult | { ok: false; diagnostics: Diagnostic[]; error?: undefined }> {
  const result = await capture(dir, [{ screen, width, height, fullPage, layer, step, state, at, scroll, motion }]);
  if (!result.shots) return result;
  return result.shots[0];
}

export interface ComponentPreviewOptions {
  id: string; // component id
  width?: number;
  height?: number;
  props?: Record<string, unknown>; // instead of the component's examples
}

// Specimen of a component: its examples (or given props) on a temporary screen of a copy of the
// course, captured once rendered. The light review of a component: run it at 1280 and 375 px.
export type ComponentPreview = (ShotSuccess & { count: number }) | { ok: false; error?: string; diagnostics?: Diagnostic[] };

export async function previewComponent(dir: string, { id, width = 1280, height = 860, props }: ComponentPreviewOptions): Promise<ComponentPreview> {
  const project = loadProjectFromDir(dir);
  const descriptor = getRegistry(project).get(id);
  if (!descriptor) return { ok: false, error: `No component "${id}"` };
  const item = project.plan?.items?.[0]?.id;
  if (!item) return { ok: false, error: 'The plan has no item to attach the specimen screen to.' };
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-specimen-'));
  try {
    // Neither tool folders nor the author's sources (D49), which may hold hundreds of megabytes.
    fs.cpSync(project.root, copy, { recursive: true, filter: (source) => !/[\\/](dist|\.elabora|node_modules)([\\/]|$)|^[\\/]sources([\\/]|$)/.test(source.slice(project.root.length)) });
    const examples: { props: Record<string, unknown>; blocks?: Block[] }[] = props ? [{ props }] : descriptor.examples?.length ? descriptor.examples : [{ props: {} }];
    const screen: Screen = { id: 'elabora-specimen', title: descriptor.title, covers: [item], blocks: [] };
    if (descriptor.level === 'screen') {
      screen.layout = id;
      screen.layoutProps = examples[0].props;
      screen.blocks = examples[0].blocks?.length ? examples[0].blocks : [{ id: 'specimen-text', type: 'text', props: { markdown: descriptor.title } }];
    } else {
      examples.forEach((example, i) => screen.blocks.push({ id: `specimen-${i + 1}`, type: id, props: example.props || {}, ...(example.blocks ? { blocks: example.blocks } : {}) }));
    }
    fs.writeFileSync(path.join(copy, 'screens', 'elabora-specimen.json'), JSON.stringify(screen, null, 2));
    const course: unknown = JSON.parse(fs.readFileSync(path.join(copy, 'course.json'), 'utf8'));
    const sections = fieldOf(course, 'sections');
    const screens = fieldOf(Array.isArray(sections) ? sections[sections.length - 1] : undefined, 'screens');
    if (!Array.isArray(screens)) return { ok: false, error: 'course.json has no section to add the specimen screen to.' };
    screens.push('elabora-specimen');
    fs.writeFileSync(path.join(copy, 'course.json'), JSON.stringify(course, null, 2));
    const result = await screenshot(copy, { screen: 'elabora-specimen', width, height });
    return result.ok ? { ...result, count: descriptor.level === 'screen' ? 1 : examples.length } : result;
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}
