import { test, type TestContext } from 'node:test';
import { resources } from '../resources.ts';
import { bytes } from '../bytes.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as edit from '@elabora/node/edit';
import { runInWorker, workerExecArgv, type AutoVersion } from '@elabora/node/edit/auto-version';
import { readJournal, lockPath } from '@elabora/node/journal/index';
import { listVersions, readVersion } from '@elabora/node/backups/index';
import { readProjectFiles } from '@elabora/node/project-reader';
import { hashBytes } from '@elabora/node/blobs';
import { commandContext, moveBlock, moveScreen, addBlock } from '@elabora/core/commands/index';
import type { Author, ChangeEntry, UndoEntry } from '@elabora/core/ops/types';
import { moduleUrl, readJSON, writeJSON } from '../helpers.ts';

const agent: Author = { kind: 'agent', name: 'claude-code' };
const human: Author = { kind: 'human' };
const project = (t: TestContext) => resources(t).copyExample();
const changes = (dir: string) => readJournal(dir).filter((e): e is ChangeEntry | UndoEntry => e.type !== 'mark');
const text = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

test('commands are pure: files or operations from a snapshot, nothing written', (t) => {
  const dir = project(t);
  const files = readProjectFiles(dir).files;
  const context = commandContext(files, { root: dir });
  const before = text(dir, 'screens/chemin.json');
  // A block moved into the layer of another screen is one move operation.
  const move = moveBlock(context, { block: 'chemin-intro', screen: 'premier-reflexe', layer: 'rappel-regle' });
  assert.deepEqual(move.ops, [{ op: 'move', file: 'screens/chemin.json', path: ['blocks', { id: 'chemin-intro' }], to: { file: 'screens/premier-reflexe.json', path: ['layers', { id: 'rappel-regle' }, 'blocks'] }, after: 'rappel-texte' }]);
  // A screen moved to the start of another section: one move in course.json.
  assert.deepEqual(moveScreen(context, { id: 'bilan', section: 'decouvrir', position: 0 }).ops, [
    { op: 'move', file: 'course.json', path: ['sections', { id: 'valider' }, 'screens', { id: 'bilan' }], to: { file: 'course.json', path: ['sections', { id: 'decouvrir' }, 'screens'] }, after: null }
  ]);
  const added = addBlock(context, { screen: 'chemin', block: { id: 'x', type: 'text', props: { markdown: 'X' } }, position: 0 });
  assert.equal(JSON.parse((added.files!.get('screens/chemin.json') as { text: string }).text).blocks[0].id, 'x');
  assert.equal(text(dir, 'screens/chemin.json'), before, 'nothing was written');
});

test('edits are journaled as changes: command, author, operations by id, inverse and file hashes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const dir = project(t);
  const r1 = edit.addBlock(dir, { screen: 'chemin', block: { id: 'chemin-note', type: 'text', props: { markdown: 'Note' } }, after: 'chemin-intro' }, { author: agent });
  const r2 = edit.updateBlock(dir, { block: 'chemin-note', props: { markdown: 'Note révisée' } }, { author: agent });
  const r3 = edit.moveBlock(dir, { block: 'chemin-note', screen: 'accueil' }, { author: human });
  assert.deepEqual([r1.undo, r2.undo, r3.undo], [1, 2, 3]);
  assert.equal(r1.change?.batch, r2.change?.batch, 'AI changes a moment apart form one batch');
  assert.equal(r3.change?.batch, r3.change?.id, 'a human change is its own batch');
  const [c1, c2, c3] = changes(dir);
  assert.deepEqual([c1.command?.name, c2.command?.name, c3.command?.name], ['add_block', 'update_block', 'move_block']);
  assert.deepEqual(c1.author, agent);
  assert.deepEqual(c1.ops.map((op) => op.op), ['insert']);
  assert.deepEqual(c2.ops, [{ op: 'set', file: 'screens/chemin.json', path: ['blocks', { id: 'chemin-note' }, 'props', 'markdown'], value: 'Note révisée' }]);
  assert.deepEqual(c3.ops.map((op) => op.op), ['move']);
  assert.equal(c3.inverse.length, c3.ops.length);
  // The hashes say what the files hold.
  assert.deepEqual(c3.files.map((f) => f.path), ['screens/accueil.json', 'screens/chemin.json']);
  assert.equal(c3.files[0].after, hashBytes(text(dir, 'screens/accueil.json')));
  // A command that changes nothing writes no change.
  const same = edit.updateBlock(dir, { block: 'chemin-note', props: { markdown: 'Note révisée' } });
  assert.equal(same.change, null);
  assert.equal(changes(dir).length, 3);
  // History, from the journal.
  assert.deepEqual(edit.history(dir).map((h) => [h.seq, h.op, h.undone]), [[1, 'add_block', false], [2, 'update_block', false], [3, 'move_block', false]]);
});

