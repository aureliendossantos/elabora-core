import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Browser, Page } from 'playwright-core';
import type { Diagnostic, Screen } from '@elabora/format';
import { startServer } from './emulator/server.ts';
import { browserIdentity, launchMotionBrowsers, openedBrowserIdentity } from './emulator/browser.ts';
import type { BrowserIdentity } from './emulator/electron.ts';
import { loadProjectFromDir } from './project-reader.ts';
import { pageStyleConflicts, styleConflictDiagnostics, type StyleConflict } from './style-cascade.ts';
import { codeVersion } from './code-version.ts';
import { fitKey, readKeptFit, screenRenders, writeKeptFit } from './fit-cache.ts';
import type { FitCourse } from './fit-cache.ts';
import { measureMotion } from './motion-report.ts';
import { packageFolder, openAllScreens } from './package-folder.ts';
import { measureContrast, scrollDrivenIn } from './contrast.ts';
import type { Band, MeasuredContrast } from './contrast.ts';

// Fit of slides: every screen (all steps revealed, as in slides they keep their place) measured
// in a real browser at the fit sizes of the course (presentation.fit). A screen fits when the page
// does not scroll: header, screen and footer inside the window. Blocks that end below the fold are
// named so an agent or an author knows what to move. In scroll presentation screens are pages of
// any length: only the reference size is measured (unless sizes are given), for the length of each
// page and the contrast of its text, read over the whole page. dir is a course folder (built here)
// or, with pkgDir, an already built package.
export const FIT_DEFAULTS = { reference: '1600x900', minimum: '1280x720' };
// A phone, where a slide becomes a page: measured for the contrast of its text down the page and for
// the player's bars, which must hold on one line (nothing has to fit).
export const FIT_PHONE = '375x812';

export interface FitSize {
  role: 'reference' | 'minimum' | 'phone';
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
  // Scroll pages, at the reference size: animations driven by the scroll that have not reached their
  // end when the page is scrolled to the bottom (motion-report.ts), atEnd their progress there.
  unfinished?: { block: string | null; name: string; target: string; atEnd: number | null }[];
  // On a phone: the player's bars whose items go onto a second line (the Next button under the
  // others), by their class (t-bar--top, t-bar--bottom, t-bar--controls).
  wrapped?: string[];
  // Unchanged since it was measured at this date (ISO): the fit kept then (fit-cache.ts).
  reused?: string;
}

export type FitResult =
  | { ok: true; mode: 'scroll' | 'slides'; sizes: (FitSize & { screens: ScreenFit[] })[]; browser?: BrowserIdentity; diagnostics?: undefined }
  | { ok: false; diagnostics: Diagnostic[]; error?: string; mode?: undefined; sizes?: undefined };

export interface FitOptions {
  pkgDir?: string;
  sizes?: FitSize[];
  // Only these screens (default: every screen of the course).
  screens?: string[];
  // Measure again the screens unchanged since their last measure (course folders: a screen whose
  // key is unchanged, fit-cache.ts, is given as kept, with reused).
  fresh?: boolean;
  // The phone size (default FIT_PHONE, measured when sizes are not given), or false: none.
  phone?: string | false;
}

// Screens measured side by side: each page renders in a process of its own (Elabora's Electron: a
// worker per page), never in the background. Two: their captures share the GPU, and more pages wait
// on each other's (four took longer than one on a ten-core Mac).
const FIT_PAGES = Math.min(2, os.availableParallelism());

export async function measureFit(dir: string | null, options: FitOptions = {}): Promise<FitResult> {
  if (!options.pkgDir && !dir) throw new Error('Give a course folder or pkgDir, a built package.');
  // Built once, and only when a screen is measured.
  const building: { folder?: ReturnType<typeof packageFolder> } = {};
  try {
    return await fitScreens(dir, options, () => (building.folder ??= packageFolder(dir, options.pkgDir, 'elabora-fit-')));
  } finally {
    const made = await building.folder;
    if (made && !('diagnostics' in made) && made.temporary) fs.rmSync(made.temporary, { recursive: true, force: true });
  }
}

