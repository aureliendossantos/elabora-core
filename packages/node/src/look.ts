import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Browser, Page } from 'playwright-core';
import { screenOrder } from '@elabora/core/project/load';
import { renderScreen } from '@elabora/core/render/screen';
import type { CanvasApi } from '@elabora/player/canvas';
import { createCanvasHandler } from './canvas/host.ts';
import { startServer } from './emulator/server.ts';
import type { RouteHandler } from './emulator/server.ts';
import { browserIdentity, launchMotionBrowsers } from './emulator/browser.ts';
import type { MotionBrowsers } from './emulator/browser.ts';
import type { ReadyReport } from './emulator/page-globals.ts';
import { loadProjectFromDir } from './project-reader.ts';
import { contactSheet, fullPageWithObjects } from './capture.ts';
import { scrollFilmstrip, scrollStops, scrollWindow } from './scroll-strip.ts';
import { measureMotion } from './motion-report.ts';
import type { MotionReport } from './motion-report.ts';
import { captureClip, closeUpClip, objectControls, objectFrameOf, playActions } from './look-inspect.ts';
import type { ObjectHost } from '@elabora/player/object-host';
import { timelineMarks } from '@elabora/core/narration/view';
import { isTimedLayer } from '@elabora/core/narration/timeline';
import { timelineVoiceLines } from '@elabora/core/narration/voice-lines';
import { lineAnchor } from '@elabora/core/narration/narration';
import { resolveAt } from '@elabora/core/narration/anchor-text';
import { findDialogue } from '@elabora/core/dialogue/project';
import { playDialogue } from '@elabora/core/dialogue/play';
import { codeVersion } from './code-version.ts';
import { findLookServer, lookServerFile, parseLookAction, TOKEN_HEADER } from './look-client.ts';
import type { BackdropReport, LookAction, LookRequest, LookResult, LookServerInfo } from './look-client.ts';
import { writeFileAtomic } from './util/fs.ts';
import { pageStyleConflicts } from './style-cascade.ts';
import { errorMessage } from './util/values.ts';

export * from './look-client.ts';

// ── Looking while designing ───────────────────────────────────────────
// A capture (capture.ts) builds the package, starts a browser, boots the course and its free objects,
// and closes everything: seconds every time. A looker keeps one canvas server (canvas/host.ts) and one
// browser drawing with the GPU, and shows a screen as the editor canvas does: rendered from the files
// as they are now (renderScreen, no build), updated in place in the page, so a free object whose code
// and assets did not change keeps running. The page shows the player's header and footer, inert, so
// a slide has the room it has in a package. A look after an edit takes a fraction of a second.
// The full build and its checks (elabora build, fit, test, object test) stay the final word.
//
// A look server keeps a looker for a project between commands: elabora look and the MCP tool elabora_look
// find it through <data>/look/server.json and start it when none answers (look-client.ts); it stops
// after a quiet while. Its page (url) follows the looks and the project's files, for a browser pane.

export interface LookerOptions {
  port?: number;
  // Shows the screen last looked at again when the project's files change, for the pages a browser
  // pane shows (default true).
  live?: boolean;
}

export interface Looker {
  readonly root: string;
  readonly base: string; // http://127.0.0.1:<port>
  // The page that follows the looks, for a browser pane: free objects load from a second port of the
  // server (@elabora/player frames.ts), which in-app browsers of agent apps accept.
  readonly url: string;
  look(request?: LookRequest): Promise<LookResult>;
  // Serves more under this prefix (the look server's API).
  route(prefix: string, handler: RouteHandler): void;
  close(): Promise<void>;
}

type LookWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi; __lookErrors: { id: string | number | null; message: string }[] };

interface LookPage {
  key: string;
  page: Page;
  errors: string[];
  // Frames of free objects that loaded in the page (a restart counts again).
  frames: number;
}

const MAX_PAGES = 3;
// Tool folders and files that are not the course's.
const NOT_COURSE = /^(\.elabora|dist|node_modules|\.git)([\\/]|$)/;

