import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Browser, BrowserContext, Frame, Page } from 'playwright-core';
import type { Diagnostic, LmsProfile } from '@elabora/format';
import { resolveProfiles } from '@elabora/core/lms/profiles';
import { createReporter } from '@elabora/core/diagnostics/index';
import type { Reporter } from '@elabora/core/diagnostics/index';
import { startServer } from './server.ts';
import type { EmulatorServer } from './server.ts';
import { browserIdentity, launchBrowser } from './browser.ts';
import type { UnloadVariant } from './browser.ts';
import type { LmsCall, PlayerBlock } from './page-globals.ts';
import { readZip } from '../zip.ts';
import { loadAxe, axeViolations } from '../util/axe.ts';
import type { AxeViolation } from '../util/axe.ts';
import { fieldOf, errorMessage } from '../util/values.ts';

// Instrumentation injected in every frame: counts unload/beforeunload listeners and synchronous XHR.
const INSTRUMENT = () => {
  // Narrated screens run on a virtual clock: the emulator plays them to their end at once.
  window.ELABORA_TEST = { virtualTime: true };
  window.__unloadListeners = 0;
  window.__syncXHR = 0;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (type === 'unload' || type === 'beforeunload') window.__unloadListeners++;
    return add.call(this, type, listener, options);
  };
  for (const prop of ['onunload', 'onbeforeunload']) {
    try { Object.defineProperty(window, prop, { configurable: true, set() { window.__unloadListeners++; }, get() { return null; } }); } catch { /* ignore */ }
  }
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
    if (async === false) window.__syncXHR++;
    return open.call(this, method, url, async === undefined ? true : async, username, password);
  };
};

export interface TestPackageOptions {
  dir?: string; // unzipped package folder
  zip?: string; // a .zip (any SCORM 1.2 package, Elabora or not)
  profiles?: string[];
  browsers?: string[]; // default ['chromium']
  modes?: string[]; // launch modes, among those of each profile
  accessibility?: boolean; // axe-core on every screen and phone width, in the first run
  unloadVariants?: boolean; // false: Chrome as it is, instead of unload deprecated and allowed
  stallMs?: number;
  parallel?: number; // runs side by side
  onRun?: (run: PackageRun) => void; // called as each run ends, in order (the CLI prints it)
}

export interface PackageRun {
  profile: string;
  launch: string;
  browser: string;
  browserVersion?: string;
  ok: boolean;
  failures: Diagnostic[];
  checks: { name: string; ok: boolean }[];
}

export interface AccessibilityReport {
  screens: number; // screen states checked
  violations: number;
  details: (AxeViolation & { screen: string; state: string })[];
  overflow?: { screen: string; scrollWidth: number; viewport: number; culprit: string | null }[];
}

export interface PackageTestResult {
  ok: boolean;
  runs: PackageRun[];
  accessibility?: AccessibilityReport | null; // null without accessibility checks; left out when the package was refused
  diagnostics: Diagnostic[];
}

