import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openProject, ProtocolClient } from '@elabora/engine';
import type { EngineEvent, OpenOptions, Session, SessionStore, ResponseMessage, EventMessage } from '@elabora/engine';
import { FsStore } from '@elabora/node/store/index';
import { readJournal } from '@elabora/node/journal/index';
import type { ChangeEntry } from '@elabora/core/ops/types';
import { copyExample, readJSON } from '../helpers.ts';

// The engine's session on the example course: commands, external edits, half-written files, its
// own writes, bursts, and the message protocol.

const temporary: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) await session.close().catch(() => {});
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

const QUIET: OpenOptions = { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 };

async function open(options: OpenOptions = {}): Promise<{ dir: string; session: Session; events: EngineEvent[] }> {
  const dir = copyExample();
  temporary.push(dir);
  const session = await openProject(dir, { ...QUIET, ...options });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  await session.flush(); // the first look at the folder after watching it
  return { dir, session, events };
}

async function waitFor<T extends EngineEvent>(events: EngineEvent[], match: (event: EngineEvent) => event is T, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`No matching event in ${timeoutMs} ms: ${JSON.stringify(events.map((event) => event.type))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isChanged = (source?: string) => (event: EngineEvent): event is Extract<EngineEvent, { type: 'changed' }> => event.type === 'changed' && (!source || event.source === source);
const changes = (dir: string) => readJournal(dir).filter((entry): entry is ChangeEntry => entry.type === 'change');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const codesOf = (list: readonly { code: string }[] | undefined) => (list ?? []).map((d) => d.code);

// A store that counts what the session reads, to show that a command does not read the folder again.
function countingStore(dir: string) {
  const store = new FsStore(dir);
  const counts = { list: 0, readText: 0, hash: 0 };
  const counting: SessionStore = {
    id: store.id,
    list: () => { counts.list++; return store.list(); },
    readText: (rel) => { counts.readText++; return store.readText(rel); },
    readBytes: (rel) => store.readBytes(rel),
    write: (rel, data) => store.write(rel, data),
    remove: (rel) => store.remove(rel),
    watch: (onChange, onReady) => store.watch(onChange, onReady),
    stat: (rel) => store.stat(rel),
    hash: (rel) => { counts.hash++; return store.hash(rel); }
  };
  return { store: counting, counts };
}

test('a command updates the snapshot and the diagnostics from what it wrote, without reading the folder', async () => {
  const dir = copyExample();
  temporary.push(dir);
  const { store, counts } = countingStore(dir);
  // No watcher: nothing but the command itself may read files.
  const session = await openProject(dir, { ...QUIET, store, watch: false });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  const before = session.files;
  counts.list = counts.readText = counts.hash = 0;

  const added = await session.run('add_block', { screen: 'chemin', block: { id: 'chemin-plan', type: 'image', props: { asset: 'images/absent.svg', alt: 'Plan du réseau' } }, after: 'chemin-intro' });
  assert.deepEqual(counts, { list: 0, readText: 0, hash: 0 }, 'the folder was not read again');
  assert.equal(added.change?.command?.name, 'add_block');
  assert.deepEqual(added.change?.author, { kind: 'human' });
  assert.deepEqual(added.files, ['screens/chemin.json']);
  // The snapshot holds the file as written, and only that file changed.
  assert.equal((session.files.get('screens/chemin.json') as { text: string }).text, fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8'));
  for (const [rel, file] of before) if (rel !== 'screens/chemin.json') assert.equal(session.files.get(rel), file, `${rel} is the same entry`);
  assert.ok(session.project.screens.get('chemin')?.data.blocks?.some((block) => block.id === 'chemin-plan'));
  // The missing asset is found on that screen, and reported in an event after the change event.
  assert.ok(codesOf(session.readScreen('chemin').diagnostics).includes('E_ASSET_MISSING'));
  assert.ok(codesOf(added.diagnostics).includes('E_ASSET_MISSING'));
  const changedAt = events.findIndex(isChanged('engine'));
  const diagnosticsAt = events.findIndex((event) => event.type === 'diagnostics');
  assert.ok(changedAt >= 0 && diagnosticsAt > changedAt, 'changed, then diagnostics');
  const diagnostics = events[diagnosticsAt] as Extract<EngineEvent, { type: 'diagnostics' }>;
  assert.deepEqual(Object.keys(diagnostics.screens), ['chemin'], 'only the edited screen was reported');
  assert.equal(diagnostics.summary.errors, 1);

  await session.run('remove_block', { block: 'chemin-plan' });
  assert.deepEqual(counts, { list: 0, readText: 0, hash: 0 });
  assert.ok(!codesOf(session.readScreen('chemin').diagnostics).includes('E_ASSET_MISSING'));
  assert.equal(session.summary().diagnostics.errors, 0);
  assert.deepEqual(changes(dir).map((change) => change.command?.name), ['add_block', 'remove_block']);
});

test('an edit made with a plain file write is journaled as external and validated', async () => {
  const { dir, session, events } = await open();
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.title = 'Titre écrit par un agent';
  screen.blocks.push({ id: 'accueil-photo', type: 'image', props: { asset: 'images/photo-absente.svg', alt: 'Photo' } });
  fs.writeFileSync(path.join(dir, 'screens/accueil.json'), JSON.stringify(screen));

  const changed = await waitFor(events, isChanged('watcher'));
  assert.deepEqual(changed.change.author, { kind: 'external' });
  assert.deepEqual(changed.change.files, ['screens/accueil.json']);
  assert.deepEqual(changed.change.ops.map((op) => op.op).sort(), ['insert', 'set']);
  const [entry] = changes(dir);
  assert.equal(entry.author.kind, 'external');
  assert.equal(entry.id, changed.change.id);
  const diagnostics = await waitFor(events, (event): event is Extract<EngineEvent, { type: 'diagnostics' }> => event.type === 'diagnostics');
  assert.ok(codesOf(diagnostics.screens.accueil).includes('E_ASSET_MISSING'));
  assert.equal(session.readScreen('accueil').data.title, 'Titre écrit par un agent');
  // The snapshot keeps the agent's text as it is (its formatting too).
  assert.equal(session.readFile('screens/accueil.json').kind === 'text' && (session.readFile('screens/accueil.json') as { text: string }).text, JSON.stringify(screen));
});

// openProject resolves once the folder's watcher reports, and the sessions of the earlier tests are
// still open (on macOS each open rebuilds the process's FSEvents stream; before, a write right after
// opening was missed once in about 24 opens, until the periodic listing these tests turn off).
test('a file written as soon as the project is open is reported by the watcher, without the periodic listing', async () => {
  for (let i = 0; i < 10; i++) {
    const { dir, events } = await open();
    const screen = readJSON(dir, 'screens/accueil.json');
    screen.title = `Écrit à l'ouverture ${i}`;
    fs.writeFileSync(path.join(dir, 'screens/accueil.json'), `${JSON.stringify(screen, null, 2)}\n`);
    const changed = await waitFor(events, isChanged('watcher'), 3000);
    assert.deepEqual(changed.change.files, ['screens/accueil.json']);
  }
});

