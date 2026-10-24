import { test, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../helpers.ts';
import { resources } from '../resources.ts';
import { bytes } from '../bytes.ts';
import {
  createVersion, shouldTakeVersion, restore, prune, collectGarbage, nameVersion, deleteVersion,
  listVersions, readVersion, diffVersions, status, retentionPlan, withBackupsLock, BackupsLockedError,
  type Version, type VersionReport, type RetentionInput,
} from '@elabora/node/backups/index';
import { blobPath, hasBlob, listBlobs, putBytes, type BlobHash } from '@elabora/node/blobs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.now();
const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

// A project in a temp folder. Times are set a minute back: files written just now are not cached
// (they could still change within the same timestamp tick).
function project(t: TestContext, files: Record<string, string | Buffer>): string {
  const dir = resources(t).tempDir('elabora-backups-');
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}
// Files are dated a minute back (past the hash cache's racy window), each write a millisecond after
// the last at least: a rewrite of the same size never shares its predecessor's time, which would
// make it look unchanged (random offsets did, about once in 500 writes).
let lastWrite = 0;
beforeEach(() => { lastWrite = 0; });
function write(dir: string, rel: string, content: string | Buffer): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  lastWrite = Math.max(Date.now() - 60_000, lastWrite + 1);
  const past = new Date(lastWrite);
  fs.utimesSync(file, past, past);
}
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));

async function created(dir: string, options: Parameters<typeof createVersion>[1]): Promise<Version> {
  const v = await createVersion(dir, options);
  assert.ok(v, 'a version was expected');
  return v;
}

test('backups: an unchanged project gives no version, a change gives one', async (t) => {
  const dir = project(t, {
    'course.json': '{"a":1}\n',
    'screens/intro.json': '{}\n',
    'assets/img.png': bytes(2000),
    'dist/package.zip': 'build output',
    '.elabora/journal/2026-10.jsonl': '{}\n',
  });
  const v1 = await created(dir, { reason: 'manual', now: T0 });
  assert.deepEqual(Object.keys(v1.files), ['assets/img.png', 'course.json', 'screens/intro.json']);
  assert.ok(exists(dir, `.elabora/backups/versions/${v1.time.replace(/:/g, '-')}-${v1.id}.json`));
  assert.ok(hasBlob(dir, v1.files['assets/img.png'].hash));

  assert.equal(await createVersion(dir, { reason: 'auto', now: T0 + 60_000 }), null);

  write(dir, 'course.json', '{"a":2}\n');
  write(dir, 'screens/new.json', '{"new":true}\n');
  fs.rmSync(path.join(dir, 'screens/intro.json'));
  const v2 = await created(dir, { reason: 'after-ai', batch: 'b1', author: { kind: 'agent', name: 'claude-code' }, now: T0 + 120_000 });
  const diff = diffVersions(v1, v2);
  assert.deepEqual(diff.changed.map((c) => c.path), ['course.json']);
  assert.deepEqual(diff.added.map((c) => c.path), ['screens/new.json']);
  assert.deepEqual(diff.removed.map((c) => c.path), ['screens/intro.json']);

  // A named version is taken even when nothing changed.
  const named = await created(dir, { reason: 'publish', name: 'Published 1.2.0', now: T0 + 180_000 });
  assert.deepEqual(named.files, v2.files);

  const list = listVersions(dir);
  assert.deepEqual(list.map((v) => v.reason), ['manual', 'after-ai', 'publish']);
  assert.equal(list[1].batch, 'b1');
  assert.deepEqual(list[1].author, { kind: 'agent', name: 'claude-code' });
  assert.equal(readVersion(dir, 'Published 1.2.0').id, named.id);
  assert.equal(readVersion(dir, named.id.slice(0, 5)).id, named.id);
});

