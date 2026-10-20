import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Browser, CDPSession, Page } from 'playwright-core';
import type { Block, Diagnostic, ObjectTests, Screen } from '@elabora/format';
import { screenBlocks } from '@elabora/core/project/load';
import { partialDiff } from './objects/test.ts';
import { getRegistry } from '@elabora/core/components/registry';
import { build } from './build.ts';
import type { BuildResult } from './build.ts';
import { startServer } from './emulator/server.ts';
import type { PackageFiles } from './emulator/server.ts';
import { browserIdentity, launchMotionBrowsers } from './emulator/browser.ts';
import type { BrowserIdentity } from './emulator/electron.ts';
import type { ReadyReport } from './emulator/page-globals.ts';
import { loadProjectFromDir } from './project-reader.ts';
import { projectDataDir } from './data-dir.ts';
import { errorMessage, fieldOf } from './util/values.ts';
import { lineAnchor } from '@elabora/core/narration/narration';
import { resolveAt } from '@elabora/core/narration/anchor-text';
import type { Project } from '@elabora/core/project/model';
import { escapeHtml } from '@elabora/core/util/html';
import { codeInfo } from '@elabora/core/diagnostics/codes';
import { pageStyleConflicts, styleConflictDiagnostics, type StyleConflict } from './style-cascade.ts';

export interface PreviewOptions {
  port?: number;
  profile?: string; // LMS profile of the emulator page
  onRebuild?: (result: BuildResult) => void;
}

export interface Preview {
  result: BuildResult; // the first build
  urls: { standalone: string; lms: string };
  close(): Promise<void>;
}

// Live preview: rebuilds on every change and serves both the standalone player and the LMS emulator;
// its pages reload after each rebuild, on the screen they showed. Free objects load from a second
// port of the server (@elabora/player frames.ts), so browser panes that refuse frames of an opaque
// origin (the in-app browsers of agent apps) show them.
// Media are never copied: they are served from the project folder (masters), with range requests,
// and media a job is still writing show a placeholder until the job is done.
// The course shows with the errors that only stop a delivery (BuildOptions.preview); when it
// cannot be built at all, the pages say why, and show it once a change builds.
export async function preview(dir: string, { port = 4807, profile = 'unknown', onRebuild }: PreviewOptions = {}): Promise<Preview> {
  const root = path.resolve(dir);
  const out = path.join(projectDataDir(root), 'preview');
  const rebuild = () => build(root, { profiles: [profile], emit: 'dir', out, debug: true, writeLock: false, media: 'link', preview: true });
  let last = await rebuild();
  const server = await startServer({ port, frames: true });
  const show = (result: BuildResult) => {
    if (result.dirPath) server.addPackage('preview', result.dirPath, result.media, { preview: true });
    else server.addPackage('preview', notBuiltPage(out, result), new Map(), { preview: true });
  };
  show(last);
  const watched = ['course.json', 'plan.json', 'screens', 'objects', 'components', 'theme', 'assets'].map((name) => path.join(root, name)).filter((file) => fs.existsSync(file));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers = watched.map((file) => fs.watch(file, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => { last = await rebuild(); show(last); onRebuild?.(last); }, 250);
  }));
  return {
    result: last,
    urls: {
      standalone: `${server.base}/pkg/preview/index.html`,
      lms: `${server.base}/lms/launch.html?pkg=preview&profile=${profile}&mode=iframe&reg=preview`
    },
    close: async () => { for (const watcher of watchers) watcher.close(); await server.close(); }
  };
}