async function fitScreens(dir: string | null, { pkgDir, sizes, screens, fresh = false, phone }: FitOptions, built: () => ReturnType<typeof packageFolder>): Promise<FitResult> {
  const only = screens?.length ? screens : undefined;
  // A course folder: each screen rendered (renderScreen) for its key. A package, or a course that
  // does not render: measured, never kept.
  const project = pkgDir || !dir ? null : loadProjectFromDir(dir);
  const renders = project ? screenRenders(project) : null;
  let course: FitCourse;
  if (renders) course = renders;
  else {
    const made = await built();
    if ('diagnostics' in made) return { ok: false, diagnostics: made.diagnostics };
    course = packageCourse(made.root);
  }
  const mode = course.presentation.mode || 'scroll';
  const fitSizes = { ...FIT_DEFAULTS, ...(course.presentation.fit || {}) };
  const fit: FitSize[] = sizes ? [...sizes] : mode === 'slides' ? [{ role: 'reference', size: fitSizes.reference }, { role: 'minimum', size: fitSizes.minimum }] : [{ role: 'reference', size: fitSizes.reference }];
  const phoneSize = phone === undefined ? (sizes ? null : FIT_PHONE) : phone || null;
  if (phoneSize && !fit.some((size) => size.role === 'phone')) fit.push({ role: 'phone', size: phoneSize });
  const unknown = (only ?? []).filter((id) => !course.ids.includes(id));
  if (unknown.length) return { ok: false, diagnostics: [], error: `Unknown screen${unknown.length > 1 ? 's' : ''} ${unknown.map((id) => `"${id}"`).join(', ')}. Screens: ${course.ids.join(', ')}` };
  const ids = only ? course.ids.filter((id) => only.includes(id)) : course.ids;

  const browsers = launchMotionBrowsers({ rendering: 'gpu' });
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let blank: Page | null = null;
  try {
    const browser = await browsers.for(false);
    // The browser's version (Elabora's Electron tells it once a page is open): from the page the
    // first screen is measured in, when one is.
    const [width, height] = fit[0].size.split('x').map(Number);
    if (!browserIdentity(browser).version) blank = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const identity = await openedBrowserIdentity(browser);
    const code = codeVersion();
    const results = fit.map((size) => ({ ...size, screens: new Array<ScreenFit>(ids.length) }));
    const jobs: FitJob[] = [];
    for (const [s, size] of fit.entries()) for (const [i, id] of ids.entries()) {
      const render = renders?.renders.get(id);
      const key = project && render ? fitKey({ render, code, browser: identity, size: size.size, role: size.role, mode }) : null;
      const kept = project && key && !fresh ? readKeptFit<ScreenFit>(project.root, size.size, size.role, id) : null;
      if (kept && kept.key === key) results[s].screens[i] = { ...kept.fit, reused: kept.at };
      else jobs.push({ s, i, size, id, key });
    }
    if (jobs.length) {
      const made = await built();
      if ('diagnostics' in made) return { ok: false, diagnostics: made.diagnostics };
      server = await startServer();
      server.addPackage('fit', made.root, made.files);
      const base = server.base;
      const queue = [...jobs];
      const opened = new Map<string, number>(); // window size → pages of the workers
      await Promise.all(Array.from({ length: Math.min(FIT_PAGES, jobs.length) }, async () => {
        // A page per window size and motion setting; its screens are visited one after the other.
        // A worker takes the screens of a size it has a page for first, else of the size the fewest
        // workers have a page for (slides: one worker per size).
        const pages = new Map<string, Promise<Page>>();
        const pageFor = (size: FitSize, motion: boolean): Promise<Page> => {
          const id = `${size.size}${motion ? 'm' : ''}`;
          let page = pages.get(id);
          if (!page) {
            if (!motion) opened.set(size.size, (opened.get(size.size) ?? 0) + 1);
            const ready = !motion && size.size === fit[0].size ? blank : null;
            if (ready) blank = null;
            page = (async () => fitPage(await browsers.for(motion), base, size.size, motion, ready))();
            pages.set(id, page);
          }
          return page;
        };
        const next = (): FitJob | undefined => {
          if (!queue.length) return undefined;
          let index = queue.findIndex((job) => pages.has(job.size.size));
          if (index < 0) {
            const fewest = Math.min(...queue.map((job) => opened.get(job.size.size) ?? 0));
            index = queue.findIndex((job) => (opened.get(job.size.size) ?? 0) === fewest);
          }
          return queue.splice(index, 1)[0];
        };
        try {
          for (let job = next(); job; job = next()) {
            const screen = await measureScreen(await pageFor(job.size, false), job.id, job.size, mode);
            // Scroll pages, at the reference size: once more with animations on (scrolledContrast).
            if (mode === 'scroll' && job.size.role === 'reference') await scrolledContrast(await pageFor(job.size, true), screen);
            results[job.s].screens[job.i] = screen;
            if (project && job.key) writeKeptFit<ScreenFit>(project.root, job.size.size, job.size.role, job.id, { key: job.key, at: new Date().toISOString(), fit: screen });
          }
        } finally {
          await Promise.allSettled([...pages.values()].map(async (page) => (await page).close()));
        }
      }));
    }
    return { ok: true, mode, sizes: results, browser: identity };
  } finally {
    await blank?.close().catch(() => {});
    await browsers.close();
    await server?.close();
  }
}

