import { test } from 'node:test';
import { resources } from '../resources.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { startCanvasHost } from '@elabora/node/canvas/host';
import { byteRange, mimeType } from '@elabora/node/canvas/files';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { HostMessage } from '@elabora/player/canvas-protocol';
import { ROOT } from '../helpers.ts';
import { narrate, hasFfmpeg } from '../narration.ts';

test('byte ranges: first, open, last bytes; several ranges serve the whole file', (t) => {
  assert.deepEqual(byteRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(byteRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(byteRange('bytes=990-2000', 1000), { start: 990, end: 999 });
  assert.equal(byteRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(byteRange('bytes=5-1', 1000), 'unsatisfiable');
  assert.equal(byteRange('bytes=0-1,5-9', 1000), null);
  assert.equal(byteRange(undefined, 1000), null);
  assert.equal(mimeType('theme/fonts/inter.woff2'), 'font/woff2');
  assert.equal(mimeType('assets/video/a.MP4'), 'video/mp4');
  assert.equal(mimeType('assets/x.unknown'), 'application/octet-stream');
  // The player's resources: a PDF sent as anything else is downloaded and its preview stays empty.
  assert.equal(mimeType('assets/resources/fiche.pdf'), 'application/pdf');
  assert.equal(mimeType('assets/resources/Plan.XLSX'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(mimeType('assets/resources/notes.odt'), 'application/vnd.oasis.opendocument.text');
});

// Messages of the event stream of the canvas page, as they arrive.
function events(url: string): { next(): Promise<HostMessage>; close(): void } {
  const queue: HostMessage[] = [];
  const waiting: ((message: HostMessage) => void)[] = [];
  let buffer = '';
  const call = http.get(url, (response) => {
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
        if (!data) continue;
        const message = JSON.parse(data) as HostMessage;
        const resolve = waiting.shift();
        if (resolve) resolve(message); else queue.push(message);
      }
    });
  });
  call.on('error', () => {});
  return {
    next: () => new Promise((resolve) => { const message = queue.shift(); if (message) resolve(message); else waiting.push(resolve); }),
    close: () => call.destroy()
  };
}

const get = (url: string) => new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
  http.get(url, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode ?? 0, type: String(response.headers['content-type']), body }));
  }).on('error', reject);
});

test('canvas host: render data pushed to pages, styles sent once, the page and the files it needs served', { timeout: 120000 }, async (t) => {
  const project = loadProjectFromDir(path.join(ROOT, 'examples', 'planetary-gearset'));
  const context = createRenderContext(project);
  const host = resources(t).own(await startCanvasHost({ root: project.root }), value => value.close());
  const first = events(`${host.base}/canvas/elabora/events`);
  try {
    const page = await get(host.url);
    assert.equal(page.status, 200);
    assert.match(page.body, /<link rel="stylesheet" href="elabora\/player.css">[\s\S]*<script src="elabora\/canvas.js"><\/script>/);
    assert.match(host.url, /\/canvas\/index.html\?token=[0-9a-f]{32}$/);
    for (const [name, type] of [['elabora/canvas.js', /^text\/javascript/], ['elabora/player.css', /^text\/css/], ['elabora/object-frame.js', /^text\/javascript/], ['elabora/canvas-connect.js', /^text\/javascript/]] as const) {
      const file = await get(`${host.base}/canvas/${name}`);
      assert.equal(file.status, 200, name);
      assert.match(file.type, type, name);
    }
    assert.equal((await get(`${host.base}/canvas/objects/planetary-lab/frame.html`)).status, 404, 'nothing of the project before a render lists it');

    const lab = renderScreen(project, 'lab', {}, context);
    assert.equal(host.push(lab, { id: 1 }), 1);
    const one = await first.next();
    assert.ok(one.type === 'elabora/render' && one.id === 1 && one.render.screen === 'lab');
    assert.equal(one.render.styles?.hash, lab.styles.hash);
    assert.deepEqual(one.render.files, lab.files, 'the files and their hashes, for the canvas to load again what changed');
    for (const file of lab.files) assert.match(String(file.hash), /^sha256:[0-9a-f]{64}$/, file.path);
    host.push(renderScreen(project, 'intro', {}, context), { id: 2 });
    const two = await first.next();
    assert.ok(two.type === 'elabora/render' && two.render.screen === 'intro' && two.render.styles === undefined, 'styles the page has are not sent again');
    host.view({ step: 1 }, { id: 3 });
    const three = await first.next();
    assert.deepEqual(three, { type: 'elabora/view', id: 3, view: { step: 1 } });
    // A page connecting later gets the last render, with its styles and the view since.
    const second = resources(t).own(events(`${host.base}/canvas/elabora/events`), value => value.close());
    const late = await second.next();
    assert.ok(late.type === 'elabora/render' && late.render.screen === 'intro' && late.render.styles && late.render.view.step === 1);
    second.close();

    // The files of the object of the lab: its frame and its code generated, its folder's files served.
    const frame = await get(`${host.base}/canvas/objects/planetary-lab/frame.html`);
    assert.equal(frame.status, 200);
    assert.match(frame.body, /connect-src 'none'/);
    assert.match(frame.body, /<script src="object.js"><\/script>/);
    const code = await get(`${host.base}/canvas/objects/planetary-lab/object.js`);
    assert.equal(code.status, 200);
    assert.match(code.body, /__elaboraObject/);
    for (const file of lab.files.filter((candidate) => ['asset', 'style', 'font', 'object'].includes(candidate.kind))) assert.equal((await get(`${host.base}/canvas/${file.path}`)).status, 200, file.path);
  } finally {
    first.close();
    await host.close();
  }
});

test('canvas host: the audio of a narration line served for the editor to play, nothing else unlisted', { skip: !hasFfmpeg() && 'ffmpeg not found' }, async (t) => {
  const dir = resources(t).copyExample();
  narrate(dir, 'accueil', [{ id: 'l1', text: 'Bonjour.', seconds: 1 }], { speakers: [{ id: 'guide', name: 'Guide' }] });
  const host = resources(t).own(await startCanvasHost({ root: dir }), value => value.close());
  try {
    const audio = await get(`${host.base}/canvas/assets/narration/fr/accueil/l1.m4a`);
    assert.equal(audio.status, 200);
    assert.equal(audio.type, 'audio/mp4');
    assert.equal((await get(`${host.base}/canvas/assets/narration/fr/accueil/l1.json`)).status, 404, 'its sidecar is not served');
    assert.equal((await get(`${host.base}/canvas/assets/narration/fr/accueil/l9.m4a`)).status, 404, 'a line without audio');
    assert.equal((await get(`${host.base}/canvas/course.json`)).status, 404);
  } finally {
    await host.close();
  }
});
