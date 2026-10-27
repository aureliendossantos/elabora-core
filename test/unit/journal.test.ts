import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  withProjectLock, withProjectLockSync, lockPath, LockError, appendChange, appendUndo, appendMark, readJournal, lastEntry, lastChanges,
  batchChanges, pruneJournal, storeChangeBlobs, journalBlobReferences, changeFileHashes, contentHash, JournalError, detectAuthor, type NewChange
} from '@elabora/node/journal/index';
import { projectDataDir } from '@elabora/node/data-dir';
import { hasBlob, readBlob, hashBytes, blobPath, type BlobHash } from '@elabora/node/blobs';
import { listProjectFiles, isTextFile } from '@elabora/node/project-files';
import {
  applyOps, invertOps, diffFiles, undoChanges, changesToUndo, undoneChanges, lastAiBatch, summarizeBatches, textFile, binaryFile, makeFiles, formatJson,
  type Author, type FileContent, type Files, type Op, type JsonObject
} from '@elabora/core/ops/index';
import { ROOT, copyExample, moduleUrl } from '../helpers.ts';

const agent: Author = { kind: 'agent', name: 'claude-code' };
const human: Author = { kind: 'human' };
const temporary: string[] = [];
const tmpProject = (prefix = 'elabora-journal-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const journalDir = (dir: string) => path.join(projectDataDir(dir), 'journal');
const someChange = (author: Author, n = 0): NewChange => ({
  author, command: { name: 'update_block', args: { n } },
  ops: [{ op: 'set', file: 'screens/a.json', path: ['title'], value: `T${n}` }],
  inverse: [{ op: 'set', file: 'screens/a.json', path: ['title'], value: `T${n - 1}` }],
  files: [{ path: 'screens/a.json', before: null, after: null }]
});

// Runs a module script in another Node process; resolves with its exit code and output.
const MODULES = {
  journal: moduleUrl('packages/node/src/journal/index.ts'),
  dataDir: moduleUrl('packages/node/src/data-dir.ts')
};
// Without NODE_TEST_CONTEXT: a child that inherits it reports to the test runner instead of stdout.
function spawnNode(code: string, env: Record<string, string> = {}) {
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  return spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}
function runNode(code: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnNode(code, env);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on('close', (exitCode) => resolve({ code: exitCode, stdout, stderr })));
}
const imports = `const journal = await import(${JSON.stringify(MODULES.journal)});`;


test('lock: held while the function runs, released after it and on errors, reentrant', () => {
  const dir = tmpProject();
  const file = lockPath(dir);
  assert.equal(file, path.join(projectDataDir(dir), 'lock'));
  const result = withProjectLockSync(dir, () => {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.host, os.hostname());
    assert.ok(Number.isFinite(Date.parse(holder.at)) && typeof holder.token === 'string');
    assert.equal(withProjectLockSync(dir, () => 'nested'), 'nested', 'a nested call does not wait for itself');
    assert.ok(fs.existsSync(file), 'the outer call still holds it');
    return 42;
  });
  assert.equal(result, 42);
  assert.ok(!fs.existsSync(file));
  assert.throws(() => withProjectLockSync(dir, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(file));
});

test('lock: async writers of one process take turns; a synchronous wait inside another task fails at once', async () => {
  const dir = tmpProject();
  let inside = 0;
  let most = 0;
  await Promise.all(Array.from({ length: 5 }, () => withProjectLock(dir, async () => {
    inside++;
    most = Math.max(most, inside);
    await sleep(5);
    await withProjectLock(dir, () => sleep(1)); // nested: reentrant
    inside--;
  })));
  assert.equal(most, 1);

  let release = () => {};
  const holding = withProjectLock(dir, () => new Promise<void>((resolve) => { release = resolve; }));
  await sleep(5);
  const started = Date.now();
  assert.throws(() => withProjectLockSync(dir, () => 1), (error: unknown) => error instanceof LockError && /another task of this process/.test(error.message));
  assert.ok(Date.now() - started < 1000, 'it does not wait for the timeout');
  release();
  await holding;
});