test('backups: full restore makes the project match the version, after saving the current state', async (t) => {
  const dir = project(t, { 'course.json': '{"v":1}\n', 'screens/a.json': '{"a":1}\n', 'assets/clip.mp4': bytes(5000) });
  const v1 = await created(dir, { reason: 'manual', now: T0 });
  write(dir, 'course.json', '{"v":2}\n');
  fs.rmSync(path.join(dir, 'assets/clip.mp4'));
  write(dir, 'extra/notes/n.md', 'later\n');
  write(dir, 'dist/out.zip', 'build');
  write(dir, '.elabora/journal/x.jsonl', '{}\n');

  const result = await restore(dir, v1.id, { now: T0 + HOUR });
  assert.equal(read(dir, 'course.json'), '{"v":1}\n');
  assert.ok(fs.readFileSync(path.join(dir, 'assets/clip.mp4')).equals(fs.readFileSync(blobPath(dir, v1.files['assets/clip.mp4'].hash))));
  assert.equal(exists(dir, 'extra'), false, 'files the version does not have are deleted, and their emptied folders');
  assert.ok(exists(dir, 'dist/out.zip') && exists(dir, '.elabora/journal/x.jsonl'), 'tool folders are never touched');
  assert.deepEqual(result.changes.map((c) => [c.path, c.before === null, c.after === null]), [
    ['assets/clip.mp4', true, false],
    ['course.json', false, false],
    ['extra/notes/n.md', false, true],
  ]);
  assert.equal(result.changes[1].after, v1.files['course.json'].hash);

  // The state before the restore is a version: restoring it undoes the restore.
  const before = readVersion(dir, result.before!);
  assert.equal(before.reason, 'restore');
  assert.ok(before.files['extra/notes/n.md']);
  await restore(dir, before.id, { now: T0 + 2 * HOUR });
  assert.equal(read(dir, 'course.json'), '{"v":2}\n');
  assert.equal(read(dir, 'extra/notes/n.md'), 'later\n');
  assert.equal(exists(dir, 'assets/clip.mp4'), false);
});

test('backups: partial restore writes the selected files and never deletes', async (t) => {
  const dir = project(t, { 'screens/s1.json': '1\n', 'screens/s2.json': '2\n', 'assets/a.png': bytes(100) });
  const v1 = await created(dir, { reason: 'manual', now: T0 });
  write(dir, 'screens/s1.json', '1b\n');
  write(dir, 'screens/s2.json', '2b\n');
  write(dir, 'assets/a.png', bytes(100, 2));
  write(dir, 'screens/s3.json', '3\n');

  const r1 = await restore(dir, v1.id, { paths: ['screens/s1.json', 'assets/*.png', 'nothing/**'], now: T0 + HOUR });
  assert.deepEqual(r1.changes.map((c) => c.path), ['assets/a.png', 'screens/s1.json']);
  assert.deepEqual(r1.unmatched, ['nothing/**']);
  assert.equal(read(dir, 'screens/s1.json'), '1\n');
  assert.equal(read(dir, 'screens/s2.json'), '2b\n');

  const r2 = await restore(dir, v1.id, { paths: ['screens/'], now: T0 + 2 * HOUR });
  assert.deepEqual(r2.changes.map((c) => c.path), ['screens/s2.json']);
  assert.equal(read(dir, 'screens/s3.json'), '3\n', 'a partial restore never deletes');
});

