import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openProject } from '@elabora/engine';
import type { EngineEvent, Session } from '@elabora/engine';
import { createMcpServer } from '@elabora/cli/mcp';
import { callAgentTool } from '@elabora/cli';
import { main } from '@elabora/cli/main';
import { activityPath, readActivity } from '@elabora/node/activity';
import { appendChange, appendMark, chatTurn, readJournal, detectAuthor, type NewChange } from '@elabora/node/journal/index';
import { appendChat, chatPath, listChats, noteDetour, readChat, recordRefusal, refusalNeed, summarizeChats, turnSummary } from '@elabora/node/chats';
import { assignBatch, summarizeBatches, lastAiBatch, BATCH_IDLE_MS } from '@elabora/core/ops/batch';
import type { Author, ChangeEntry, ChangeLike, MarkEntry } from '@elabora/core/ops/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { copyExample } from '../helpers.ts';

// Elabora's chat in the core (reports/chat-agentique, phase 2): a turn is a mark with its chat, and
// everything the conversation's agent writes joins it; the tools refused to the agent and its
// detours are kept in the transcript; elabora history --chats sums the turns up.

const temporary: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) await session.close().catch(() => {});
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});
const course = () => { const dir = copyExample(); temporary.push(dir); return dir; };
const chatAgent: Author = { kind: 'agent', name: 'opencode', chat: 'c1' };
const otherAgent: Author = { kind: 'agent', name: 'codex' };
const human: Author = { kind: 'human' };
const change = (author: Author, n = 0): NewChange => ({
  author, command: { name: 'update_block', args: { n } },
  ops: [{ op: 'set', file: 'screens/a.json', path: ['title'], value: `T${n}` }],
  inverse: [{ op: 'set', file: 'screens/a.json', path: ['title'], value: `T${n - 1}` }],
  files: [{ path: 'screens/a.json', before: null, after: null }]
});
const at = (minutes: number) => ({ now: new Date(Date.UTC(2026, 10, 1, 10, minutes)) });

// ── one batch per turn ───────────────────────────────────────────────

test('assignBatch: a chat\'s change joins its turn; an agent outside the chat never does', () => {
  const head = (id: string, minutes: number, author: Author) => ({ id, at: new Date(Date.UTC(2026, 10, 1, 10, minutes)).toISOString(), author });
  const turnChange = { type: 'change', seq: 2, ...head('a', 0, chatAgent), batch: 'turn1', ops: [], inverse: [], files: [] } satisfies ChangeEntry;
  const humanChange = { type: 'change', seq: 3, ...head('h', 1, human), batch: 'h', ops: [], inverse: [], files: [] } satisfies ChangeEntry;
  assert.equal(assignBatch(humanChange, head('b', 20, chatAgent), 'turn1'), 'turn1', 'after a human change and 20 minutes: still the turn');
  assert.equal(assignBatch(turnChange, head('c', 1, otherAgent)), 'c', 'another agent opens its own batch');
  assert.equal(assignBatch(turnChange, head('d', 1, { kind: 'external' })), 'turn1', 'a file written by no Elabora tool joins the turn');
  assert.equal(assignBatch(turnChange, head('e', 1, chatAgent)), 'turn1', 'without its mark, the conversation goes on with its batch');
  assert.equal(assignBatch(turnChange, head('f', 1, { ...chatAgent, chat: 'c2' })), 'f', 'another conversation opens its own');
  assert.equal(assignBatch(turnChange, head('g', 1, human), 'turn1'), 'g', 'a human change never joins a turn');
  assert.equal(assignBatch(turnChange, { ...head('i', 0, chatAgent), at: new Date(Date.parse(turnChange.at) + BATCH_IDLE_MS).toISOString() }), 'i', 'without a turn, 5 minutes still cut');
});

