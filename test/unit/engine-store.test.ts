import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsStore, readSnapshot, watchFolders } from '@elabora/node/store/index';
import { readProjectFiles } from '@elabora/node/project-reader';
import { copyExample } from '../helpers.ts';

// FsStore (the Store of a course folder) and snapshots read from a store: the same files as the
// CLI's synchronous reader, atomic writes, watching.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const project = () => {
  const dir = copyExample();
  temporary.push(dir);
  return dir;
};

test('a snapshot read from FsStore is the snapshot the CLI reads', async () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist/course.zip'), 'zip');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  fs.writeFileSync(path.join(dir, 'screens/chemin.json.42.tmp'), '{');
  fs.writeFileSync(path.join(dir, 'screens/chemin (1).json'), fs.readFileSync(path.join(dir, 'screens/chemin.json')));
  const store = new FsStore(dir);
  const snapshot = await readSnapshot(store);
  const expected = readProjectFiles(dir);
  assert.deepEqual([...snapshot.files.keys()].sort(), [...expected.files.keys()].sort());
  for (const [rel, file] of expected.files) {
    const read = snapshot.files.get(rel);
    if (file.kind === 'text') assert.equal(read?.kind === 'text' && read.text, file.text, rel);
    else assert.deepEqual(read?.kind === 'binary' && [read.size, read.hash], [file.size, file.hash], rel);
  }
  assert.deepEqual(snapshot.artefacts, expected.artefacts);
  assert.equal(snapshot.stats.get('course.json')?.size, fs.statSync(path.join(dir, 'course.json')).size);
});