test('backups: skipped media, sync conflict copies and symbolic links are not content', async (t) => {
  const outside = resources(t).tempDir('elabora-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the project');
  const dir = project(t, {
    'course.json': '{}\n',
    'screens/intro.json': '{"id":"intro"}\n',
    'screens/intro (conflicted copy).json': '{"id":"intro","other":1}\n',
    'assets/video/raw.mov': bytes(3000),
  });
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'assets/link.txt'));
    fs.symlinkSync(outside, path.join(dir, 'assets/linked-folder'));
  }
  const v1 = await created(dir, { reason: 'manual', skip: ['assets/video/raw.mov'], now: T0 });
  assert.deepEqual(Object.keys(v1.files), ['course.json', 'screens/intro.json']);
  const reasons = Object.fromEntries(v1.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons['assets/video/raw.mov'], 'excluded');
  assert.equal(reasons['screens/intro (conflicted copy).json'], 'conflict-copy');
  if (process.platform !== 'win32') {
    assert.equal(reasons['assets/link.txt'], 'symlink');
    assert.equal(reasons['assets/linked-folder'], 'symlink');
    assert.equal(hasBlob(dir, `sha256:${crypto.createHash('sha256').update('outside the project').digest('hex')}`), false);
  }

  // The raw media existed when the version was taken: a full restore leaves it.
  write(dir, 'course.json', '{"changed":true}\n');
  const result = await restore(dir, v1.id, { skip: ['assets/video/raw.mov'], now: T0 + HOUR });
  assert.deepEqual(result.changes.map((c) => c.path), ['course.json']);
  assert.ok(exists(dir, 'assets/video/raw.mov') && exists(dir, 'screens/intro (conflicted copy).json'));
  if (process.platform !== 'win32') assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside the project');
});

test('backups: restore across file and folder swaps, never through a symbolic link', async (t) => {
  const dir = project(t, { 'assets/a': 'a file\n', 'assets/b/x.json': '{}\n', 'screens/s.json': '1\n' });
  const v1 = await created(dir, { reason: 'manual', now: T0 });
  fs.rmSync(path.join(dir, 'assets/a'));
  write(dir, 'assets/a/inner.json', '{}\n');
  fs.rmSync(path.join(dir, 'assets/b'), { recursive: true });
  write(dir, 'assets/b', 'now a file\n');
  await restore(dir, v1.id, { now: T0 + HOUR });
  assert.equal(read(dir, 'assets/a'), 'a file\n');
  assert.equal(read(dir, 'assets/b/x.json'), '{}\n');

  if (process.platform === 'win32') return;
  const outside = resources(t).tempDir('elabora-outside-');
  fs.rmSync(path.join(dir, 'screens'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'screens'));
  const result = await restore(dir, v1.id, { now: T0 + 2 * HOUR });
  assert.deepEqual(result.kept, [{ path: 'screens/s.json', reason: 'symlink' }]);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing is written outside the project');
});

test('backups: cloud placeholders keep their content; manifests with unsafe paths are not trusted', async (t) => {
  const dir = project(t, { 'course.json': '{}\n', 'assets/intro.mp4': bytes(3000) });
  const v1 = await created(dir, { reason: 'manual', now: T0 });
  // iCloud evicted the video: only its stub is on this computer.
  fs.rmSync(path.join(dir, 'assets/intro.mp4'));
  write(dir, 'assets/.intro.mp4.icloud', 'stub');
  write(dir, 'course.json', '{"v":2}\n');
  const v2 = await created(dir, { reason: 'auto', now: T0 + HOUR });
  assert.deepEqual(v2.files['assets/intro.mp4'], v1.files['assets/intro.mp4']);
  assert.deepEqual(v2.skipped, [{ path: 'assets/intro.mp4', reason: 'cloud-placeholder', kept: true }]);
  const result = await restore(dir, v1.id, { now: T0 + 2 * HOUR });
  assert.deepEqual(result.kept, [{ path: 'assets/intro.mp4', reason: 'cloud-placeholder' }]);
  assert.equal(exists(dir, 'assets/intro.mp4'), false, 'not written over the cloud copy');

  const file = path.join(dir, '.elabora/backups/versions', fs.readdirSync(path.join(dir, '.elabora/backups/versions'))[0]);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const bad of ['../outside.txt', '/etc/hosts', '.elabora/lock', 'a\\b.json', 'dist/x.zip']) {
    fs.writeFileSync(file, JSON.stringify({ ...manifest, files: { [bad]: manifest.files['course.json'] } }));
    assert.equal(status(dir).problems.length, 1, bad);
    await assert.rejects(restore(dir, manifest.id), /No backup version/);
  }
});