test('journal: everything the chat\'s agent writes during a turn is one batch, labelled by its request, undone at once', () => {
  const dir = course();
  const turn1 = appendMark(dir, { request: 'Ajoute une question', chat: 'c1' }, at(0));
  assert.equal(turn1.chat, 'c1');
  const first = appendChange(dir, change(chatAgent, 1), at(1));
  const theirs = appendChange(dir, change(human, 2), at(2));
  const outside = appendChange(dir, change(otherAgent, 3), at(3));
  const late = appendChange(dir, change(chatAgent, 4), at(30));
  assert.equal(first.batch, turn1.id, 'the turn\'s id is its batch');
  assert.equal(late.batch, turn1.id, 'after the author\'s change, another agent\'s, and 29 minutes');
  assert.notEqual(theirs.batch, turn1.id);
  assert.equal(outside.batch, outside.id);
  const turn2 = appendMark(dir, { request: 'Raccourcis l\'accueil', chat: 'c1' }, at(31));
  assert.equal(appendChange(dir, change(chatAgent, 5), at(32)).batch, turn2.id);

  const batches = summarizeBatches(readJournal(dir));
  const one = batches.find((batch) => batch.id === turn1.id)!;
  assert.deepEqual([one.label, one.chat, one.changes], ['Ajoute une question', 'c1', [first.id, late.id]]);
  assert.equal(batches.find((batch) => batch.id === turn2.id)?.label, 'Raccourcis l\'accueil');
  assert.equal(batches.find((batch) => batch.id === outside.id)?.label, undefined, 'a chat\'s mark labels only its turn');
  assert.equal(lastAiBatch(readJournal(dir))?.id, turn2.id);
  const beforeTurn2 = readJournal(dir).filter((entry) => entry.seq < turn2.seq);
  assert.equal(lastAiBatch(beforeTurn2)?.id, turn1.id, 'the turn wrote after the other agent began: it is the newest AI work');
});

test('chatTurn: the conversation\'s last mark, read from the end; none past a day', () => {
  const dir = course();
  assert.equal(chatTurn(dir, chatAgent), undefined);
  const mark = appendMark(dir, { request: 'Une demande', chat: 'c1' }, at(0));
  appendMark(dir, { request: 'Une autre conversation', chat: 'c2' }, at(1));
  for (let n = 0; n < 300; n++) appendChange(dir, change(human, n), at(2));
  assert.equal(chatTurn(dir, chatAgent, at(3).now.toISOString()), mark.id);
  assert.equal(chatTurn(dir, otherAgent), undefined, 'outside the chat: no turn');
  assert.equal(chatTurn(dir, chatAgent, new Date(Date.UTC(2026, 10, 3)).toISOString()), undefined, 'two days later');
});

