import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renditionsDir } from '@elabora/node/media/index';
import { pruneProjectData } from '@elabora/node/project-data';
import { projectFileHash } from '@elabora/node/file-hash';
import { presetHash } from '@elabora/core/media/presets';
import { copyExample } from '../helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

test('pruning removes week-old renditions of masters gone or of changed preset parameters, and keeps the rest', async () => {
  const dir = copyExample();
  fs.mkdirSync(path.join(dir, 'assets/video'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/video/clip.mp4'), crypto.randomBytes(4096));
  const master = (await projectFileHash(dir, 'assets/video/clip.mp4')).slice('sha256:'.length, 'sha256:'.length + 32);
  const gone = 'f'.repeat(32);
  const current = `medium-${presetHash('medium', 'video')}`;
  const cache = renditionsDir(dir);
  fs.mkdirSync(cache, { recursive: true });
  const now = new Date();
  const old = new Date(now.getTime() - 10 * DAY);
  const files: Record<string, Date> = {
    [`${master}-${current}.mp4`]: old,           // in use: kept, however old
    [`${master}-medium-000000000000.mp4`]: old,  // preset parameters changed
    [`${gone}-${current}.mp4`]: old,             // master deleted a week ago
    [`${gone}-low-${presetHash('low', 'video')}.mp4`]: now, // master deleted today: kept for a week
    'stray.tmp': old
  };
  for (const [name, time] of Object.entries(files)) {
    fs.writeFileSync(path.join(cache, name), Buffer.alloc(100));
    fs.utimesSync(path.join(cache, name), time, time);
  }
  const result = await pruneProjectData(dir, { now });
  assert.deepEqual(result.renditions, { removed: 3, bytesFreed: 300 });
  assert.deepEqual(fs.readdirSync(cache).sort(), [`${gone}-low-${presetHash('low', 'video')}.mp4`, `${master}-${current}.mp4`].sort());
});

test('pruning a project without renditions does nothing', async () => {
  const dir = copyExample();
  assert.deepEqual((await pruneProjectData(dir)).renditions, { removed: 0, bytesFreed: 0 });
});