// The page of a preview whose course cannot be built: the errors that stop it, in a folder next to
// the package's. Its server adds the reload of preview pages.
function notBuiltPage(out: string, result: BuildResult): string {
  const errors = result.diagnostics.filter((d) => d.severity === 'error' && !d.waived);
  const stopping = errors.some((d) => !d.rule) ? errors.filter((d) => !d.rule) : errors;
  const items = stopping.map((d) => `<li><strong>${escapeHtml(codeInfo(d.code).title)}</strong>${d.file ? ` <code>${escapeHtml(d.file)}</code>` : ''}<br>${escapeHtml(d.message)}</li>`);
  const dir = path.join(out, 'not-built');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Preview not built</title>
<style>body { font: 15px/1.5 system-ui, sans-serif; margin: 40px; max-width: 760px; color: #2c2a27; } li { margin: 0 0 12px; } code { font-size: 13px; }</style>
</head>
<body>
<h1>${stopping.length === 1 ? 'An error is preventing' : 'Errors are preventing'} this course from being shown</h1>
<p>Please ask your agent to fix ${stopping.length === 1 ? 'this error' : 'these errors'}:</p>
<ul>${items.join('\n')}</ul>
</body>
</html>
`);
  return dir;
}

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

// Builds a course folder into a temporary folder for a capture or a measure (or uses pkgDir, an
// already built package).
// Media stay where they are (files: their package paths, served from the project).
async function packageFolder(dir: string | null, pkgDir: string | undefined, prefix: string): Promise<{ root: string; temporary: string | null; files: PackageFiles } | { diagnostics: Diagnostic[] }> {
  if (pkgDir) return { root: pkgDir, temporary: null, files: new Map() };
  if (!dir) throw new Error('Give a course folder or pkgDir, a built package.');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const result = await build(dir, { emit: 'dir', out, debug: true, writeLock: false, media: 'link' });
  if (!result.ok || !result.dirPath) { fs.rmSync(out, { recursive: true, force: true }); return { diagnostics: result.diagnostics }; }
  return { root: result.dirPath, temporary: out, files: result.media };
}

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
  const momentAt = (screen: string, anchor: string): number => {
    project ??= dir ? loadProjectFromDir(dir) : null;
    if (!project) throw new Error(`"${anchor}": a word, seconds or a step need the course folder (a line works with a package).`);
    const found = resolveAt(project, screen, anchor);
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
        if (!ids.includes(target)) { results[index] = { ok: false, error: `Unknown screen "${target}". Screens: ${ids.join(', ')}` }; continue; }
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

// In the page: every screen visited and complete (free navigation), the preview banner removed;
// returns the screen ids.
function openAllScreens(): string[] {
  const elabora = window.__elabora;
  for (const screen of elabora.engine.screens) { elabora.engine.st.visited.add(screen.key); elabora.engine.st.completed.add(screen.key); }
  document.querySelector('.t-banner')?.remove();
  return elabora.engine.screens.map((screen) => screen.id);
}

async function shoot(browser: Browser, page: Page, screen: string, shot: Shot, group: ShotGroup, momentAt: (screen: string, anchor: string) => number) {
  await page.evaluate(({ screen, step }) => {
    const elabora = window.__elabora;
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')) dialog.close();
    elabora.go(screen);
    if (step) elabora.reveal(step); else elabora.revealAll();
    const active = document.activeElement;
    if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
  }, { screen, step: shot.step || 0 });
  // Wait for images and free objects (not a fixed delay), then let objects render a few frames.
  const ready = await page.evaluate(() => window.__elabora.ready());
  const answered = shot.state === 'answered' ? await page.evaluate(() => window.__elabora.showAnswered()) : null;
  if (shot.layer) {
    await page.evaluate((id) => {
      const elabora = window.__elabora;
      const current = elabora.engine.screens[elabora.engine.screenIndex.get(elabora.screen ?? '') ?? -1];
      if (!(current.layers || []).some((layer) => layer.id === id)) throw new Error(`No layer "${id}" on screen "${elabora.screen}"`);
      elabora.openLayer(id);
    }, shot.layer);
    await page.evaluate(() => window.__elabora.ready());
  }
  const begin = Date.now();
  await page.waitForTimeout(ready.objects.length ? 1500 : 120); // auto-height objects resize after their first frames
  const fullPage = shot.fullPage !== false && !shot.layer && !shot.scroll?.length && !linesOf(shot).length;

  // In a full-page capture the footer sits at the end of the page, not over the content.
  const restore = fullPage ? await page.addStyleTag({ content: '.t-bar { position: static !important; }' }) : null;
  const base = { screen, width: group.width, height: group.height, state: shot.state || 'initial', objects: ready.objects, ...(answered ? { answered: answered.changed } : {}) };
  try {
    if (fullPage && !shot.at?.length && !shot.scroll?.length) return { ...base, png: await fullPageWithObjects(page, ready.objects.length > 0) };
    if (shot.scroll?.length) {
      // Down the page: each position resolved against the scrollable length, captured once the
      // scroll-driven animations and the objects (one frame to hear where they are, a few to draw) follow.
      const end = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
      const tops = shot.scroll.map((position) => {
        const percent = typeof position === 'string' && /^\d+(\.\d+)?%$/.test(position.trim()) ? parseFloat(position) / 100 : null;
        const px = percent !== null ? end * percent : Number(position);
        if (!Number.isFinite(px)) throw new Error(`Scroll position "${position}": give px or a percentage of the page ("40%").`);
        return Math.round(Math.min(end, Math.max(0, px)));
      });
      const frames: ShotFrame[] = [];
      for (const top of tops) {
        await page.evaluate((y) => new Promise((resolve) => { scrollTo(0, y); requestAnimationFrame(() => requestAnimationFrame(resolve)); }), top);
        await page.waitForTimeout(ready.objects.length ? 450 : 120);
        frames.push({ ms: 0, png: await page.screenshot({ fullPage: false }), label: `${top} px${end ? ` (${Math.round((top / end) * 100)} %)` : ''}` });
      }
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
      let shown = !!cue && await page.evaluate((at) => window.__elabora.timeline.at(at.line, { edge: at.edge, captions: true }), cue);
      if (!shown) shown = await page.evaluate((time) => window.__elabora.timeline.atTime(time, { captions: true }), momentAt(screen, anchor));
      if (!shown) throw new Error(`Screen "${screen}" has no timeline: ${anchor} names a moment of one.`);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      frames.push({ ms: 0, png: await page.screenshot({ fullPage: false }), label: anchor });
    }
    return { ...base, at: frames.map((frame) => frame.ms), frames, png: await contactSheet(browser, frames, `${screen} — ${group.width}×${group.height}`) };
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
export async function screenshot(dir: string, { screen, width = 1600, height = 900, fullPage = true, layer, step, state, at, motion }: Shot = {}): Promise<ShotResult | { ok: false; diagnostics: Diagnostic[]; error?: undefined }> {
  const result = await capture(dir, [{ screen, width, height, fullPage, layer, step, state, at, motion }]);
  if (!result.shots) return result;
  return result.shots[0];
}

// Fit of slides: every screen (all steps revealed, as in slides they keep their place) measured
// in a real browser at the fit sizes of the course (presentation.fit). A screen fits when the page
// does not scroll: header, screen and footer inside the window. Blocks that end below the fold are
// named so an agent or an author knows what to move. In scroll presentation screens are pages of
// any length: only the reference size is measured (unless sizes are given), for the length of each
// page and the contrast of its text, read over the whole page. dir is a course folder (built here)
// or, with pkgDir, an already built package.
export const FIT_DEFAULTS = { reference: '1600x900', minimum: '1280x720' };

export interface FitSize {
  role: 'reference' | 'minimum';
  size: string; // <width>x<height>
}

export interface ScreenFit {
  screen: string | undefined;
  overflow: number; // px of scrolling
  spare: number; // px left below the screen when it fits
  windows: number; // length of the page in windows (1 when it fits), one decimal
  below: (string | undefined)[]; // blocks that end below the fold
  // Answering moves the screen (slides): blocks that grow or move.
  shift?: { px: number; grew: { block: string; px: number }[]; moved: string[]; overflow: number };
  contrast?: MeasuredContrast[];
  // At the reference size, with every step shown and once answered: component rules the theme
  // overrides and theme rules for a component that it overrides (style-cascade.ts, D32).
  styles?: StyleConflict[];
  // A slide that scrolls (reference size): what compact feedback (quiz feedbackStyle) would save,
  // quiz by quiz.
  feedback?: { block: string; px: number }[];
}

export interface MeasuredContrast {
  block: string | null;
  text: string;
  ratio: number;
  need: number;
  // Found with animations on, as the page scrolls (scroll presentation): text that a scroll-driven
  // animation leaves too faint where it is read, in the middle of the window.
  scrolled?: true;
}

export type FitResult =
  | { ok: true; mode: 'scroll' | 'slides'; sizes: (FitSize & { screens: ScreenFit[] })[]; browser?: BrowserIdentity; diagnostics?: undefined }
  | { ok: false; diagnostics: Diagnostic[]; mode?: undefined; sizes?: undefined };

export async function measureFit(dir: string | null, { pkgDir, sizes }: { pkgDir?: string; sizes?: FitSize[] } = {}): Promise<FitResult> {
  const folder = await packageFolder(dir, pkgDir, 'elabora-fit-');
  if ('diagnostics' in folder) return { ok: false, diagnostics: folder.diagnostics };
  const server = await startServer();
  server.addPackage('fit', folder.root, folder.files);
  const browsers = launchMotionBrowsers({ rendering: 'gpu' });
  try {
    const browser = await browsers.for(false);
    // The course settings: presentation mode and fit sizes.
    const probe = await browser.newPage();
    await probe.goto(`${server.base}/pkg/fit/index.html`);
    await probe.waitForFunction(() => window.__elabora);
    const presentation = await probe.evaluate(() => window.__elabora.course.presentation || {});
    await probe.close();
    const mode = presentation.mode || 'scroll';
    const fitSizes = { ...FIT_DEFAULTS, ...(presentation.fit || {}) };
    const fit: FitSize[] = sizes || (mode === 'slides' ? [{ role: 'reference', size: fitSizes.reference }, { role: 'minimum', size: fitSizes.minimum }] : [{ role: 'reference', size: fitSizes.reference }]);
    const results: (FitSize & { screens: ScreenFit[] })[] = [];
    for (const size of fit) {
      const [width, height] = size.size.split('x').map(Number);
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      await page.addInitScript(() => { window.ELABORA_TEST = { virtualTime: true }; }); // narrated screens hold still
      await page.goto(`${server.base}/pkg/fit/index.html`);
      await page.waitForFunction(() => window.__elabora);
      // Free navigation and every step shown: all screens visited and complete. The preview
      // banner does not exist in an LMS.
      const ids = await page.evaluate(openAllScreens);
      const screens: ScreenFit[] = [];
      for (const id of ids) {
        await page.evaluate((screen) => {
          window.__elabora.go(screen);
          window.__elabora.revealAll();
          const active = document.activeElement;
          if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
        }, id);
        const ready = await page.evaluate(() => window.__elabora.ready());
        await page.waitForTimeout(ready.objects.length ? 1200 : 80); // auto-height objects resize after their first frames
        const before = await page.evaluate(blockBoxes);
        const initial = await page.evaluate(() => {
          const root = document.documentElement;
          const main = document.getElementById('t-main');
          if (!main) throw new Error('the player has no #t-main');
          // The player's bars that stay in the window (D58) hide what scrolls under them.
          const stuck = (selector: string) => { const bar = document.querySelector<HTMLElement>(selector); return bar && !bar.hidden && getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().height : 0; };
          const fold = innerHeight - Math.max(stuck('.t-bar--bottom'), stuck('.t-bar--controls'));
          const overflow = Math.max(0, Math.round(root.scrollHeight - innerHeight));
          const style = getComputedStyle(main);
          const room = main.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
          const below = overflow ? [...main.querySelectorAll<HTMLElement>('.t-block')]
            .filter((node) => !node.parentElement?.closest('.t-block') && node.getBoundingClientRect().bottom > fold + 1)
            .map((node) => node.dataset.block) : [];
          return { screen: window.__elabora.screen, overflow, spare: overflow ? 0 : Math.max(0, Math.round(room - (main.querySelector<HTMLElement>('.t-screen')?.offsetHeight ?? 0))), below, windows: Math.round((root.scrollHeight / innerHeight) * 10) / 10 };
        });
        // Once everything is answered (tallest feedback of every activity, concealed blocks shown),
        // nothing may move: blocks that grow or move are a layout shift.
        const styles = size.role === 'reference' ? await page.evaluate(pageStyleConflicts) : [];
        const feedback = mode === 'slides' && size.role === 'reference' && initial.overflow
          ? (await page.evaluate(() => window.__elabora.feedbackRooms())).map((room) => ({ block: room.block, px: room.full - room.compact })).filter((room) => room.px > 4)
          : [];
        const { changed } = mode === 'slides' ? await page.evaluate(() => window.__elabora.showAnswered()) : { changed: [] };
        let shift: ScreenFit['shift'] | null = null;
        if (changed.length) {
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const after = await page.evaluate(blockBoxes);
          const grew: { block: string; px: number }[] = []; const moved: string[] = []; let px = 0;
          for (const [id, box] of Object.entries(after)) {
            const previous = before[id];
            if (!previous) continue;
            const growth = box.h - previous.h; const offset = box.y - previous.y;
            if (Math.abs(growth) > 1) grew.push({ block: id, px: growth });
            else if (Math.abs(offset) > 1) moved.push(id);
            px = Math.max(px, Math.abs(growth), Math.abs(offset));
          }
          const overflowAfter = await page.evaluate(() => Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)));
          if (grew.length || moved.length || overflowAfter > initial.overflow) shift = { px, grew, moved, overflow: overflowAfter };
          if (size.role === 'reference') {
            const seen = new Set(styles.map((conflict) => `${conflict.kind}\u0000${conflict.componentRule}\u0000${conflict.themeRule}`));
            styles.push(...(await page.evaluate(pageStyleConflicts)).filter((conflict) => !seen.has(`${conflict.kind}\u0000${conflict.componentRule}\u0000${conflict.themeRule}`)));
          }
        }
        // Text over a backdrop, an image or a gradient: contrast measured against the pixels behind it
        // (in scroll presentation, window by window down the page).
        const contrast = size.role === 'reference' ? await measureContrast(page, mode === 'scroll') : [];
        screens.push({ ...initial, ...(shift ? { shift } : {}), ...(contrast.length ? { contrast } : {}), ...(styles.length ? { styles } : {}), ...(feedback.length ? { feedback } : {}) });
      }
      results.push({ ...size, screens });
      await page.close();
      // Scroll pages, at the reference size: once more with animations on, down each page by a quarter
      // of a window. Scroll-driven animations (a fade as text leaves, a block rising into place) set
      // what text looks like at each position: text is read in the middle of the window (20 to
      // 80 % of its height), and must be readable there at least once (an entrance may still be
      // fading in when it enters the middle; text kept faint is reported).
      if (mode === 'scroll' && size.role === 'reference') {
        const moving = await (await browsers.for(true)).newPage({ viewport: { width, height }, reducedMotion: 'no-preference' });
        await moving.addInitScript(() => { window.ELABORA_TEST = { virtualTime: true }; });
        await moving.goto(`${server.base}/pkg/fit/index.html`);
        await moving.waitForFunction(() => window.__elabora);
        await moving.evaluate(openAllScreens);
        // Only when a stylesheet animates with the scroll (theme and components are served with the package).
        const scrollDriven = await moving.evaluate(() => {
          // Style rules have cssRules too (nesting): their own declarations are read first.
          const rules = (list: CSSRuleList): boolean => [...list].some((rule) => {
            if (rule instanceof CSSImportRule) return !!rule.styleSheet && rules(rule.styleSheet.cssRules);
            if (rule instanceof CSSStyleRule && !['', 'auto'].includes(rule.style.getPropertyValue('animation-timeline').trim())) return true;
            return 'cssRules' in rule && rules((rule as CSSGroupingRule).cssRules);
          });
          return [...document.styleSheets].some((sheet) => { try { return rules(sheet.cssRules); } catch { return false; } });
        });
        for (const screen of scrollDriven ? screens : []) {
          await moving.evaluate((id) => { window.__elabora.go(id ?? ''); window.__elabora.revealAll(); (document.activeElement as HTMLElement | null)?.blur?.(); }, screen.screen);
          await moving.evaluate(() => window.__elabora.ready());
          const known = new Set((screen.contrast || []).map((found) => `${found.block}\u0000${found.text}`));
          const scrolled = (await measureContrast(moving, true, { top: 0.2, bottom: 0.8 }, { keep: 'best', stride: 0.25 })).filter((found) => !known.has(`${found.block}\u0000${found.text}`)).map((found): MeasuredContrast => ({ ...found, scrolled: true }));
          if (scrolled.length) screen.contrast = [...(screen.contrast || []), ...scrolled];
        }
        await moving.close();
      }
    }
    return { ok: true, mode, sizes: results, browser: browserIdentity(browser) };
  } finally {
    await browsers.close();
    await server.close();
    if (folder.temporary) fs.rmSync(folder.temporary, { recursive: true, force: true });
  }
}

// ── Measured contrast ────────────────────────────────────────────────
// Static checks compare text tokens with the surface token; over a backdrop, an image or a gradient
// the real background is only known in pixels. The text of the window is located, made transparent,
// the window captured, and for every element its colour is compared with the pixels behind its
// lines: 90 % of them must reach WCAG 1.4.3 (4.5:1, 3:1 for large text). Text shadows stay: a
// halo behind the letters is what readers see them against. Transitions stop at once: with
// animations on, a colour transition would still show the text in the capture of its background.
const HIDE_TEXT = '*, *::before, *::after, *::marker { color: transparent !important; -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important; caret-color: transparent !important; transition: none !important; }';
// The window as it is, or (wholePage: a page of scroll presentation) every window down the page,
// each element kept once with its lowest ratio.
// band: the part of the window read (fractions of its height from the top), default all of it.
interface Band { top: number; bottom: number }
// keep: "worst", the lowest ratio of an element over the windows (what does not move); "best", the
// highest (with animations on: text that a scroll-driven entrance shows as it reaches the middle of
// the window is read then; text never readable there is reported). stride: share of a window.
async function measureContrast(page: Page, wholePage = false, band: Band = { top: 0, bottom: 1 }, { keep = 'worst', stride: share = 0.85 }: { keep?: 'worst' | 'best'; stride?: number } = {}): Promise<MeasuredContrast[]> {
  const tops: (number | null)[] = wholePage ? await page.evaluate((share) => {
    const end = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const stride = Math.max(160, Math.round(innerHeight * share));
    const out: number[] = [];
    for (let top = 0; top < end; top += stride) out.push(top);
    out.push(end);
    return out;
  }, share) : [null];
  const found = new Map<string, MeasuredContrast>();
  for (const top of tops) {
    if (top !== null) await page.evaluate((y) => { scrollTo(0, y); }, top);
    for (const measured of await contrastInWindow(page, band)) {
      const key = `${measured.block}\u0000${measured.text}`;
      const known = found.get(key);
      if (!known || (keep === 'worst' ? measured.ratio < known.ratio : measured.ratio > known.ratio)) found.set(key, measured);
    }
  }
  if (wholePage) await page.evaluate(() => { scrollTo(0, 0); });
  return [...found.values()].filter((measured) => measured.ratio < measured.need);
}
async function contrastInWindow(page: Page, band: Band): Promise<MeasuredContrast[]> {
  // With animations on, transitions are settled first: those of a state change (a screen, a step), and
  // the colour transitions that removing HIDE_TEXT starts (.t-btn: color .2s) after the last window,
  // or the text is read still fading in, more or less depending on timing.
  await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation instanceof CSSTransition) animation.finish(); });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const runs = await page.evaluate(textRuns, band);
  if (!runs.length) return [];
  const style = await page.addStyleTag({ content: HIDE_TEXT });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await windowPng(page);
  await style.evaluate((node) => { node.parentNode?.removeChild(node); });
  return page.evaluate(contrastBehind, { png, runs });
}

// The window as a PNG in base64, for reading its pixels: Chrome encodes it for speed (lossless,
// larger), six times faster than its default compression on a textured page, which a measure down
// a long page pays window after window.
const devtools = new WeakMap<Page, Promise<CDPSession>>();
async function windowPng(page: Page): Promise<string> {
  let session = devtools.get(page);
  if (!session) {
    session = page.context().newCDPSession(page);
    devtools.set(page, session);
  }
  try {
    return (await (await session).send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })).data;
  } catch {
    return (await page.screenshot({ fullPage: false })).toString('base64');
  }
}

type Rgba = [number, number, number, number];
type Rect = [number, number, number, number]; // left, top, right, bottom

// Visible text of an element: colour, size class and line boxes.
interface TextRun {
  block: string | null;
  text: string;
  fg: Rgba;
  large: boolean;
  rects: Rect[];
}

// In the page: visible text of the window, grouped by element.
function textRuns(band: Band = { top: 0, bottom: 1 }): TextRun[] {
  const out = new Map<Element, TextRun>();
  // Any CSS colour (rgb(), color(srgb …) from color-mix(), …) to 0–255 RGBA, through a canvas.
  const pen = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!pen) return [];
  const rgba = (css: string): Rgba => { pen.clearRect(0, 0, 1, 1); pen.fillStyle = css; pen.fillRect(0, 0, 1, 1); const pixel = pen.getImageData(0, 0, 1, 1).data; return [pixel[0], pixel[1], pixel[2], pixel[3] / 255]; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  // Opacity of an element and its ancestors (a block faded by an animation), once per element.
  const opacities = new Map<Element, number>();
  const opacityOf = (element: Element | null): number => {
    if (!element || element === document.documentElement) return 1;
    const known = opacities.get(element);
    if (known !== undefined) return known;
    const value = (parseFloat(getComputedStyle(element).opacity) || 0) * opacityOf(element.parentElement);
    opacities.set(element, value);
    return value;
  };
  // Text that has scrolled under a bar that stays in the window (the player's bars, D58) is hidden by
  // it: only what is between them is read.
  const stuck = (selector: string) => { const bar = document.querySelector<HTMLElement>(selector); return bar && !bar.hidden && getComputedStyle(bar).position === 'sticky' ? bar : null; };
  const footer = stuck('.t-bar--bottom') ?? stuck('.t-bar--controls');
  const header = stuck('.t-bar--top');
  const fold = footer ? footer.getBoundingClientRect().top : innerHeight;
  const ceiling = header ? header.getBoundingClientRect().bottom : 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = node.textContent ?? '';
    if (!data.trim()) continue;
    const element = node.parentElement;
    if (!element || element.closest('.t-backdrop, .t-sr-only, [aria-hidden="true"], [inert], [aria-disabled="true"], :disabled, script, style')) continue;
    // Not rendered: closed disclosures (content-visibility), hidden or fully transparent elements.
    if (element.checkVisibility && !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || parseFloat(style.opacity) === 0) continue;
    range.selectNodeContents(node);
    const inBar = !!element.closest('.t-bar');
    const top = Math.max(innerHeight * band.top, inBar ? 0 : ceiling);
    const bottom = Math.min(inBar ? innerHeight : fold, innerHeight * band.bottom);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 2 && rect.height > 2 && rect.bottom > top && rect.top < bottom && rect.right > 0 && rect.left < innerWidth)
      .map((rect): Rect => [Math.max(0, rect.left), Math.max(top, rect.top), Math.min(innerWidth, rect.right), Math.min(bottom, rect.bottom)]);
    if (!rects.length) continue;
    let run = out.get(element);
    if (!run) {
      const size = parseFloat(style.fontSize);
      const weight = parseInt(style.fontWeight, 10) || 400;
      // The text's own alpha times the opacity of its ancestors (a block faded by an animation).
      const fg = rgba(style.color);
      fg[3] *= opacityOf(element);
      run = { block: element.closest<HTMLElement>('[data-block]')?.dataset.block || element.closest('header, footer')?.localName || null, text: '', fg, large: size >= 24 || (size >= 18.66 && weight >= 700), rects: [] };
      out.set(element, run);
    }
    run.text += data;
    run.rects.push(...rects);
  }
  return [...out.values()].map((run) => ({ ...run, text: run.text.replace(/\s+/g, ' ').trim().slice(0, 48) }));
}

// In the page: contrast of every run against the captured pixels behind it (text made transparent).
async function contrastBehind({ png, runs }: { png: string; runs: TextRun[] }): Promise<MeasuredContrast[]> {
  const image = new Image();
  image.src = `data:image/png;base64,${png}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0);
  const scale = image.width / innerWidth;
  const data = context.getImageData(0, 0, image.width, image.height).data;
  const linear = (value: number) => { const x = value / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const luminance = (red: number, green: number, blue: number) => 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  const out: MeasuredContrast[] = [];
  for (const run of runs) {
    const ratios: number[] = [];
    const behind: [number, number, number][] = [];
    for (const [x0, y0, x1, y1] of run.rects) {
      for (let y = Math.floor(y0 * scale); y < Math.min(image.height, y1 * scale); y += 2) {
        for (let x = Math.floor(x0 * scale); x < Math.min(image.width, x1 * scale); x += 2) {
          const i = (y * image.width + x) * 4;
          behind.push([data[i], data[i + 1], data[i + 2]]);
        }
      }
    }
    if (!behind.length) continue;
    const [red, green, blue, alpha] = run.fg;
    for (const [backRed, backGreen, backBlue] of behind) {
      // Semi-transparent text: its colour over this pixel.
      const textRed = red * alpha + backRed * (1 - alpha), textGreen = green * alpha + backGreen * (1 - alpha), textBlue = blue * alpha + backBlue * (1 - alpha);
      const l1 = luminance(textRed, textGreen, textBlue), l2 = luminance(backRed, backGreen, backBlue);
      ratios.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
    }
    ratios.sort((p, q) => p - q);
    const ratio = ratios[Math.floor(ratios.length * 0.1)];
    const need = run.large ? 3 : 4.5;
    out.push({ block: run.block, text: run.text, ratio: Math.round(ratio * 100) / 100, need });
  }
  return out;
}

// In the page: positions of the blocks of the screen (fit: what moves once activities are answered).
function blockBoxes(): Record<string, { y: number; h: number }> {
  const out: Record<string, { y: number; h: number }> = {};
  for (const node of document.querySelectorAll<HTMLElement>('#t-main .t-block[data-block]')) {
    const box = node.getBoundingClientRect();
    out[node.dataset.block ?? ''] = { y: Math.round(box.top + scrollY), h: Math.round(box.height) };
  }
  return out;
}

// Diagnostics of a fit measurement. Overflow and shifts concern slides only (a scroll presentation
// has no fold); measured contrast concerns both.
export function fitDiagnostics(fit: FitResult | null | undefined): Diagnostic[] {
  if (!fit?.ok) return [];
  const out: Diagnostic[] = styleConflictDiagnostics(fit.sizes.filter((size) => size.role === 'reference').flatMap((size) => size.screens.map((screen) => ({ screen: screen.screen ?? '', conflicts: screen.styles ?? [] }))));
  for (const size of fit.sizes) for (const screen of size.screens) {
    for (const contrast of size.role === 'reference' ? screen.contrast || [] : []) {
      out.push({ code: 'W_TEXT_CONTRAST_MEASURED', severity: 'warning', target: screen.screen, message: `Screen "${screen.screen}"${contrast.block ? `, ${contrast.block}` : ''}: "${contrast.text}" reaches ${contrast.ratio}:1 against what is behind it (needs ${contrast.need}:1)${contrast.scrolled ? ', as the page scrolls, with its animations' : ''}.`, rule: 'F1' });
    }
    if (fit.mode !== 'slides') continue;
    if (screen.shift) {
      const what = [...screen.shift.grew.map((grown) => `${grown.block} ${grown.px > 0 ? 'grows' : 'shrinks'} by ${Math.abs(grown.px)} px`), ...(screen.shift.moved.length ? [`${screen.shift.moved.length} block(s) move (${screen.shift.moved.slice(0, 4).join(', ')})`] : [])].join(', ');
      const message = `Answering moves screen "${screen.screen}" at ${size.size.replace('x', '×')}: ${what || 'the page grows'}${screen.shift.overflow > screen.overflow ? `; it then scrolls by ${screen.shift.overflow} px` : ''}.`;
      out.push(size.role === 'reference'
        ? { code: 'W_SLIDE_SHIFT', severity: 'warning', target: screen.screen, message, rule: 'F1' }
        : { code: 'I_SLIDE_SHIFT_MINIMUM', severity: 'info', target: screen.screen, message, rule: 'F1' });
    }
    if (!screen.overflow) continue;
    const saves = screen.feedback ?? [];
    const compact = saves.length ? ` Compact feedback would reserve less room: feedbackStyle "compact" on ${saves.map((room) => `${room.block} (−${room.px} px)`).join(', ')}.` : '';
    const message = `Screen "${screen.screen}" is ${screen.overflow} px taller than ${size.size.replace('x', '×')}${screen.below.length ? ` (below the fold: ${screen.below.join(', ')})` : ''}.${compact}`;
    out.push(size.role === 'reference'
      ? { code: 'W_SLIDE_OVERFLOW', severity: 'warning', target: screen.screen, message, rule: 'F1' }
      : { code: 'I_SLIDE_OVERFLOW_MINIMUM', severity: 'info', target: screen.screen, message, rule: 'F1' });
  }
  return out;
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

// ── Replaying an object's test in the course ─────────────────────────
// The behaviour tests of a free object (object.tests.json) run in an empty test page with virtual
// time. Replayed here, the same steps drive the object where learners meet it: in the built
// course, on the page that places it, scrolled into view, in real time, with the course around it.
// A snapshot step captures the window; expectations are checked as they come (not a gate: the
// object test is). set-view scrolls the page to the frame's view; set-safe-area and set-context
// do not apply to a page.
export interface ReplayOptions {
  block?: string; // the block placing the object (default: the first one, in course order)
  test?: string; // a test whose name contains this text (default: the first test)
  width?: number;
  height?: number;
}

export interface ReplayFrame {
  name: string;
  png: Buffer;
}

export type ReplayResult =
  | { ok: boolean; object: string; block: string; screen: string; test: string; frames: ReplayFrame[]; failures: string[]; skipped: string[]; png: Buffer; consoleErrors: string[]; diagnostics?: undefined; error?: undefined }
  | { ok: false; error: string; diagnostics?: Diagnostic[] };

export async function replayObject(dir: string, objectId: string, { block: blockId, test: testName, width = 1600, height = 900 }: ReplayOptions = {}): Promise<ReplayResult> {
  const project = loadProjectFromDir(dir);
  // The block that places the object, and its screen.
  let placed: { block: string; screen: string } | null = null;
  for (const [screenId, entry] of project.screens) {
    for (const { block } of screenBlocks(entry.data, entry.file)) {
      if (!block || block.type !== 'free-object' || fieldOf(block.props, 'object') !== objectId) continue;
      if (!blockId || block.id === blockId) { placed = { block: block.id, screen: screenId }; break; }
    }
    if (placed) break;
  }
  if (!placed) return { ok: false, error: blockId ? `No free-object block "${blockId}" places "${objectId}".` : `No screen places the free object "${objectId}".` };
  const testsFile = path.join(project.root, 'objects', objectId, 'object.tests.json');
  if (!fs.existsSync(testsFile)) return { ok: false, error: `objects/${objectId}/object.tests.json not found.` };
  const tests: ObjectTests = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
  const test = (tests.tests || []).find((candidate) => !testName || candidate.name.includes(testName));
  if (!test) return { ok: false, error: `No test of "${objectId}" matches "${testName}". Tests: ${(tests.tests || []).map((candidate) => candidate.name).join(' | ')}` };

  const folder = await packageFolder(dir, undefined, 'elabora-replay-');
  if ('diagnostics' in folder) return { ok: false, error: 'The course does not build.', diagnostics: folder.diagnostics };
  const server = await startServer();
  server.addPackage('replay', folder.root, folder.files);
  const browsers = launchMotionBrowsers({ rendering: 'gpu' });
  const frames: ReplayFrame[] = [];
  const failures: string[] = [];
  const skipped: string[] = [];
  const consoleErrors: string[] = [];
  try {
    const browser = await browsers.for(!test.reducedMotion);
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: test.reducedMotion ? 'reduce' : 'no-preference' });
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await page.goto(`${server.base}/pkg/replay/index.html`);
    await page.waitForFunction(() => window.__elabora);
    await page.evaluate(openAllScreens);
    await page.evaluate((screen) => { window.__elabora.go(screen); window.__elabora.revealAll(); }, placed.screen);
    await page.evaluate(() => window.__elabora.ready());
    const block = placed.block;
    // Scrolls the page so the frame is where a view puts it (progress, else entry), or centred.
    const scrollToView = (view: { progress?: number; entry?: number } | null) => page.evaluate(({ id, view }) => new Promise<void>((resolve) => {
      const frame = document.querySelector(`[data-block="${id}"] .t-object-frame`);
      if (!frame) { resolve(); return; }
      const box = frame.getBoundingClientRect();
      const top = box.top + scrollY;
      let at = top - (innerHeight - box.height) / 2;
      if (view && typeof view.progress === 'number') at = top - (innerHeight - view.progress * (innerHeight + box.height));
      else if (view && typeof view.entry === 'number') at = top - (innerHeight - view.entry * Math.min(box.height, innerHeight));
      scrollTo(0, Math.max(0, at));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }), { id: block, view });
    type HostMethod = 'testClick' | 'testKey' | 'updateProps' | 'setState' | 'getState';
    const host = (method: HostMethod, argument?: unknown) => page.evaluate(async ({ id, method, argument }) => {
      const found = window.__elabora.objectHost(id);
      if (!found) throw new Error(`no object host for "${id}"`);
      switch (method) {
        case 'testClick': return found.testClick(argument as { object?: string; at?: [number, number] });
        case 'testKey': return found.testKey(String(argument));
        case 'updateProps': return found.updateProps(argument as Record<string, unknown>);
        case 'setState': return found.setState(argument);
        case 'getState': return found.getState();
      }
    }, { id: block, method, argument });
    await scrollToView(test.view || null);
    if (test.props) await host('updateProps', test.props);
    await page.waitForTimeout(300);
    let cursor = 0;
    for (const [index, step] of test.steps.entries()) {
      const where = `step ${index + 1} (${step.action})`;
      try {
        if (step.action === 'step') await page.waitForTimeout(Math.round(((step.frames || 1) * 1000) / 60));
        else if (step.action === 'click') await host('testClick', step.object ? { object: step.object } : { at: step.at });
        else if (step.action === 'key') await host('testKey', step.key ?? '');
        else if (step.action === 'set-props') await host('updateProps', step.props || {});
        else if (step.action === 'set-state') await host('setState', step.state || {});
        else if (step.action === 'set-view') { await scrollToView(step.view || null); await page.waitForTimeout(250); }
        else if (step.action === 'set-safe-area' || step.action === 'set-context') skipped.push(`${where}: does not apply to a page`);
        else if (step.action === 'expect-state') {
          // Real time: the object may be a little behind the frames the test counted (software
          // WebGL draws slower). An expectation waits for it a moment before it fails.
          let difference: string | null = null;
          for (const begin = Date.now(); ; await page.waitForTimeout(100)) {
            difference = partialDiff(step.state || {}, await host('getState'));
            if (!difference || Date.now() - begin > 2000) break;
          }
          if (difference) failures.push(`${where}: state ${difference}`);
        } else if (step.action === 'expect-event' || step.action === 'expect-no-event') {
          const read = () => page.evaluate((id) => (window.__elabora.objectHost(id)?.emitted || []).map((event) => ({ name: event.name, payload: event.payload })), block);
          const find = (events: { name: string; payload: unknown }[]) => events.slice(cursor).findIndex((event) => (!step.name || event.name === step.name) && !partialDiff(step.payload || {}, event.payload));
          let events = await read();
          for (const begin = Date.now(); step.action === 'expect-event' && find(events) < 0 && Date.now() - begin < 4000; events = await read()) await page.waitForTimeout(100);
          if (step.action === 'expect-no-event') { await page.waitForTimeout(300); events = await read(); }
          const fresh = events.slice(cursor);
          const match = find(events);
          if (step.action === 'expect-event') {
            if (match < 0) failures.push(`${where}: no "${step.name}" event${step.payload ? ` with ${JSON.stringify(step.payload)}` : ''} (got ${JSON.stringify(fresh.map((event) => event.name))})`);
            else cursor += match + 1;
          } else if (match >= 0) failures.push(`${where}: unexpected "${fresh[match].name}" event`);
        } else if (step.action === 'snapshot') frames.push({ name: step.name || `step ${index + 1}`, png: await page.screenshot({ fullPage: false }) });
      } catch (error) {
        failures.push(`${where}: ${errorMessage(error).split('\n')[0]}`);
      }
    }
    await page.waitForTimeout(200);
    frames.push({ name: 'end', png: await page.screenshot({ fullPage: false }) });
    const sheet = await contactSheet(browser, frames.map((frame) => ({ ms: 0, png: frame.png, label: frame.name })), `${objectId} — "${test.name}" in ${placed.screen} — ${width}×${height}`);
    return { ok: !failures.length, object: objectId, block, screen: placed.screen, test: test.name, frames, failures, skipped, png: sheet, consoleErrors };
  } finally {
    await browsers.close();
    await server.close();
    if (folder.temporary) fs.rmSync(folder.temporary, { recursive: true, force: true });
  }
}

