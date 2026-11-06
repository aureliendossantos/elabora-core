// node scripts/scorm-cloud-trial.ts [--example diagnostic-reseau] [--format scorm12|scorm2004|cmi5|xapi] [--out <dir>] [--keep]
//
// A real trial of a package in SCORM Cloud (Rustici's reference LMS, docs/delivery.md): builds an
// example of the core (CC0) in a format, uploads it, registers a test learner, launches it in
// Chromium (the one the emulator uses: nothing is downloaded), goes to the second screen and closes
// the window abruptly, reads what SCORM Cloud kept (location, suspend data), launches again (the
// learner is back on that screen?), completes every screen through the real interface, quits, and
// reads the registration: completion, success, score, the runtime data, and what the LMS refused.
// Then deletes the course, with its registrations (the free plan holds three
// courses and ten registrations). Writes <out>/scorm-cloud-<format>.json and screenshots there.
//
// The key is read from ~/.config/elabora/scorm-cloud.json ({ "appId", "secretKey" }, mode 0600;
// ELABORA_SCORM_CLOUD_KEY names another file) when the script runs, and never printed or written:
// without it, the script says so and stops (exit 0). It goes through the network: it belongs to no
// test suite. Send only the core's examples and test packages: SCORM Cloud keeps what it receives.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Frame, Page } from 'playwright-core';
import { build } from '@elabora/node/build';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { answerScreen } from '@elabora/node/emulator/run';
import { isDeliveryFormat } from '@elabora/core/lms/formats';
import type { DeliveryFormat } from '@elabora/core/lms/formats';

const API = 'https://cloud.scorm.com/api/v2';
const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const example = flag('example') ?? 'diagnostic-reseau';
const format = flag('format') ?? 'scorm2004';
const out = path.resolve(flag('out') ?? path.join(os.tmpdir(), 'elabora-scorm-cloud'));
const keep = args.includes('--keep');
if (!isDeliveryFormat(format)) { console.error(`--format is scorm12, scorm2004, cmi5 or xapi (not "${format}").`); process.exit(2); }

const keyFile = process.env.ELABORA_SCORM_CLOUD_KEY ?? path.join(os.homedir(), '.config/elabora/scorm-cloud.json');
if (!fs.existsSync(keyFile)) { console.log(`No SCORM Cloud key in ${keyFile}: nothing tried.`); process.exit(0); }
const { appId, secretKey } = JSON.parse(fs.readFileSync(keyFile, 'utf8')) as { appId?: string; secretKey?: string };
if (!appId || !secretKey) { console.log(`${keyFile} has no appId and secretKey: nothing tried.`); process.exit(0); }
// Built here, used for requests only: never printed.
const authorization = `Basic ${Buffer.from(`${appId}:${secretKey}`).toString('base64')}`;

async function api(method: string, route: string, body?: unknown, raw?: BodyInit): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: authorization, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (response.status >= 400) throw new Error(`${method} ${route.replace(/\?.*$/, '')}: HTTP ${response.status} ${typeof json === 'string' ? json.slice(0, 200) : JSON.stringify(json).slice(0, 300)}`);
  return { status: response.status, json };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const field = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);

fs.mkdirSync(out, { recursive: true });
const stamp = Date.now().toString(36);
const courseId = `elabora-trial-${example}-${format}-${stamp}`;
const registrationId = `${courseId}-learner`;
const result: Record<string, unknown> = { example, format, courseId, at: new Date().toISOString(), steps: {} as Record<string, unknown> };
const steps = result.steps as Record<string, unknown>;
// Nothing of the key goes out, the app id in SCORM Cloud's addresses included.
const hide = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).replaceAll(appId!, '<app>'));
const note = (step: string, value: unknown) => { steps[step] = hide(value); console.log(`${step}: ${JSON.stringify(steps[step])}`); };

// The package: the example as the core has it, for SCORM Cloud, in the format asked for.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-trial-'));
fs.cpSync(path.resolve(import.meta.dirname, '..', 'examples', example), path.join(work, example), { recursive: true });
const built = await build(path.join(work, example), { profiles: ['scorm-cloud'], target: format as DeliveryFormat, emit: 'zip', out: path.join(work, 'dist'), writeLock: false });
if (!built.ok || !built.zipPath) { console.error(`Build stopped: ${built.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code).join(', ')}`); process.exit(1); }
note('package', { file: path.basename(built.zipPath), bytes: fs.statSync(built.zipPath).size, delivery: built.report.delivery });