// testPackage({ dir | zip, profiles, browsers, modes, accessibility, … }): runs a package in the
// LMS emulator. Elabora packages get the full scenario; other packages get the generic checks.
export async function testPackage(options: TestPackageOptions): Promise<PackageTestResult> {
  const profiles = resolveProfiles(options.profiles);
  const browsers = options.browsers?.length ? options.browsers : ['chromium'];
  let dir = options.dir;
  let extracted: string | null = null;
  if (!dir && options.zip) {
    extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-pkg-'));
    const { files } = readZip(fs.readFileSync(options.zip));
    if (!files.has('imsmanifest.xml')) {
      const reporter = createReporter();
      reporter.emit('E_MANIFEST_NOT_AT_ROOT', { file: path.basename(options.zip) });
      fs.rmSync(extracted, { recursive: true, force: true });
      return { ok: false, runs: [], diagnostics: reporter.items };
    }
    for (const [name, data] of files) {
      const file = path.join(extracted, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
    dir = extracted;
  }
  if (!dir) throw new Error('testPackage: give dir (a package folder) or zip (a package file)');
  const packageDir = dir;
  const manifest = fs.readFileSync(path.join(packageDir, 'imsmanifest.xml'), 'utf8');
  const mastery = /<adlcp:masteryscore>(\d+)<\/adlcp:masteryscore>/.exec(manifest)?.[1];
  const isElabora = fs.existsSync(path.join(packageDir, 'elabora/player.js'));

  // Every run (browser variant × profile × launch mode) has its own windows and LMS registration:
  // they run side by side, a few at a time, and are reported in order. The first run also checks
  // accessibility (axe-core, phone width).
  const server = await startServer();
  const tasks: RunTask[] = [];
  for (const browserName of browsers) {
    const variants: UnloadVariant[] = ['chromium', 'electron', 'chrome', 'msedge', 'playwright'].includes(browserName) ? (options.unloadVariants === false ? ['default'] : ['deprecated', 'allowed']) : ['default'];
    for (const unload of variants) for (const profile of profiles) {
      const supported = new Set<string>(profile.launch.modes);
      const modes: string[] = options.modes?.length ? options.modes.filter((mode) => supported.has(mode)) : profile.launch.modes;
      for (const mode of modes) tasks.push({ browserName, unload, profile, mode, label: `${browserName}${unload !== 'default' ? `(unload ${unload})` : ''}` });
    }
  }
  const runs: PackageRun[] = [];
  const accessibility: AccessibilityReport = { screens: 0, violations: 0, details: [] };
  const browsersOpen = new Map<string, Promise<Browser>>();
  const browserFor = (task: RunTask): Promise<Browser> => {
    const key = `${task.browserName}/${task.unload}`;
    let browser = browsersOpen.get(key);
    if (!browser) { browser = launchBrowser(task.browserName, { unload: task.unload }); browsersOpen.set(key, browser); }
    return browser;
  };
  let reported = 0;
  const runTask = async (task: RunTask, index: number) => {
    const result: PackageRun = { profile: task.profile.id, launch: task.mode, browser: task.label, ok: true, failures: [], checks: [] };
    const reporter = createReporter();
    const pkgName = `p${index}`;
    server.addPackage(pkgName, packageDir);
    let step: string | null = null;
    let browser: Browser | undefined;
    try {
      browser = await browserFor(task);
      const run = runContext({ browser, server, profile: task.profile, mode: task.mode, pkgName, mastery, reporter, result,
        reducedMotion: !!options.accessibility && index === 0, stallMs: options.stallMs || STALL_MS });
      step = 'launch';
      const scenario = isElabora ? () => elaboraScenario(run, { accessibility: options.accessibility && index === 0 ? accessibility : null }) : () => genericScenario(run);
      await watched(run, () => scenario().finally(() => { step = run.step; }));
    } catch (error) {
      // The step it stopped at says where to look.
      reporter.emit('E_LMS_SCENARIO', { profile: task.profile.id, message: `${task.mode}/${task.label}${step ? ` (step "${step}")` : ''}: ${errorMessage(error).split('\n')[0]}` });
    } finally {
      if (browser) {
        const identity = browserIdentity(browser);
        result.browser = `${identity.engine}${task.unload !== 'default' ? `(unload ${task.unload})` : ''}`;
        result.browserVersion = identity.version;
      }
    }
    result.failures = reporter.items.filter((diagnostic) => diagnostic.severity === 'error');
    result.ok = !result.failures.length;
    for (const diagnostic of reporter.items) diagnostic.profile = diagnostic.profile || task.profile.id;
    runs[index] = result;
    while (reported < tasks.length && runs[reported]) {
      const done = runs[reported++];
      options.onRun?.(done);
    }
  };
  try {
    let next = 0;
    const worker = async () => { while (next < tasks.length) { const index = next++; await runTask(tasks[index], index); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.parallel || PARALLEL, tasks.length)) }, worker));
  } finally {
    for (const browser of browsersOpen.values()) await (await browser.catch(() => null))?.close();
    await server.close();
    if (extracted) fs.rmSync(extracted, { recursive: true, force: true });
  }
  const diagnostics: Diagnostic[] = runs.flatMap((run) => run.failures.map((failure) => ({ ...failure, message: `[${run.profile} · ${run.launch} · ${run.browser}] ${failure.message}` })));
  if (accessibility.violations) for (const violation of accessibility.details) diagnostics.push({ code: 'E_GATE_A11Y', severity: 'error', message: `axe ${violation.id} on screen "${violation.screen}" (${violation.state}): ${violation.help}${violation.targets?.length ? ` — ${violation.targets.join(', ')}` : ''}`, rule: 'F1' });
  for (const overflow of accessibility.overflow || []) diagnostics.push({ code: 'W_RENDER_OVERFLOW', severity: 'warning', message: `Screen "${overflow.screen}" is ${overflow.scrollWidth} px wide at ${overflow.viewport} px${overflow.culprit ? ` (widest element: ${overflow.culprit})` : ''}.`, rule: 'F1' });
  return { ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'), runs, accessibility: options.accessibility ? accessibility : null, diagnostics };
}

