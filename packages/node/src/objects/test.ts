import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { version as esbuildVersion } from 'esbuild';
import { createRequire } from 'node:module';
import type { Browser, CDPSession, Frame, Page } from 'playwright-core';
import type { Diagnostic, ObjectTest, ObjectTestContext, ObjectTestSafeArea, ObjectTestStep, ObjectTestView } from '@elabora/format';
import { resolveTokens } from '@elabora/core/validate/theme';
import { createReporter } from '@elabora/core/diagnostics/index';
import type { Reporter } from '@elabora/core/diagnostics/index';
import { validateData } from '@elabora/player/data-schema';
import { loadProjectFromDir } from '../project-reader.ts';
import { compileObjectCode, objectFrameHtml, objectTestHostBundle, runtimeFiles, vendorThree, bundleErrorMessage, ELABORA_VERSION } from '../bundles.ts';
import { startServer } from '../emulator/server.ts';
import { browserIdentity, launchBrowser, openedBrowserIdentity } from '../emulator/browser.ts';
import type { BrowserIdentity } from '../emulator/electron.ts';
import { loadAxe, axeViolations } from '../util/axe.ts';
import { isRecord, errorMessage } from '../util/values.ts';
import { codeVersion } from '../code-version.ts';
import { fileHash } from '@elabora/core/project/files';
import { inputsHash, objectFingerprint, readKeptRun, recordedAt, writeGatesRecord, writeKeptRun } from './gates-record.ts';
import type { ObjectTestInputs } from './gates-record.ts';
import type { DryReport } from '@elabora/player/object-protocol';
import type { HostCall, HostDefinition, HostEvent, HostStarted, SafeArea } from './host-api.ts';

const require = createRequire(import.meta.url);

// Runs the automated gates of the free-object contract in a real browser:
//   2 smoke (mount, 300 frames, getState, dispose, no console error)
//   3 behaviour (object.tests.json) · 4 budgets (renderer.info, boot time)
//   5 visual snapshots (baseline PNGs in objects/<id>/__snapshots__/) · 6 accessibility (axe-core, keyboard)
// WebGL draws in software (SwiftShader: the same pixels on every machine), which spends nearly all
// the time of the gates drawing frames, and a test looks at very few of them: the last frame before
// each snapshot. The others run dry (@elabora/player dry-frames.ts): the object's code runs every
// frame, its draws are skipped. A dry run decides only when it passes and nothing it saw depended
// on a skipped draw; otherwise (a failure, a snapshot that differs, a stale drawing shown, read or
// reused) the run is done again with every frame drawn, and that run decides. When only drawings
// of other framebuffers than the canvas were reused (a texture baked over the first frames), it is
// first tried again skipping only the draws on the canvas, as are the next tests of the object.
// Runs that record baselines draw every frame.
// Boot time is measured on the mount of every run kept (smoke and each test) and judged on the median:
// one slow sample under software rendering does not fail the gate. Over the budget, learners without
// a GPU see the player's loading indicator (warning); over HARD_BOOT_MS, the 15 s timeout is near (error).
const HARD_BOOT_MS = 10000;
// A call the object does not answer (stuck in a loop, it blocks its frame, and the host page with it
// when they share a process) fails the gate instead of hanging the run: page.evaluate has no timeout.
const STALL_MS = 60000;
// Events cross from the frame by postMessage. Each expectation first takes a round trip to the
// frame, which brings in the events of the earlier steps. An object may also emit a moment later
// (once an asset has arrived, after a round trip to the host): an expected event is awaited up to
// EVENT_WAIT_MS, read again every EVENT_POLL_MS. Virtual time does not move meanwhile.
const EVENT_WAIT_MS = 5000;
const EVENT_POLL_MS = 20;

export interface ObjectTestOptions {
  updateSnapshots?: boolean;
  browser?: string;
  headed?: boolean;
  only?: string | null; // run the behaviour tests whose name contains this text (a partial run is not recorded)
  stallMs?: number;
  allFrames?: boolean; // draw every frame of every run (slower; the verdicts are the same)
  // Run the gates even when nothing they depend on changed since the last full run on this computer
  // (default: its result is given again, with reused).
  force?: boolean;
}

// What the object's frame measured (renderer.info, WebGL contexts: values from the frame, unchecked),
// then the boot times of the run.
export interface ObjectPerf {
  [measure: string]: unknown;
  bootMs?: number; // median
  bootSamples?: number[];
}

// Gate → passed, failed, pending, no tests, not-run (why)…
export interface ObjectGates {
  smoke: string;
  behaviour: string;
  budget: string;
  visual: string;
  accessibility: string;
  perf?: ObjectPerf;
  tests?: { name: string; ok: boolean; failures: string[] }[];
  // How the runs that decided were drawn: dry, dry on the canvas, or every frame (and why).
  frames?: { smoke: string; tests: Record<string, string> };
}

export interface ObjectTestResult {
  object: string;
  ok: boolean;
  gates: ObjectGates;
  diagnostics: Diagnostic[];
  browser?: BrowserIdentity;
  // Nothing the gates depend on changed since the full run of this date on this computer: its result,
  // not run again (force runs it).
  reused?: { at: string };
  // With updateSnapshots: the baselines of states no test names any more, removed; and the baselines
  // kept for other browsers and systems (another engine's, another platform's), which their runs use.
  snapshots?: { removed: string[]; kept: string[] };
}

// The object did not answer a call in time.
class StuckError extends Error {}

