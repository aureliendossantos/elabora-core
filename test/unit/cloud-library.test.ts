import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A project of a team downloaded into the library (cloneToLibrary), from a test server of this file:
// one whose module reads comes in; one whose course.json does not read (the filler text of a project
// written before the room validated) is refused, and nothing of it stays, in the library or in the
// projects' data. Its card's picture (C77): sent with its type at a head, read with its version.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-cloud-library-'));
const library = path.join(work, 'library');
const data = path.join(work, 'data');
process.env.ELABORA_LIBRARY = library;
process.env.ELABORA_DATA_DIR = data;
const keyFile = path.join(work, 'key');
fs.writeFileSync(keyFile, `eas_${'a'.repeat(43)}`, { mode: 0o600 });
process.env.ELABORA_CLOUD_KEY_FILE = keyFile;

const projects: Record<string, { path: string; text: string }[]> = {
  prj_good: [{ path: 'course.json', text: JSON.stringify({ id: 'course-good', title: 'Lisible', format: 'elabora/0.1', language: 'fr' }) }],
  prj_broken: [{ path: 'course.json', text: 'alpha 89 ···· alpha 90 ····' }, { path: 'screens/intro.json', text: 'alpha 12 ··' }]
};
const covers = new Map<string, { type: string; bytes: Buffer; head: number }>();
const server = http.createServer(async (request, response) => {
  const answer = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  const cover = /^\/v1\/teams\/tm_test\/projects\/(prj_\w+)\/cover(?:\?head=(\d+))?$/.exec(request.url ?? '');
  if (cover && request.method === 'PUT') {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const kept = { type: String(request.headers['content-type']), bytes: Buffer.concat(chunks), head: Number(cover[2]) };
    covers.set(cover[1]!, kept);
    return answer(200, { cover: { head: kept.head, version: `v${kept.head}`, type: kept.type, bytes: kept.bytes.length, source: 'app', at: new Date().toISOString() } });
  }
  const renamed = /^\/v1\/teams\/tm_test\/projects\/(prj_\w+)$/.exec(request.url ?? '');
  if (renamed && request.method === 'PATCH') {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    const name = (JSON.parse(text) as { name: string }).name;
    return answer(200, { project: { id: renamed[1], team: 'tm_test', name }, ...(name === 'Lisible' ? {} : { change: 4 }) });
  }
  if (cover && request.method === 'GET') {
    const kept = covers.get(cover[1]!);
    if (!kept) return answer(404, { error: { code: 'no-cover', message: 'No cover yet.' } });
    response.writeHead(200, { 'content-type': kept.type, etag: `"v${kept.head}"` });
    return response.end(kept.bytes);
  }
  if (request.url === '/v1/account') return answer(200, { account: { id: 'acc_test', handle: 'test', displayName: 'Test' } });
  const files = /^\/v1\/teams\/tm_test\/projects\/(prj_\w+)\/files$/.exec(request.url ?? '')?.[1];
  if (files && projects[files]) return answer(200, { head: 3, files: projects[files] });
  answer(404, { error: { code: 'not-found', message: 'No such thing.' } });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ELABORA_CLOUD_URL = api;
const { cloneToLibrary, projectsClient, putCover, readCover, renameProject } = await import('@elabora/node/cloud/projects');
after(() => { server.close(); fs.rmSync(work, { recursive: true, force: true }); });

const kept = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.startsWith('.')) : []);

test('a project whose module does not read is not downloaded into the library; one that reads is', async () => {
  await assert.rejects(cloneToLibrary({ api, team: 'tm_test', project: 'prj_broken' }), (error: { code?: string }) => error.code === 'E_PROJECT_UNREADABLE');
  assert.deepEqual(kept(library), []);
  assert.deepEqual(kept(path.join(data, 'projects')), []);
  const good = await cloneToLibrary({ api, team: 'tm_test', project: 'prj_good' });
  assert.equal(good.title, 'Lisible');
  assert.deepEqual(kept(library), [path.basename(good.path)]);
});

test('a project\'s cover: none at first, then sent with its type at a head, read back with its version (C77)', async () => {
  const client = projectsClient(api);
  assert.equal(await readCover(client, 'tm_test', 'prj_good'), null);
  const picture = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const sent = await putCover(client, 'tm_test', 'prj_good', 3, picture, 'image/jpeg');
  assert.deepEqual([sent.head, sent.version, covers.get('prj_good')?.type, [...covers.get('prj_good')!.bytes]], [3, 'v3', 'image/jpeg', [...picture]]);
  const read = await readCover(client, 'tm_test', 'prj_good');
  assert.deepEqual([read?.type, read?.version, [...read!.bytes]], ['image/jpeg', 'v3', [...picture]]);
});

test('a project renamed: its name sent, the project and the change the room placed back; none when the title was that already (C78)', async () => {
  const client = projectsClient(api);
  const renamed = await renameProject(client, 'tm_test', 'prj_good', 'Lisible, autrement');
  assert.deepEqual([renamed.project.name, renamed.change], ['Lisible, autrement', 4]);
  assert.equal((await renameProject(client, 'tm_test', 'prj_good', 'Lisible')).change, undefined);
});