// On macOS each project opened or closed in the process (and each preview started or stopped)
// started or stopped a watcher in the process's one FSEvents stream, and an open project lost what
// was written from about 16 ms before to 10 ms after, until the periodic listing these tests turn
// off (packages/engine/bench/watch-rebuild.ts: 336 writes of 4297 for 10 opens and closes).
test('an agent writing while other projects open and close: every write is seen, without the periodic listing', async () => {
  const dir = copyExample();
  temporary.push(dir);
  fs.mkdirSync(path.join(dir, 'notes'));
  const session = await openProject(dir, QUIET);
  sessions.push(session);
  await session.flush();
  let written = 0;
  const writer = setInterval(() => fs.writeFileSync(path.join(dir, `notes/w-${written++}.md`), 'x'), 1);
  try {
    for (let i = 0; i < 4; i++) {
      const other = copyExample();
      temporary.push(other);
      await sleep(40);
      const opened = await openProject(other, { ...QUIET, backups: { enabled: false } });
      await sleep(40);
      await opened.close();
    }
    await sleep(40);
  } finally {
    clearInterval(writer);
  }
  const missed = () => Array.from({ length: written }, (_, n) => `notes/w-${n}.md`).filter((rel) => !session.files.has(rel));
  const deadline = Date.now() + 5000;
  while (missed().length && Date.now() < deadline) {
    await sleep(100);
    await session.flush(); // what the watcher reported, nothing listed
  }
  assert.ok(written > 20, `${written} writes`);
  assert.deepEqual(missed(), [], `${missed().length} of ${written} writes never seen`);
});

