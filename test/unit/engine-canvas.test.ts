import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { openProject } from '@elabora/engine';
import type { OpenOptions, Session } from '@elabora/engine';
import type { HostMessage } from '@elabora/player/canvas-protocol';
import { copyExample, readJSON } from '../helpers.ts';

// The session's renders and its canvas host, read from the host's event stream (what the canvas
// page receives): a change to the screen shown is pushed with the change's sequence number as
// render id, a change elsewhere is not, view changes go through requests.

const temporary: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) await session.close().catch(() => {});
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});
const QUIET: OpenOptions = { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 };

function stream(url: string): { next(timeoutMs?: number): Promise<HostMessage | null>; close(): void } {
  const queue: HostMessage[] = [];
  const waiting: ((message: HostMessage) => void)[] = [];
  let buffer = '';
  const call = http.get(url, (response) => {
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const data = buffer.slice(0, end).split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
        buffer = buffer.slice(end + 2);
        if (!data) continue;
        const message = JSON.parse(data) as HostMessage;
        const resolve = waiting.shift();
        if (resolve) resolve(message); else queue.push(message);
      }
    });
  });
  call.on('error', () => {});
  return {
    next: (timeoutMs = 5000) => new Promise((resolve) => {
      const message = queue.shift();
      if (message) return resolve(message);
      const timer = setTimeout(() => { waiting.splice(waiting.indexOf(deliver), 1); resolve(null); }, timeoutMs);
      const deliver = (received: HostMessage) => { clearTimeout(timer); resolve(received); };
      waiting.push(deliver);
    }),
    close: () => call.destroy()
  };
}

test('renders are memoised per screen and view, and forgotten when what they read changes', async () => {
  const dir = copyExample();
  temporary.push(dir);
  const session = await openProject(dir, QUIET);
  sessions.push(session);
  const first = session.renderScreen({ screen: 'chemin' });
  assert.equal(session.renderScreen({ screen: 'chemin' }), first, 'the same render while nothing changed');
  assert.notEqual(session.renderScreen({ screen: 'chemin', state: 'answered' }), first, 'another view, another render');
  const accueil = session.renderScreen({ screen: 'accueil' });
  await session.run('update_block', { block: 'chemin-intro', props: { markdown: 'Nouveau texte' } });
  const second = session.renderScreen({ screen: 'chemin' });
  assert.notEqual(second, first);
  assert.match(JSON.stringify(second.course.screens[0]), /Nouveau texte/);
  assert.equal(session.renderScreen({ screen: 'accueil' }), accueil, 'another screen keeps its render');
  // Another screen's title is in the bars' outline: made again with it.
  await session.run('update_screen', { id: 'chemin', title: 'Le chemin, renommé' });
  const renamed = session.renderScreen({ screen: 'accueil' });
  assert.notEqual(renamed, accueil);
  assert.equal(renamed.outline?.sections.flatMap((section) => section.screens).find((screen) => screen.id === 'chemin')?.title, 'Le chemin, renommé');
  assert.equal(session.renderScreen({ screen: 'accueil' }), renamed);
  await session.run('update_course', { description: 'Un module sur le réseau' });
  assert.notEqual(session.renderScreen({ screen: 'accueil' }), renamed, 'course.json is shared: every render is made again');
});

test('the canvas host gets the screen shown again after each change that affects it, with the change as render id', async () => {
  const dir = copyExample();
  temporary.push(dir);
  const session = await openProject(dir, QUIET);
  sessions.push(session);
  const canvas = await session.openCanvas();
  assert.match(canvas.url, /^http:\/\/127\.0\.0\.1:\d+\/canvas\/index\.html\?token=/);
  const events = stream(`${canvas.base}/canvas/elabora/events`);
  try {
    const shown = await session.canvasView({ screen: 'chemin' });
    let message = await events.next();
    assert.equal(message?.type, 'elabora/render');
    assert.equal(message?.type === 'elabora/render' && message.id, shown.id);
    assert.equal(message?.type === 'elabora/render' && message.render.screen, 'chemin');

    // A command on the screen shown: a render whose id is the change's sequence number.
    const edited = await session.run('update_block', { block: 'chemin-intro', props: { markdown: 'Texte modifié' } });
    message = await events.next();
    assert.equal(message?.type === 'elabora/render' && message.id, edited.change?.seq);
    assert.match(JSON.stringify(message), /Texte modifié/);
    // A change to another screen: nothing is sent, unless the bars show it (its title in the outline).
    await session.run('update_block', { block: 'accueil-objectifs', props: { title: 'Autres objectifs' } });
    assert.equal(await events.next(300), null);
    const renamed = await session.run('update_screen', { id: 'accueil', title: 'Autre écran' });
    message = await events.next();
    assert.equal(message?.type === 'elabora/render' && message.id, renamed.change?.seq);
    assert.equal(message?.type === 'elabora/render' && message.render.screen, 'chemin');
    assert.equal(message?.type === 'elabora/render' && message.render.outline?.sections.flatMap((section) => section.screens).find((screen) => screen.id === 'accueil')?.title, 'Autre écran');
    // An agent's own write to the screen shown: sent too, with the external change's number.
    const screen = readJSON(dir, 'screens/chemin.json');
    screen.title = 'Titre de l\'agent';
    fs.writeFileSync(path.join(dir, 'screens/chemin.json'), JSON.stringify(screen));
    message = await events.next();
    assert.equal(message?.type, 'elabora/render');
    assert.equal(message?.type === 'elabora/render' && message.id, session.journalSeq);
    assert.match(JSON.stringify(message), /Titre de l'agent/);

    // Step, layer and state through requests: view messages, no new render.
    const view = await session.canvasView({ step: 1, state: 'answered' });
    message = await events.next();
    assert.deepEqual(message, { type: 'elabora/view', id: view.id, view: { state: 'answered', step: 1, layer: null } });
    // The next change keeps the view.
    await session.run('update_block', { block: 'chemin-intro', props: { markdown: 'Encore' } });
    message = await events.next();
    assert.deepEqual(message?.type === 'elabora/render' && message.render.view, { state: 'answered', step: 1, layer: null });
    // Another screen through a request.
    await session.canvasView({ screen: 'accueil', step: null, state: 'initial' });
    message = await events.next();
    assert.equal(message?.type === 'elabora/render' && message.render.screen, 'accueil');
    await assert.rejects(session.canvasView({ screen: 'absent' }), { kind: 'not-found' });
  } finally {
    events.close();
  }
  assert.deepEqual(await session.closeCanvas(), { closed: true });
});
