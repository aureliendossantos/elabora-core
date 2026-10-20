import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openProject } from '@elabora/engine';
import type { EngineEvent, HistoryView, OpenOptions, Session } from '@elabora/engine';
import { readJournal } from '@elabora/node/journal/index';
import { listVersions } from '@elabora/node/backups/index';
import type { Author, ChangeLike } from '@elabora/core/ops/types';
import { ROOT, copyExample, readJSON } from '../helpers.ts';

// The session alongside agents: the CLI in another process, an agent's own file writes, AI
// batches and their undo, marks and the versions around AI work.

const run = promisify(execFile);
const temporary: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) await session.close().catch(() => {});
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

const QUIET: OpenOptions = { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 };
const agent: Author = { kind: 'agent', name: 'claude-code' };

async function open(options: OpenOptions = {}): Promise<{ dir: string; session: Session; events: EngineEvent[] }> {
  const dir = copyExample();
  temporary.push(dir);
  const session = await openProject(dir, { ...QUIET, ...options });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  await session.flush();
  return { dir, session, events };
}

async function waitFor<T extends EngineEvent>(events: EngineEvent[], match: (event: EngineEvent) => event is T, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`No matching event in ${timeoutMs} ms: ${JSON.stringify(events.map((event) => event.type))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Changed = Extract<EngineEvent, { type: 'changed' }>;
const isChanged = (source?: string) => (event: EngineEvent): event is Changed => event.type === 'changed' && (!source || event.source === source);
const changes = (dir: string) => readJournal(dir).filter((entry): entry is ChangeLike => entry.type !== 'mark');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const elabora = (dir: string, ...args: string[]) => run(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: dir, env: { ...process.env, ELABORA_AUTHOR: 'agent:codex' } });

test('an edit of the elabora command in another process appears as an agent change and is not journaled again', async () => {
  const { dir, session, events } = await open();
  await elabora(dir, 'block', 'duplicate', dir, 'chemin-intro', '--id', 'chemin-intro-bis');

  const changed = await waitFor(events, isChanged('journal'));
  assert.deepEqual(changed.change.author, { kind: 'agent', name: 'codex' });
  assert.equal(changed.change.command?.name, 'duplicate_block');
  assert.ok(session.project.screens.get('chemin')?.data.blocks?.some((block) => block.id === 'chemin-intro-bis'), 'the snapshot has the copy');
  assert.equal((session.files.get('screens/chemin.json') as { text: string }).text, fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8'));
  // The file the CLI wrote also reached the watcher: it is explained by the journal.
  await sleep(400);
  await session.flush({ rescan: true });
  assert.deepEqual(changes(dir).map((change) => change.author.kind), ['agent']);
  assert.equal(events.filter(isChanged('watcher')).length, 0);
  assert.equal(session.history().openBatch, changed.change.batch, 'AI work is open');
});

test('history with ops: an agent\'s work done before the session opened says what it did', async () => {
  const dir = copyExample();
  temporary.push(dir);
  await elabora(dir, 'block', 'duplicate', dir, 'chemin-intro', '--id', 'chemin-intro-bis');
  const session = await openProject(dir, QUIET);
  sessions.push(session);
  assert.equal(session.history().changes[0]?.ops, undefined, 'the default response is unchanged');
  const [change] = session.history(50, { ops: true }).changes;
  assert.deepEqual(change?.author, { kind: 'agent', name: 'codex' });
  assert.deepEqual(change?.ops, changes(dir)[0]?.ops, 'the journaled ops, as a changed event carries them');
  assert.ok(change?.ops?.some((op) => op.file === 'screens/chemin.json'));
  // The same through the protocol.
  const response = await session.handle({ kind: 'request', id: 'h', type: 'history', params: { limit: 10, ops: true } });
  assert.ok(response.ok);
  assert.deepEqual((response.result as HistoryView).changes[0]?.ops, change?.ops);
});

test('a file the CLI wrote and an agent rewrote before the session looked: the journal\'s part, then the rest as external', async () => {
  const { dir, session, events } = await open({ watch: false });
  await elabora(dir, 'block', 'duplicate', dir, 'chemin-intro', '--id', 'chemin-intro-bis');
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.title = 'Titre réécrit par l\'agent';
  fs.writeFileSync(path.join(dir, 'screens/chemin.json'), JSON.stringify(screen));
  await session.flush({ rescan: true });
  assert.deepEqual(events.filter(isChanged()).map((event) => [event.source, event.change.author.kind]), [['journal', 'agent'], ['watcher', 'external']]);
  const external = events.filter(isChanged('watcher'))[0];
  assert.deepEqual(external.change.ops, [{ op: 'set', file: 'screens/chemin.json', path: ['title'], value: 'Titre réécrit par l\'agent' }]);
  assert.equal(session.readScreen('chemin').data.title, 'Titre réécrit par l\'agent');
});

test('undoing the AI batch through the session keeps a later human edit', async () => {
  const { dir, session, events } = await open();
  const mark = await session.mark('Déplace le premier bloc sur l\'accueil');
  assert.ok(mark.mark.seq > 0);
  const original = readJSON(dir, 'screens/accueil.json');
  // The agent moves a block through the engine, then edits a file with its own tools.
  await session.run('move_block', { block: 'chemin-intro', screen: 'accueil', position: 0 }, agent);
  const accueil = readJSON(dir, 'screens/accueil.json');
  accueil.title = 'Titre écrit par l\'agent';
  fs.writeFileSync(path.join(dir, 'screens/accueil.json'), JSON.stringify(accueil, null, 2));
  const external = await waitFor(events, isChanged('watcher'));
  const batch = external.change.batch;
  assert.equal(session.history().changes.at(-2)?.batch, batch, 'the agent\'s command and its own edit form one batch');
  // The human rewrites the moved block: the AI batch closes (after-ai version).
  await session.run('update_block', { block: 'chemin-intro', props: { markdown: 'Texte humain' } });
  const closed = await waitFor(events, (event): event is Extract<EngineEvent, { type: 'batchClosed' }> => event.type === 'batchClosed');
  assert.equal(closed.batch, batch);
  assert.equal(closed.reason, 'human');
  assert.ok(closed.version, 'an after-ai version was taken');

  const undone = await session.undoBatch();
  assert.equal(undone.batch, batch);
  assert.equal(undone.undone.length, 2);
  assert.equal(session.history().batches.find((summary) => summary.id === batch)?.label, 'Déplace le premier bloc sur l\'accueil');
  const now = readJSON(dir, 'screens/accueil.json');
  assert.equal(now.title, original.title, 'the agent\'s title is undone');
  const back = readJSON(dir, 'screens/chemin.json').blocks[0];
  assert.equal(back.id, 'chemin-intro', 'the block is back in its place');
  assert.deepEqual(back.props, { markdown: 'Texte humain' }, 'with the human\'s text');
  assert.equal(session.readScreen('accueil').data.title, original.title, 'the snapshot follows');
  assert.equal(changes(dir).at(-1)?.type, 'undo');
});

test('a mark keeps a before-ai version and labels the AI batch that follows', async () => {
  const { dir, session, events } = await open();
  assert.equal(listVersions(dir).length, 0);
  const marked = await session.mark('Ajoute une question sur le pare-feu');
  const versions = listVersions(dir);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].reason, 'before-ai');
  assert.equal(marked.version, versions[0].id);
  assert.ok(events.some((event) => event.type === 'backupTaken' && event.version.reason === 'before-ai'));
  await elabora(dir, 'block', 'duplicate', dir, 'chemin-intro', '--id', 'chemin-intro-bis');
  await waitFor(events, isChanged('journal'));
  const batch = session.history().batches.at(-1);
  assert.equal(batch?.label, 'Ajoute une question sur le pare-feu');
  assert.equal(batch?.ai, true);
});

test('an AI batch closes after its idle time, with an after-ai version', async () => {
  const { dir, session, events } = await open({ batchIdleMs: 300 });
  await session.run('update_screen', { id: 'chemin', title: 'Titre de l\'agent' }, agent);
  assert.ok(session.openBatch);
  const closed = await waitFor(events, (event): event is Extract<EngineEvent, { type: 'batchClosed' }> => event.type === 'batchClosed');
  assert.equal(closed.reason, 'idle');
  assert.equal(session.openBatch, null);
  const version = listVersions(dir).find((summary) => summary.id === closed.version);
  assert.equal(version?.reason, 'after-ai');
  assert.equal(version?.batch, closed.batch);
});

test('closing takes a close version of the project as it is', async () => {
  const dir = copyExample();
  temporary.push(dir);
  const session = await openProject(dir, QUIET);
  await session.run('update_screen', { id: 'chemin', title: 'Avant fermeture' });
  const versionsBefore = listVersions(dir);
  assert.deepEqual(versionsBefore.map((version) => version.reason), ['auto'], 'an automatic version before the first write');
  const { version } = await session.close();
  const versions = listVersions(dir);
  assert.equal(versions.at(-1)?.reason, 'close');
  assert.equal(version, versions.at(-1)?.id);
  assert.equal(session.closed, true);
  await assert.rejects(session.run('update_screen', { id: 'chemin', title: 'Après' }), { kind: 'closed' });
});

test('an auto version every interval of activity', async () => {
  const { dir, session, events } = await open({ backups: { onOpen: true, prune: false, intervalMs: 3000 } });
  const taken = (count: number) => (event: EngineEvent): event is Extract<EngineEvent, { type: 'backupTaken' }> =>
    event.type === 'backupTaken' && events.filter((candidate) => candidate.type === 'backupTaken').length >= count;
  await waitFor(events, taken(1));
  assert.deepEqual(listVersions(dir).map((version) => version.reason), ['auto'], 'on open');
  await session.run('update_screen', { id: 'chemin', title: 'Un' });
  await session.run('update_screen', { id: 'chemin', title: 'Deux' });
  assert.equal(listVersions(dir).length, 1, 'not again within the interval');
  await waitFor(events, taken(2));
  assert.deepEqual(listVersions(dir).map((version) => version.reason), ['auto', 'auto'], 'after the interval, the activity is saved');
});