test('lock: stale locks are broken: a process gone on this computer at once, another computer after 30 s', async () => {
  const dir = tmpProject();
  const file = lockPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const holder = (fields: object) => fs.writeFileSync(file, JSON.stringify({ pid: 1, host: os.hostname(), at: new Date().toISOString(), token: 'old', ...fields }));
  const takes = (message: string) => {
    const started = Date.now();
    withProjectLockSync(dir, () => assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'old', message), { timeoutMs: 2000 });
    assert.ok(Date.now() - started < 1000, `${message}: at once`);
  };

  const gone = await runNode('process.stdout.write(String(process.pid))');
  holder({ pid: Number(gone.stdout) });
  takes('a process that exited');
  holder({ pid: process.pid, token: 'leaked', at: new Date(Date.now() - process.uptime() * 1000 - 60_000).toISOString() });
  takes('our own pid, older than this process: a crashed process whose pid we reuse');
  holder({ host: 'studio-mac.local', at: new Date(Date.now() - 31_000).toISOString() });
  takes('another computer, 31 s old');
  fs.writeFileSync(file, '');
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(file, old, old);
  takes('an empty lock file, 31 s old');

  holder({ host: 'studio-mac.local' });
  const started = Date.now();
  assert.throws(() => withProjectLockSync(dir, () => 1, { timeoutMs: 150 }), (error: unknown) => error instanceof LockError && error.code === 'E_LOCKED' && error.holder?.host === 'studio-mac.local' && /studio-mac\.local/.test(error.message));
  assert.ok(Date.now() - started >= 150, 'a fresh lock from another computer makes writers wait');
  fs.writeFileSync(file, '');
  assert.throws(() => withProjectLockSync(dir, () => 1, { timeoutMs: 100 }), LockError, 'an empty lock being written is respected');
  holder({ pid: process.pid, token: 'another-thread' });
  assert.throws(() => withProjectLockSync(dir, () => 1, { timeoutMs: 100 }), LockError, 'a fresh lock of this process (another thread) is respected');
});

test('lock: a writer in another process makes this one wait until it is done', async () => {
  const dir = tmpProject();
  const child = spawnNode(`${imports}
    journal.withProjectLockSync(${JSON.stringify(dir)}, () => {
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    });`);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.on('close', resolve));
  // The child holds the lock, or fails: never wait for a child that is gone.
  await Promise.race([
    new Promise<void>((resolve) => child.stdout.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); })),
    closed.then(() => { throw new Error(`The other process ended without taking the lock: ${stderr}`); })
  ]);
  const started = Date.now();
  await withProjectLock(dir, () => {
    assert.ok(Date.now() - started >= 150, 'waited for the other process');
  });
  await closed;
});