test('backups: an unreadable file keeps its previous content and is never overwritten', { skip: !canChmod }, async (t) => {
  const dir = project(t, { 'course.json': '{"v":1}\n', 'assets/locked.bin': bytes(1000) });
  const v1 = await created(dir, { reason: 'manual', now: T0 });
  write(dir, 'assets/locked.bin', bytes(1200));
  write(dir, 'course.json', '{"v":2}\n');
  fs.chmodSync(path.join(dir, 'assets/locked.bin'), 0o000);
  try {
    const v2 = await created(dir, { reason: 'auto', now: T0 + HOUR });
    assert.deepEqual(v2.skipped, [{ path: 'assets/locked.bin', reason: 'unreadable', error: 'EACCES', kept: true }]);
    assert.deepEqual(v2.files['assets/locked.bin'], v1.files['assets/locked.bin']);
    const result = await restore(dir, v1.id, { now: T0 + 2 * HOUR });
    assert.deepEqual(result.kept, [{ path: 'assets/locked.bin', reason: 'unreadable' }]);
    assert.deepEqual(result.changes.map((c) => c.path), ['course.json']);
    assert.equal(fs.statSync(path.join(dir, 'assets/locked.bin')).size, 1200);
  } finally {
    fs.chmodSync(path.join(dir, 'assets/locked.bin'), 0o644);
  }
});

test('backups: the hash cache avoids reading unchanged files again', { skip: !canChmod }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const dir = project(t, { 'course.json': '{"v":1}\n', 'assets/big.bin': bytes(1 << 20) });
  const reports: VersionReport[] = [];
  const v1 = await created(dir, { reason: 'manual', now: T0, onReport: (r) => reports.push(r) });
  assert.equal(reports[0].hashedFiles, 2);
  // Unreadable but unchanged (same size and time): the cache answers, the file is not opened.
  fs.chmodSync(path.join(dir, 'assets/big.bin'), 0o000);
  try {
    write(dir, 'course.json', '{"v":2}\n');
    const v2 = await created(dir, { reason: 'auto', now: T0 + HOUR, onReport: (r) => reports.push(r) });
    assert.deepEqual([reports[1].hashedFiles, reports[1].reusedFiles, reports[1].skipped], [1, 1, []]);
    assert.equal(v2.files['assets/big.bin'].hash, v1.files['assets/big.bin'].hash);
  } finally {
    fs.chmodSync(path.join(dir, 'assets/big.bin'), 0o644);
  }
  // A file written just now is not trusted from the cache yet.
  fs.writeFileSync(path.join(dir, 'fresh.json'), '{}\n');
  await createVersion(dir, { reason: 'auto', now: T0 + 2 * HOUR, onReport: (r) => reports.push(r) });
  await createVersion(dir, { reason: 'auto', now: T0 + 3 * HOUR, onReport: (r) => reports.push(r) });
  assert.deepEqual([reports[3].created, reports[3].hashedFiles], [false, 1]);
});