test('a half-written JSON file keeps its last valid content until it parses again', async () => {
  const { dir, session, events } = await open();
  const file = path.join(dir, 'screens/accueil.json');
  const screen = readJSON(dir, 'screens/accueil.json');
  const title = screen.title;
  fs.writeFileSync(file, '{ "id": "accueil", "title": "Nouveau ti');

  const broken = await waitFor(events, (event): event is Extract<EngineEvent, { type: 'diagnostics' }> => event.type === 'diagnostics' && codesOf(event.screens.accueil).includes('E_JSON_PARSE'));
  assert.equal(broken.summary.errors, 1);
  const view = session.readScreen('accueil');
  assert.equal(view.data.title, title, 'the last valid content is still loaded');
  assert.match(view.error ?? '', /JSON/);
  assert.equal(session.project.screens.get('accueil')?.data.blocks?.length, screen.blocks.length);
  assert.equal(changes(dir).length, 0, 'nothing journaled while the file does not parse');

  screen.title = 'Nouveau titre';
  fs.writeFileSync(file, `${JSON.stringify(screen, null, 2)}\n`);
  const fixed = await waitFor(events, isChanged('watcher'));
  assert.deepEqual(fixed.change.ops, [{ op: 'set', file: 'screens/accueil.json', path: ['title'], value: 'Nouveau titre' }], 'diffed against the last valid content');
  await waitFor(events, (event): event is Extract<EngineEvent, { type: 'diagnostics' }> => event.type === 'diagnostics' && event.summary.errors === 0);
  assert.equal(session.readScreen('accueil').error, undefined);
  assert.equal(session.readScreen('accueil').data.title, 'Nouveau titre');
  assert.equal(changes(dir).length, 1);
});

test('the engine\'s own writes come back from the watcher and are ignored', async () => {
  const { dir, session, events } = await open();
  await session.run('update_block', { block: 'chemin-intro', props: { markdown: 'Premier texte' } });
  await session.run('update_screen', { id: 'accueil', title: 'Accueil' });
  await session.run('move_block', { block: 'chemin-intro', screen: 'accueil', position: 0 });
  await sleep(400); // the watcher reports the three writes
  await session.flush({ rescan: true });
  assert.deepEqual(changes(dir).map((change) => change.author.kind), ['human', 'human', 'human']);
  assert.equal(events.filter(isChanged('watcher')).length, 0);
  assert.equal(events.filter(isChanged('engine')).length, 3);
  for (const rel of ['screens/chemin.json', 'screens/accueil.json']) {
    assert.equal((session.files.get(rel) as { text: string }).text, fs.readFileSync(path.join(dir, rel), 'utf8'));
  }
});

test('a burst of 50 file writes gives one external change', async () => {
  const { dir, session, events } = await open({ debounceMs: 150 });
  fs.mkdirSync(path.join(dir, 'notes'));
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, 'notes', `note-${String(i).padStart(2, '0')}.md`), `# Note ${i}\n`);
  const changed = await waitFor(events, isChanged('watcher'));
  await sleep(500);
  await session.flush({ rescan: true });
  assert.equal(events.filter(isChanged('watcher')).length, 1, 'one change');
  assert.equal(changed.change.files.length, 50);
  assert.equal(changes(dir).length, 1);
  assert.equal([...session.files.keys()].filter((rel) => rel.startsWith('notes/')).length, 50);
});

test('a file an edit touches that changed on disk unseen is journaled first, then the edit is computed again', async () => {
  const { dir, session } = await open({ watch: false });
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.title = 'Titre de l\'agent';
  fs.writeFileSync(path.join(dir, 'screens/chemin.json'), JSON.stringify(screen, null, 2));
  // The session has not seen the write: the edit finds the file changed and takes it in first.
  const result = await session.run('update_block', { block: 'chemin-intro', props: { markdown: 'Texte humain' } });
  assert.deepEqual(changes(dir).map((change) => [change.author.kind, change.command?.name ?? null]), [['external', null], ['human', 'update_block']]);
  assert.equal(result.change?.seq, 2);
  const written = readJSON(dir, 'screens/chemin.json');
  assert.equal(written.title, 'Titre de l\'agent', 'the agent\'s edit is kept');
  assert.equal(written.blocks[0].props.markdown, 'Texte humain');
});