test('lock: processes incrementing a counter under the lock lose no update', async () => {
  const dir = tmpProject();
  const counter = path.join(dir, 'counter.txt');
  fs.writeFileSync(counter, '0');
  const worker = `import fs from 'node:fs';
    ${imports}
    for (let i = 0; i < 20; i++) {
      journal.withProjectLockSync(${JSON.stringify(dir)}, () => {
        const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); // widen the race window
        fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
      });
    }`;
  const results = await Promise.all(Array.from({ length: 5 }, () => runNode(worker)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(counter, 'utf8'), '100');
  assert.ok(!fs.existsSync(lockPath(dir)));
});


test('journal: entries get sequence numbers and batches, go to monthly files and read back in order', () => {
  const dir = tmpProject();
  const at = (iso: string) => ({ now: new Date(iso) });
  const e1 = appendChange(dir, someChange(agent, 1), at('2026-09-30T23:58:00Z'));
  const e2 = appendChange(dir, someChange({ kind: 'external' }, 2), at('2026-10-01T00:01:00Z'));
  const mark = appendMark(dir, { request: 'Ajoute un quiz' }, at('2026-10-01T00:02:00Z'));
  const e3 = appendChange(dir, someChange(agent, 3), at('2026-10-01T00:03:00Z'));
  const e4 = appendChange(dir, someChange(human, 4), at('2026-10-01T00:04:00Z'));
  assert.deepEqual([e1, e2, mark, e3, e4].map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(e2.batch, e1.id, 'AI work across midnight and months stays one batch');
  assert.equal(e3.batch, e3.id, 'a mark opens a new batch');
  assert.equal(e4.batch, e4.id);
  assert.match(e1.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(fs.readdirSync(journalDir(dir)).sort(), ['2026-09.jsonl', '2026-10.jsonl']);
  assert.equal(fs.readFileSync(path.join(journalDir(dir), '2026-10.jsonl'), 'utf8').trim().split('\n').length, 4);

  assert.deepEqual(readJournal(dir), [e1, e2, mark, e3, e4]);
  assert.deepEqual(lastEntry(dir), e4);
  assert.deepEqual(lastChanges(dir, 2), [e4, e3]);
  assert.deepEqual(lastChanges(dir), [e4, e3, e2, e1], 'marks are not changes');
  assert.deepEqual(batchChanges(dir, e1.id), [e1, e2]);
  assert.equal(summarizeBatches(readJournal(dir)).find((b) => b.id === e3.id)?.label, 'Ajoute un quiz');

  const late = appendChange(dir, someChange(agent, 5), at('2026-09-15T00:00:00Z'));
  assert.equal(late.seq, 6, 'a clock set back keeps counting');
  assert.deepEqual(fs.readdirSync(journalDir(dir)).sort(), ['2026-09.jsonl', '2026-10.jsonl'], 'and keeps writing to the newest month');
});

test('journal: a line cut short by a crash is skipped; long lines are read back from the end', () => {
  const dir = tmpProject();
  appendChange(dir, someChange(agent, 1));
  const month = path.join(journalDir(dir), fs.readdirSync(journalDir(dir))[0]);
  fs.appendFileSync(month, '{"type":"change","seq":2,"id":"cut');
  const e2 = appendChange(dir, someChange(agent, 2));
  assert.equal(e2.seq, 2);
  assert.deepEqual(readJournal(dir).map((e) => e.seq), [1, 2]);
  const big = { ...someChange(agent, 3), ops: [{ op: 'write', file: 'notes.md', text: 'é'.repeat(200_000) } as Op], inverse: [{ op: 'delete', file: 'notes.md' } as Op] };
  appendChange(dir, big);
  assert.equal(lastEntry(dir)?.seq, 3, 'a line longer than a read chunk');
  fs.appendFileSync(month, 'not json\n');
  assert.equal(appendChange(dir, someChange(agent, 4)).seq, 4);
  assert.equal(fs.readFileSync(month, 'utf8').split('\n').filter((line) => line.trim()).length, 6);
});

test('journal: pruning drops entries older than 30 days, keeps the newest one, and numbering goes on', () => {
  const dir = tmpProject();
  const now = new Date('2026-10-06T12:00:00Z');
  const daysAgo = (days: number) => ({ now: new Date(now.getTime() - days * 86_400_000) });
  appendChange(dir, someChange(agent, 1), daysAgo(45));
  appendChange(dir, someChange(agent, 2), daysAgo(31));
  appendChange(dir, someChange(agent, 3), daysAgo(29));
  appendChange(dir, someChange(agent, 4), daysAgo(1));
  assert.deepEqual(pruneJournal(dir, { now }), { removed: 2 });
  assert.deepEqual(readJournal(dir).map((e) => e.seq), [3, 4]);
  assert.deepEqual(fs.readdirSync(journalDir(dir)).sort(), ['2026-09.jsonl', '2026-10.jsonl'], 'the August file went away');

  assert.deepEqual(pruneJournal(dir, { now: new Date(now.getTime() + 90 * 86_400_000) }), { removed: 1 });
  assert.deepEqual(readJournal(dir).map((e) => e.seq), [4], 'the newest entry stays');
  assert.equal(appendChange(dir, someChange(agent, 5)).seq, 5);
});

test('journal: processes appending at the same time get distinct sequence numbers with no gap', async () => {
  const dir = tmpProject();
  const results = await Promise.all(Array.from({ length: 5 }, (_, worker) => runNode(`${imports}
    for (let i = 0; i < 20; i++) journal.appendChange(${JSON.stringify(dir)}, {
      author: { kind: 'agent', name: 'worker-${worker}' }, ops: [], inverse: [], files: [{ path: 'w${worker}-' + i, before: null, after: null }]
    });`)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const entries = readJournal(dir);
  assert.deepEqual(entries.map((e) => e.seq), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(new Set(entries.map((e) => e.id)).size, 100);
  const lines = fs.readdirSync(journalDir(dir)).flatMap((name) => fs.readFileSync(path.join(journalDir(dir), name), 'utf8').split('\n').filter((line) => line.trim()));
  assert.equal(lines.length, 100);
  for (const line of lines) JSON.parse(line);
  // Each entry's batch was assigned from the entry before it, under the lock.
  entries.forEach((entry, i) => {
    if (entry.type === 'mark') return;
    const previous = entries[i - 1];
    assert.ok(entry.batch === entry.id || (previous && previous.type !== 'mark' && entry.batch === previous.batch), `batch of ${entry.seq}`);
  });
});

test('journal and lock live in the data folder (ELABORA_DATA_DIR), not in the project', async () => {
  const dir = tmpProject();
  const store = tmpProject('elabora-store-');
  const result = await runNode(`${imports}
    const { projectDataDir } = await import(${JSON.stringify(MODULES.dataDir)});
    const dir = ${JSON.stringify(dir)};
    journal.withProjectLockSync(dir, () => console.log(journal.lockPath(dir)));
    journal.appendMark(dir, { request: 'x' });
    console.log(projectDataDir(dir));`, { ELABORA_DATA_DIR: store, ELABORA_DATA_IN_PROJECT: '' });
  assert.equal(result.code, 0, result.stderr);
  const [lock, data] = result.stdout.trim().split('\n');
  assert.ok(data.startsWith(path.join(store, 'projects')), data);
  assert.equal(lock, path.join(data, 'lock'));
  assert.equal(fs.readdirSync(path.join(data, 'journal')).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.elabora')), ['project-id'], 'only the project id stays in the project');
});


test('journal: binary contents go to the blob store; journal lines only hold their hashes', async () => {
  const dir = tmpProject();
  const old = crypto.randomBytes(300 << 10); // large enough to be cloned on macOS
  const fresh = crypto.randomBytes(1000);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets/logo.png'), old);
  const oldHash = hashBytes(old);
  const freshHash = hashBytes(fresh);
  const change: NewChange = {
    author: agent,
    ops: [{ op: 'write', file: 'assets/logo.png', blob: freshHash }],
    inverse: [{ op: 'write', file: 'assets/logo.png', blob: oldHash }],
    files: [{ path: 'assets/logo.png', before: oldHash, after: freshHash }]
  };
  assert.throws(() => appendChange(dir, change), (error: unknown) => error instanceof JournalError && error.code === 'E_BLOB_MISSING');
  assert.equal(readJournal(dir).length, 0, 'nothing journaled');

  await storeChangeBlobs(dir, change, new Map([[freshHash, fresh]]));
  assert.ok(readBlob(dir, oldHash).equals(old), 'the content the inverse restores, taken from the project before writing');
  assert.ok(readBlob(dir, freshHash).equals(fresh));
  fs.writeFileSync(path.join(dir, 'assets/logo.png'), fresh);
  appendChange(dir, change);
  const line = fs.readFileSync(path.join(journalDir(dir), fs.readdirSync(journalDir(dir))[0]), 'utf8');
  assert.ok(line.length < 1000 && line.includes(oldHash) && line.includes(freshHash));
  assert.deepEqual(journalBlobReferences(dir), [oldHash, freshHash].sort());

  // A file that changed since it was read is not stored under the hash it no longer has.
  const changedSince: NewChange = { ...change, inverse: [{ op: 'write', file: 'assets/logo.png', blob: hashBytes('something else') }] };
  await assert.rejects(storeChangeBlobs(dir, changedSince), (error: unknown) => error instanceof JournalError && /changed since it was read/.test(error.message));
  await assert.rejects(storeChangeBlobs(dir, { ops: [{ op: 'write', file: 'assets/new.png', blob: hashBytes('new') }], inverse: [] }), JournalError);
  await assert.rejects(storeChangeBlobs(dir, { ops: [{ op: 'write', file: 'assets/new.png', blob: hashBytes('new') }], inverse: [] }, new Map([[hashBytes('new'), new TextEncoder().encode('other')]])), JournalError);
  assert.ok(!hasBlob(dir, hashBytes('new') as BlobHash));
});

test('file hashes of a change: text by its UTF-8 bytes, binary by its hash, null when absent', () => {
  const before = makeFiles({ 'a.json': formatJson({ id: 'a', list: [{ id: 'x' }] }), 'b.json': formatJson({ id: 'b', list: [] }), 'logo.png': binaryFile(hashBytes('png')) });
  const ops: Op[] = [
    { op: 'move', file: 'a.json', path: ['list', { id: 'x' }], to: { file: 'b.json', path: ['list'] }, after: null },
    { op: 'delete', file: 'logo.png' },
    { op: 'write', file: 'notes.md', text: 'été\n' }
  ];
  const after = applyOps(before, ops);
  assert.deepEqual(changeFileHashes(before, after, ops), [
    { path: 'a.json', before: contentHash(before.get('a.json')), after: hashBytes(formatJson({ id: 'a', list: [] })) },
    { path: 'b.json', before: hashBytes(formatJson({ id: 'b', list: [] })), after: hashBytes(formatJson({ id: 'b', list: [{ id: 'x' }] })) },
    { path: 'logo.png', before: hashBytes('png'), after: null },
    { path: 'notes.md', before: null, after: hashBytes(Buffer.from('été\n', 'utf8')) }
  ]);
});


test('author of CLI changes: ELABORA_AUTHOR, then Claude Code or Codex, then a terminal or not', () => {
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: 'human' }, false), { kind: 'human' });
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: 'human:Marie', CLAUDECODE: '1' }, false), { kind: 'human', name: 'Marie' });
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: 'agent:codex' }, true), { kind: 'agent', name: 'codex' });
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: 'codex' }, true), { kind: 'agent', name: 'codex' });
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: 'system' }, true), { kind: 'system' });
  assert.deepEqual(detectAuthor({ CLAUDECODE: '1' }, true), { kind: 'agent', name: 'claude-code' });
  assert.deepEqual(detectAuthor({ CLAUDECODE: '0' }, true), { kind: 'human' });
  assert.deepEqual(detectAuthor({ CODEX_THREAD_ID: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b' }, true), { kind: 'agent', name: 'codex' });
  assert.deepEqual(detectAuthor({ CODEX_THREAD_ID: '' }, true), { kind: 'human' });
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: 'human', CODEX_THREAD_ID: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b' }, false), { kind: 'human' });
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: '  ' }, false), { kind: 'agent' });
  assert.deepEqual(detectAuthor({}, true), { kind: 'human' });
});