// ── Contact sheet of generated assets ─────────────────────────────────
// Every figure a generator wrote, on the course's surface colour, with its file name and size:
// the light review of generators/ (elabora assets --sheet), one image for all of them.
export interface AssetGroup {
  generator: string;
  description?: string;
  outputs: string[]; // paths under assets/
}

export async function assetsSheet(dir: string, groups: AssetGroup[], { surface = '#ffffff', width = 1600 }: { surface?: string; width?: number } = {}): Promise<Buffer> {
  const root = path.resolve(dir);
  const types: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sections = groups.map((group) => {
    const cells = group.outputs.filter((output) => types[path.extname(output).toLowerCase()]).map((output) => {
      const file = path.join(root, 'assets', output);
      if (!fs.existsSync(file)) return `<figure><div class="missing">missing</div><figcaption>${escape(output)}</figcaption></figure>`;
      const data = fs.readFileSync(file).toString('base64');
      return `<figure><div class="art"><img src="data:${types[path.extname(output).toLowerCase()]};base64,${data}"></div><figcaption>${escape(output)} <span></span></figcaption></figure>`;
    }).join('');
    return `<section><h2>${escape(group.generator)}${group.description ? ` <small>${escape(group.description)}</small>` : ''}</h2><main>${cells}</main></section>`;
  }).join('');
  // The figures as they rest: animations off, in the SVGs shown through <img> too (a figure that draws
  // itself would be captured at its first, empty frame).
  const browsers = launchMotionBrowsers({ rendering: 'gpu' });
  try {
    const page = await (await browsers.for(false)).newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await page.setContent(`<!doctype html><style>
body{margin:0;padding:20px;background:#1a1a1a;color:#ddd;font:13px system-ui}
h2{font-size:15px;margin:18px 0 10px;color:#fff}h2 small{font-weight:400;color:#999}
main{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
figure{margin:0}.art,.missing{display:grid;place-items:center;aspect-ratio:4/3;background:${surface.replace(/[^#0-9a-zA-Z(),. %]/g, '')};border:1px solid #333;overflow:hidden}
.art img{width:100%;height:100%;object-fit:contain}.missing{color:#c33}figcaption{padding:4px 2px;word-break:break-all}figcaption span{color:#888}
</style>${sections}`);
    await page.evaluate(() => Promise.all([...document.images].map(async (image) => {
      await image.decode().catch(() => {});
      const caption = image.closest('figure')?.querySelector('figcaption span');
      if (caption) caption.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
    })));
    return await page.screenshot({ fullPage: true });
  } finally {
    await browsers.close();
  }
}