interface RunTask {
  browserName: string;
  unload: UnloadVariant;
  profile: LmsProfile;
  mode: string;
  label: string;
}

// What a scenario works with: its browser, the LMS server, the profile and launch mode, where it
// reports, and its progress (the step it is at, since when).
interface RunContext {
  browser: Browser;
  server: EmulatorServer;
  profile: LmsProfile;
  mode: string;
  pkgName: string;
  mastery: string | undefined;
  reporter: Reporter;
  result: PackageRun;
  reducedMotion: boolean;
  stallMs: number;
  step: string;
  at: number;
  contexts: BrowserContext[]; // windows opened by the scenario, closed when it stalls
  progress(step: string): void;
}

function runContext(fields: Omit<RunContext, 'step' | 'at' | 'contexts' | 'progress'>): RunContext {
  const run: RunContext = {
    ...fields, step: 'launch', at: Date.now(), contexts: [],
    progress(step) { run.step = step; run.at = Date.now(); }
  };
  return run;
}

// A run that stops making progress fails instead of hanging the whole test: page.evaluate has no
// timeout, and a page whose main thread never yields (a free object stuck in a loop) never answers.
// The scenario calls run.progress(step) as it goes; the error names the step it stopped at.
const STALL_MS = 90000;
// Content that never opens fails after this long (generous: a loaded machine opens windows slowly).
const LAUNCH_MS = 30000;
const PARALLEL = 4;
async function watched(run: RunContext, scenario: () => Promise<void>): Promise<void> {
  run.progress('launch');
  let timer: ReturnType<typeof setInterval> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setInterval(() => {
      if (Date.now() - run.at < run.stallMs) return;
      reject(new Error(`no progress for ${run.stallMs / 1000} s at step "${run.step}"`));
      // Closing its windows ends the stuck scenario (its pending calls reject); other runs go on.
      for (const context of run.contexts) context.close().catch(() => {});
    }, 1000);
  });
  const work = scenario();
  work.catch(() => {});
  try {
    return await Promise.race([work, stalled]);
  } finally {
    clearInterval(timer);
  }
}

// One launch of the content by the fake LMS: its browser context, the LMS page and the content frame.
interface Launch {
  context: BrowserContext;
  page: Page;
  content: Frame;
}

async function openLaunch(run: RunContext, reg: string, extra = ''): Promise<Launch> {
  const { browser, server, profile, mode, pkgName, mastery } = run;
  // Audit a settled reading state: axe checks offscreen content too, where a scroll-driven
  // entrance can leave text partly transparent. Motion is exercised by fit and object gates.
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: run.reducedMotion ? 'reduce' : 'no-preference' });
  run.contexts.push(context);
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  const url = `${server.base}/lms/launch.html?pkg=${pkgName}&profile=${profile.id}&mode=${mode}&reg=${reg}${mastery ? `&mastery=${mastery}` : ''}${extra}`;
  const contentPage = ['popup', 'new-tab', 'popup-chain'].includes(mode) ? waitForContentPage(context) : null;
  await page.goto(url);
  let content: Frame;
  if (contentPage) content = await contentPage;
  else {
    await page.waitForFunction(() => window.__lmsReady === true);
    content = await waitForFrame(page);
  }
  return { context, page, content };
}

function waitForContentPage(context: BrowserContext): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('content window did not open')), LAUNCH_MS);
    context.on('page', (page) => {
      page.waitForURL(/\/pkg\//, { timeout: LAUNCH_MS }).then(() => { clearTimeout(timer); resolve(page.mainFrame()); }).catch(() => {});
    });
  });
}

async function waitForFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((candidate) => /\/pkg\//.test(candidate.url()) && !/\/objects\//.test(candidate.url()));
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error('content frame not found');
}

const lmsLog = (page: Page): Promise<LmsCall[]> => page.evaluate(() => window.__lmsLog || []).catch(() => []);

