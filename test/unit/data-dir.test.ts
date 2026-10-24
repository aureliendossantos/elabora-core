import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { moduleUrl } from '../helpers.ts';
import { resources } from '../resources.ts';

// Each case runs in a child process: the data location is cached per process and read from the
// environment once.
const probe = (dir: string, env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
  const { dataLocation } = await import(${JSON.stringify(moduleUrl('packages/node/src/data-dir.ts'))});
  const { putBytes, blobPath } = await import(${JSON.stringify(moduleUrl('packages/node/src/blobs.ts'))});
  const hash = putBytes(${JSON.stringify(dir)}, 'x');
  console.log(JSON.stringify({ ...dataLocation(${JSON.stringify(dir)}), blob: blobPath(${JSON.stringify(dir)}, hash) }));
`], { env: { ...process.env, ELABORA_DATA_DIR: '', ...env } }).toString());

test('machine-local data stays in .elabora/ by default, or moves under ELABORA_DATA_DIR with a project id', (t) => {
  const r = resources(t);
  const project = path.join(r.tempDir('elabora-data-'), 'course');
  fs.mkdirSync(project);
  const local = probe(project, {});
  assert.equal(local.inProject, true);
  assert.ok(local.blob.startsWith(path.join(project, '.elabora', 'blobs')));

  const store = r.tempDir('elabora-store-');
  const moved = probe(project, { ELABORA_DATA_DIR: store });
  assert.equal(moved.inProject, false);
  const id = fs.readFileSync(path.join(project, '.elabora', 'project-id'), 'utf8').trim();
  assert.equal(moved.dir, path.join(store, 'projects', id));
  assert.ok(fs.existsSync(moved.blob));
  // Same project, same id: renaming the folder keeps its data.
  const renamed = `${project}-renamed`;
  fs.renameSync(project, renamed);
  assert.equal(probe(renamed, { ELABORA_DATA_DIR: store }).dir, moved.dir);
  assert.equal(probe(renamed, {}).inProject, true);
});