test('protocol: requests answered with results or typed errors, events as messages', async () => {
  const { dir, session } = await open();
  const messages: EventMessage[] = [];
  session.subscribe((message) => messages.push(message));
  // A transport in memory: what an Electron message port or a WebSocket would carry.
  const client = new ProtocolClient((message) => {
    void session.handle(structuredClone(message)).then((response: ResponseMessage) => client.receive(structuredClone(response)));
  });
  const summary = await client.request('summary', {});
  assert.equal(summary.course?.id, readJSON(dir, 'course.json').id);
  assert.equal(summary.outline.flatMap((section) => section.screens).length, summary.outline.reduce((n, section) => n + section.screens.length, 0));
  assert.equal(summary.plan.state, 'approved');
  // Every screen with how long a learner spends on it (D50).
  assert.ok(summary.outline.flatMap((section) => section.screens).every((entry) => entry.seconds >= 10));
  // The author writes the plan as the agent does, a validated version or not; versions are a person's.
  await assert.rejects(client.request('run', { command: 'write_plan', args: { patch: [{ op: 'remove', path: '/items/9' }] } }), (error: Error & { kind?: string }) => error.kind === 'refused' && /does not apply/.test(error.message));
  await assert.rejects(client.request('run', { command: 'approve_plan', args: { by: 'Claire Martin' }, author: { kind: 'agent', name: 'assistant' } }), (error: Error & { kind?: string }) => error.kind === 'refused' && /Only a person/.test(error.message));
  const screen = await client.request('readScreen', { screen: 'chemin' });
  assert.equal(screen.data.id, 'chemin');
  const file = await client.request('readFile', { path: 'course.json' });
  assert.equal(file.kind, 'text');
  const run = await client.request('run', { command: 'update_screen', args: { id: 'chemin', title: 'Le chemin' } });
  assert.equal(run.change?.command?.name, 'update_screen');
  const history = await client.request('history', { limit: 10 });
  assert.deepEqual(history.changes.map((change) => change.op), ['update_screen']);
  const diagnostics = await client.request('diagnostics', {});
  assert.ok(Object.keys(diagnostics.screens).includes('chemin'));
  assert.ok(messages.some(({ kind, event }) => kind === 'event' && event.type === 'changed'));

  // What the events of a screen can name: a free object's events and settings, the course's
  // screens and variables.
  const parts = await client.request('screenParts', { screen: 'simulation' });
  const scene = parts.blocks.find((block) => block.id === 'simulation-scene');
  assert.equal(scene?.behavior, 'object');
  assert.deepEqual(scene?.object?.events.map((event) => [event.name, event.fields]), [['device_inspected', ['device', 'inOrder', 'faulty']], ['hint_shown', []], ['completed', ['score', 'attempts']]]);
  assert.ok(scene?.object?.props.some((prop) => prop.name === 'packetSpeed' && prop.type === 'number'));
  assert.deepEqual(parts.blocks.find((block) => block.id === 'simulation-consigne')?.controls, []);
  assert.deepEqual(parts.steps, [1]);
  assert.equal(parts.screens[0]?.id, summary.outline[0]?.screens[0]?.id);
  assert.ok(parts.variables.some((variable) => variable.id === 'indiceVu'));
  await assert.rejects(client.request('screenParts', { screen: 'absent' }), { kind: 'not-found' });
  // The course's words that hold a text, and where.
  const found = await client.request('findText', { query: 'pare-feu' });
  assert.ok(found.some((match) => match.screen === 'chemin' && match.block === 'chemin-roles'));
  assert.ok(found.every((match) => match.file.startsWith('screens/') || match.file === 'course.json'));
  // Languages: none, then English started as a change, as a bilingual table.
  assert.deepEqual(await client.request('translationStatus', {}), []);
  await client.request('run', { command: 'export_translation', args: { to: 'en' } });
  const languages = await client.request('translationStatus', {});
  assert.deepEqual(languages.map((status) => [status.language, status.exists]), [['en', true]]);
  const table = await client.request('translationTable', { language: 'en' });
  assert.ok(table.rows.length > 20 && table.rows.every((row) => row.status === 'to-translate'));
  await assert.rejects(client.request('translationTable', { language: 'fr' }), { kind: 'bad-request' });
  await assert.rejects(client.request('readScreen', { screen: 'absent' }), { kind: 'not-found' });
  const render = await client.request('renderScreen', { screen: 'chemin', step: 1 });
  assert.equal(render.screen, 'chemin');
  assert.equal(render.course.screens[0].id, 'chemin');
  assert.deepEqual(render.view, { state: 'initial', step: 1, layer: null });
  assert.ok(render.files.some((file) => file.path === 'assets/images/chemin-impression.svg' && file.kind === 'asset'));
  await assert.rejects(client.request('renderScreen', { screen: 'absent' }), { kind: 'not-found' });
  await assert.rejects(client.request('canvasView', { screen: 'chemin' }), { kind: 'not-available' });
  await assert.rejects(client.request('run', { command: 'remove_block', args: { block: 'absent' } }), { kind: 'refused' });
  const unknown = await session.handle({ kind: 'request', id: 'x', type: 'format_disk', params: {} });
  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.error.kind, 'bad-request');

  const closed = await client.request('close', {});
  assert.equal(typeof closed.version === 'string' || closed.version === null, true);
  await assert.rejects(client.request('summary', {}), { kind: 'closed' });
});