// A year of work: a version every 20 minutes from 9:00 to 18:00 on weekdays, a release named every
// quarter, pruning every evening.
test('backups: the retention schedule over a simulated year', () => {
  const start = Date.UTC(2025, 9, 6); // a Monday
  const all: RetentionInput[] = [];
  let kept: RetentionInput[] = [];
  let now = start;
  for (let day = 0; day < 365; day++) {
    const midnight = start + day * DAY;
    const weekday = new Date(midnight).getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      for (let minute = 9 * 60; minute < 18 * 60; minute += 20) {
        const v = { id: `v${all.length}`, time: midnight + minute * 60_000, name: day % 91 === 3 && minute === 12 * 60 ? `Release ${day}` : null };
        all.push(v);
        kept.push(v);
      }
    }
    now = midnight + 22 * HOUR;
    const plan = retentionPlan(kept, now);
    kept = kept.filter((v) => plan.keep.has(v.id));
  }
  // Pruning every day keeps exactly what pruning once would: the schedule never leaves a gap.
  const once = retentionPlan(all, now);
  assert.deepEqual(kept.map((v) => v.id), all.filter((v) => once.keep.has(v.id)).map((v) => v.id));

  const keptIds = new Set(kept.map((v) => v.id));
  for (const v of all) if (v.name) assert.ok(keptIds.has(v.id), `named ${v.name} kept`);
  const tiers = [
    { from: 0, to: DAY, period: 0 },
    { from: DAY, to: 7 * DAY, period: HOUR },
    { from: 7 * DAY, to: 30 * DAY, period: DAY },
    { from: 30 * DAY, to: Infinity, period: 7 * DAY },
  ];
  const bucket = (time: number, period: number) => (period === 7 * DAY ? Math.floor((time - 4 * DAY) / period) : Math.floor(time / period));
  for (const tier of tiers) {
    const inTier = (v: RetentionInput) => now - v.time > tier.from && now - v.time <= tier.to;
    if (tier.period === 0) {
      assert.deepEqual(kept.filter(inTier).map((v) => v.id), all.filter(inTier).map((v) => v.id), 'everything from the last 24 hours');
      continue;
    }
    const periods = new Map<number, { all: number; kept: number; keptInTier: number }>();
    for (const v of all.filter(inTier)) {
      const b = bucket(v.time, tier.period);
      if (!periods.has(b)) periods.set(b, { all: 0, kept: 0, keptInTier: 0 });
      periods.get(b)!.all++;
    }
    for (const v of kept) {
      const p = periods.get(bucket(v.time, tier.period));
      if (!p) continue;
      p.kept++;
      if (inTier(v) && !v.name) p.keptInTier++;
    }
    for (const [b, p] of periods) {
      assert.ok(p.kept >= 1, `period ${b} of ${tier.period / HOUR} h has a version`);
      assert.ok(p.keptInTier <= 1, `period ${b} of ${tier.period / HOUR} h keeps one version`);
    }
  }
  // 27 versions a day for 24 h, ~9 per working day for 6 days, ~17 days, ~48 weeks, 4 releases.
  assert.ok(kept.length < 27 + 6 * 9 + 23 + 48 + 4, `${kept.length} versions kept`);
});

test('backups: a year of versions and pruning keeps the store consistent', async (t) => {
  const dir = project(t, { 'course.json': '{}\n', 'assets/clip.bin': bytes(10_000) });
  let now = T0;
  for (let i = 0; i < 40; i++) {
    now += 9 * DAY;
    write(dir, 'course.json', `{"i":${i}}\n`);
    if (i % 3 === 0) write(dir, 'assets/clip.bin', bytes(10_000, i + 2));
    await created(dir, { reason: 'auto', name: i === 5 ? 'Published 1.0' : null, now });
    await prune(dir, { now, graceMs: 0 });
  }
  const versions = listVersions(dir).map((s) => readVersion(dir, s.id));
  const old = (v: Version) => now - Date.parse(v.time) > 30 * DAY;
  const clip = (v: Version) => (v.files['assets/clip.bin'] ?? v.trimmed['assets/clip.bin']).hash;
  // Still needed: the current content, a named version's, a version of the last 30 days'.
  const needed = new Set(versions.filter((v, i) => i === versions.length - 1 || v.name || !old(v)).map(clip));
  const referenced = new Set<string>();
  for (const v of versions) {
    for (const e of Object.values(v.files)) {
      assert.ok(hasBlob(dir, e.hash), `${v.id} has its files`);
      referenced.add(e.hash);
    }
    const trimmable = old(v) && !v.name && !needed.has(clip(v));
    assert.equal('assets/clip.bin' in v.trimmed, trimmable, `${v.time}: binaries of old versions are trimmed unless still needed`);
  }
  assert.ok(versions.some((v) => 'assets/clip.bin' in v.trimmed) && versions.some((v) => old(v) && 'assets/clip.bin' in v.files && !v.name));
  const stored = listBlobs(dir);
  assert.deepEqual(stored.filter((h) => !referenced.has(h)), [], 'no blob is left that no version uses');
});

