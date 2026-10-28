import fs from 'node:fs';
import path from 'node:path';
import type { Diagnostic, ObjectTests } from '@elabora/format';
import { screenBlocks } from '@elabora/core/project/load';
import { partialDiff } from './objects/test.ts';
import { build } from './build.ts';
import { startServer } from './emulator/server.ts';
import { launchMotionBrowsers } from './emulator/browser.ts';
import { loadProjectFromDir } from './project-reader.ts';
import { errorMessage, fieldOf } from './util/values.ts';
import { packageFolder, openAllScreens } from './package-folder.ts';
import { contactSheet } from './capture.ts';

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
    type HostMethod = 'testClick' | 'testKey' | 'updateProps' | 'carryOn' | 'setState' | 'getState';
    const host = (method: HostMethod, argument?: unknown) => page.evaluate(async ({ id, method, argument }) => {
      const found = window.__elabora.objectHost(id);
      if (!found) throw new Error(`no object host for "${id}"`);
      switch (method) {
        case 'testClick': return found.testClick(argument as { object?: string; at?: [number, number] });
        case 'testKey': return found.testKey(String(argument));
        case 'updateProps': return found.updateProps(argument as Record<string, unknown>);
        // A block of another screen gives way to this one (D65), in real time.
        case 'carryOn': {
          const { props, duration, direction, safeArea } = argument as { props: Record<string, unknown>; duration: number; direction: 'forward' | 'back'; safeArea?: Record<string, number> };
          const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
          return found.carryOn(props, { from: { screen: 'before', block: 'before' }, to: { screen: id, block: id }, direction, duration: reducedMotion ? 0 : duration, reducedMotion }, safeArea ? { safeArea } : {});
        }
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
        else if (step.action === 'set-props' && step.transition) await host('carryOn', { props: step.props || {}, duration: step.transition.duration ?? 700, direction: step.transition.direction ?? 'forward', safeArea: step.transition.safeArea });
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