export async function testObject(projectDir: string, objectId: string, { updateSnapshots = false, browser: browserName = 'chromium', headed = false, only = null, stallMs = STALL_MS, allFrames = false, force = false }: ObjectTestOptions = {}): Promise<ObjectTestResult> {
  const project = loadProjectFromDir(projectDir);
  const object = project.objects.get(objectId);
  const manifest = object?.manifest;
  if (!object || !manifest) throw new Error(`No free object "${objectId}" with a manifest in ${project.root}/objects/`);
  const objectDir = path.join(project.root, object.folder);
  const reporter = createReporter();
  const file = `objects/${objectId}`;
  const gates: ObjectGates = { smoke: 'pending', behaviour: 'pending', budget: 'pending', visual: 'pending', accessibility: 'pending' };
  let browser: Browser | undefined;
  const finish = (): ObjectTestResult => ({ object: objectId, ok: !reporter.errors.length, gates, diagnostics: reporter.items, ...(browser ? { browser: browserIdentity(browser) } : {}) });

  // Course fonts are staged with the object so tests render with the real typography.
  const fonts = (project.course?.theme?.fonts || []).map((font) => ({ family: font.family, src: font.src, weight: font.weight || '400', style: font.style || 'normal', ...(font.unicodeRange ? { unicodeRange: font.unicodeRange } : {}) }));
  const tokens: Record<string, string | number> = resolveTokens(project.course);
  const language = manifest.language || project.course?.language || 'en';
  // What the verdicts depend on beyond the object folder; a full run whose folder and inputs are
  // those of now, on this browser, is not run again.
  const inputs: ObjectTestInputs = {
    tokens, fonts: fonts.map((font) => ({ ...font, hash: fileHash(project.files, font.src) })), language: `${language}|${project.course?.language || 'en'}`, code: codeVersion(), platform: `${process.platform}-${process.arch}`, browser: `${browserName}${headed ? ' headed' : ''}`,
    tools: testTools(!!manifest.requires?.three)
  };
  const kept = !force && !updateSnapshots && !only && !allFrames ? readKeptRun<ObjectTestResult>(project.root, objectId) : null;
  if (kept && kept.inputs === inputsHash(inputs) && kept.fingerprint === objectFingerprint(objectDir) && recordedAt(objectDir) === kept.at) {
    const opened = await launchBrowser(browserName, { headed });
    try {
      const identity = await openedBrowserIdentity(opened);
      if (kept.browser && identity.engine === kept.browser.engine && identity.version === kept.browser.version) return { ...kept.result, reused: { at: kept.at } };
    } finally {
      await opened.close();
    }
  }

  // Stage the object, its frame and a host page in a temporary folder served over HTTP.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-object-'));
  const write = (rel: string, content: string | Uint8Array) => { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.writeFileSync(path.join(stage, rel), content); };
  let code: string;
  try { code = await compileObjectCode(objectDir, { minify: false }); } catch (error) {
    reporter.emit('E_OBJECT_PARSE', { file: `${file}/object.js`, target: objectId, message: bundleErrorMessage(error) });
    const failed = finish();
    await browser?.close();
    fs.rmSync(stage, { recursive: true, force: true });
    return failed;
  }
  write(`objects/${objectId}/object.js`, code);
  write(`objects/${objectId}/frame.html`, objectFrameHtml(manifest, { language: project.course?.language || 'en' }));
  for (const asset of manifest.assets || []) write(`objects/${objectId}/${asset.file}`, fs.readFileSync(path.join(objectDir, asset.file)));
  for (const [name, content] of Object.entries(await runtimeFiles({ debug: true }))) write(name, content);
  if (manifest.requires?.three) for (const [name, content] of Object.entries(vendorThree())) write(name, content);
  write('test-host.js', await objectTestHostBundle());
  write('test.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Object test</title><style>body{margin:0;background:#fff}#box{width:960px;height:600px}#box iframe{width:100%;height:100%;border:0;display:block}</style></head><body><div id="box"></div><script src="test-host.js"></script></body></html>`);

  for (const font of fonts) if (fs.existsSync(path.join(project.root, font.src))) write(font.src, fs.readFileSync(path.join(project.root, font.src)));
  const defaults: Record<string, unknown> = Object.fromEntries(Object.entries(manifest.props?.properties || {}).map(([name, prop]) => [name, prop.default]));
  for (const [name, prop] of Object.entries(manifest.props?.properties || {})) {
    const token = prop['x-token'];
    if (token && tokens[token] !== undefined) defaults[name] = tokens[token];
  }
  const def: HostDefinition = {
    id: manifest.id, dir: `objects/${manifest.id}`, objects: manifest.objects || [], assets: manifest.assets || [],
    events: Object.fromEntries((manifest.events || []).map((event) => [event.name, { payload: event.payload || null, tracking: event.tracking || null }]))
  };

  const server = await startServer();
  server.addPackage('object', stage);
  browser ??= await launchBrowser(browserName, { headed });
  const openedBrowser = browser;
  const snapshotEngine = browserIdentity(browser).engine;
  // Tests run side by side in Elabora's Electron, which opens a worker of its own for each page. The
  // pages of one Chrome (or Firefox, WebKit) share the process that draws their WebGL, which already
  // spreads one test over the cores: side by side they took longer, and a page not in front was not
  // drawn as it would be (a snapshot differed). There they run one at a time.
  const atOnce = snapshotEngine === 'electron' ? TEST_PAGES : 1;
  const snapshotDir = path.join(objectDir, '__snapshots__');
  // A decoration runs behind every screen for the whole session: smaller default budgets.
  const decoration = manifest.pedagogicalRole === 'decoration';
  const budgets = { drawCallsMax: decoration ? 30 : 150, trianglesMax: decoration ? 60000 : 300000, bootMsMax: 3000, webglContexts: 1, ...(manifest.budgets || {}) };
  const boots: number[] = [];

  const bounded = <T>(page: Page, call: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stuck = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        page.close({ runBeforeUnload: false }).catch(() => {});
        reject(new StuckError(`no answer to ${what} within ${stallMs / 1000} s: is the object stuck in a loop?`));
      }, stallMs);
    });
    call.catch(() => {});
    return Promise.race([call, stuck]).finally(() => clearTimeout(timer));
  };

  // Strings as written in the manifest (a test may reword some, as a block does).
  const manifestStrings = Object.fromEntries(Object.entries(manifest.strings || {}).map(([key, string]) => [key, string.text]));
  type Mounted = HostStarted | { ok: false; error: string; stuck: boolean };
  interface OpenOptions {
    seed?: number;
    reducedMotion?: boolean;
    savedState?: unknown;
    size?: [number, number];
    safeArea?: ObjectTestSafeArea | null;
    context?: ObjectTestContext | null;
    view?: ObjectTestView | null;
    strings?: Record<string, string> | null;
    locale?: string | null;
  }
  const openHost = async (props: Record<string, unknown>, { seed = 1, reducedMotion = false, savedState = null, size = [960, 600], safeArea = null, context = null, view = null, strings = null, locale = null }: OpenOptions = {}) => {
    const page = await openedBrowser.newPage({ viewport: { width: Math.max(960, size[0]), height: Math.max(600, size[1]) }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.base}/pkg/object/test.html`);
    const begin = Date.now();
    await page.evaluate(([width, height]) => { const box = document.getElementById('box'); if (box) { box.style.width = `${width}px`; box.style.height = `${height}px`; } }, size);
    const start = {
      def, props, strings: { ...manifestStrings, ...(strings || {}) }, tokens, fonts, language: locale || language, seed, reducedMotion, savedState,
      safeArea: safeArea ? { top: 0, right: 0, bottom: 0, left: 0, ...safeArea } : null, decorative: decoration, context, view
    };
    const ready: Mounted = await bounded(page, page.evaluate((options) => window.__startHost(options), start), 'mount')
      .catch((error) => ({ ok: false, error: errorMessage(error), stuck: error instanceof StuckError }));
    const bootMs = Date.now() - begin;
    return { page, errors, ready, bootMs };
  };
  const callHost = (page: Page, call: HostCall): Promise<unknown> => bounded(page, page.evaluate((hostCall) => window.__call(hostCall), call), call.method);
  const settledEvents = (page: Page): Promise<HostEvent[]> => bounded(page, page.evaluate(() => window.__settle()), 'the event list');
  // Frames from now on drawn (false) or dry; what the dry frames left (DryReport).
  const setDry = async (page: Page, skip: Skip): Promise<DryReport> => {
    const report = await callHost(page, { method: 'testDry', dry: skip !== false, drawOffscreen: skip === 'canvas' });
    if (!isRecord(report)) return { skipped: 0, unsafe: 'no answer to test-dry', offscreen: false, stale: true };
    return { skipped: Number(report.skipped) || 0, unsafe: typeof report.unsafe === 'string' ? report.unsafe : null, offscreen: report.offscreen === true, stale: report.stale === true };
  };
  // How to run again a dry run that does not decide, and why (null: it decides). A stale canvas
  // matters only to a snapshot.
  const again = (skip: Skip, report: DryReport | null, failed: boolean, snapshot = false): Redo | null => {
    if (!skip) return null;
    if (report?.unsafe) return { skip: report.offscreen && skip === 'all' ? 'canvas' : false, why: report.unsafe };
    if (snapshot && report?.stale) return { skip: false, why: 'a snapshot of a canvas a dry frame left stale' };
    return failed ? { skip: false, why: 'to confirm a failure' } : null;
  };
  // A capture has no timeout of its own but the stall guard's: software WebGL with large textures
  // may take long on a loaded machine.
  const capture = (page: Page, compact: boolean): Promise<Buffer> => bounded(page, framePng(page, compact), 'the snapshot');

  // ── Gate 2: smoke, with the budgets and the accessibility of gates 4 and 6 read on its page ──
  // Nothing looks at the pixels of its 300 frames: they run dry.
  interface SmokeRun { found: Reporter; perf: ObjectPerf | null; accessibility: string | null; bootMs: number | null; stuck: boolean; redo: Redo | null }
  const runSmoke = async (skip: Skip): Promise<SmokeRun> => {
    const found = createReporter();
    const run: SmokeRun = { found, perf: null, accessibility: null, bootMs: null, stuck: false, redo: null };
    const { page, errors, ready, bootMs } = await openHost(defaults);
    if (!ready.ok) {
      found.emit('E_GATE_SMOKE', { file: `${file}/object.js`, target: objectId, message: `mount failed: ${ready.error}` });
      run.stuck = 'stuck' in ready && ready.stuck;
    } else try {
      run.bootMs = bootMs;
      if (skip) await setDry(page, skip);
      await callHost(page, { method: 'step', frames: 300 });
      const state = await callHost(page, { method: 'getState' });
      const stateErrors: string[] = validateData(manifest.state, state);
      if (stateErrors.length) found.emit('E_GATE_SMOKE', { file: `${file}/object.js`, target: objectId, message: `getState() does not match manifest.state: ${stateErrors.join('; ')}` });
      const measured = await callHost(page, { method: 'perf' });
      const perf: ObjectPerf = {};
      if (isRecord(measured)) for (const [name, value] of Object.entries(measured)) perf[name] = value;
      const drawCalls = perf.drawCalls;
      const triangles = perf.triangles;
      const contexts = perf.webglContexts;
      if (typeof drawCalls === 'number' && drawCalls > budgets.drawCallsMax) found.emit('E_GATE_BUDGET', { target: objectId, measured: drawCalls, limit: budgets.drawCallsMax, message: `Draw calls per frame: ${drawCalls}.` });
      if (typeof triangles === 'number' && triangles > budgets.trianglesMax) found.emit('E_GATE_BUDGET', { target: objectId, measured: triangles, limit: budgets.trianglesMax, message: `Triangles per frame: ${triangles}.` });
      if (typeof contexts === 'number' && contexts > budgets.webglContexts) found.emit('E_GATE_BUDGET', { target: objectId, measured: contexts, limit: budgets.webglContexts, message: `${contexts} WebGL contexts created.` });
      run.perf = perf;
      // Gate 6: accessibility of the object DOM, and keyboard reachability.
      const frame = objectFrame(page);
      const axe = loadAxe();
      if (frame && axe) {
        const result = await bounded(page, frame.evaluate(`${axe};\naxe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => String(n.target) + (n.any?.[0]?.message ? ' — ' + n.any[0].message : '')) })))`), 'the accessibility check');
        for (const violation of axeViolations(result)) found.emit('E_GATE_A11Y', { target: objectId, message: `axe ${violation.id} (${violation.impact}, ${violation.nodes} node(s)): ${violation.help}. ${violation.targets.join('; ')}` });
        const focusables = await bounded(page, frame.evaluate(() => document.querySelectorAll('a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]').length), 'the keyboard check');
        if (decoration && focusables) found.emit('E_GATE_A11Y', { target: objectId, message: `${focusables} focusable element(s) in a decoration: a backdrop takes no focus and has no controls.` });
        if (!decoration && !focusables) found.emit('E_GATE_A11Y', { target: objectId, message: 'No keyboard-focusable element in the object: provide keyboard access (manifest a11y.keyboard).' });
        run.accessibility = found.items.some((diagnostic) => diagnostic.code === 'E_GATE_A11Y') ? 'failed' : 'passed';
      } else run.accessibility = axe ? 'not-run (frame not found)' : 'not-run (axe-core not installed)';
      const report = skip ? await setDry(page, false) : null;
      await callHost(page, { method: 'dispose' });
      await page.waitForTimeout(50);
      if (errors.length) found.emit('E_GATE_SMOKE', { file: `${file}/object.js`, target: objectId, message: `Console errors: ${errors.slice(0, 3).join(' | ')}` });
      // A dry run decides only when it passes.
      run.redo = again(skip, report, found.items.length > 0);
    } catch (error) {
      if (!(error instanceof StuckError)) throw error;
      run.stuck = true;
      found.emit('E_GATE_SMOKE', { file: `${file}/object.js`, target: objectId, message: error.message });
    }
    await page.close().catch(() => {});
    return run;
  };

  // ── Gates 3 and 5: a behaviour test and its snapshots ──
  interface TestRun { failures: string[]; visual: Reporter; snapshots: number; recorded: boolean; blank: string[]; bootMs: number | null; stuck: boolean; redo: Redo | null }
  // The object mounted for a test: mounts run one at a time, so that each boot time is measured
  // with nothing else running; the tests then run side by side.
  type Host = Awaited<ReturnType<typeof openHost>>;
  const mountTest = (test: ObjectTest): Promise<Host> => openHost({ ...defaults, ...(test.props || {}) }, { seed: test.seed ?? 1, reducedMotion: !!test.reducedMotion, size: test.size || [960, 600], safeArea: test.safeArea || null, context: test.context || null, view: test.view || null, strings: test.strings || null, locale: test.locale || null });
  // A WebGL context the object made was lost (the browser's GPU process gave way, most often on a
  // loaded machine): it draws nothing more, and a snapshot would show the page without the scene.
  const contextLost = async (page: Page): Promise<boolean> => { const perf = await callHost(page, { method: 'perf' }).catch(() => null); return isRecord(perf) && perf.contextLost === true; };
  // mayRedoLost: a run whose context is lost is done again (twice at most), else reported as such.
  const runTest = async (test: ObjectTest, skip: Skip, { page, errors, ready, bootMs }: Host, mayRedoLost = true): Promise<TestRun> => {
    const failures: string[] = [];
    const visual = createReporter();
    const run: TestRun = { failures, visual, snapshots: 0, recorded: false, blank: [], bootMs: null, stuck: false, redo: null };
    if (!ready.ok) failures.push(`mount failed: ${ready.error}`);
    else run.bootMs = bootMs;
    // Dry, the frames are drawn from the last frame of the last step that runs frames before each
    // snapshot, to the snapshot.
    const drawn = skip ? drawnBeforeSnapshots(test.steps) : new Set<number>();
    // Event expectations look at the events emitted by the actions since the previous
    // expectations: consecutive expect-event steps share those events (an action may emit
    // several) and each event satisfies one expect-event only.
    let cursor = 0;
    let seen = 0;
    let expecting = false;
    const matched = new Set<number>();
    try {
      if (ready.ok && skip) await setDry(page, skip);
      for (const [i, step] of (ready.ok ? test.steps : []).entries()) {
        const where = `step ${i + 1} (${step.action})`;
        if (expecting && ACTIONS.has(step.action)) { cursor = seen; expecting = false; }
        try {
          const frames = Math.max(1, Math.min(10000, step.frames || 1));
          if (drawn.has(i)) {
            if (step.action === 'step' && frames > 1) await callHost(page, { method: 'step', frames: frames - 1 });
            await setDry(page, false);
          }
          if (step.action === 'step') await callHost(page, { method: 'step', frames: drawn.has(i) ? 1 : frames });
          else if (step.action === 'click') await callHost(page, { method: 'testClick', target: step.object ? { object: step.object } : { at: step.at } });
          else if (step.action === 'key') await callHost(page, { method: 'testKey', key: step.key ?? '' }); // a key event without key has key ''
          else if (step.action === 'set-props' && step.transition) await callHost(page, { method: 'carryOn', props: step.props || {}, duration: step.transition.duration ?? 700, direction: step.transition.direction ?? 'forward', ...(step.transition.safeArea ? { safeArea: step.transition.safeArea } : {}) });
          else if (step.action === 'set-props') await callHost(page, { method: 'updateProps', props: step.props || {} });
          else if (step.action === 'set-state') await callHost(page, { method: 'setState', state: step.state || {} });
          else if (step.action === 'set-context') await callHost(page, { method: 'setContext', context: step.context || {} });
          else if (step.action === 'set-view') await callHost(page, { method: 'setView', view: step.view || {} });
          else if (step.action === 'set-safe-area') await callHost(page, { method: 'setSafeArea', safeArea: { top: 0, right: 0, bottom: 0, left: 0, ...(step.safeArea || {}) } });
          else if (step.action === 'expect-state') {
            const state = await callHost(page, { method: 'getState' });
            const difference = partialDiff(step.state || {}, state);
            if (difference) failures.push(`${where}: state ${difference} (state: ${JSON.stringify(state)})`);
          } else if (step.action === 'expect-event' || step.action === 'expect-no-event') {
            const freshOf = (events: HostEvent[]) => events.map((event, index) => ({ ...event, index })).slice(cursor).filter((event) => !matched.has(event.index));
            const matches = (event: HostEvent) => (!step.name || event.name === step.name) && !partialDiff(step.payload || {}, event.payload);
            // No event is declared absent before the frame has answered; an expected one is awaited.
            let events = await settledEvents(page);
            for (const deadline = Date.now() + Math.min(EVENT_WAIT_MS, stallMs); step.action === 'expect-event' && !freshOf(events).some(matches) && Date.now() < deadline;) {
              await new Promise((resolve) => setTimeout(resolve, EVENT_POLL_MS));
              events = await settledEvents(page);
            }
            seen = events.length;
            expecting = true;
            const fresh = freshOf(events);
            const match = fresh.find(matches);
            const shown = JSON.stringify(fresh.map(({ name, payload }) => ({ name, payload })));
            if (step.action === 'expect-event') {
              if (match) matched.add(match.index);
              else failures.push(`${where}: no "${step.name}" event${step.payload ? ` with ${JSON.stringify(step.payload)}` : ''} (got ${shown})`);
            }
            if (step.action === 'expect-no-event' && match) failures.push(`${where}: unexpected "${match.name}" event ${JSON.stringify(match.payload)}`);
          } else if (step.action === 'snapshot') {
            // Dry, a canvas that shows a drawing older than its last frame cannot be compared.
            if (skip) {
              run.redo = again(skip, await setDry(page, false), false, true);
              if (run.redo !== null) return run;
            }
            const { name, baseline } = snapshotFiles(snapshotDir, `${slug(test.name)}--${slug(step.name || `step-${i + 1}`)}`, snapshotEngine);
            // A baseline kept with the course is compressed as before; a PNG only compared is not.
            const png = await capture(page, updateSnapshots || !baseline);
            if (skip) await setDry(page, skip);
            if (await contextLost(page)) {
              if (mayRedoLost) { run.redo = { skip, why: 'the WebGL context was lost before a snapshot', lost: true }; return run; }
              visual.emit('E_GATE_CONTEXT_LOST', { file: `${file}/object.tests.json`, target: objectId, message: `Snapshot "${step.name}" of test "${test.name}": the WebGL context was lost before it, in three runs.` });
              continue;
            }
            run.snapshots++;
            const comparison = compareSnapshot(baseline, path.join(snapshotDir, name), png, { update: updateSnapshots });
            if (comparison.status === 'created') {
              run.recorded = true;
              if (comparison.uniform) run.blank.push(`${file}/__snapshots__/${name}`);
            }
            if (comparison.status === 'different') visual.emit('E_GATE_VISUAL', { file: `${file}/__snapshots__/${name}`, target: objectId, measured: `${comparison.ratio.toFixed(3)} %`, limit: '0.1 %', message: `Snapshot "${step.name}" of test "${test.name}" differs from its baseline.` });
          }
        } catch (error) {
          failures.push(`${where}: ${errorMessage(error).split('\n')[0]}`);
          if (error instanceof StuckError) { run.stuck = true; break; }
        }
      }
      const report = skip && ready.ok && !run.stuck ? await setDry(page, skip) : null;
      if (errors.length) failures.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);
      // A dry run decides only when it passes (a context lost again is not confirmed by one more run).
      if (ready.ok && !run.stuck) run.redo = again(skip, report, failures.length > 0 || visual.items.some((item) => item.code !== 'E_GATE_CONTEXT_LOST'));
      return run;
    } finally {
      await page.close().catch(() => {});
    }
  };

  // Whether this run may be given again for an unchanged object (writeKeptRun).
  let keepable = true;
  try {
    // Draws skipped by dry runs: all of them, then for an object whose own textures are reused,
    // those on the canvas only.
    let skipping: Skip = allFrames ? false : 'all';
    let smoke = await runSmoke(skipping);
    const frames: NonNullable<ObjectGates['frames']> = { smoke: FRAMES_DRAWN[String(skipping)], tests: {} };
    while (smoke.redo !== null) {
      const { skip, why } = smoke.redo;
      if (skip) skipping = skip;
      frames.smoke = `${FRAMES_DRAWN[String(skip)]} (${why})`;
      smoke = await runSmoke(skip);
    }
    gates.frames = frames;
    reporter.merge(smoke.found.items);
    if (smoke.bootMs !== null) boots.push(smoke.bootMs);
    if (smoke.perf) gates.perf = smoke.perf;
    if (smoke.accessibility) gates.accessibility = smoke.accessibility;
    gates.smoke = smoke.found.items.some((diagnostic) => diagnostic.code === 'E_GATE_SMOKE') ? 'failed' : 'passed';
    const stuck = smoke.stuck;
    if (stuck) keepable = false;

    // An object stuck in the smoke test would be stuck in each test: they are not run.
    const tests = stuck ? [] : (object.tests?.tests || []).filter((test) => !only || test.name.includes(only));
    if (stuck) for (const gate of ['behaviour', 'budget', 'visual', 'accessibility'] as const) gates[gate] = 'not-run (object stuck)';
    else if (!tests.length) { gates.behaviour = 'no tests'; gates.visual = 'no tests'; }
    let snapshots = 0;
    let snapshotFailures = 0;
    const testResults: NonNullable<ObjectGates['tests']> = [];
    // Tests run side by side, a few at a time (atOnce), in the order of object.tests.json; a run done
    // again (redo) goes to a later batch. The results keep that order.
    const kept: (TestRun | undefined)[] = [];
    // Runs done again because their WebGL context was lost, by test.
    const lostRuns = new Map<number, number>();
    let queue: { index: number; skip: Skip }[] = tests.map((test, index) => {
      // A run that records baselines draws every frame.
      const records = updateSnapshots || test.steps.some((step, i) => step.action === 'snapshot' && !snapshotFiles(snapshotDir, `${slug(test.name)}--${slug(step.name || `step-${i + 1}`)}`, snapshotEngine).baseline);
      frames.tests[test.name] = records && skipping ? `${FRAMES_DRAWN.false} (records baselines)` : FRAMES_DRAWN[String(records ? false : skipping)];
      return { index, skip: records ? false : skipping };
    });
    while (queue.length) {
      const batch = queue.slice(0, atOnce);
      queue = queue.slice(atOnce);
      const hosts: Host[] = [];
      for (const job of batch) hosts.push(await mountTest(tests[job.index]));
      const runs = await Promise.all(batch.map((job, i) => runTest(tests[job.index], job.skip, hosts[i], (lostRuns.get(job.index) ?? 0) < 2)));
      for (const [i, run] of runs.entries()) {
        const { index } = batch[i];
        if (run.redo === null) { kept[index] = run; continue; }
        if (run.redo.lost) lostRuns.set(index, (lostRuns.get(index) ?? 0) + 1);
        const { skip, why } = run.redo;
        if (skip) skipping = skip;
        frames.tests[tests[index].name] = `${FRAMES_DRAWN[String(skip)]} (${why})`;
        queue.push({ index, skip });
      }
    }
    for (const [index, test] of tests.entries()) {
      const run = kept[index];
      if (!run) continue;
      if (run.stuck || run.recorded) keepable = false;
      if (run.bootMs !== null) boots.push(run.bootMs);
      snapshots += run.snapshots;
      snapshotFailures += run.visual.items.length;
      reporter.merge(run.visual.items);
      for (const blank of run.blank) reporter.emit('W_GATE_VISUAL_BLANK', { file: blank, target: objectId, message: `The baseline just recorded for "${test.name}" is a single colour: the object may draw nothing there (a canvas of no size, a context lost on a loaded machine). Look at it before keeping it.` });
      for (const failure of run.failures) reporter.emit('E_GATE_BEHAVIOUR', { file: `${file}/object.tests.json`, target: objectId, message: `"${test.name}": ${failure}` });
      testResults.push({ name: test.name, ok: !run.failures.length, failures: run.failures });
    }
    if (tests.length) {
      gates.behaviour = testResults.every((result) => result.ok) ? 'passed' : 'failed';
      gates.visual = snapshotFailures ? 'failed' : snapshots ? 'passed' : 'no snapshots';
      gates.tests = testResults;
    }
    // ── Gate 4, boot time: median of the mounts of the runs kept (the smoke run, a run per test) ──
    if (boots.length) {
      const sorted = [...boots].sort((a, b) => a - b);
      const bootMs = sorted[Math.floor((sorted.length - 1) / 2)];
      gates.perf = { ...gates.perf, bootMs, bootSamples: boots };
      const measured = `${bootMs} ms (median of ${boots.length})`;
      if (bootMs > HARD_BOOT_MS) keepable = false;
      if (bootMs > HARD_BOOT_MS) reporter.emit('E_GATE_BUDGET', { target: objectId, measured, limit: `${HARD_BOOT_MS} ms`, message: `Boot takes ${bootMs} ms: close to the 15 s after which the player gives up and shows the text version.` });
      else if (bootMs > budgets.bootMsMax) reporter.emit('W_GATE_BOOT_SLOW', { target: objectId, measured, limit: `${budgets.bootMsMax} ms`, message: `Boot takes ${bootMs} ms (software WebGL here, as on machines without a GPU): learners see the loading indicator meanwhile.` });
    }
    if (gates.budget === 'pending' && gates.perf) gates.budget = reporter.items.some((diagnostic) => diagnostic.code === 'E_GATE_BUDGET') ? 'failed' : 'passed';
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(stage, { recursive: true, force: true });
  }
  reporter.emit('I_GATE_HUMAN_PENDING', { target: objectId });
  // Baselines no test names any more: only when object.tests.json was read (a file that does not
  // parse names no test, and every baseline would go).
  const named = Array.isArray(object.tests?.tests) ? object.tests.tests.flatMap((test) => test.steps.flatMap((step, i) => (step.action === 'snapshot' ? [`${slug(test.name)}--${slug(step.name || `step-${i + 1}`)}`] : []))) : null;
  const result: ObjectTestResult = { ...finish(), ...(updateSnapshots && !only && named ? { snapshots: pruneSnapshots(snapshotDir, named, snapshotEngine) } : {}) };
  if (!only) {
    const record = writeGatesRecord(objectDir, {
      object: objectId, version: manifest.version, elabora: ELABORA_VERSION, at: new Date().toISOString(), ok: result.ok, browser: result.browser,
      gates: Object.fromEntries(Object.entries(gates).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      perf: gates.perf || null, tests: (gates.tests || []).map((test) => ({ name: test.name, ok: test.ok }))
    });
    // Not kept: a run that wrote baselines (it compared nothing with them: the next one does), nor
    // one an object stuck in a call or a boot near the timeout failed, which a loaded computer may cause.
    if (!updateSnapshots && keepable) writeKeptRun<ObjectTestResult>(project.root, { object: objectId, fingerprint: record.fingerprint, inputs: inputsHash(inputs), browser: result.browser ?? null, at: record.at, result });
  }
  return result;
}

// The baselines of the snapshots named by the tests (stems), for every engine and system, are kept;
// any other PNG of the folder is a state no test names any more, and is removed. Returned: what was
// removed, and the baselines of other engines and systems than this run's (Chromium's -darwin.png
// next to Electron's -electron-darwin.png), which their runs still compare with.
export function pruneSnapshots(snapshotDir: string, stems: readonly string[], engine: string): { removed: string[]; kept: string[] } {
  const out = { removed: [] as string[], kept: [] as string[] };
  if (!fs.existsSync(snapshotDir)) return out;
  const own = new Set(stems.map((stem) => snapshotFiles(snapshotDir, stem, engine).name));
  const named = new Set(stems);
  for (const name of fs.readdirSync(snapshotDir).sort()) {
    if (!name.endsWith('.png')) continue;
    const stem = snapshotStem(name, named);
    if (stem === null) { fs.rmSync(path.join(snapshotDir, name), { force: true }); out.removed.push(name); }
    else if (!own.has(name)) out.kept.push(name);
  }
  return out;
}

// The test state a baseline file is of: <stem>.png (legacy), <stem>-<platform>.png (Chromium) or
// <stem>-<engine>-<platform>.png; null when no named stem fits.
const PLATFORM = '(?:aix|android|cygwin|darwin|freebsd|haiku|linux|netbsd|openbsd|sunos|win32)';
const SUFFIXES = [new RegExp(`-${PLATFORM}\\.png$`), new RegExp(`-(?:electron|firefox|webkit)-${PLATFORM}\\.png$`), /\.png$/];
function snapshotStem(name: string, stems: ReadonlySet<string>): string | null {
  for (const suffix of SUFFIXES) {
    const stem = suffix.test(name) ? name.replace(suffix, '') : null;
    if (stem !== null && stems.has(stem)) return stem;
  }
  return null;
}

// What runs the gates beside Elabora's own code (codeVersion): the bundler of the object's code, the
// three.js it may import, and the optional packages without which a gate is not run (axe-core) or
// snapshots are not compared (pngjs, pixelmatch).
function testTools(three: boolean): Record<string, string | boolean> {
  const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  const present = (name: string) => { try { require.resolve(name); return true; } catch { return false; } };
  const axe = loadAxe();
  return { esbuild: esbuildVersion, three: three ? sha(Object.values(vendorThree())[0]) : false, axe: axe ? sha(axe) : false, compare: present('pngjs') && present('pixelmatch') };
}

// Behaviour tests run at the same time in Elabora's Electron: each page is a worker drawing in
// software (SwiftShader).
const TEST_PAGES = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));

// Draws skipped by a run: none (every frame drawn), all, or those on the canvas only.
type Skip = false | 'all' | 'canvas';
interface Redo { skip: Skip; why: string; lost?: true }
const FRAMES_DRAWN: Record<string, string> = { false: 'every frame', all: 'dry', canvas: 'dry on the canvas' };

// Steps that can make the object emit events (expectations and snapshots do not).
const ACTIONS = new Set(['step', 'click', 'key', 'set-props', 'set-state', 'set-safe-area', 'set-context', 'set-view']);
// Steps that run frames of the object (step: its frames; the others one frame, after the change).
const FRAMES = new Set(['step', 'click', 'set-props', 'set-state', 'set-safe-area', 'set-context', 'set-view']);

// The last step that runs frames before each snapshot, since the one before (or the mount): a dry
// run draws from its last frame on, so that the snapshot shows what every frame drawn would show.
export function drawnBeforeSnapshots(steps: readonly Pick<ObjectTestStep, 'action'>[]): Set<number> {
  const drawn = new Set<number>();
  let last = -1;
  for (const [i, step] of steps.entries()) {
    if (FRAMES.has(step.action)) last = i;
    else if (step.action === 'snapshot') { if (last >= 0) drawn.add(last); last = -1; }
  }
  return drawn;
}

function objectFrame(page: Page): Frame | undefined {
  return page.frames().find((candidate) => candidate.url().includes('/frame.html'));
}

// The object's frame as a PNG, without the text caret, as Playwright's element screenshot takes it
// (the same pixels) but ten times sooner. Unless compact, Chromium encodes it for speed: lossless,
// larger. Other browsers take Playwright's screenshot.
const devtools = new WeakMap<Page, Promise<CDPSession>>();
async function framePng(page: Page, compact: boolean): Promise<Buffer> {
  const iframe = page.locator('#box iframe');
  if (page.context().browser()?.browserType().name() !== 'chromium') return iframe.screenshot({ timeout: 0 });
  const box = await iframe.boundingBox();
  if (!box) throw new Error('the object frame is not on the page');
  let session = devtools.get(page);
  if (!session) {
    session = page.context().newCDPSession(page);
    devtools.set(page, session);
  }
  const frame = objectFrame(page);
  const hidden = frame ? await frame.evaluate(() => {
    const saved = [...document.querySelectorAll<HTMLElement>('input, textarea, [contenteditable]')].map((element) => {
      const kept = [element, element.style.getPropertyValue('caret-color'), element.style.getPropertyPriority('caret-color')] as const;
      element.style.setProperty('caret-color', 'transparent', 'important');
      return kept;
    });
    Reflect.set(window, '__elaboraCarets', saved);
    return saved.length;
  }) : 0;
  try {
    const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.x + box.width) - Math.floor(box.x), height: Math.ceil(box.y + box.height) - Math.floor(box.y), scale: 1 };
    const { data } = await (await session).send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: !compact, clip, captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  } finally {
    if (hidden) await frame?.evaluate(() => {
      const saved: unknown = Reflect.get(window, '__elaboraCarets');
      if (Array.isArray(saved)) for (const [element, value, priority] of saved) element.style.setProperty('caret-color', value, priority);
      Reflect.deleteProperty(window, '__elaboraCarets');
    });
  }
}

function slug(text: string): string { return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }

// Returns null if `actual` contains every value of `expected` (deep, arrays compared fully).
export function partialDiff(expected: unknown, actual: unknown, pointer = ''): string | null {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return JSON.stringify(expected) === JSON.stringify(actual) ? null : `${pointer || 'value'} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  if (actual === null || typeof actual !== 'object') return `${pointer || 'value'} expected an object, got ${JSON.stringify(actual)}`;
  for (const [key, value] of Object.entries(expected)) {
    const difference = partialDiff(value, (actual as Record<string, unknown>)[key], `${pointer}.${key}`); // any object, arrays too
    if (difference) return difference;
  }
  return null;
}