// A value of the CMI the fake LMS stored (scorm-again's JSON, as the content committed it).
const cmiValue = (cmi: unknown, ...keys: string[]): unknown => keys.reduce(fieldOf, cmi);

async function elaboraScenario(run: RunContext, { accessibility }: { accessibility: AccessibilityReport | null }): Promise<void> {
  const { reporter, server, profile } = run;
  const reg = `r${Math.random().toString(36).slice(2, 9)}`;
  const check = (name: string, ok: boolean, code: string, message: string) => { run.result.checks.push({ name, ok }); if (!ok) reporter.emit(code, { profile: profile.id, message }); };

  // 1. First launch: API found, initialised once, no unload listener, no sync XHR.
  let launch = await openLaunch(run, reg);
  await launch.content.waitForFunction(() => window.__elabora, null, { timeout: LAUNCH_MS });
  const kind = await launch.content.evaluate(() => window.__elabora.lms.kind);
  check('api-found', kind === 'scorm12', 'E_LMS_API_NOT_FOUND', `Launch "${run.mode}": the content ran without finding the SCORM API (standalone mode).`);
  if (kind !== 'scorm12') { await launch.context.close(); return; }
  const screens = await launch.content.evaluate(() => window.__elabora.engine.screens.map((screen) => screen.id));

  run.progress('next button');
  // 2. Navigate to the second screen with the real Next button when it is unlocked (Continue
  // first reveals the steps of the screen, as a learner would see them).
  if (screens.length > 1) {
    const content = launch.content;
    // Next refuses (greyed, aria-disabled) while the screen is locked. A course without Next goes on
    // with the screen's own buttons, which the emulator does not guess: the hook takes it on.
    const locked = () => content.evaluate(() => document.querySelector('.t-nav-btn--next')?.getAttribute('aria-disabled') === 'true');
    const onFirst = async () => (await content.evaluate(() => window.__elabora.screen)) === screens[0];
    // Continue buttons in the page first (scroll presentation), then Next.
    const pressNext = async () => {
      for (let i = 0; i < 13 && await onFirst(); i++) {
        // A narrated step is heard to its end first (Continue may wait for it); a dialog one of its
        // cues opened is closed, as a learner would.
        for (let held = 0; held < 20; held++) {
          await content.evaluate(() => window.__elabora.timeline?.advance(3600));
          // Its close event (which lets the narration go on) comes with the next frame.
          const closed = await content.evaluate(async () => {
            const open = [...document.querySelectorAll<HTMLDialogElement>('dialog.t-layer.t-dialog[open]')];
            for (const dialog of open) dialog.close();
            if (open.length) await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
            return open.length;
          });
          if (!closed) break;
        }
        // A narrated slide keeps the place of its Continue, hidden while the step plays (data-t-waiting).
        const inPage = await content.$('.t-continue:not([data-t-waiting]) .t-continue-btn:not([aria-disabled="true"])');
        if (inPage) { await inPage.click(); continue; }
        if (await content.$('.t-continue:not([data-t-waiting]) .t-continue-btn') || await locked() || await content.evaluate(() => !!document.querySelector<HTMLElement>('.t-bar--bottom')?.hidden)) break;
        if (await content.$('.t-nav-btn--next')) await content.click('.t-nav-btn--next');
        else await content.evaluate(() => window.__elabora.go(1));
      }
    };
    await pressNext();
    // A first screen with an activity to do (navigation locked until it is done): answered, as a
    // learner would, then Next again.
    if (await onFirst()) {
      await content.evaluate(() => window.__elabora.timeline?.toEnd());
      await content.evaluate(() => window.__elabora.revealAll());
      await answerScreen(content);
      await content.evaluate(() => window.__elabora.timeline?.toEnd());
      await pressNext();
    }
    if (await onFirst()) await content.evaluate(() => window.__elabora.go(1));
    await content.waitForFunction((id) => window.__elabora.screen === id, screens[1]);
  }
  const instrumentation = await launch.content.evaluate(() => ({ unload: window.__unloadListeners, syncXHR: window.__syncXHR }));
  check('no-unload-listener', instrumentation.unload === 0, 'E_LMS_UNLOAD_LISTENER', `${instrumentation.unload} unload/beforeunload listener(s) registered by the content.`);
  check('no-sync-xhr', instrumentation.syncXHR === 0, 'E_LMS_UNLOAD_LISTENER', `${instrumentation.syncXHR} synchronous XHR call(s) from the content.`);
  const expectedLocation = screens[Math.min(1, screens.length - 1)];
  // lesson_location holds the screen's key (its id in packages built before 2026-10-07).
  const expectedKey = await launch.content.evaluate((id) => window.__elabora.engine.screens.find((screen) => screen.id === id)?.key, expectedLocation);
  const storedLocation = (cmi: unknown) => cmiValue(cmi, 'core', 'lesson_location');

  // 3. Close abruptly (tab or popup closed, no beforeunload): data committed before must survive.
  run.progress('close');
  await closeAll(launch);
  await sleep(300);
  let stored = server.registration(reg)?.cmi;
  const location = storedLocation(stored);
  check('data-survives-close', (location === expectedKey || location === expectedLocation) && !!cmiValue(stored, 'suspend_data'), 'E_LMS_DATA_LOST_ON_CLOSE',
    `After closing, the LMS has lesson_location=${JSON.stringify(location)} (expected "${expectedKey}", the key of "${expectedLocation}") and ${cmiValue(stored, 'suspend_data') ? 'suspend_data' : 'no suspend_data'}.`);
  check('exit-suspend', cmiValue(stored, 'core', 'exit') === 'suspend', 'E_LMS_DATA_LOST_ON_CLOSE', `cmi.core.exit is ${JSON.stringify(cmiValue(stored, 'core', 'exit'))} instead of "suspend": some LMSs would not resume.`);

  // 4. Relaunch: entry=resume and the learner is back on the same screen.
  run.progress('resume');
  launch = await openLaunch(run, reg);
  await launch.content.waitForFunction(() => window.__elabora, null, { timeout: LAUNCH_MS });
  const resumed = await launch.content.evaluate(() => ({ screen: window.__elabora.screen, entry: window.__elabora.lms.log.find((call) => call.args?.[0] === 'cmi.core.entry')?.result }));
  check('resume', resumed.screen === expectedLocation, 'E_LMS_RESUME_FAILED', `Relaunch opened "${resumed.screen}" instead of "${expectedLocation}".`);

  // 5. Complete the course through the real UI (quizzes and decisions answered correctly).
  for (let i = 0; i < screens.length; i++) {
    run.progress(`answer ${screens[i]}`);
    await launch.content.evaluate((id) => window.__elabora.go(id), screens[i]);
    await launch.content.waitForFunction((id) => window.__elabora.screen === id, screens[i]);
    if (accessibility) await runAxe(launch.content, screens[i], 'initial', accessibility);
    // A narrated screen plays to its end on the virtual clock (its cues fire), before and after its
    // activities are answered (a step may wait for an answer).
    await launch.content.evaluate(() => window.__elabora.timeline?.toEnd());
    await launch.content.evaluate(() => window.__elabora.revealAll());
    await answerScreen(launch.content);
    await launch.content.evaluate(() => window.__elabora.timeline?.toEnd());
    if (accessibility) await runAxe(launch.content, screens[i], 'answered', accessibility);
  }
  // Rendered checks of the free design layer: no horizontal scrolling at phone width.
  if (accessibility) {
    const page = launch.content.page();
    const before = page.viewportSize();
    await page.setViewportSize({ width: 375, height: 812 });
    const overflows = accessibility.overflow ??= [];
    for (const id of screens) {
      run.progress(`phone width ${id}`);
      await launch.content.evaluate((screen) => { window.__elabora.go(screen); window.__elabora.revealAll(); }, id);
      await sleep(150);
      const overflow = await launch.content.evaluate(() => {
        const root = document.documentElement;
        if (root.scrollWidth <= root.clientWidth + 1) return null;
        let culprit: string | null = null; let widest = 0;
        for (const node of document.querySelectorAll('#t-main *')) { const box = node.getBoundingClientRect(); if (box.right > root.clientWidth + 1 && box.width > widest) { widest = box.width; culprit = node.className ? `${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}` : node.tagName.toLowerCase(); } }
        return { scrollWidth: root.scrollWidth, viewport: root.clientWidth, culprit };
      });
      if (overflow) overflows.push({ screen: id, ...overflow });
    }
    if (before) await page.setViewportSize(before);
  }
  await sleep(200);
  const state = await launch.content.evaluate(() => window.__elabora.state());
  const completion = await launch.content.evaluate(() => window.__elabora.course.completion);
  const expected = completion.reportAs.startsWith('passed') ? 'passed' : 'completed';
  stored = server.registration(reg)?.cmi;
  check('final-status', cmiValue(stored, 'core', 'lesson_status') === expected, 'E_LMS_STATUS', `Expected lesson_status "${expected}" with all answers correct, the LMS has "${cmiValue(stored, 'core', 'lesson_status')}".`);
  if (state.score.raw !== null) check('score', String(cmiValue(stored, 'core', 'score', 'raw')) === '100', 'E_LMS_STATUS', `Expected score.raw 100, the LMS has ${JSON.stringify(cmiValue(stored, 'core', 'score', 'raw'))}.`);

  // 6. Quit button: commit + LMSFinish.
  run.progress('quit');
  // Quit may be hidden (the exit item disabled: a warning, D58): the player's own quit then.
  if (await launch.content.locator('.t-quit').count()) {
    await launch.content.click('.t-quit');
    await launch.content.click('.t-quit-confirm');
  } else {
    await launch.content.evaluate(() => (window.__elabora as unknown as { quit(): void }).quit());
  }
  await sleep(200);
  const log = await lmsLog(launch.page);
  check('quit-finishes', log.some((call) => call.method === 'LMSFinish'), 'E_LMS_NO_FINISH_ON_QUIT', 'Quit did not call LMSFinish.');
  const rejected = log.filter((call) => call.method === 'LMSSetValue' && call.result === 'false');
  for (const call of rejected.slice(0, 5)) reporter.emit('E_LMS_SET_VALUE_REJECTED', { profile: profile.id, message: `LMSSetValue(${call.args[0]}) rejected${call.args[0] === 'cmi.suspend_data' ? ` (${String(call.args[1]).length} characters)` : ''}.` });
  const initializations = log.filter((call) => call.method === 'LMSInitialize').length;
  check('single-initialize', initializations === 1, 'E_LMS_INITIALIZE_TWICE', `LMSInitialize called ${initializations} times in one session.`);
  await closeAll(launch);

  // 7. Relaunch after completion: the status never regresses.
  run.progress('review relaunch');
  launch = await openLaunch(run, reg);
  await launch.content.waitForFunction(() => window.__elabora, null, { timeout: LAUNCH_MS });
  await launch.content.evaluate((id) => window.__elabora.go(id), screens[0]);
  await sleep(200);
  await closeAll(launch);
  await sleep(200);
  stored = server.registration(reg)?.cmi;
  check('no-regression', cmiValue(stored, 'core', 'lesson_status') === expected, 'E_LMS_STATUS_REGRESSION', `After a review session the LMS has "${cmiValue(stored, 'core', 'lesson_status')}" instead of "${expected}".`);
}