test('a file changed on disk while the edit was computed: computed again, or refused with E_CONFLICT', (t) => {
  const dir = project(t);
  const file = path.join(dir, 'screens/chemin.json');
  // Another program writes the screen once: the edit is computed again on top of it.
  const r = edit.updateBlock(dir, { block: 'chemin-intro', props: { markdown: 'Par Elabora' } }, {
    beforeWrite: (attempt) => {
      if (attempt > 1) return;
      const s = readJSON(dir, 'screens/chemin.json');
      s.title = 'Par un autre programme';
      writeJSON(dir, 'screens/chemin.json', s);
    }
  });
  assert.equal(r.ok, true);
  const s = readJSON(dir, 'screens/chemin.json');
  assert.equal(s.title, 'Par un autre programme', 'the other write is kept');
  assert.equal(s.blocks.find((b: { id: string }) => b.id === 'chemin-intro').props.markdown, 'Par Elabora');
  // It keeps writing: the edit is refused, nothing is written or journaled.
  let n = 0;
  assert.throws(() => edit.updateBlock(dir, { block: 'chemin-intro', props: { markdown: 'Jamais' } }, {
    beforeWrite: () => {
      const other = readJSON(dir, 'screens/chemin.json');
      other.title = `Écrit ${++n}`;
      writeJSON(dir, 'screens/chemin.json', other);
    }
  }), (e: unknown) => e instanceof edit.EditError && (e as edit.EditError).code === 'E_CONFLICT' && (e as edit.EditError).diagnostics[0].code === 'E_CONFLICT');
  assert.ok(!text(dir, 'screens/chemin.json').includes('Jamais'));
  assert.equal(changes(dir).length, 1);
});

test('refusals carry catalogue codes: a project locked by another writer, an operation that cannot apply', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.dirname(lockPath(dir)), { recursive: true });
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 1, host: 'other-computer', at: new Date().toISOString(), token: 't' }));
  assert.throws(() => edit.updateScreen(dir, { id: 'chemin', title: 'X' }, { lockTimeoutMs: 0 }), (e: unknown) => e instanceof edit.EditError && (e as edit.EditError).code === 'E_LOCKED' && /other-computer/.test((e as Error).message));
  fs.rmSync(lockPath(dir));
  // Errors of operations carry their code too: a list with a duplicate id cannot take a move by id.
  const screen = readJSON(dir, 'screens/premier-reflexe.json');
  screen.layers[0].blocks.push(screen.layers[0].blocks[0]);
  writeJSON(dir, 'screens/premier-reflexe.json', screen);
  assert.throws(() => edit.moveBlock(dir, { block: 'chemin-intro', screen: 'premier-reflexe', layer: 'rappel-regle' }), (e: unknown) => e instanceof edit.EditError && (e as edit.EditError).code === 'E_OP_NOT_KEYED' && (e as edit.EditError).diagnostics[0].code === 'E_OP_NOT_KEYED');
});

