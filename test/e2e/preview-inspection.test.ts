import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Browser, Frame, Page } from 'playwright-core';
import { preview } from '@elabora/node/preview';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';

// The preview as the desktop app's Aperçu shows it: the LMS emulator's page in a frame of another
// origin, with no band of its own. It tells that page what the LMS receives and what the course does
// (messages elabora/lms: session, call, course, state, events), and sets a variable when asked; the
// course's « when it changes » events run as if an event had set it. « Déverrouiller la progression »:
// the preview built again with free navigation, the same learner back on the same screen.

interface Message { type: string; kind: string; [key: string]: unknown }
type Received = Window & typeof globalThis & { received: Message[] };

const messages = (page: Page): Promise<Message[]> => page.evaluate(() => (window as Received).received);
async function until<T>(page: Page, find: (all: Message[]) => T | undefined, what: string): Promise<T> {
  for (const begin = Date.now(); Date.now() - begin < 30000; await page.waitForTimeout(100)) {
    const found = find(await messages(page));
    if (found !== undefined) return found;
  }
  throw new Error(`no message: ${what}\n${JSON.stringify((await messages(page)).map((message) => message.kind))}`);
}
const lastState = (all: Message[]) => all.filter((message) => message.kind === 'state').at(-1)?.state as { screen: string; variables: Record<string, unknown>; suspendData: string } | undefined;

test('preview in a frame: no band, the LMS session, calls, course, state and events told to the page; a variable set; free navigation keeps the learner', { timeout: 180000 }, async (t) => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.delivery = { ...course.delivery, lms: ['moodle'] };
  writeJSON(dir, 'course.json', course);
  // On the first screen: « when indiceVu changes », one more good reflex if there are 2 already.
  const first = course.sections[0].screens[0];
  const screen = readJSON(dir, `screens/${first}.json`);
  screen.events = [...(screen.events ?? []), { id: 'indice-change', on: { type: 'variable.changed', variable: 'indiceVu' }, if: [{ variable: 'bonsReflexes', op: 'gte', value: 2 }], do: [{ type: 'increment-variable', variable: 'bonsReflexes', by: 1 }] }];
  writeJSON(dir, `screens/${first}.json`, screen);

  const session = await preview(dir, { port: 0 });
  const browser: Browser = await launchBrowser('chromium');
  t.after(async () => { await browser.close(); await session.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(session.profile, 'moodle', 'the course\'s LMS');
  assert.match(session.urls.lms, /[?&]profile=moodle&mode=iframe&/);
  assert.equal(session.locks, true, 'linear and locked until complete');
  assert.equal(session.navigation, 'authored');

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(`<!doctype html><body style="margin:0"><iframe style="border:0;width:1200px;height:800px" src="${session.urls.lms.replace('reg=preview', 'reg=essai')}"></iframe>
<script>window.received = []; addEventListener('message', (event) => { if (event.data && event.data.type === 'elabora/lms') window.received.push(event.data); });</script></body>`);
  const sessionMessage = await until(page, (all) => all.find((message) => message.kind === 'session')?.session as Record<string, unknown> | undefined, 'session');
  assert.deepEqual(sessionMessage, { reg: 'essai', mode: 'iframe', limit: 4096, enforcement: 'reject', entry: 'ab-initio', profile: { id: 'moodle', name: 'Moodle 4.5–5.2 (mod_scorm)', launch: 'iframe' }, saved: null });
  const data = await until(page, (all) => all.find((message) => message.kind === 'course')?.course as { navigation: unknown; variables: { id: string }[] } | undefined, 'course');
  assert.deepEqual(data.navigation, { mode: 'linear', lockUntilComplete: true });
  assert.deepEqual(data.variables.map((variable) => variable.id), ['bonsReflexes', 'indiceVu']);
  await until(page, (all) => (lastState(all)?.screen === first ? true : undefined), 'the first screen');
  const calls = (await messages(page)).filter((message) => message.kind === 'call').map((message) => (message.call as { method: string }).method);
  assert.ok(calls.includes('LMSInitialize') && calls.includes('LMSCommit'), JSON.stringify(calls));

  // No band: the course takes the whole page.
  const lms = page.frames().find((frame) => frame.url().includes('/lms/launch.html')) as Frame;
  assert.deepEqual(await lms.evaluate(() => ({ header: document.querySelectorAll('header').length, height: document.querySelector('#frame-host iframe')?.getBoundingClientRect().height })), { header: 0, height: 800 });

  // A variable set from the page; then one whose « when it changes » event runs.
  const ask = (id: string, value: unknown) => page.evaluate(([id, value]) => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'elabora/lms-ask', ask: 'set-variable', id, value }, '*'), [id, value] as const);
  await ask('bonsReflexes', 3);
  await until(page, (all) => (lastState(all)?.variables.bonsReflexes === 3 ? true : undefined), 'bonsReflexes 3');
  await ask('indiceVu', true);
  const events = await until(page, (all) => all.find((message) => message.kind === 'events')?.entries as { type: string; screen: string; info: unknown; runs: unknown[] }[] | undefined, 'events');
  assert.deepEqual(events.map(({ type, screen, info, runs }) => ({ type, screen, info, runs })), [{ type: 'variable.changed', screen: first, info: { variable: 'indiceVu' }, runs: [{ event: 'indice-change', held: true }] }]);
  await until(page, (all) => (lastState(all)?.variables.bonsReflexes === 4 ? true : undefined), 'the event ran: bonsReflexes 4');
  // A value the course refuses: its state again, unchanged.
  const states = (await messages(page)).filter((message) => message.kind === 'state').length;
  await ask('bonsReflexes', 'beaucoup');
  await until(page, (all) => (all.filter((message) => message.kind === 'state').length > states ? true : undefined), 'the state again');
  assert.equal(lastState(await messages(page))?.variables.bonsReflexes, 4);

  // Free navigation: the page reloads with the same learner, back on the same screen, every screen open.
  const before = (await messages(page)).length;
  await session.setNavigation('free');
  assert.equal(session.navigation, 'free');
  const resumed = await until(page, (all) => all.slice(before).find((message) => message.kind === 'session')?.session as { entry: string; saved: { location: string } | null } | undefined, 'the session again');
  assert.equal(resumed.entry, 'resume');
  assert.ok(resumed.saved?.location, 'the screen it showed');
  const unlocked = await until(page, (all) => all.slice(before).find((message) => message.kind === 'course')?.course as { navigation: unknown; player: { bottom?: { items: { id: string }[] } } } | undefined, 'the course again');
  assert.deepEqual(unlocked.navigation, { mode: 'free', lockUntilComplete: false });
  assert.ok(unlocked.player.bottom?.items.some((item) => item.id === 'outline'), 'the outline shown');
  const back = await until(page, (all) => lastState(all.slice(before)), 'its state');
  assert.equal(back.screen, first);
  assert.equal(back.variables.bonsReflexes, 4, 'the learner kept');
  // The last screen, now open.
  const last = course.sections.at(-1).screens.at(-1);
  const player = page.frames().find((frame) => frame.url().includes('/pkg/preview/index.html')) as Frame;
  await player.evaluate((id) => (window as unknown as { __elabora: { go(id: string): void } }).__elabora.go(id), last);
  await until(page, (all) => (lastState(all)?.screen === last ? true : undefined), 'the last screen');
});
