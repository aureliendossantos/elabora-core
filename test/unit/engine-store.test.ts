import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FsStore, readSnapshot, watchFolders } from '@elabora/node/store/index';
import { readProjectFiles } from '@elabora/node/project-reader';
import { copyExample } from '../helpers.ts';

// Node's after hooks run in registration order. Close watchers before removing their folders.
const resources = new WeakMap<TestContext, (() => void)[]>();
function own(t: TestContext, dispose: () => void) {
  let stack = resources.get(t);
  if (!stack) {
    stack = []; resources.set(t, stack);
    t.after(() => {
      const errors: unknown[] = [];
      for (const close of stack!.reverse()) { try { close(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed');
    });
  }
  stack.push(dispose);
}

function project(t: TestContext) {
  const dir = copyExample();
  own(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Subscribe before acting. The timer bounds failure; successful waits never depend on elapsed time.
function reported(events: EventEmitter, predicate: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const check = () => { if (predicate()) { clearTimeout(timer); events.off('change', check); resolve(); } };
    const timer = setTimeout(() => { events.off('change', check); reject(new Error('Expected filesystem change was not reported')); }, 5000);
    events.on('change', check);
    check();
  });
}
async function watch(t: TestContext, dir: string) {
  const seen = new Set<string>(), events = new EventEmitter();
  let stop = () => {};
  own(t, () => stop());
  await new Promise<void>(ready => {
    stop = new FsStore(dir).watch(paths => { paths.forEach(rel => seen.add(rel)); events.emit('change'); }, ready);
  });
  return { seen, events, stop, until: (predicate: () => boolean) => reported(events, predicate) };
}

test('an FsStore snapshot contains the same content and artefacts as the CLI reader', async t => {
  const dir = project(t);
  for (const [rel, text] of [['dist/course.zip', 'zip'], ['.DS_Store', 'x'], ['screens/chemin.json.42.tmp', '{'], ['screens/chemin (1).json', fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8')]]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const snapshot = await readSnapshot(new FsStore(dir));
  const expected = readProjectFiles(dir);
  assert.deepEqual([...snapshot.files].sort(), [...expected.files].sort());
  assert.deepEqual(snapshot.artefacts, expected.artefacts);
  assert.equal(snapshot.stats.get('course.json')?.size, fs.statSync(path.join(dir, 'course.json')).size);
});

test('FsStore persists text and bytes without leaving temporary files', async t => {
  const dir = project(t), store = new FsStore(dir);
  await store.write('notes/new.md', '# Note\n');
  await store.write('assets/data.bin', new Uint8Array([1, 2, 3]));
  assert.equal(await store.readText('notes/new.md'), '# Note\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'notes')), ['new.md']);
  assert.deepEqual([...await store.readBytes('assets/data.bin')], [1, 2, 3]);
  assert.equal(await store.hash('assets/data.bin'), 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  await store.write('assets/data.bin', new Uint8Array([4, 5, 6]));
  assert.notEqual(await store.hash('assets/data.bin'), 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
});

test('removing an absent file is harmless', async t => {
  const store = new FsStore(project(t));
  await store.write('notes/new.md', 'note');
  await store.remove('notes/new.md');
  await store.remove('notes/new.md');
  assert.equal(await store.stat('notes/new.md'), null);
});

test('FsStore refuses paths outside the project', async t => {
  const store = new FsStore(project(t));
  await assert.rejects(store.write('../outside.txt', 'x'), /Not a project-relative/);
  await assert.rejects(store.readText('/etc/hosts'), /Not a project-relative/);
});

test('a ready FsStore reports recursive content writes and filters tool and temporary paths', async t => {
  const dir = project(t);
  const log = await watch(t, dir);
  fs.mkdirSync(path.join(dir, '.elabora'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.elabora/lock'), 'x');
  fs.writeFileSync(path.join(dir, 'screens/x.json.1.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'screens/chemin.json'), '{}');
  await log.until(() => log.seen.has('screens/chemin.json'));
  assert.ok(![...log.seen].some(rel => rel.startsWith('.elabora') || rel.endsWith('.tmp')));
});

// Regression: watcher startup used to rebuild the process's FSEvents stream and lose writes.
test('each ready FsStore reports an immediate write while other stores remain open', async t => {
  for (let i = 0; i < 4; i++) await watch(t, project(t));
  for (let i = 0; i < 10; i++) {
    const dir = project(t), log = await watch(t, dir);
    fs.writeFileSync(path.join(dir, 'course.json'), `{ "n": ${i} }\n`);
    await log.until(() => log.seen.has('course.json'));
    log.stop();
    assert.ok(![...log.seen].some(rel => rel.startsWith('.elabora')));
    const tool = path.join(dir, '.elabora');
    assert.deepEqual(fs.existsSync(tool) ? fs.readdirSync(tool).filter(name => name.endsWith('.probe')) : [], []);
  }
});

test('FsStore reports every write across other watchers starting and stopping', async t => {
  const dir = project(t), log = await watch(t, dir), other = project(t);
  fs.mkdirSync(path.join(dir, 'notes'));
  const folders = ['screens', 'assets', 'objects', 'one', 'two', 'three', 'four'].map(name => path.join(other, name));
  for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
  let written = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    const watchers = folders.map(folder => fs.watch(folder, { recursive: true }));
    try {
      for (let i = 0; i < 32; i++) {
        fs.writeFileSync(path.join(dir, `notes/w-${written++}.md`), 'x');
        await new Promise<void>(resolve => setImmediate(resolve));
        if (i === 16) for (const watcher of watchers) watcher.close();
      }
    } finally { for (const watcher of watchers) watcher.close(); }
  }
  await log.until(() => Array.from({ length: written }, (_, n) => `notes/w-${n}.md`).every(rel => log.seen.has(rel)));
  assert.equal(written, 128);
});

// Linux must keep watching after a rename. watchFolders is also exercised on other systems.
for (const name of ['FsStore', 'watchFolders'] as const) test(`${name} reports replacements and subsequent writes in existing and new folders`, async t => {
  const dir = project(t);
  const events = new EventEmitter(), seen = new Set<string>();
  let unknown = false, stop = () => {};
  own(t, () => stop());
  const onChange = (paths: string[]) => { unknown ||= paths.length === 0; paths.forEach(rel => seen.add(rel)); events.emit('change'); };
  if (name === 'FsStore') await new Promise<void>(ready => { stop = new FsStore(dir).watch(onChange, ready); });
  else stop = watchFolders(dir, onChange);
  const expect = async (rel: string, orUnknown = false) => {
    await reported(events, () => seen.has(rel) || (orUnknown && unknown));
    seen.clear(); unknown = false;
  };
  // watchFolders has no readiness callback. Probe the actual OS stream until it acknowledges
  // a write; macOS starts/rebuilds FSEvents asynchronously when a folder watcher is added.
  const ready = async (rel: string) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; }, 5000);
    try {
      for (let n = 0; !seen.has(rel); n++) {
        assert.ok(!timedOut, `watcher did not acknowledge ${rel}`);
        fs.writeFileSync(path.join(dir, rel), String(n));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { clearTimeout(timer); }
    seen.clear(); unknown = false;
  };
  if (name === 'watchFolders') await ready('ready.txt');
  const file = path.join(dir, 'screens/chemin.json');
  fs.writeFileSync(`${file}.1.tmp`, '{"title":"one"}');
  fs.renameSync(`${file}.1.tmp`, file);
  await expect('screens/chemin.json');
  fs.writeFileSync(file, '{"title":"two"}');
  await expect('screens/chemin.json');
  fs.mkdirSync(path.join(dir, 'assets/new'));
  fs.writeFileSync(path.join(dir, 'assets/new/a.txt'), 'a');
  await expect('assets/new/a.txt', true);
  if (name === 'watchFolders') await ready('assets/new/ready.txt');
  fs.writeFileSync(path.join(dir, 'assets/new/a.txt'), 'b');
  await expect('assets/new/a.txt');
});