test('an automatic version is taken just before the first write, not for refused or empty edits', (t) => {
  const dir = project(t);
  const original = text(dir, 'screens/chemin.json');
  assert.throws(() => edit.addBlock(dir, { screen: 'chemin', block: { id: 'x', type: 'quiz', props: { stem: 1 } } }), edit.EditError);
  edit.updateBlock(dir, { block: 'chemin-intro', props: {} });
  assert.deepEqual(listVersions(dir), [], 'no version for a refused edit or one that changes nothing');
  const r = edit.updateScreen(dir, { id: 'chemin', title: 'Nouveau titre' }, { author: agent });
  assert.ok(r.backup?.version, 'the result says which version was taken');
  const versions = listVersions(dir);
  assert.equal(versions.length, 1);
  const version = readVersion(dir, versions[0].id);
  assert.equal(version.reason, 'auto');
  assert.deepEqual(version.author, agent);
  assert.equal(version.files['screens/chemin.json'].hash, hashBytes(original), 'the project as it was before the edit');
  edit.updateScreen(dir, { id: 'chemin', title: 'Encore' });
  assert.equal(listVersions(dir).length, 1, 'the next one waits 5 minutes');
});

test('an edit from `node --input-type=module -e` takes its version: the worker does without the flags of the main entry', async (t) => {
  assert.deepEqual(workerExecArgv(['--input-type=module', '-e', 'x', '--conditions=dev']), ['--conditions=dev']);
  assert.deepEqual(workerExecArgv(['--input-type', 'module', '--eval=x', '-pe', 'y', '--print', 'z', '-p', '--no-warnings']), ['--no-warnings']);
  assert.equal(workerExecArgv(['--max-old-space-size=2048', '--conditions=dev']), undefined, 'nothing to remove: the worker inherits the flags');
  // The worker of the version used to inherit --input-type and fail before waking the edit, which
  // then held the project lock for 10 minutes. With --max-old-space-size, which a worker refuses
  // when given explicitly, it inherits every flag and its bootstrap runs with them.
  const script = `import * as edit from ${JSON.stringify(moduleUrl('packages/node/src/edit/index.ts'))};
console.log(JSON.stringify(edit.updateScreen(process.cwd(), { id: 'chemin', title: 'Titre' }).backup));`;
  const run = (flags: string[]) => {
    const dir = project(t);
    return new Promise<{ dir: string; backup: AutoVersion }>((resolve, reject) => execFile(process.execPath, [...flags, '--input-type=module', '-e', script], { cwd: dir, timeout: 30_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(`${flags.join(' ') || 'no flag'}: ${error.killed ? 'the edit hung' : stderr}`)) : resolve({ dir, backup: JSON.parse(stdout) })));
  };
  for (const { dir, backup } of await Promise.all([run([]), run(['--max-old-space-size=2048'])])) {
    assert.equal(backup.error, undefined);
    assert.deepEqual(listVersions(dir).map((v) => v.id), [backup.version]);
  }
});

test('a worker that cannot load its task or stops before finishing ends the wait at once, with an error', (t) => {
  const dir = project(t);
  const task = { kind: 'prune', dir } as const;
  const module = (name: string, code: string) => {
    fs.writeFileSync(path.join(dir, name), code);
    return pathToFileURL(path.join(dir, name));
  };
  const outcome = (url: URL) => {
    const result = runInWorker(task, { module: url, timeoutMs: 20_000 });
    return result;
  };
  assert.deepEqual(outcome(module('throws.mjs', `throw new Error('broken at import');\n`)), { version: null, error: 'broken at import' });
  assert.match(outcome(pathToFileURL(path.join(dir, 'missing.mjs'))).error!, /Cannot find module .*missing\.mjs/);
  assert.deepEqual(outcome(module('exits.mjs', `export const runTask = () => new Promise(() => process.exit(3));\n`)), { version: null, error: 'the worker stopped before finishing (exit code 3)' });
  assert.deepEqual(outcome(module('uncaught.mjs', `export const runTask = () => new Promise(() => setTimeout(() => { throw new Error('uncaught'); }));\n`)), { version: null, error: 'uncaught' });
  assert.deepEqual(outcome(module('ok.mjs', `export const runTask = async (task) => ({ version: task.kind });\n`)), { version: 'prune' });
});

