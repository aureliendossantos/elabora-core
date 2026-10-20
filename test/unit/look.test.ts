import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { objectFrame } from '@elabora/player/frames';
import { startServer } from '@elabora/node/emulator/server';
import { findLookServer, lookFolder } from '@elabora/node/look';
import { codeHash, codeVersion } from '@elabora/node/code-version';
import { copyExample } from '../helpers.ts';

test('object frames: next to the page in an opaque sandbox, or from the frames port of a local preview', () => {
  const page = 'http://127.0.0.1:4807/pkg/preview/index.html';
  // As in a package.
  assert.deepEqual(objectFrame('objects/lab', [], null, page), { src: 'objects/lab/frame.html', sandbox: 'allow-scripts' });
  assert.deepEqual(objectFrame('objects/lab', ['pointer-lock'], null, page), { src: 'objects/lab/frame.html', sandbox: 'allow-scripts allow-pointer-lock' });
  // A preview: another origin of the same site, which may keep allow-same-origin.
  assert.deepEqual(objectFrame('objects/lab', ['pointer-lock'], 4808, page), { src: 'http://127.0.0.1:4808/pkg/preview/objects/lab/frame.html', sandbox: 'allow-scripts allow-pointer-lock allow-same-origin' });
  assert.deepEqual(objectFrame('objects/lab', [], 4808, 'http://localhost:4807/canvas/index.html?token=x'), { src: 'http://localhost:4808/canvas/objects/lab/frame.html', sandbox: 'allow-scripts allow-same-origin' });
  // Never the page's own origin, never a page of another computer.
  assert.deepEqual(objectFrame('objects/lab', [], 4807, page), { src: 'objects/lab/frame.html', sandbox: 'allow-scripts' });
  assert.deepEqual(objectFrame('objects/lab', [], 4808, 'https://lms.example.com/content/index.html'), { src: 'objects/lab/frame.html', sandbox: 'allow-scripts' });
});

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; }).on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

test('preview server: the course page asks for frames from the second port and reloads when the package is built again', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-preview-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n</body>\n</html>\n');
  fs.writeFileSync(path.join(dir, 'other.html'), '<!doctype html>\n<meta charset="utf-8">\n<body></body>\n');
  const server = await startServer({ frames: true });
  try {
    assert.ok(server.framesPort && server.framesPort !== Number(new URL(server.base).port));
    server.addPackage('preview', dir, new Map(), { preview: true });
    server.addPackage('plain', dir);
    const page = await get(`${server.base}/pkg/preview/index.html`);
    assert.match(page.body, new RegExp(`<meta charset="utf-8">\\n<meta name="elabora-object-frames" content="${server.framesPort}">`));
    assert.match(page.body, /new EventSource\('\/preview-events\/preview'\)/);
    // Only the course page of a preview; the frames port serves the same.
    assert.doesNotMatch((await get(`${server.base}/pkg/plain/index.html`)).body, /elabora-object-frames|EventSource/);
    assert.doesNotMatch((await get(`${server.base}/pkg/preview/other.html`)).body, /elabora-object-frames/);
    assert.equal((await get(`http://127.0.0.1:${server.framesPort}/pkg/preview/other.html`)).status, 200);
    // A rebuild (the package added again) tells its pages to reload.
    const reload = new Promise<string>((resolve, reject) => {
      http.get(`${server.base}/preview-events/preview`, (response) => {
        let data = '';
        response.setEncoding('utf8').on('data', (chunk: string) => {
          data += chunk;
          if (data.includes('retry:') && !data.includes('data:')) server.addPackage('preview', dir, new Map(), { preview: true });
          if (data.includes('data: reload')) { resolve(data); response.destroy(); }
        });
      }).on('error', reject);
    });
    assert.match(await reload, /data: reload/);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('look server: none answers for a course that never started one, or whose server is gone', async () => {
  const dir = copyExample();
  try {
    assert.equal(await findLookServer(dir), null);
    // A server.json left by a process that is gone.
    fs.mkdirSync(lookFolder(dir), { recursive: true });
    fs.writeFileSync(path.join(lookFolder(dir), 'server.json'), JSON.stringify({ pid: 999999, base: 'http://127.0.0.1:9', token: 'x', url: '', version: '0', root: dir }));
    assert.equal(await findLookServer(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code version: two states of the sources are two versions, so that a look server of older code is replaced', () => {
  const packages = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-code-'));
  try {
    fs.mkdirSync(path.join(packages, 'node/src'), { recursive: true });
    fs.mkdirSync(path.join(packages, 'player/src'), { recursive: true });
    fs.mkdirSync(path.join(packages, 'node/node_modules/dep'), { recursive: true });
    fs.writeFileSync(path.join(packages, 'node/src/look.ts'), 'export const subtitles = "[chuchote]";\n');
    fs.writeFileSync(path.join(packages, 'player/src/player.css'), '.t-caption { color: black; }\n');
    const before = codeHash({ packages });
    assert.match(before!, /^[0-9a-f]{12}$/);
    assert.equal(codeHash({ packages }), before, 'the same sources, the same version');
    fs.writeFileSync(path.join(packages, 'node/node_modules/dep/index.js'), 'ignored\n');
    assert.equal(codeHash({ packages }), before, 'installed packages are not the code');
    fs.writeFileSync(path.join(packages, 'player/src/player.css'), '.t-caption { color: white; }\n');
    const edited = codeHash({ packages });
    assert.notEqual(edited, before, 'a stylesheet of the player edited');
    fs.renameSync(path.join(packages, 'node/src/look.ts'), path.join(packages, 'node/src/looks.ts'));
    assert.notEqual(codeHash({ packages }), edited, 'a file renamed');
  } finally {
    fs.rmSync(packages, { recursive: true, force: true });
  }
  // The running code: the package's version, then the hash of its sources.
  assert.match(codeVersion(), /^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
});

test('code version: a packaged app has no sources, its bundles are the code', () => {
  const bundles = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-bundles-'));
  try {
    fs.writeFileSync(path.join(bundles, 'elabora.js'), 'import "./core.js";\n');
    fs.writeFileSync(path.join(bundles, 'core.js'), 'console.log(1);\n');
    const entry = path.join(bundles, 'elabora.js');
    const first = codeHash({ bundled: true, entry });
    assert.ok(first);
    assert.equal(codeHash({ bundled: true, entry }), first);
    fs.writeFileSync(path.join(bundles, 'core.js'), 'console.log(2);\n');
    assert.notEqual(codeHash({ bundled: true, entry }), first, 'a bundle made again');
    assert.equal(codeHash({ bundled: true, entry: '' }), null, 'no entry, nothing to hash');
  } finally {
    fs.rmSync(bundles, { recursive: true, force: true });
  }
});