// Answers every activity of the current screen through the real UI and the behaviour hooks
// (data-t-…), whatever the component that renders it: built-in blocks and their forks.
async function answerScreen(frame: Frame): Promise<void> {
  await frame.evaluate(async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const elabora = window.__elabora;
    const screen = elabora.engine.screens[elabora.engine.screenIndex.get(elabora.screen ?? '') ?? -1];
    const flat = (blocks: PlayerBlock[] | undefined): PlayerBlock[] => (blocks || []).flatMap((block) => [block, ...flat(block.blocks)]);
    const quote = (value: unknown) => String(value).replace(/["\\]/g, '\\$&');
    const builtinBehaviors: Record<string, string> = { quiz: 'quiz', numeric: 'numeric', decision: 'decision', 'free-object': 'object' };
    for (const block of flat(screen.blocks)) {
      const node = document.querySelector(`[data-block="${block.id}"]`);
      if (!node) continue;
      const behavior = block.behavior || builtinBehaviors[block.type];
      if (behavior === 'quiz') {
        for (const option of block.props?.options || []) {
          const input = node.querySelector<HTMLInputElement>(`[data-t-option="${quote(option.id)}"] input`);
          if (input && input.checked !== !!option.correct) input.click();
        }
        node.querySelector<HTMLElement>('[data-t-submit]:not([hidden])')?.click();
      } else if (behavior === 'numeric') {
        const input = node.querySelector<HTMLInputElement>('input[data-t-input]');
        if (input && !input.readOnly) { input.value = String(block.props?.answer); node.querySelector<HTMLElement>('[data-t-submit]:not([hidden])')?.click(); }
      } else if (behavior === 'decision') {
        const options = block.props?.options || [];
        const best = options.find((option) => option.correct) || options[0];
        node.querySelector<HTMLElement>(`[data-t-choice="${quote(best?.id)}"]`)?.click();
      } else if (behavior === 'object') {
        elabora.test.completeObject(block.id, 1);
      } else if (behavior === 'predict') {
        // A trend to predict: the slider (what keys and screen readers use) set to the real last value, then « Show me ».
        const points = (block.props?.points as { y: number }[] | undefined) || [];
        const range = node.querySelector<HTMLInputElement>('.t-trend-range');
        if (range && !range.disabled && points.length) {
          range.value = String(points[points.length - 1].y);
          range.dispatchEvent(new Event('input', { bubbles: true }));
          node.querySelector<HTMLElement>('.t-trend-reveal:not([hidden])')?.click();
        }
      }
      await wait(30);
      for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
    }
  });
}

async function runAxe(frame: Frame, screen: string, state: string, report: AccessibilityReport): Promise<void> {
  const axe = loadAxe();
  if (!axe) return;
  // Contrast is measured on what is at rest: a fade still running (a chart's rows coming back after the
  // voice, a tooltip leaving) would be read at its passing opacity. Loops (endless) are not waited for.
  await frame.evaluate(async () => {
    const frameDone = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frameDone();
    for (const end = Date.now() + 2000; Date.now() < end;) {
      const running = document.getAnimations().filter((animation) => animation.playState === 'running' && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
      if (!running.length) return;
      await Promise.race([Promise.all(running.map((animation) => animation.finished.catch(() => null))), new Promise((resolve) => setTimeout(resolve, 250))]);
    }
  });
  const result = await frame.evaluate(`(function(){ if (!window.axe) { ${axe} } return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => String(n.target)) }))); })()`);
  report.screens++;
  for (const violation of axeViolations(result)) { report.violations++; report.details.push({ screen, state, ...violation }); }
}

async function closeAll(launch: Launch): Promise<void> {
  // Close the content window first when it is a popup, then the LMS page: no beforeunload handlers run.
  for (const page of launch.context.pages().reverse()) await page.close({ runBeforeUnload: false }).catch(() => {});
  await launch.context.close().catch(() => {});
}

async function genericScenario(run: RunContext): Promise<void> {
  const { reporter, server, profile } = run;
  const reg = `g${Math.random().toString(36).slice(2, 9)}`;
  const launch = await openLaunch(run, reg);
  await sleep(4000);
  const log = await lmsLog(launch.page);
  const initializations = log.filter((call) => call.method === 'LMSInitialize').length;
  if (!initializations) reporter.emit('E_LMS_API_NOT_FOUND', { profile: profile.id, message: `Launch "${run.mode}": the package never called LMSInitialize.` });
  const frames = launch.page.frames().filter((frame) => /\/pkg\//.test(frame.url()));
  for (const frame of frames) {
    const counts = await frame.evaluate(() => ({ unload: window.__unloadListeners || 0, syncXHR: window.__syncXHR || 0 })).catch(() => ({ unload: 0, syncXHR: 0 }));
    if (counts.unload) reporter.emit('E_LMS_UNLOAD_LISTENER', { profile: profile.id, message: `${counts.unload} unload/beforeunload listener(s) in ${new URL(frame.url()).pathname}: progress may be lost in Chrome and Edge.` });
  }
  const rejected = log.filter((call) => call.method === 'LMSSetValue' && call.result === 'false');
  for (const call of rejected.slice(0, 5)) reporter.emit('E_LMS_SET_VALUE_REJECTED', { profile: profile.id, message: `LMSSetValue(${call.args[0]}) rejected.` });
  const committedBefore = server.registration(reg)?.commits?.length || 0;
  await closeAll(launch);
  await sleep(300);
  if (initializations && !committedBefore) reporter.emit('E_LMS_DATA_LOST_ON_CLOSE', { profile: profile.id, message: 'Nothing was committed before the window closed: everything after the last commit is lost in Chrome/Edge without unload.' });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