test('a session ignores files that are not content: tool folders, temporary files, conflict copies', async () => {
  const { dir, session, events } = await open();
  fs.writeFileSync(path.join(dir, 'screens/chemin.json.123.tmp'), '{');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist/package.zip'), 'zip');
  fs.writeFileSync(path.join(dir, 'screens/chemin (conflicted copy 2026-10-06).json'), fs.readFileSync(path.join(dir, 'screens/chemin.json')));
  await sleep(400);
  await session.flush({ rescan: true });
  assert.equal(events.filter(isChanged()).length, 0);
  assert.equal(changes(dir).length, 0);
  assert.ok(codesOf(session.diagnostics().project).includes('W_SYNC_CONFLICT_COPY'));
  assert.ok(![...session.files.keys()].some((rel) => rel.includes('conflicted') || rel.startsWith('dist/') || rel.endsWith('.tmp')));
});

test('backups: a named version, then a restore journaled as one system change that can be undone', async () => {
  const { dir, session, events } = await open();
  const named = await session.createBackup('Avant la relecture');
  assert.equal(named?.name, 'Avant la relecture');
  assert.equal(named?.reason, 'manual');
  const original = readJSON(dir, 'screens/chemin.json').title;
  await session.run('update_screen', { id: 'chemin', title: 'Titre modifié' });
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n');
  await waitFor(events, isChanged('watcher'));

  const restored = await session.restoreBackup(named?.id as string);
  assert.equal(restored.version, named?.id);
  assert.ok(restored.before, 'the state before the restore is kept in a version');
  assert.deepEqual(restored.change?.author, { kind: 'system' });
  assert.equal(restored.change?.command?.name, 'restore_backup');
  assert.deepEqual([...(restored.change?.files ?? [])].sort(), ['notes.md', 'screens/chemin.json']);
  assert.equal(readJSON(dir, 'screens/chemin.json').title, original);
  assert.ok(!fs.existsSync(path.join(dir, 'notes.md')));
  assert.equal(session.readScreen('chemin').data.title, original);
  assert.ok(!session.files.has('notes.md'));
  assert.ok(session.backups().some((version) => version.id === restored.before));

  await session.undo();
  assert.equal(readJSON(dir, 'screens/chemin.json').title, 'Titre modifié', 'the restore is undone');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), '# Notes\n');
  await assert.rejects(session.restoreBackup('nope'), { kind: 'not-found' });
});