// The project as operations see it (what the project snapshot will provide).
function snapshot(dir: string): Files {
  const files = new Map<string, FileContent>();
  for (const { path: rel } of listProjectFiles(dir).files) {
    const bytes = fs.readFileSync(path.join(dir, rel));
    files.set(rel, isTextFile(rel) ? textFile(rel, bytes.toString('utf8')) : binaryFile(hashBytes(bytes), bytes.length));
  }
  return files;
}
function writeFiles(dir: string, before: Files, after: Files): void {
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const content = after.get(file);
    if (content === before.get(file)) continue;
    const target = path.join(dir, file);
    if (!content) fs.rmSync(target);
    else if (content.kind === 'text') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content.text);
    } else fs.copyFileSync(blobPath(dir, content.hash as BlobHash), target);
  }
}
// One writer's turn: under the lock, from the files as they are now.
async function commit(dir: string, author: Author, command: string, makeOps: (files: Files) => Op[]) {
  return withProjectLock(dir, async () => {
    const before = snapshot(dir);
    const ops = makeOps(before);
    const after = applyOps(before, ops);
    const inverse = invertOps(before, ops);
    await storeChangeBlobs(dir, { ops, inverse });
    writeFiles(dir, before, after);
    return appendChange(dir, { author, command: { name: command, args: {} }, ops, inverse, files: changeFileHashes(before, after, ops) });
  });
}

