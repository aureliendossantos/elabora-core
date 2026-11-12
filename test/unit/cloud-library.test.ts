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
// projects' data.
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
const server = http.createServer((request, response) => {
  const answer = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (request.url === '/v1/account') return answer(200, { account: { id: 'acc_test', handle: 'test', displayName: 'Test' } });
  const files = /^\/v1\/teams\/tm_test\/projects\/(prj_\w+)\/files$/.exec(request.url ?? '')?.[1];
  if (files && projects[files]) return answer(200, { head: 3, files: projects[files] });
  answer(404, { error: { code: 'not-found', message: 'No such thing.' } });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ELABORA_CLOUD_URL = api;
const { cloneToLibrary } = await import('@elabora/node/cloud/projects');
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