// The elements a selector matches, with the styles that place and paint them and their parent's layout
// (what centres a child: align-items, justify-content, text-align…).
const SELECT_STYLES = ['display', 'position', 'inset', 'z-index', 'width', 'height', 'margin', 'padding', 'align-self', 'justify-self', 'text-align', 'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border', 'opacity', 'transform', 'overflow'];
const PARENT_STYLES = ['display', 'flex-direction', 'align-items', 'justify-content', 'justify-items', 'grid-template-columns', 'text-align', 'gap'];
export function selectedElements(page: Page, selector: string): Promise<NonNullable<Extract<LookResult, { ok: true }>['selected']>> {
  return page.evaluate(({ selector, own, parentKeys }) => {
    const name = (node: Element) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${[...node.classList].slice(0, 4).map((c) => `.${c}`).join('')}`;
    const pick = (node: Element, keys: string[]) => { const style = getComputedStyle(node); return Object.fromEntries(keys.map((key) => [key, style.getPropertyValue(key)]).filter(([, value]) => value !== '')); };
    let nodes: Element[];
    try { nodes = [...document.querySelectorAll(selector)]; } catch (error) { return { selector, count: 0, elements: [], selectorError: String((error as Error).message) }; }
    return {
      selector, count: nodes.length,
      elements: nodes.slice(0, 5).map((node) => {
        const box = node.getBoundingClientRect();
        return { element: name(node), rect: { x: Math.round(box.x + scrollX), y: Math.round(box.y + scrollY), width: Math.round(box.width), height: Math.round(box.height) }, styles: pick(node, own), parent: node.parentElement ? { element: name(node.parentElement), styles: pick(node.parentElement, parentKeys) } : null };
      })
    };
  }, { selector, own: SELECT_STYLES, parentKeys: PARENT_STYLES });
}

// The backdrop as the page shows it (null: the course has none).
export function backdropReport(page: Page): Promise<BackdropReport | null> {
  return page.evaluate(() => {
    const node = document.querySelector<HTMLElement>('.t-backdrop');
    if (!node) return null;
    const holder = node.querySelector<HTMLElement>('.t-backdrop-object');
    const state = holder?.dataset.state;
    return {
      screen: node.dataset.screen ?? null, section: node.dataset.section ?? null, step: node.dataset.step ? Number(node.dataset.step) : null, variant: node.dataset.variant ?? null, hidden: node.hidden === true,
      object: holder ? { id: holder.dataset.object || '', state: state === 'ready' || state === 'failed' ? state : 'starting' } : null
    };
  });
}

export async function startLooker(dir: string, { port = 0, live = true }: LookerOptions = {}): Promise<Looker> {
  const root = path.resolve(dir);
  const server = await startServer({ port, frames: true });
  const canvas = createCanvasHandler({ root });
  server.route('/canvas/', canvas.handle);
  const page = `${server.base}/canvas/${canvas.page}&chrome=player`;
  // One browser for pages with animations off (it prefers reduced motion as a whole, which reaches
  // SVGs shown through <img>), one for the others, each started when first asked for.
  let browsers: MotionBrowsers | null = null;
  // By window size and motion, the most recently used last.
  const pages = new Map<string, Promise<LookPage>>();
  let seq = 0;
  let shown: { screen: string; state: 'initial' | 'answered'; step: number | null; layer: string | null; language?: string; at?: { line: string; edge: 'start' | 'end' } | { time: number } } | null = null;
  // One look (or live update) at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  async function openPage(key: string, width: number, height: number, motion: boolean): Promise<LookPage> {
    browsers ??= launchMotionBrowsers({ rendering: 'gpu' });
    const opened = await (await browsers.for(motion)).newPage({ viewport: { width, height }, reducedMotion: motion ? 'no-preference' : 'reduce' });
    const target: LookPage = { key, page: opened, errors: [], frames: 0 };
    opened.on('console', (message) => { if (message.type() === 'error') target.errors.push(message.text()); });
    opened.on('pageerror', (error) => target.errors.push(error.message));
    opened.on('framenavigated', (frame) => { if (frame !== opened.mainFrame() && /\/frame\.html(\?|$)/.test(frame.url())) target.frames++; });
    // Frames as packages have them (an opaque origin): headless Chrome takes them.
    await opened.goto(page);
    await opened.waitForFunction(() => (window as LookWindow).__elaboraCanvas);
    await opened.evaluate(() => {
      const view = window as LookWindow;
      view.__lookErrors = [];
      view.__elaboraCanvas.onMessage((message) => { if (message.type === 'elabora/error') view.__lookErrors.push({ id: message.id, message: message.message }); });
    });
    return target;
  }

  async function pageFor(width: number, height: number, motion: boolean): Promise<LookPage> {
    const key = `${width}x${height}${motion ? '-motion' : ''}`;
    let found = pages.get(key);
    pages.delete(key);
    if (!found) {
      found = openPage(key, width, height, motion);
      found.catch(() => pages.delete(key));
    }
    pages.set(key, found);
    // The least recently used page goes (its objects stop running).
    for (const [other, stale] of pages) {
      if (pages.size <= MAX_PAGES) break;
      pages.delete(other);
      void stale.then((old) => old.page.close()).catch(() => {});
    }
    return found;
  }

  async function look(request: LookRequest): Promise<LookResult> {
    const started = performance.now();
    const project = loadProjectFromDir(root);
    if (!project.course) return { ok: false, error: 'course.json is missing or does not parse (elabora validate says why).' };
    const ids = screenOrder(project).map((entry) => entry.id);
    const screen = request.screen ?? (shown && project.screens.has(shown.screen) ? shown.screen : ids[0]);
    const broken = project.loadErrors.find((error) => error.file === `screens/${screen}.json`);
    if (broken) return { ok: false, error: `${broken.file}: ${broken.message} (${broken.code})` };
    if (!screen || !project.screens.has(screen)) return { ok: false, error: `Unknown screen "${screen ?? ''}". Screens: ${ids.join(', ')}` };
    const layers = (project.screens.get(screen)?.data.layers ?? []).map((layer) => layer.id);
    if (request.layer && !layers.includes(request.layer)) return { ok: false, error: `No layer "${request.layer}" on screen "${screen}"${layers.length ? `. Layers: ${layers.join(', ')}` : ''}.` };
    // A line (as phase 1 shows it: its caption on), or any moment: a word, seconds, a step, a time.
    let at: { line: string; edge: 'start' | 'end' } | { time: number } | null = null;
    // A sheet of a timed screen shows the marks of its timeline; of another screen, the page down its length.
    const positions = request.scroll ?? [];
    // A layer with a timeline of its own (D62): at and the sheet are on its timeline.
    const timedLayer = request.layer && isTimedLayer(project, project.screens.get(screen)?.data, request.layer) ? request.layer : null;
    const marks = request.sheet && !positions.length ? timelineMarks(project, screen, request.language, { layer: timedLayer }) : null;
    const downThePage = positions.length > 1 || (!!request.sheet && !marks);
    const actions: LookAction[] = [];
    for (const source of request.act ?? []) {
      const action = parseLookAction(source);
      if ('error' in action) return { ok: false, error: action.error };
      actions.push(action);
    }
    if (actions.length && !request.block) return { ok: false, error: 'act drives the free object of a block, or chooses in a dialogue block: give block too.' };
    // A dialogue block (D61): its choices, played by the core's walk, then the thread shown at rest
    // after them by the canvas (RenderView.dialogue), as the app's editor shows a path.
    const dialogueRef = request.block ? findDialogue(project, request.block) : null;
    let dialogue: { block: string; choices: string[] } | undefined;
    let played: ReturnType<typeof playDialogue> | undefined;
    if (dialogueRef && dialogueRef.screen === screen) {
      const other = actions.find((action) => action.kind !== 'choose');
      if (other) return { ok: false, error: `${other.source}: a dialogue block takes choose:<option> (one per decision met, retries included).` };
      const choices = actions.map((action) => (action as Extract<LookAction, { kind: 'choose' }>).option);
      played = playDialogue(project, dialogueRef, choices, { language: request.language });
      if (!played.ok) return { ok: false, error: `${played.error}${played.offered.length ? ` (offered: ${played.offered.join(', ')})` : ''}` };
      dialogue = { block: dialogueRef.id, choices };
    } else if (actions.some((action) => action.kind === 'choose')) return { ok: false, error: `choose: is for a dialogue block of this screen, and "${request.block}" is not one.` };
    if (actions.length && downThePage) return { ok: false, error: 'act plays once, before one capture: not with a sheet or several scroll positions.' };
    if (marks && (request.block || actions.length || request.scale)) return { ok: false, error: `A sheet of a timed screen captures the window at each mark: not with block, act or scale (look at a mark with at).` };
    if (request.scale !== undefined && request.scale !== 1 && request.scale !== 2) return { ok: false, error: `scale is 1 or 2 (not ${String(request.scale)}).` };
    if (marks) at = { time: marks[0].time };
    else if (request.at) {
      const line = lineAnchor(request.at);
      const lines = timelineVoiceLines(project, screen, timedLayer).map((candidate) => candidate.line.id);
      if (line && lines.includes(line.line)) at = line;
      else {
        const found = resolveAt(project, screen, request.at, { language: request.language, layer: timedLayer });
        if ('error' in found) return { ok: false, error: found.error };
        at = { time: found.time };
      }
    }
    const view = { screen, state: request.state === 'answered' ? 'answered' as const : 'initial' as const, step: request.step ?? null, layer: request.layer ?? null, language: request.language, ...(at ? { at } : {}) };
    let render;
    try {
      render = renderScreen(project, screen, { state: view.state, step: view.step ?? undefined, layer: view.layer ?? undefined, language: view.language, ...(at ? { at } : {}), ...(dialogue ? { dialogue } : {}) });
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    const width = request.width || 1600;
    const height = request.height || 900;
    // Down the page, animations follow the scroll: animations on.
    const motion = !!request.motion || positions.length > 0 || downThePage;
    const target = await pageFor(width, height, motion);
    const { page: tab } = target;
    target.errors.length = 0;
    const framesBefore = target.frames;
    // Shows a render in the page: null once it is there, else why not.
    const show = async (shownRender: typeof render): Promise<string | null> => {
      const id = ++seq;
      canvas.push(shownRender, { id });
      await tab.waitForFunction((wanted) => {
        const canvasWindow = window as LookWindow;
        return canvasWindow.__elaboraCanvas.layout().id === wanted || canvasWindow.__lookErrors.some((error) => error.id === wanted);
      }, id, { timeout: 20000 });
      return tab.evaluate((wanted) => (window as LookWindow).__lookErrors.find((error) => error.id === wanted)?.message ?? null, id);
    };
    shown = view;
    const failed = await show(render);
    if (failed !== null) return { ok: false, error: `The canvas could not show "${screen}": ${failed}` };
    await tab.evaluate(() => { scrollTo(0, 0); (document.activeElement as HTMLElement | null)?.blur?.(); });
    const ready = await tab.evaluate(() => (window as LookWindow).__elaboraCanvas.ready(15000)) as ReadyReport | null;
    const startedFrames = target.frames - framesBefore;
    await settle(tab, startedFrames > 0 ? { min: 300, max: 1500 } : { min: 0, max: 0 });
    const metrics = await tab.evaluate(() => {
      const height = document.documentElement.scrollHeight;
      return { height, windows: Math.round((height / innerHeight) * 10) / 10, overflow: Math.max(0, Math.round(height - innerHeight)) };
    });
    const blocks = await tab.evaluate(() => (window as LookWindow).__elaboraCanvas.layout().blocks);
    const styles = await tab.evaluate(pageStyleConflicts).catch(() => []);
    const objects = ready?.objects ?? [];
    let type: 'png' | 'jpeg' = request.type ?? 'jpeg';
    const scale = request.scale ?? 1;
    let image: Buffer;
    let report: MotionReport | undefined;
    let scrolled: { top: number; label: string }[] | undefined;
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    let acted: { actions: string[]; state: unknown; events: { name: string; payload: unknown }[] } | undefined;
    // The block cropped from the window as it stands.
    const closeUp = async (block: string): Promise<Buffer> => {
      const box = await closeUpClip(tab, block);
      if (!box) throw new Error(`Block "${block}" is not in the window at ${await tab.evaluate(() => Math.round(scrollY))} px: scroll to it (--scroll ${block}).`);
      const scroll = await tab.evaluate(() => ({ x: Math.round(scrollX), y: Math.round(scrollY) }));
      clip = { x: box.x + scroll.x, y: box.y + scroll.y, width: box.width, height: box.height, scale };
      // PNG for a close-up, unless it is larger than 2 megapixels (a wide block at scale 2: several MB, more than agents' image inputs take).
      type = request.type ?? (box.width * box.height * scale * scale <= 2_000_000 ? 'png' : 'jpeg');
      return captureClip(tab, box, { scale, type });
    };
    if (request.block && !blocks.some((block) => block.id === request.block)) return { ok: false, error: `No block "${request.block}" on screen "${screen}". Blocks: ${blocks.map((block) => block.id).join(', ')}` };
    const inspect = async (): Promise<Buffer> => {
      if (downThePage) {
        if (metrics.overflow <= 0 && !positions.length) throw new Error(`Screen "${screen}" has no timeline (no narration, no timed block, no cue) and does not scroll at ${width}×${height}: a sheet shows the marks of a timeline, or a page down its length.`);
        const stops = await scrollStops(tab, positions.length ? positions : ['0%', '25%', '50%', '75%', '100%']);
        // The block where the window shows it; the window where it does not.
        const windowShot = () => tab.screenshot({ type: 'jpeg', quality: 85 });
        const frames = await scrollFilmstrip(tab, stops, { settleMs: objects.length ? 450 : 120, capture: request.block ? async () => (await closeUpClip(tab, request.block!) ? closeUp(request.block!) : windowShot()) : windowShot });
        scrolled = stops;
        report = await measureMotion(tab, request.block ? { block: request.block } : { scope: 'page' });
        return contactSheet(tab.context().browser()!, frames, `${screen}${request.block ? ` — ${request.block}` : ''}: down the page${view.language ? ` (${view.language})` : ''}`);
      }
      const [stop] = await scrollStops(tab, positions.length ? positions : [request.block!]);
      // A dialogue taller than the window: its end, where the last choices led, above the bottom bar.
      const end = played && !positions.length ? await tab.evaluate((id) => {
        const node = document.querySelector(`[data-block="${CSS.escape(id)}"]`);
        if (!node) return null;
        const bar = document.querySelector('.t-bar-bottom')?.getBoundingClientRect().height ?? 0;
        return Math.round(scrollY + node.getBoundingClientRect().bottom - (innerHeight - bar) + 16);
      }, request.block!) : null;
      const top = await scrollWindow(tab, end !== null && end > stop.top ? end : stop.top);
      scrolled = [{ ...stop, top }];
      // Objects that follow the scroll hear where they are, then draw.
      if (objects.length) await tab.waitForTimeout(450);
      if (played) {
        await settle(tab, { min: 300, max: 1500 });
        acted = { actions: actions.map((action) => action.source), state: { waiting: played.waiting, offered: played.offered, ended: played.ended, ending: played.ending?.id ?? null, score: played.score }, events: [] };
      } else if (actions.length) {
        const frame = await objectFrameOf(tab, request.block!);
        if (typeof frame === 'string') throw new Error(frame);
        const before = await tab.evaluate((id) => ((window as LookWindow).__elaboraCanvas.objectHost(id) as ObjectHost | undefined)?.emitted.length ?? 0, request.block!);
        const failure = await playActions(tab, frame, actions);
        if (failure) throw new Error(failure);
        await settle(tab, { min: 300, max: 1500 });
        // A click scrolls what it clicks into view.
        scrolled = [{ ...stop, top: await tab.evaluate(() => Math.round(scrollY)) }];
        acted = await tab.evaluate(async ({ id, before: seen, sources }) => {
          const host = (window as LookWindow).__elaboraCanvas.objectHost(id) as ObjectHost | undefined;
          let state: unknown = null;
          // An object that never answers (its start failed) must not hold the look server.
          const late = new Promise((resolve) => setTimeout(() => resolve({ error: 'the object did not answer getState in 3 s' }), 3000));
          try { state = host ? await Promise.race([host.getState(), late]) : null; } catch (error) { state = { error: String(error) }; }
          return { actions: sources, state, events: host ? host.emitted.slice(seen) : [] };
        }, { id: request.block!, before, sources: actions.map((action) => action.source) });
      }
      const captured = request.block ? await closeUp(request.block) : await tab.screenshot(type === 'jpeg' ? { type, quality: 90 } : { type });
      report = await measureMotion(tab, request.block ? { block: request.block } : { scope: 'window' });
      return captured;
    };
    if (!marks && (downThePage || positions.length || request.block)) {
      try {
        image = await inspect();
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    } else if (marks) {
      // One capture of the window per mark, the screen rendered at its time, then one sheet.
      const frames = [{ ms: marks[0].time * 1000, png: await tab.screenshot({ type: 'jpeg', quality: 85 }), label: marks[0].label }];
      for (const mark of marks.slice(1)) {
        const failure = await show(renderScreen(project, screen, { state: view.state, step: view.step ?? undefined, layer: view.layer ?? undefined, language: view.language, at: { time: mark.time } }));
        if (failure !== null) return { ok: false, error: `The canvas could not show "${screen}" at ${mark.label}: ${failure}` };
        await tab.evaluate(() => (window as LookWindow).__elaboraCanvas.ready(15000));
        await settle(tab, { min: 0, max: 0 });
        frames.push({ ms: mark.time * 1000, png: await tab.screenshot({ type: 'jpeg', quality: 85 }), label: mark.label });
      }
      shown = { ...view, at: { time: marks.at(-1)!.time } };
      image = await contactSheet(tab.context().browser()!, frames, `${screen}: ${marks.length} marks${view.language ? ` (${view.language})` : ''}`);
    } else if (request.full !== false && !view.layer && !at) {
      // In a full-page capture the footer sits at the end of the page, not over the content.
      const style = await tab.addStyleTag({ content: '.t-bar { position: static !important; }' });
      try {
        image = await fullPageWithObjects(tab, objects.length > 0, { settleMs: 300, type });
      } finally {
        await style.evaluate((node) => { node.parentNode?.removeChild(node); });
      }
      if (motion) report = await measureMotion(tab, { scope: 'page' });
    } else {
      image = await tab.screenshot(type === 'jpeg' ? { type, quality: 90 } : { type });
      if (motion) report = await measureMotion(tab, { scope: 'window' });
    }
    const backdrop = await backdropReport(tab);
    // Where the objects' controls are, and what covers them (the window as captured).
    const controls = objects.length ? await objectControls(tab).catch(() => []) : [];
    const selected = request.select ? await selectedElements(tab, request.select) : null;
    return {
      ok: true, screen, width, height, state: view.state, step: view.step, layer: view.layer,
      presentation: project.course.presentation?.mode === 'slides' ? 'slides' : 'scroll',
      type: marks || downThePage ? 'png' : type, image, objects, started: startedFrames, page: metrics, blocks, styles, ...(marks ? { marks: marks.map((mark) => ({ time: mark.time, label: mark.label })) } : {}),
      ...(scrolled ? { scrolled } : {}), ...(clip ? { clip } : {}), ...(report ? { motion: report } : {}), ...(acted ? { act: acted } : {}), ...(backdrop ? { backdrop } : {}), ...(controls.length ? { controls } : {}), ...(selected ? { selected } : {}), consoleErrors: [...target.errors],
      browser: browserIdentity(tab.context().browser()!),
      ms: Math.round(performance.now() - started)
    };
  }

  // The screen last looked at, shown again in the pages a browser pane opened (the looker's own
  // pages show it at their next look).
  async function refresh(): Promise<void> {
    if (!shown || canvas.pages <= pages.size) return;
    try {
      const project = loadProjectFromDir(root);
      if (!project.course || !project.screens.has(shown.screen)) return;
      canvas.push(renderScreen(project, shown.screen, { state: shown.state, step: shown.step ?? undefined, layer: shown.layer ?? undefined, language: shown.language, ...(shown.at ? { at: shown.at } : {}) }), { id: ++seq });
    } catch {
      // A file mid-write: the next change shows.
    }
  }
  let watcher: fs.FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (live) {
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, file) => {
        if (file && NOT_COURSE.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void serial(refresh), 150);
      });
      watcher.on('error', () => {});
    } catch {
      watcher = null;
    }
  }

  return {
    root,
    base: server.base,
    url: `${page}&frames=${server.framesPort}`,
    look: (request = {}) => serial(() => look(request)),
    route: (prefix, handler) => server.route(prefix, handler),
    async close() {
      clearTimeout(timer);
      watcher?.close();
      await queue;
      const opened = browsers;
      browsers = null;
      await opened?.close();
      canvas.close();
      await server.close();
    }
  };
}

// Until the page holds still: its height and the boxes of its object frames the same over two
// measures 100 ms apart (objects that started draw their first frames, auto-height ones resize),
// after min ms and at most max ms. With max 0: two animation frames.
async function settle(page: Page, { min, max }: { min: number; max: number }): Promise<void> {
  const begin = Date.now();
  let previous = '';
  for (;;) {
    const now = await page.evaluate(() => new Promise<string>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const frames = [...document.querySelectorAll('.t-object-frame')].map((node) => { const box = node.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; });
      resolve(JSON.stringify([document.documentElement.scrollHeight, frames]));
    }))));
    const elapsed = Date.now() - begin;
    if (elapsed >= max || (now === previous && elapsed >= min)) return;
    previous = now;
    await page.waitForTimeout(100);
  }
}

// ── The look server ───────────────────────────────────────────────────
export interface LookServer {
  info: LookServerInfo;
  // Resolves once it stopped (idle, stop request, or stop()).
  closed: Promise<void>;
  stop(): Promise<void>;
}


// Serves looks of a project until idleMs pass without one (or a stop request). Refuses when another
// look server answers for the project.
//   GET  /look/info   LookServerInfo
//   POST /look/shot   LookRequest → LookResult (image in base64)
//   POST /look/stop
// Every request carries the token of server.json (x-elabora-look), which only this user can read.
export async function serveLooks(dir: string, { idleMs = 15 * 60_000, port = 0 }: { idleMs?: number; port?: number } = {}): Promise<LookServer> {
  const root = path.resolve(dir);
  const running = await findLookServer(root);
  if (running) throw new Error(`A look server already runs for this course (process ${running.pid}).`);
  const looker = await startLooker(root, { port });
  const info: LookServerInfo = { pid: process.pid, base: looker.base, token: crypto.randomBytes(16).toString('hex'), url: looker.url, version: codeVersion(), root };
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | null = null;
  let done: () => void = () => {};
  const closed = new Promise<void>((resolve) => { done = resolve; });
  const stop = () => {
    stopping ??= (async () => {
      clearTimeout(idle);
      try {
        const written: unknown = JSON.parse(fs.readFileSync(lookServerFile(root), 'utf8'));
        if (typeof written === 'object' && written !== null && 'pid' in written && written.pid === process.pid) fs.rmSync(lookServerFile(root), { force: true });
      } catch {
        // Gone already.
      }
      await looker.close();
      done();
    })();
    return stopping;
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => void stop(), idleMs);
  };
  looker.route('/look/', async (request, response, url, send) => {
    if (request.headers[TOKEN_HEADER] !== info.token) return send(403, 'forbidden');
    touch();
    const json = 'application/json';
    if (url.pathname === '/look/info') return send(200, JSON.stringify(info), json);
    if (request.method !== 'POST') return send(405, 'method not allowed');
    if (url.pathname === '/look/stop') {
      send(200, JSON.stringify({ stopped: true }), json);
      setImmediate(() => void stop());
      return;
    }
    if (url.pathname !== '/look/shot') return send(404, 'not found');
    let lookRequest: LookRequest;
    try { lookRequest = JSON.parse(await readBody(request)) as LookRequest; } catch { return send(400, 'bad request'); }
    const result = await looker.look(lookRequest).catch((error: unknown): LookResult => ({ ok: false, error: errorMessage(error) }));
    touch();
    send(200, JSON.stringify(result.ok ? { ...result, image: result.image.toString('base64') } : result), json);
  });
  writeFileAtomic(lookServerFile(root), `${JSON.stringify(info, null, 2)}\n`);
  touch();
  return { info, closed, stop };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