test('end to end: an agent command, an external edit and a human edit; undoing the AI batch keeps the human edit', async () => {
  const dir = copyExample();
  temporary.push(dir);
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as JsonObject;
  const original = snapshot(dir);
  const block = (read('screens/chemin.json').blocks as JsonObject[])[0];

  appendMark(dir, { request: 'Déplace le premier bloc sur l\'accueil' });
  // The agent moves a block through an Elabora command.
  await commit(dir, agent, 'move_block', () => [
    { op: 'move', file: 'screens/chemin.json', path: ['blocks', { id: block.id as string }], to: { file: 'screens/accueil.json', path: ['blocks'] }, after: null }
  ]);
  // Then edits a file with its own tools. The engine diffs it against the snapshot it had before,
  // which is also what the inverse is computed from (the old text is no longer on disk).
  const beforeExternal = snapshot(dir);
  const accueil = read('screens/accueil.json');
  accueil.title = 'Titre écrit par l\'agent';
  fs.writeFileSync(path.join(dir, 'screens/accueil.json'), JSON.stringify(accueil));
  await withProjectLock(dir, async () => {
    const now = snapshot(dir);
    const ops = diffFiles(beforeExternal, now);
    assert.deepEqual(ops, [{ op: 'set', file: 'screens/accueil.json', path: ['title'], value: accueil.title }]);
    const inverse = invertOps(beforeExternal, ops);
    await storeChangeBlobs(dir, { ops, inverse });
    appendChange(dir, { author: { kind: 'external' }, ops, inverse, files: changeFileHashes(beforeExternal, now, ops) });
  });
  // The human then rewrites the moved block.
  await commit(dir, human, 'update_block', () => [{ op: 'set', file: 'screens/accueil.json', path: ['blocks', { id: block.id as string }, 'props'], value: { markdown: 'Texte humain' } }]);

  const entries = readJournal(dir);
  const batch = lastAiBatch(entries);
  assert.equal(batch?.label, 'Déplace le premier bloc sur l\'accueil');
  assert.equal(batch?.changes.length, 2);
  const changes = changesToUndo(entries, { batch: batch?.id as string });
  await withProjectLock(dir, async () => {
    const current = snapshot(dir);
    const result = undoChanges(current, changes);
    const inverse = invertOps(current, result.ops);
    await storeChangeBlobs(dir, { ops: result.ops, inverse });
    writeFiles(dir, current, result.files);
    appendUndo(dir, {
      author: human, command: { name: 'undo', args: { batch: batch?.id } }, ops: result.ops, inverse,
      files: changeFileHashes(current, result.files, result.ops), undoes: { batch: batch?.id, changes: changes.map((c) => c.id) }, skipped: result.skipped
    });
  });

  assert.equal(read('screens/accueil.json').title, (JSON.parse((original.get('screens/accueil.json') as { text: string }).text) as JsonObject).title, 'the agent\'s title is undone');
  const back = (read('screens/chemin.json').blocks as JsonObject[])[0];
  assert.equal(back.id, block.id, 'the block is back in its place');
  assert.deepEqual(back.props, { markdown: 'Texte humain' }, 'with the human\'s text');
  const after = readJournal(dir);
  assert.equal(after[after.length - 1].type, 'undo');
  assert.deepEqual([...undoneChanges(after)].sort(), changes.map((c) => c.id).sort());
  assert.equal(lastAiBatch(after), undefined, 'nothing left to undo');
});