// pngjs and pixelmatch: optional dependencies, loaded for snapshot comparisons only.
interface PngModule {
  PNG: { sync: { read(data: Buffer): { width: number; height: number; data: Buffer } } };
}
type Pixelmatch = typeof import('pixelmatch').default;

type SnapshotComparison = { status: 'created'; uniform: boolean } | { status: 'skipped' } | { status: 'same' | 'different'; ratio: number };

// Pixel comparison with pixelmatch: tolerance aligned on three.js e2e tests (0.1 % of pixels).
// Baselines are per system: fonts and WebGL do not draw the same pixels on macOS, Windows and Linux
// (2 to 3 % of a 3D object's frame). A snapshot is compared with the baseline of this system,
// <name>-<platform>.png for Chromium, <name>-<engine>-<platform>.png for Electron, Firefox and
// WebKit. Engines never overwrite each other's baselines; a legacy suffix-free one is macOS Chrome.
function snapshotFiles(snapshotDir: string, stem: string, engine = 'chromium'): { name: string; baseline: string | null } {
  const name = `${stem}${engine === 'chromium' ? '' : `-${engine}`}-${process.platform}.png`;
  if (fs.existsSync(path.join(snapshotDir, name))) return { name, baseline: path.join(snapshotDir, name) };
  const legacy = path.join(snapshotDir, `${stem}.png`);
  if (engine === 'chromium' && process.platform === 'darwin' && fs.existsSync(legacy)) return { name: `${stem}.png`, baseline: legacy };
  return { name, baseline: null };
}