test('ELABORA_CHAT puts the conversation on the agent\'s author, the MCP server\'s included', async () => {
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: 'agent:opencode', ELABORA_CHAT: 'c1' }, false), chatAgent);
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: 'human', ELABORA_CHAT: 'c1' }, false), human, 'a person is in no chat');
  assert.deepEqual(detectAuthor({ ELABORA_AUTHOR: 'codex', ELABORA_CHAT: '../x' }, false), otherAgent, 'a bad id is ignored');

  const dir = course();
  const mark = appendMark(dir, { request: 'Change le titre', chat: 'c1' });
  const saved = { author: process.env.ELABORA_AUTHOR, chat: process.env.ELABORA_CHAT };
  try {
    delete process.env.ELABORA_AUTHOR;
    process.env.ELABORA_CHAT = 'c1';
    const server = createMcpServer(dir);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'opencode', version: '1' });
    await client.connect(clientSide);
    const result = await client.callTool({ name: 'elabora_update_screen', arguments: { id: 'accueil', title: 'Titre du chat' } });
    assert.ok(!result.isError, JSON.stringify(result.content));
    await client.close();
  } finally {
    for (const [key, value] of [['ELABORA_AUTHOR', saved.author], ['ELABORA_CHAT', saved.chat]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const written = readJournal(dir).filter((entry): entry is ChangeLike => entry.type === 'change').at(-1)!;
  assert.deepEqual([written.author, written.batch], [chatAgent, mark.id]);
  assert.ok(readActivity(dir).every((entry) => entry.author.chat === 'c1'));
});

// ── refusals and detours ─────────────────────────────────────────────

test('a refusal: an activity line with the tool and its target, never any content; the next operation is its detour', async () => {
  const dir = course();
  const mark = appendMark(dir, { request: 'Écris un générateur', chat: 'c1' });
  const opencode: Author = { kind: 'agent', name: 'opencode' };
  recordRefusal(dir, { chat: 'c1', mark: mark.id, tool: 'write', path: path.join(dir, 'generators/carte.mjs'), author: opencode });
  recordRefusal(dir, { chat: 'c1', mark: mark.id, tool: 'bash', command: '/usr/bin/sed -i "s/secret text/other/" screens/accueil.json', author: opencode });
  recordRefusal(dir, { chat: '../escape', tool: 'edit', author: chatAgent });
  recordRefusal(dir, { chat: 'c2', tool: 'read', path: '/Users/someone/Documents/brief.md', author: chatAgent });
  const refused = readActivity(dir).filter((entry) => entry.family === 'refused');
  assert.deepEqual(refused.map((entry) => [entry.phase, entry.op, entry.path, entry.outside, entry.command, entry.ok, entry.author.chat]), [
    ['end', 'write', 'generators/carte.mjs', undefined, undefined, false, 'c1'], ['end', 'bash', undefined, undefined, 'sed', false, 'c1'],
    ['end', 'read', 'brief.md', true, undefined, false, 'c2']
  ], 'outside the course: the file\'s name only');
  assert.ok(!fs.readFileSync(activityPath(dir), 'utf8').includes('secret'), 'nothing of the command\'s arguments');
  assert.deepEqual(readChat(dir, 'c1'), [], 'the transcript\'s refused line is the host\'s');

  // The next Elabora operation of the conversation is the detour, once.
  await callAgentTool('elabora_write_object_file', { object: 'nope', file: 'index.html', content: '<p></p>' }, { root: dir, author: chatAgent });
  await callAgentTool('elabora_overview', {}, { root: dir, author: chatAgent });
  const detours = readChat(dir, 'c1').filter((line) => line.type === 'detour');
  assert.deepEqual(detours.map((line) => [line.mark, line.op, line.family, line.after]), [[mark.id, 'elabora_write_object_file', 'write-object', 'bash']]);
  noteDetour(dir, otherAgent, 'elabora_overview', 'module');
  assert.equal(readChat(dir, 'c1').filter((line) => line.type === 'detour').length, 1);
});

test('the transcript: whole lines read back, its conversations listed', () => {
  const dir = course();
  appendChat(dir, 'c1', { type: 'user', turn: 1, text: 'Bonjour' });
  appendChat(dir, 'c2', { type: 'reply', turn: 1, text: 'Salut' });
  fs.appendFileSync(chatPath(dir, 'c1'), '{"type":"reply","at":"2026-11');
  assert.deepEqual(readChat(dir, 'c1').map((line) => [line.type, line.text]), [['user', 'Bonjour']]);
  assert.deepEqual(listChats(dir).map((each) => each.chat).sort(), ['c1', 'c2']);
  assert.deepEqual(readChat(dir, 'absent'), []);
  assert.throws(() => appendChat(dir, 'a/b', { type: 'user' }), /Not a chat id/);
});

// ── the summary ──────────────────────────────────────────────────────

test('refusalNeed: by the shape of the target', () => {
  assert.equal(refusalNeed({ tool: 'write', path: 'generators/carte.mjs' }), 'generators/*.mjs');
  assert.equal(refusalNeed({ tool: 'edit', path: 'theme.css' }), '*.css');
  assert.equal(refusalNeed({ tool: 'edit', path: 'Makefile' }), 'Makefile');
  assert.equal(refusalNeed({ tool: 'read', path: '/Users/x/notes.md' }), 'outside the course');
  assert.equal(refusalNeed({ tool: 'bash', command: 'node' }), '$ node');
  assert.equal(refusalNeed({ tool: 'webfetch' }), 'webfetch');
});

// Turns of conversation c1 as the app writes them: the request with its mark, the refusals, one
// change of the agent, the end with its tokens.
function turns(dir: string, specs: { refused?: string[]; reason?: string; tokens?: number }[]): MarkEntry[] {
  return specs.map((spec, index) => {
    const turn = index + 1;
    const mark = appendMark(dir, { request: `Demande ${index}`, chat: 'c1' });
    appendChat(dir, 'c1', { type: 'user', turn, text: `Demande ${index}`, mark: mark.id });
    for (const target of spec.refused ?? []) appendChat(dir, 'c1', { type: 'refused', turn, tool: 'write', path: target });
    appendChange(dir, change(chatAgent, index));
    appendChat(dir, 'c1', { type: 'reply', turn, text: 'Fait.' });
    appendChat(dir, 'c1', { type: 'turn-end', turn, reason: spec.reason ?? 'end', batch: mark.id, ms: 1000, cost: 0, ...(spec.tokens ? { tokens: { input: spec.tokens, output: 0 } } : {}) });
    return mark;
  });
}

test('summary: too few turns, then the threshold of one turn in five', () => {
  const few = course();
  turns(few, [{ refused: ['generators/a.mjs'] }, {}]);
  assert.equal(summarizeChats(few).verdict, 'too-few-turns');

  const rare = course();
  turns(rare, [{ refused: ['a.css'], tokens: 3000 }, { tokens: 1000 }, { tokens: 1000 }, {}, {}, { refused: ['generators/b.mjs'] }, {}, {}, {}, {}, {}]);
  const kept = summarizeChats(rare);
  assert.equal(kept.turns.length, 11);
  assert.deepEqual([kept.refused, kept.verdict, kept.reasons], [2, 'keep', []]);
  assert.deepEqual([kept.withRefusal.tokens, kept.without.tokens], [3000, 1000]);
  assert.deepEqual([kept.withRefusal.succeeded, kept.without.succeeded], [1, 1]);

  const often = course();
  turns(often, [{ refused: ['a.css'], reason: 'cancelled' }, {}, { refused: ['b/x.json'] }, {}, {}]);
  const open = summarizeChats(often);
  assert.equal(open.verdict, 'open-a-tool');
  assert.match(open.reasons[0]!, /2 turn\(s\) in 5/);
  assert.deepEqual([open.withRefusal.succeeded, open.without.succeeded], [0.5, 1]);
});

test('summary: one need behind most refusals, in more than one turn, calls for a tool', () => {
  const dir = course();
  const specs = Array.from({ length: 12 }, () => ({}) as { refused?: string[] });
  specs[1] = { refused: ['generators/a.mjs', 'generators/b.mjs'] };
  specs[7] = { refused: ['generators/c.mjs'] };
  const marks = turns(dir, specs);
  const report = summarizeChats(dir);
  assert.equal(report.share < 0.2, true);
  assert.equal(report.verdict, 'open-a-tool');
  assert.deepEqual(report.needs, [{ need: 'generators/*.mjs', refusals: 3, turns: 2 }]);
  const turn = report.turns.find((each) => each.turn === 2)!;
  assert.deepEqual([turn.request, turn.mark, turn.agent, turn.changes, turn.reason, turn.refusals.length], ['Demande 1', marks[1]!.id, 'opencode', 1, 'end', 2]);
  assert.deepEqual(turnSummary(dir, 'c1', 2), turn, 'one turn, as the chat shows it when it ends');
  assert.equal(turnSummary(dir, 'c2', 2), null, 'not a turn of that conversation');
});

test('summary: a detour goes to the turn of its refusal', async () => {
  const dir = course();
  const [first] = turns(dir, [{ refused: ['generators/a.mjs'] }]);
  recordRefusal(dir, { chat: 'c1', mark: first!.id, tool: 'write', author: chatAgent });
  await callAgentTool('elabora_overview', {}, { root: dir, author: chatAgent });
  const turn = turnSummary(dir, 'c1', 1)!;
  assert.deepEqual(turn.detours, [{ op: 'elabora_overview', family: 'module', after: 'write' }]);
  assert.equal(turn.succeeded, true);
});

test('elabora history --chats says each turn and the verdict', async () => {
  const dir = course();
  turns(dir, [{ refused: ['generators/a.mjs'] }, {}]);
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try {
    assert.equal(await main(['history', dir, '--chats']), 0);
  } finally {
    console.log = log;
  }
  const text = printed.join('\n');
  assert.match(text, /"Demande 0" · 1 change\(s\) · end · turn 1 of c1/);
  assert.match(text, /refused write generators\/a\.mjs → no Elabora operation after it/);
  assert.match(text, /1 turn\(s\) of 2 hit a refusal \(50 %\)/);
  assert.match(text, /Too few turns to judge/);
});

// ── the engine ───────────────────────────────────────────────────────

test('engine: a turn\'s batch stays open through the author\'s changes and closes when the turn ends', async () => {
  const dir = course();
  const session = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0, batchIdleMs: 200 });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  const { mark } = await session.mark('Change les titres', session.author, 'c1');
  await session.run('update_screen', { id: 'chemin', title: 'Titre de l\'agent' }, chatAgent);
  await session.run('update_screen', { id: 'accueil', title: 'Titre de l\'auteur' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(session.openBatch, mark.id, 'neither the author\'s change nor the idle time closed it');
  await session.run('update_screen', { id: 'chemin', title: 'Titre d\'un autre agent' }, otherAgent);
  await session.run('update_screen', { id: 'chemin', title: 'Second titre de l\'agent' }, chatAgent);
  assert.equal(events.filter((event) => event.type === 'batchClosed').length, 0, 'another agent\'s work did not close the turn');
  assert.equal(session.openBatch, mark.id);

  const ended = await session.endTurn({ turn: mark.id });
  assert.deepEqual(ended, { batch: mark.id, changes: 2 });
  assert.equal(session.openBatch, null);
  const closed = events.filter((event): event is Extract<EngineEvent, { type: 'batchClosed' }> => event.type === 'batchClosed');
  assert.deepEqual(closed.map((event) => [event.batch, event.reason]), [[mark.id, 'turn']]);
  const undone = await session.undoBatch(mark.id);
  assert.equal(undone.undone.length, 2);
  assert.equal(session.readScreen('accueil').data.title, 'Titre de l\'auteur', 'the author\'s change is kept');

  // A session opened during a turn takes it up; once its end is in the transcript, it does not.
  const open = await session.mark('Encore', session.author, 'c1');
  await session.run('update_screen', { id: 'chemin', title: 'Pendant le tour' }, chatAgent);
  await session.close();
  const again = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0, batchIdleMs: 200 });
  sessions.push(again);
  assert.equal(again.openBatch, open.mark.id);
  await again.run('update_screen', { id: 'accueil', title: 'Encore l\'auteur' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(again.openBatch, open.mark.id, 'still open after the author\'s change and the idle time');
  appendChat(dir, 'c1', { type: 'turn-end', turn: 2, reason: 'end', batch: open.mark.id, ms: 10, cost: 0 });
  await again.close();
  const reopened = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0, batchIdleMs: 200 });
  sessions.push(reopened);
  await reopened.run('update_screen', { id: 'chemin', title: 'Après le tour' }, chatAgent);
  // The idle time (200 ms) starts again at each change the watcher reports: a loaded runner reports them late.
  for (let waited = 0; reopened.openBatch !== null && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(reopened.openBatch, null, 'an ended turn closes after its idle time like any batch');
  await reopened.close();
  const session2 = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 });
  sessions.push(session2);

  // A turn where the agent only answered: no batch.
  const quiet = await session2.mark('Une question', session2.author, 'c1');
  assert.deepEqual(await session2.endTurn({ turn: quiet.mark.id }), { batch: null, changes: 0 });
  await assert.rejects(session2.endTurn({ turn: 'nope' }), /No turn nope/);
});