interface FitJob { s: number; i: number; size: FitSize; id: string; key: string | null }

// The course data of a built package (elabora/course.js).
function packageCourse(root: string): FitCourse {
  const text = fs.readFileSync(path.join(root, 'elabora', 'course.js'), 'utf8');
  const data: { presentation?: FitCourse['presentation']; screens?: { id: string }[] } = JSON.parse(text.slice(text.indexOf('=') + 1).trim().replace(/;$/, ''));
  return { presentation: data.presentation || {}, ids: (data.screens || []).map((screen) => screen.id) };
}

// A page of the package at a window size, every screen visited and complete (free navigation, every
// step shown); the preview banner does not exist in an LMS.
async function fitPage(browser: Browser, base: string, size: string, motion: boolean, opened: Page | null = null): Promise<Page> {
  const [width, height] = size.split('x').map(Number);
  const page = opened ?? await browser.newPage({ viewport: { width, height }, reducedMotion: motion ? 'no-preference' : 'reduce' });
  await page.addInitScript(() => { window.ELABORA_TEST = { virtualTime: true }; }); // narrated screens hold still
  await page.goto(`${base}/pkg/fit/index.html`);
  await page.waitForFunction(() => window.__elabora);
  await page.evaluate(openAllScreens);
  return page;
}