// Windows refuses to move a folder that is being watched (EPERM): there the app holds it in place.
test('a project folder deleted while open is reported, not journaled as deleted files', { skip: process.platform === 'win32' && 'Windows does not let a watched folder be moved' }, async () => {
  const { dir, session, events } = await open();
  const moved = `${dir}-moved`;
  temporary.push(moved);
  fs.renameSync(dir, moved);
  // The watcher may or may not report a rename of the folder itself; the periodic listing would.
  await session.flush({ rescan: true });
  await waitFor(events, (event): event is Extract<EngineEvent, { type: 'error' }> => event.type === 'error' && /gone/.test(event.message));
  assert.ok(!fs.existsSync(dir), 'nothing was written where the project was');
  assert.equal(events.filter(isChanged()).length, 0);
  assert.ok(session.files.has('course.json'), 'the session keeps what it had');
  await assert.rejects(session.run('update_screen', { id: 'chemin', title: 'X' }), { kind: 'not-found' });
  await session.close();
  assert.ok(!fs.existsSync(dir), 'closing wrote nothing there either');
});

test('a binary file overwritten by another program before anything kept it is journaled too, as not restorable', async () => {
  const dir = copyExample();
  temporary.push(dir);
  fs.writeFileSync(path.join(dir, 'assets/data.bin'), Buffer.from([1, 2, 3]));
  const session = await openProject(dir, { ...QUIET, debounceMs: 150 });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  await session.flush();
  // No version, no change ever stored data.bin: its content is in no store when it is overwritten.
  fs.writeFileSync(path.join(dir, 'assets/data.bin'), Buffer.from([4, 5, 6, 7]));
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.title = 'Titre de l\'agent';
  fs.writeFileSync(path.join(dir, 'screens/chemin.json'), JSON.stringify(screen, null, 2));
  const changed = await waitFor(events, isChanged('watcher'));
  await session.flush({ rescan: true });
  const [entry] = changes(dir);
  assert.deepEqual([...changed.change.files].sort(), ['assets/data.bin', 'screens/chemin.json']);
  assert.deepEqual(changed.change.unavailable, ['assets/data.bin']);
  assert.equal(entry.unavailable?.length, 1);

  const undone = await session.undo();
  assert.deepEqual(undone.skipped.map((skipped) => [skipped.reason, skipped.op.file]), [['unavailable', 'assets/data.bin']]);
  assert.notEqual(readJSON(dir, 'screens/chemin.json').title, 'Titre de l\'agent', 'the rest is undone');
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'assets/data.bin'))], [4, 5, 6, 7], 'the binary file stays as it is');
});

test('opening a course brings its rules for agents up to date when nobody edited them, as a system change (D34)', async () => {
  const dir = copyExample();
  temporary.push(dir);
  const { currentRules, agentRulesState } = await import('@elabora/node/agent-rules');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), currentRules().text); // a course from before the markers
  const session = await openProject(dir, QUIET);
  sessions.push(session);
  const deadline = Date.now() + 8000;
  while (agentRulesState(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).status !== 'current' && Date.now() < deadline) await sleep(20);
  assert.equal(agentRulesState(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).status, 'current');
  const change = changes(dir).at(-1)!;
  assert.deepEqual([change.author, change.command?.name], [{ kind: 'system' }, 'update_agent_rules']);
});

test('watch readiness gates opening and close reconciles a pending observed file', async () => {
  const dir = copyExample();
  temporary.push(dir);
  const { store } = countingStore(dir);
  let ready: (() => void) | undefined;
  let changed: ((paths: string[]) => void) | undefined;
  let stopped = false;
  store.watch = (onChange, onReady) => {
    changed = onChange;
    ready = onReady;
    return () => { stopped = true; };
  };
  let opened = false;
  const opening = openProject(dir, { ...QUIET, store, debounceMs: 10_000 }).then((session) => { opened = true; return session; });
  while (!ready) await sleep(1);
  assert.equal(opened, false);
  ready();
  const session = await opening;
  sessions.push(session);
  await session.flush();
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.title = 'Pending at close';
  fs.writeFileSync(path.join(dir, 'screens/accueil.json'), JSON.stringify(screen));
  changed!(['screens/accueil.json']);
  await session.close();
  assert.equal(stopped, true);
  assert.equal(session.project.screens.get('accueil')?.data.title, 'Pending at close');
  assert.equal(changes(dir).filter((entry) => entry.author.kind === 'external').length, 1);
  const changeIndex = events.findIndex(isChanged('watcher'));
  const closedIndex = events.findIndex((event) => event.type === 'closed');
  assert.ok(changeIndex >= 0 && closedIndex > changeIndex);
});