// Every pixel the same colour (a frame that drew nothing).
function uniform(data: Uint8Array): boolean {
  for (let i = 4; i < data.length; i += 4) if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2] || data[i + 3] !== data[3]) return false;
  return true;
}

function compareSnapshot(baseline: string | null, file: string, png: Buffer, { update }: { update: boolean }): SnapshotComparison {
  let PNG: PngModule['PNG'] | null = null;
  let pixelmatch: Pixelmatch | null = null;
  try {
    const pngjs: PngModule = require('pngjs');
    const pixelmatchModule: { default?: Pixelmatch } & Pixelmatch = require('pixelmatch');
    PNG = pngjs.PNG;
    pixelmatch = pixelmatchModule.default || pixelmatchModule;
  } catch { /* compared nothing: skipped */ }
  if (update || !baseline) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    return { status: 'created', uniform: PNG ? uniform(PNG.sync.read(png).data) : false };
  }
  if (!PNG || !pixelmatch) return { status: 'skipped' };
  const reference = PNG.sync.read(fs.readFileSync(baseline));
  const current = PNG.sync.read(png);
  if (reference.width !== current.width || reference.height !== current.height) return { status: 'different', ratio: 100 };
  const different = pixelmatch(reference.data, current.data, undefined, reference.width, reference.height, { threshold: 0.1 });
  const ratio = (100 * different) / (reference.width * reference.height);
  return ratio > 0.1 ? { status: 'different', ratio } : { status: 'same', ratio };
}