// One screen at one size, animations off: room, layout shift, styles, contrast. On a phone: the
// contrast down the page and the bars that wrap.
async function measureScreen(page: Page, id: string, size: FitSize, mode: string): Promise<ScreenFit> {
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
  if (size.role === 'phone') {
    const contrast = await measureContrast(page, true);
    const wrapped = await page.evaluate(wrappedBars);
    return { ...initial, overflow: 0, below: [], ...(contrast.length ? { contrast } : {}), ...(wrapped.length ? { wrapped } : {}) };
  }
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
    for (const [block, box] of Object.entries(after)) {
      const previous = before[block];
      if (!previous) continue;
      const growth = box.h - previous.h; const offset = box.y - previous.y;
      if (Math.abs(growth) > 1) grew.push({ block, px: growth });
      else if (Math.abs(offset) > 1) moved.push(block);
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
  return { ...initial, ...(shift ? { shift } : {}), ...(contrast.length ? { contrast } : {}), ...(styles.length ? { styles } : {}), ...(feedback.length ? { feedback } : {}) };
}

// A scroll page once more with animations on, down the page by a quarter of a window. Scroll-driven
// animations (a fade as text leaves, a block rising into place) set what text looks like at each
// position: text is read in the middle of the window (20 to 80 % of its height), and must be
// readable there at least once (an entrance may still be fading in when it enters the middle; text
// kept faint is reported). Only the windows where a scroll-driven animation applies to that middle
// are read: elsewhere the page shows what the first measure read.
const SCROLLED_BAND: Band = { top: 0.2, bottom: 0.8 };
async function scrolledContrast(moving: Page, screen: ScreenFit): Promise<void> {
  await moving.evaluate((id) => { window.__elabora.go(id ?? ''); window.__elabora.revealAll(); (document.activeElement as HTMLElement | null)?.blur?.(); }, screen.screen);
  await moving.evaluate(() => window.__elabora.ready());
  if (!(await moving.evaluate(scrollDrivenIn, null))) return;
  // What the scroll cannot finish, down the whole page (W_SCROLL_ANIMATION_UNFINISHED).
  const { unfinished } = await measureMotion(moving, { scope: 'page' });
  if (unfinished.length) screen.unfinished = unfinished;
  const known = new Set((screen.contrast || []).map((found) => `${found.block}\u0000${found.text}`));
  const scrolled = (await measureContrast(moving, true, SCROLLED_BAND, { keep: 'best', stride: 0.25, known, scrollDriven: true })).filter((found) => !known.has(`${found.block}\u0000${found.text}`)).map((found): MeasuredContrast => ({ ...found, scrolled: true }));
  if (scrolled.length) screen.contrast = [...(screen.contrast || []), ...scrolled];
}

// In the page: the player's bars whose items do not stand on one line. An item as wide as the line
// is a row of its own by design, not a line the others overflow onto: the narration's controls on a
// phone (D58, player.css « Phones and narrow windows »).
function wrappedBars(): string[] {
  const out: string[] = [];
  for (const bar of document.querySelectorAll<HTMLElement>('.t-bar')) {
    if (bar.hidden || !bar.getClientRects().length) continue;
    const items = [...bar.querySelectorAll<HTMLElement>(':scope > *')].filter((node) => {
      const style = getComputedStyle(node);
      return node.getClientRects().length && style.position !== 'absolute' && style.flexBasis !== '100%' && node.offsetHeight > 8;
    });
    const boxes = items.map((node) => node.getBoundingClientRect());
    if (boxes.length < 2) continue;
    // The first line ends where its shortest item ends: an item that starts below it is on another
    // line (a short item centred in the line starts above it).
    const firstLine = Math.min(...boxes.map((box) => box.bottom));
    if (boxes.some((box) => box.top >= firstLine - 1)) out.push([...bar.classList].find((name) => name.startsWith('t-bar--')) ?? 't-bar');
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
    for (const stuck of size.role === 'reference' ? screen.unfinished || [] : []) {
      out.push({ code: 'W_SCROLL_ANIMATION_UNFINISHED', severity: 'warning', target: screen.screen, message: `Screen "${screen.screen}"${stuck.block ? `, ${stuck.block}` : ''}: the animation "${stuck.name}" of ${stuck.target} ${stuck.atEnd === null ? 'has not started' : `stops at ${Math.round(stuck.atEnd * 100)} %`} when the page is scrolled to the bottom.`, rule: 'F1' });
    }
    const phone = size.role === 'phone' ? ` on a phone (${size.size.replace('x', '×')})` : '';
    for (const contrast of size.role !== 'minimum' ? screen.contrast || [] : []) {
      out.push({ code: 'W_TEXT_CONTRAST_MEASURED', severity: 'warning', target: screen.screen, message: `Screen "${screen.screen}"${contrast.block ? `, ${contrast.block}` : ''}: "${contrast.text}" reaches ${contrast.ratio}:1 against what is behind it (needs ${contrast.need}:1)${phone}${contrast.scrolled ? ', as the page scrolls, with its animations' : ''}.`, rule: 'F1' });
    }
    for (const bar of screen.wrapped || []) {
      out.push({ code: 'W_PLAYER_BAR_WRAPS', severity: 'warning', target: screen.screen, message: `Screen "${screen.screen}": the player's bar ${bar} goes onto two lines${phone}; give it fewer items (elabora player) or shorter labels.`, rule: 'F1' });
    }
    if (fit.mode !== 'slides' || size.role === 'phone') continue;
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