test('undoing the AI batch keeps a later human edit; the undo can be undone', (t) => {
  const dir = project(t);
  const original = text(dir, 'screens/chemin.json');
  assert.deepEqual(edit.appendMark(dir, 'Ajoute une note et renomme l\'écran').mark.seq, 1);
  const title = edit.updateScreen(dir, { id: 'chemin', title: 'Titre de l\'IA' }, { author: agent });
  const note = edit.addBlock(dir, { screen: 'chemin', block: { id: 'chemin-ia', type: 'text', props: { markdown: 'Note de l\'IA' } } }, { author: agent });
  // The human rewrites the AI's note.
  const rewrite = edit.updateBlock(dir, { block: 'chemin-ia', props: { markdown: 'Note humaine' } }, { author: human });
  const batches = edit.historyBatches(dir);
  assert.deepEqual(batches.map((b) => [b.ai, b.label ?? null, b.changes.length]), [[true, 'Ajoute une note et renomme l\'écran', 2], [false, null, 1]]);

  const r = edit.undoBatch(dir, undefined, { author: human });
  assert.equal(r.batch, batches[0].id);
  assert.deepEqual(r.undone, [title.undo, note.undo]);
  const screen = readJSON(dir, 'screens/chemin.json');
  assert.notEqual(screen.title, 'Titre de l\'IA', 'the AI title is undone');
  assert.equal(screen.blocks.find((b: { id: string }) => b.id === 'chemin-ia').props.markdown, 'Note humaine', 'the note the human rewrote stays');
  assert.deepEqual(r.skipped.map((s) => s.reason), ['changed']);
  assert.match(r.skipped[0].message, /blocks\[chemin-ia\]: changed since/);
  assert.throws(() => edit.undoBatch(dir, batches[0].id), /already undone/);
  assert.deepEqual(edit.history(dir).map((h) => [h.op, h.undone]), [['update_screen', true], ['add_block', true], ['update_block', false], ['undo_batch', false]]);

  // Undoing the undo redoes the AI title.
  edit.undo(dir, r.undo as number);
  assert.equal(readJSON(dir, 'screens/chemin.json').title, 'Titre de l\'IA');
  // Undoing the human edit, then the rest of the AI work, gives back the original text exactly.
  edit.undo(dir, rewrite.undo as number);
  edit.undoBatch(dir, batches[0].id);
  assert.equal(text(dir, 'screens/chemin.json'), original);
});

test('binary files brought in by an edit are undone and redone from the blob store', (t) => {
  const dir = project(t);
  const library = resources(t).tempDir('elabora-library-');
  const write = (rel: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(library, rel)), { recursive: true }); fs.writeFileSync(path.join(library, rel), data); };
  const font = bytes(2048);
  write('library.json', JSON.stringify({ id: 'acme', title: 'ACME' }));
  write('components/badge/component.json', JSON.stringify({ id: 'badge', title: 'Badge', version: '1.0.0', props: { type: 'object', properties: {} } }, null, 2));
  write('components/badge/template.html', '<span class="badge"></span>\n');
  write('components/badge/fonts/badge.woff2', font);
  const r = edit.addLibraryComponent(dir, { library, component: 'badge' }, { author: agent });
  assert.deepEqual(r.files.sort(), ['components/badge/component.json', 'components/badge/fonts/badge.woff2', 'components/badge/template.html']);
  assert.ok(fs.readFileSync(path.join(dir, 'components/badge/fonts/badge.woff2')).equals(font));
  const entry = changes(dir)[0];
  assert.ok(entry.ops.some((op) => op.op === 'write' && 'blob' in op && op.blob === hashBytes(font)), 'the journal names the font by its hash');
  edit.undo(dir);
  assert.ok(!fs.existsSync(path.join(dir, 'components/badge/fonts/badge.woff2')));
  edit.undo(dir, 2);
  assert.ok(fs.readFileSync(path.join(dir, 'components/badge/fonts/badge.woff2')).equals(font), 'restored from the blob store');
});