test('backups: a deleted 50 MB video leaves the store after 30 days, unless a named version has it', async (t) => {
  for (const named of [false, true]) {
    const dir = project(t, { 'course.json': '{}\n', 'assets/video/intro.mp4': bytes(50 << 20) });
    const v1 = await created(dir, { reason: 'manual', name: named ? 'Published 1.0' : null, now: T0 });
    const hash = v1.files['assets/video/intro.mp4'].hash;
    fs.rmSync(path.join(dir, 'assets/video/intro.mp4'));
    write(dir, 'course.json', '{"v":2}\n');
    await created(dir, { reason: 'auto', now: T0 + 8 * DAY });

    await prune(dir, { now: T0 + 29 * DAY, graceMs: 0 });
    assert.ok(hasBlob(dir, hash), 'kept for 30 days');
    const result = await prune(dir, { now: T0 + 31 * DAY, graceMs: 0 });
    if (named) {
      assert.ok(hasBlob(dir, hash));
      await prune(dir, { now: T0 + 400 * DAY, graceMs: 0 });
      assert.ok(hasBlob(dir, hash), 'a named version keeps its files');
      assert.ok(readVersion(dir, v1.id).files['assets/video/intro.mp4']);
    } else {
      assert.equal(hasBlob(dir, hash), false);
      assert.ok(result.bytesFreed >= 50 << 20);
      assert.deepEqual(result.trimmed, [{ id: v1.id, paths: ['assets/video/intro.mp4'] }]);
      const trimmed = readVersion(dir, v1.id);
      assert.deepEqual(trimmed.trimmed['assets/video/intro.mp4'], { hash, size: 50 << 20 });
      const restored = await restore(dir, v1.id, { now: T0 + 32 * DAY });
      assert.deepEqual(restored.unavailable, [{ path: 'assets/video/intro.mp4', reason: 'trimmed' }]);
      assert.equal(read(dir, 'course.json'), '{}\n', 'the rest of the version is restored');
    }
  }
});

test('backups: garbage collection keeps referenced, recent and other referrers\' blobs', async (t) => {
  const dir = project(t, { 'course.json': '{}\n' });
  const v1 = await created(dir, { reason: 'manual', now: T0 });
  const orphan = putBytes(dir, 'orphan');
  const journal = putBytes(dir, 'journal blob');

  await prune(dir, { now: T0 + HOUR });
  assert.ok(hasBlob(dir, orphan), 'a blob stored moments ago may belong to a writer that has not recorded it yet');

  fs.writeFileSync(path.join(dir, '.elabora/backups/versions/broken.json'), '{"format":');
  const blocked = await prune(dir, { now: T0 + HOUR, graceMs: 0 });
  assert.equal(blocked.problems.length, 1);
  assert.ok(hasBlob(dir, orphan), 'nothing is collected while a manifest cannot be read');
  fs.rmSync(path.join(dir, '.elabora/backups/versions/broken.json'));

  const result = await prune(dir, { now: T0 + HOUR, graceMs: 0, extraReferences: () => [journal as BlobHash] });
  assert.equal(result.blobsRemoved, 1);
  assert.equal(hasBlob(dir, orphan), false);
  assert.ok(hasBlob(dir, journal) && hasBlob(dir, v1.files['course.json'].hash));

  assert.equal((await collectGarbage(dir, { graceMs: 0 })).blobsRemoved, 1, 'without the journal\'s references its blob goes');

  // Deleting a named version lets its files go.
  await nameVersion(dir, v1.id, 'Keep');
  write(dir, 'course.json', '{"v":2}\n');
  await created(dir, { reason: 'auto', now: T0 + 2 * HOUR });
  assert.equal(await deleteVersion(dir, v1.id), true);
  await prune(dir, { now: T0 + 3 * HOUR, graceMs: 0 });
  assert.equal(hasBlob(dir, v1.files['course.json'].hash), false);
});