const browser = await launchBrowser('chromium', { rendering: 'software' });
let uploaded = false;
// SCORM Cloud warned that the course may still be open (a session that never terminated).
let concurrent = false;
try {
  // 1. Upload, then wait for the import.
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(built.zipPath)], { type: 'application/zip' }), path.basename(built.zipPath));
  const job = await api('POST', `/courses/importJobs/upload?courseId=${encodeURIComponent(courseId)}&mayCreateNewVersion=false`, undefined, form);
  uploaded = true;
  const jobId = String(field(job.json, 'result'));
  let imported: unknown = null;
  for (let tries = 0; tries < 120; tries++) {
    imported = (await api('GET', `/courses/importJobs/${encodeURIComponent(jobId)}`)).json;
    if (field(imported, 'status') !== 'RUNNING') break;
    await sleep(2000);
  }
  note('import', { status: field(imported, 'status'), message: field(imported, 'message'), learningStandard: field(imported, 'importResult', 'course', 'courseLearningStandard') });
  if (field(imported, 'status') !== 'COMPLETE') throw new Error('the import did not complete');

  // 2. A test learner.
  await api('POST', '/registrations', { courseId, registrationId, learner: { id: 'elabora-trial-learner', firstName: 'Alex', lastName: 'Doe' } });
  const launch = async (): Promise<{ page: Page; content: Frame }> => {
    const link = String(field((await api('POST', `/registrations/${encodeURIComponent(registrationId)}/launchLink`, { redirectOnExitUrl: 'message', tracking: true, expiry: 600 })).json, 'launchLink'));
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    // Narrated screens on the virtual clock, as in the emulator: the trial plays them to their end at once.
    await context.addInitScript(() => { (window as unknown as { ELABORA_TEST: unknown }).ELABORA_TEST = { virtualTime: true }; });
    const page = await context.newPage();
    // SCORM Cloud's launch page can take a while to answer: 90 s, twice.
    await page.goto(link, { waitUntil: 'commit', timeout: 90_000 }).catch(() => page.goto(link, { waitUntil: 'commit', timeout: 90_000 }));
    // The course in a frame of SCORM Cloud's player, or in a window it opens.
    for (let tries = 0; tries < 120; tries++) {
      // After an abrupt close, SCORM Cloud warns that the course may still be open: the learner goes on.
      for (const candidate of context.pages()) {
        if (/concurrentlaunch/.test(candidate.url())) {
          concurrent = true;
          await candidate.getByRole('button', { name: /continue/i }).or(candidate.getByText(/continue anyway/i)).first().click().catch(() => {});
        }
      }
      const pages = [page, ...context.pages()];
      for (const candidate of pages) for (const frame of candidate.frames()) {
        if (await frame.evaluate(() => !!(window as unknown as { __elabora?: { screen?: string } }).__elabora?.screen).catch(() => false)) return { page: candidate, content: frame };
      }
      await sleep(500);
    }
    // What SCORM Cloud shows instead, for the report.
    for (const [index, candidate] of context.pages().entries()) {
      await candidate.screenshot({ path: path.join(out, `scorm-cloud-${format}-not-started-${index}.png`) }).catch(() => {});
      console.log(`page ${index}: ${new URL(candidate.url()).pathname.replaceAll(appId!, '<app>')} — ${(await candidate.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    throw new Error('the course did not start in SCORM Cloud\'s player');
  };
  const state = (content: Frame) => content.evaluate(() => {
    const elabora = (window as unknown as { __elabora: { screen: string; lms: { kind: string; where: string }; engine: { screens: { id: string }[] } } }).__elabora;
    const connected = (window as unknown as { __elaboraLms?: { registration?: string; endpoint?: string } | null }).__elaboraLms;
    return { screen: elabora.screen, lms: elabora.lms.kind, where: elabora.lms.where, screens: elabora.engine.screens.map((screen) => screen.id), error: (window as unknown as { __elaboraLmsError?: string }).__elaboraLmsError ?? null, registration: connected?.registration ?? null, endpoint: connected?.endpoint ?? null };
  });
  const registration = async () => (await api('GET', `/registrations/${encodeURIComponent(registrationId)}?includeChildResults=true&includeRuntime=true`)).json;
  const runtime = (value: unknown) => {
    const child = (field(value, 'activityDetails', 'children') as unknown[] | undefined)?.[0];
    const own = field(child ?? field(value, 'activityDetails'), 'runtime');
    return { completion: field(value, 'registrationCompletion'), success: field(value, 'registrationSuccess'), score: field(value, 'score', 'scaled'), location: field(own, 'location'), suspendData: typeof field(own, 'suspendData') === 'string' ? `${String(field(own, 'suspendData')).length} characters` : field(own, 'suspendData'), exit: field(own, 'exit'), completionStatus: field(own, 'completionStatus'), successStatus: field(own, 'runtimeSuccessStatus') };
  };

  // 3. First launch: the second screen, then the window closed abruptly.
  let session = await launch();
  const first = await state(session.content);
  note('first launch', { lms: first.lms, where: first.where, connectionError: first.error, screen: first.screen });
  await session.content.evaluate(() => (window as unknown as { __elabora: { go(to: number): void } }).__elabora.go(1));
  await sleep(3000);
  const left = (await state(session.content)).screen;
  await session.page.screenshot({ path: path.join(out, `scorm-cloud-${format}-1-launch.png`) });
  // The learner closes the course's window (not SCORM Cloud's), without Quit; SCORM Cloud's page stays.
  const lmsPage = session.page.context().pages()[0];
  if (lmsPage && lmsPage !== session.page) await session.page.close({ runBeforeUnload: false });
  else await session.content.page().close({ runBeforeUnload: false });
  await sleep(15000);
  await lmsPage?.context().close();
  await sleep(3000);
  note('after an abrupt close', { left, ...runtime(await registration()) });

  // 4. Relaunch: back on the same screen?
  session = await launch();
  await sleep(1500);
  const resumed = await state(session.content);
  note('relaunch', { endpoint: resumed.endpoint, screen: resumed.screen, sameScreen: resumed.screen === left, concurrentLaunchWarning: concurrent });

  // 5. Every screen through the real interface, then Quit.
  for (const id of resumed.screens) {
    await session.content.evaluate((screen) => (window as unknown as { __elabora: { go(to: string): void } }).__elabora.go(screen), id);
    await session.content.waitForFunction((screen) => (window as unknown as { __elabora: { screen: string } }).__elabora.screen === screen, id);
    await session.content.evaluate(() => (window as unknown as { __elabora: { timeline?: { toEnd(): void }; revealAll(): void } }).__elabora.timeline?.toEnd());
    await session.content.evaluate(() => (window as unknown as { __elabora: { revealAll(): void } }).__elabora.revealAll());
    await answerScreen(session.content);
    await session.content.evaluate(() => (window as unknown as { __elabora: { timeline?: { toEnd(): void } } }).__elabora.timeline?.toEnd());
  }
  await sleep(2000);
  await session.page.screenshot({ path: path.join(out, `scorm-cloud-${format}-2-completed.png`) });
  const finalState = await session.content.evaluate(() => (window as unknown as { __elabora: { state(): { status: string; score: { raw: number | null } } } }).__elabora.state());
  // What the LMS refused, as the player logged it.
  const refused = await session.content.evaluate(() => (window as unknown as { __elabora: { lms: { log: { method: string; args: string[]; result: string; error: string }[] } } }).__elabora.lms.log.filter((call) => call.result === 'false').map((call) => `${call.method}(${String(call.args[0] ?? '').slice(0, 60)}): ${call.error}`).slice(0, 6));
  note('refused by the LMS', refused);
  if (await session.content.locator('.t-quit').count()) {
    await session.content.click('.t-quit');
    await session.content.click('.t-quit-confirm');
  } else await session.content.evaluate(() => (window as unknown as { __elabora: { quit(): void } }).__elabora.quit());
  // The learner closes the course's window after Quit; SCORM Cloud's page ends the attempt then and
  // sends what it holds in batches: it stays open a while.
  await sleep(3000);
  await session.page.screenshot({ path: path.join(out, `scorm-cloud-${format}-3-quit.png`) }).catch(() => {});
  const player = session.page.context().pages()[0];
  if (player && player !== session.page) await session.page.close({ runBeforeUnload: false });
  await sleep(15000);
    await player?.context().close();
  await sleep(5000);
  const done = await registration();
  note('after completion', { player: { status: finalState.status, score: finalState.score.raw }, ...runtime(done) });

  // cmi5 and xAPI: SCORM Cloud derives the registration's completion, success and score from the
  // statements its LRS accepted (a refused one is in 'refused by the LMS').
} catch (error) {
  note('stopped', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  // The free plan holds three courses: the course goes, with its registrations.
  if (uploaded && !keep) {
    try { await api('DELETE', `/courses/${encodeURIComponent(courseId)}`); note('cleanup', 'course and registrations deleted'); }
    catch (error) { note('cleanup', `REFUSED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 3; }
  }
  fs.writeFileSync(path.join(out, `scorm-cloud-${format}.json`), JSON.stringify(result, null, 2) + '\n');
  fs.rmSync(work, { recursive: true, force: true });
}