test('FsStore writes atomically, removes, refuses paths outside the project and hashes from its cache', async () => {
  const dir = project();
  const store = new FsStore(dir);
  await store.write('notes/new.md', '# Note\n');
  assert.equal(await store.readText('notes/new.md'), '# Note\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'notes')), ['new.md'], 'no temporary file left');
  await store.write('assets/data.bin', new Uint8Array([1, 2, 3]));
  assert.deepEqual([...await store.readBytes('assets/data.bin')], [1, 2, 3]);
  const hash = await store.hash('assets/data.bin');
  assert.equal(hash, 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  assert.equal(await store.hash('assets/data.bin'), hash);
  await store.remove('notes/new.md');
  await store.remove('notes/new.md'); // gone already: fine
  assert.equal(await store.stat('notes/new.md'), null);
  await assert.rejects(store.write('../outside.txt', 'x'), /Not a project-relative/);
  await assert.rejects(store.readText('/etc/hosts'), /Not a project-relative/);
});

test('FsStore watches the folder recursively and leaves tool folders and temporary files out', async () => {
  const dir = project();
  const store = new FsStore(dir);
  const seen = new Set<string>();
  const stop = store.watch((paths) => { for (const rel of paths) seen.add(rel); });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(dir, 'screens/chemin.json'), fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8').replace('Imprimer', 'Imprimer !'));
    fs.mkdirSync(path.join(dir, '.elabora'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.elabora/lock'), 'x');
    fs.writeFileSync(path.join(dir, 'screens/x.json.1.tmp'), 'x');
    const deadline = Date.now() + 5000;
    while (!seen.has('screens/chemin.json') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(seen.has('screens/chemin.json'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(![...seen].some((rel) => rel.startsWith('.elabora') || rel.endsWith('.tmp')), [...seen].join(', '));
  } finally {
    stop();
  }
});

// On macOS the watchers of a process share one FSEvents stream, built again whenever one starts; a
// write made meanwhile is lost (measured: 1 open in 24 with other folders watched). FsStore says
// when its watcher reports (onReady, after a probe in .elabora/ there): a write made then is seen.
test('FsStore says when its watcher is live: a write made as soon as it is ready is reported, its probe neither reported nor left', async () => {
  const folder = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-watch-'));
    temporary.push(dir);
    fs.writeFileSync(path.join(dir, 'course.json'), '{}\n');
    return dir;
  };
  const others = Array.from({ length: 4 }, () => new FsStore(folder()).watch(() => {}));
  try {
    for (let i = 0; i < 10; i++) {
      const dir = folder();
      const reported: string[] = [];
      let stop = () => {};
      await new Promise<void>((ready) => { stop = new FsStore(dir).watch((paths) => reported.push(...paths), ready); });
      try {
        fs.writeFileSync(path.join(dir, 'course.json'), `{ "n": ${i} }\n`);
        const deadline = Date.now() + 3000;
        while (!reported.includes('course.json') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(reported.includes('course.json'), `open ${i}: ${JSON.stringify(reported)}`);
        assert.ok(!reported.some((rel) => rel.startsWith('.elabora')), reported.join(', '));
      } finally {
        stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const tool = path.join(dir, '.elabora');
      assert.deepEqual(fs.existsSync(tool) ? fs.readdirSync(tool).filter((name) => name.endsWith('.probe')) : [], []);
    }
  } finally {
    for (const stop of others) stop();
  }
});

// On macOS each start or stop of a watcher rebuilds the stream of its thread, losing what was written
// from about 16 ms before to 10 ms after for every watcher of that thread. FsStore watches from a
// thread of its own: a preview's seven watchers coming and going in the process take nothing from it
// (before, 47 to 102 writes of about 460 were never reported).
test('FsStore reports every write while other watchers of the process start and stop', async () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'notes'));
  const reported = new Set<string>();
  let stop = () => {};
  await new Promise<void>((ready) => {
    stop = new FsStore(dir).watch((paths) => {
      // Unknown changes: what a listing would find now.
      if (!paths.length) for (const name of fs.readdirSync(path.join(dir, 'notes'))) reported.add(`notes/${name}`);
      for (const rel of paths) reported.add(rel);
    }, ready);
  });
  const other = project();
  const folders = ['screens', 'assets', 'objects', 'one', 'two', 'three', 'four'].map((name) => path.join(other, name));
  for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
  let written = 0;
  const writer = setInterval(() => fs.writeFileSync(path.join(dir, `notes/w-${written++}.md`), 'x'), 1);
  try {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const watchers = folders.map((folder) => fs.watch(folder, { recursive: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      for (const watcher of watchers) watcher.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    clearInterval(writer);
  }
  const missed = () => Array.from({ length: written }, (_, n) => `notes/w-${n}.md`).filter((rel) => !reported.has(rel));
  const deadline = Date.now() + 3000;
  while (missed().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  assert.ok(written > 20, `${written} writes`);
  assert.deepEqual(missed(), [], `${missed().length} of ${written} writes never reported`);
});

// Linux's recursive watcher (Node) loses a file once it is replaced by a rename; FsStore watches
// folder by folder there (watchFolders), which is tested on every system too.
const watchers: [string, (dir: string, onChange: (paths: string[]) => void) => () => void][] = [
  ['FsStore', (dir, onChange) => new FsStore(dir).watch(onChange)],
  ['watchFolders', watchFolders]
];
for (const [name, watch] of watchers) {
  test(`${name}: a file replaced by a rename, then written in place, is seen both times; so is a file in a new folder`, async () => {
    const dir = project();
    const events: string[][] = [];
    const stop = watch(dir, (paths) => events.push(paths));
    const seen = async (rel: string, orUnknown = false) => {
      const deadline = Date.now() + 5000;
      const found = () => events.some((paths) => paths.includes(rel) || (orUnknown && paths.length === 0));
      while (!found() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(found(), `${rel}: ${JSON.stringify(events)}`);
      events.length = 0;
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const file = path.join(dir, 'screens/chemin.json');
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(`${file}.1.tmp`, text.replace('Imprimer', 'Un'));
      fs.renameSync(`${file}.1.tmp`, file);
      await seen('screens/chemin.json');
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.writeFileSync(file, text.replace('Imprimer', 'Deux'));
      await seen('screens/chemin.json');

      fs.mkdirSync(path.join(dir, 'assets/new'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'assets/new/a.txt'), 'a');
      await seen('assets/new/a.txt', true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.writeFileSync(path.join(dir, 'assets/new/a.txt'), 'b');
      await seen('assets/new/a.txt');
    } finally {
      stop();
    }
  });
}