test('backups: status and when an automatic version is due', async (t) => {
  const dir = project(t, { 'course.json': '{}\n', 'assets/a.bin': bytes(4096) });
  assert.equal(shouldTakeVersion(dir, { now: T0 }), true);
  assert.equal(status(dir).versions, 0);
  const v1 = await created(dir, { reason: 'auto', now: T0 });
  assert.equal(shouldTakeVersion(dir, { now: T0 + 60_000 }), false);
  assert.equal(shouldTakeVersion(dir, { now: T0 + 5 * 60_000 }), true);
  assert.equal(shouldTakeVersion(dir, { now: T0 + 60_000, minIntervalMs: 30_000 }), true);
  await created(dir, { reason: 'publish', name: '1.0', now: T0 + HOUR });
  const s = status(dir);
  assert.deepEqual([s.versions, s.named, s.oldest?.id, s.newest?.name, s.lastVersionTime], [2, 1, v1.id, '1.0', new Date(T0 + HOUR).toISOString()]);
  assert.equal(s.blobs, 2);
  assert.equal(s.storedBytes, 4096 + 3);
});

test('backups: the lock serialises processes and stale locks are broken', async (t) => {
  const dir = project(t, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`assets/f${i}.bin`, bytes(1 << 20)])));
  const module = pathToFileURL(path.join(ROOT, 'packages/node/src/backups/index.ts')).href;
  const script = `import { createVersion } from ${JSON.stringify(module)};
console.log('ready');
await new Promise(resolve => process.stdin.once('data', resolve));
const v = await createVersion(process.env.DIR, { reason: 'auto' });
console.log(JSON.stringify(v && v.id));`;
  const env = { ...process.env, DIR: dir };
  const run = () => {
    let ready!: () => void, failed!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    let child: ReturnType<typeof execFile>;
    const result = new Promise<string>((resolve, reject) => {
      child = execFile(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 30000 }, (error, stdout) => {
        if (error) { failed(error); reject(error); } else resolve(String(stdout).trim().split('\n').at(-1)!);
      });
      resources(t).own(child, value => value.kill());
      child.stdout!.once('data', () => ready());
    });
    return { started, result, release: () => child!.stdin!.end('go\n') };
  };
  const children = [run(), run()];
  await Promise.all(children.map(child => child.started));
  for (const child of children) child.release();
  const outputs = await Promise.all(children.map(child => child.result));
  const ids = outputs.map((o) => JSON.parse(o) as string | null);
  assert.equal(ids.filter(Boolean).length, 1, `one process takes the version, the other finds nothing changed: ${outputs}`);
  assert.equal(listVersions(dir).length, 1);
  assert.equal(exists(dir, '.elabora/backups/lock'), false);

  // Held by a live process: wait, then give up.
  const lock = path.join(dir, '.elabora/backups/lock');
  fs.writeFileSync(lock, JSON.stringify({ token: 'x', pid: process.pid, host: os.hostname(), purpose: 'test' }));
  await assert.rejects(withBackupsLock(dir, 'test', async () => 1, { waitMs: 0 }), BackupsLockedError);
  // Not refreshed for more than 60 s: its holder died.
  const old = new Date(fs.statSync(lock).mtimeMs - 61_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await withBackupsLock(dir, 'test', async () => 2, { waitMs: 0 }), 2);
  // Left on this computer by a process that is gone: broken at once.
  const gone = await new Promise<number>((resolve) => { const child = execFile(process.execPath, ['-e', '0'], () => resolve(child.pid!)); });
  fs.writeFileSync(lock, JSON.stringify({ token: 'y', pid: gone, host: os.hostname(), purpose: 'test' }));
  assert.equal(await withBackupsLock(dir, 'test', async () => 3, { waitMs: 0 }), 3);
});
