import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openProject } from '@elabora/engine';
import type { EngineEvent, Session } from '@elabora/engine';
import { createMcpServer } from '@elabora/cli/mcp';
import { callAgentTool, TOOLS } from '@elabora/cli';
import { GROUPS, main } from '@elabora/cli/main';
import { COMMAND_ACTIVITY, TOOL_ACTIVITY, commandPlace, toolPlace } from '@elabora/cli/activity';
import { ACTIVITY_FAMILIES, activityPath, readActivity, recordActivity } from '@elabora/node/activity';
import type { ActivityEntry } from '@elabora/node/activity';
import { readJournal } from '@elabora/node/journal/index';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { copyExample } from '../helpers.ts';

// What agents do in a course, said while they work (reports/chat-agentique, phase 1): every tool and
// command has its family, an agent's operations write their start and end next to the journal, a
// person's do not, the session sends what is appended, and ELABORA_AUTHOR names the MCP's writer.

const temporary: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) await session.close().catch(() => {});
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});
const course = () => { const dir = copyExample(); temporary.push(dir); return dir; };
const agent = { kind: 'agent', name: 'claude-code' } as const;

test('every tool and every command has its family, and nothing else is named', () => {
  const tools = TOOLS.map((tool) => tool.name);
  assert.deepEqual(tools.filter((name) => !(name in TOOL_ACTIVITY)), [], 'tools without a family');
  assert.deepEqual(Object.keys(TOOL_ACTIVITY).filter((name) => !tools.includes(name)), [], 'families of no tool');
  const commands = GROUPS.flatMap((group) => group.commands.map((command) => command.name));
  assert.deepEqual(commands.filter((name) => !(name in COMMAND_ACTIVITY)), [], 'commands without a family');
  assert.deepEqual(Object.keys(COMMAND_ACTIVITY).filter((name) => !commands.includes(name)), [], 'families of no command');
  for (const family of [...Object.values(TOOL_ACTIVITY), ...Object.values(COMMAND_ACTIVITY)]) if (family) assert.ok(ACTIVITY_FAMILIES.includes(family), family);
});

test('where an operation works: ids only, never the course\'s text', () => {
  assert.deepEqual(toolPlace('elabora_look', { screen: 'accueil', select: 'h1' }), { screen: 'accueil' });
  assert.deepEqual(toolPlace('elabora_update_screen', { id: 'chemin', title: 'Un long titre' }), { screen: 'chemin' });
  assert.deepEqual(toolPlace('elabora_update_block', { id: 'consigne', props: { text: 'x' } }), {});
  assert.deepEqual(toolPlace('elabora_check_fit', { screens: ['accueil', 'chemin'] }), { screen: 'accueil' });
  assert.deepEqual(toolPlace('elabora_docs', { page: 'skills/elabora-narration' }), { page: 'skills/elabora-narration' });
  assert.deepEqual(toolPlace('elabora_translate_text', { language: 'en', texts: [] }), { language: 'en' });
  assert.deepEqual(commandPlace('look', ['.', '--screen', 'chemin']), { screen: 'chemin' });
  assert.deepEqual(commandPlace('screenshot', ['--screen=accueil', '--language', 'en']), { screen: 'accueil', language: 'en' });
  assert.deepEqual(commandPlace('docs', ['format/blocks']), { page: 'format/blocks' });
});

test('an agent\'s tool says when it starts and ends, a person\'s says nothing', async () => {
  const dir = course();
  const read = await callAgentTool('elabora_get_screen', { id: 'accueil' }, { root: dir, author: agent });
  assert.ok(!read.isError);
  const failed = await callAgentTool('elabora_get_screen', { id: 'nowhere' }, { root: dir, author: agent });
  assert.ok(failed.isError);
  await callAgentTool('elabora_get_screen', { id: 'chemin' }, { root: dir, author: { kind: 'human' } });
  const entries = readActivity(dir).slice(0, 4);
  assert.deepEqual(entries.map((entry) => [entry.phase, entry.op, entry.family, entry.screen, entry.ok]), [
    ['start', 'elabora_get_screen', 'screen', 'accueil', undefined], ['end', 'elabora_get_screen', 'screen', 'accueil', true],
    ['start', 'elabora_get_screen', 'screen', 'nowhere', undefined], ['end', 'elabora_get_screen', 'screen', 'nowhere', false]
  ]);
  assert.equal(entries[0]!.id, entries[1]!.id);
  assert.notEqual(entries[0]!.id, entries[2]!.id);
  assert.deepEqual(entries[0]!.author, agent);
  // A block's tool: the screen its edit reports, at the end.
  await callAgentTool('elabora_update_block', { block: 'chemin-intro', props: { markdown: 'Bonjour.' } }, { root: dir, author: agent });
  assert.deepEqual(readActivity(dir).slice(-2).map((entry) => [entry.phase, entry.family, entry.screen]), [['start', 'write-screen', undefined], ['end', 'write-screen', 'chemin']]);
  // Outside a course (the manual read from anywhere), nothing is written anywhere.
  const before = fs.readdirSync(process.cwd());
  await callAgentTool('elabora_docs', {}, { root: process.cwd(), author: agent });
  assert.deepEqual(fs.readdirSync(process.cwd()), before);
});

test('the command line: an agent\'s command says itself, a person\'s and tools call (said by its tool) once', async () => {
  const dir = course();
  const saved = process.env.ELABORA_AUTHOR;
  const log = console.log;
  console.log = () => {};
  try {
    process.env.ELABORA_AUTHOR = 'codex';
    assert.equal(await main(['history', dir]), 0);
    assert.equal(await main(['tools', 'call', 'elabora_get_plan', dir]), 0);
    process.env.ELABORA_AUTHOR = 'human';
    assert.equal(await main(['history', dir]), 0);
  } finally {
    console.log = log;
    if (saved === undefined) delete process.env.ELABORA_AUTHOR; else process.env.ELABORA_AUTHOR = saved;
  }
  assert.deepEqual(readActivity(dir).map((entry) => [entry.phase, entry.op, entry.family, entry.author.name, entry.ok ?? null]), [
    ['start', 'history', 'status', 'codex', null], ['end', 'history', 'status', 'codex', true],
    ['start', 'elabora_get_plan', 'plan', 'codex', null], ['end', 'elabora_get_plan', 'plan', 'codex', true]
  ]);
});

test('ELABORA_AUTHOR names the MCP\'s writer, else the name its client gives', async () => {
  const dir = course();
  const call = async (clientName: string, title: string) => {
    const server = createMcpServer(dir);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: clientName, version: '1' });
    await client.connect(clientSide);
    const result = await client.callTool({ name: 'elabora_update_screen', arguments: { id: 'accueil', title } });
    assert.ok(!result.isError, JSON.stringify(result.content));
    await client.close();
  };
  const saved = process.env.ELABORA_AUTHOR;
  try {
    delete process.env.ELABORA_AUTHOR;
    await call('claude-code', 'Premier titre');
    process.env.ELABORA_AUTHOR = 'agent:claude';
    await call('claude-code', 'Second titre');
  } finally {
    if (saved === undefined) delete process.env.ELABORA_AUTHOR; else process.env.ELABORA_AUTHOR = saved;
  }
  const writers = readJournal(dir).flatMap((entry) => (entry.type === 'change' && entry.command?.name === 'update_screen' ? [entry.author.name] : []));
  assert.deepEqual(writers, ['claude-code', 'claude']);
  assert.deepEqual(readActivity(dir).filter((entry) => entry.phase === 'end').map((entry) => entry.author.name), ['claude-code', 'claude']);
});

test('the file keeps its last day, half its size at most, once past its size', () => {
  const dir = course();
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const line = (at: string, index: number): ActivityEntry => ({ at, id: `id-${index}-${'x'.repeat(120)}`, phase: 'start', op: 'elabora_look', family: 'look', author: agent, screen: 'accueil' });
  for (let index = 0; index < 400; index++) recordActivity(dir, line(old, index));
  for (let index = 0; index < 1600; index++) recordActivity(dir, line(new Date().toISOString(), index));
  const kept = readActivity(dir, { limit: 5000 });
  assert.ok(kept.length <= 1600 && kept.length > 0, `${kept.length} lines`);
  assert.ok(kept.every((entry) => entry.at !== old), 'nothing older than a day');
  assert.ok(fs.statSync(activityPath(dir)).size <= 256 * 1024 + 4096);
});

test('the session sends what agents append, and gives what was there before', async () => {
  const dir = course();
  await callAgentTool('elabora_overview', {}, { root: dir, author: agent });
  const session = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  assert.deepEqual(session.activity().map((entry) => [entry.phase, entry.op]), [['start', 'elabora_overview'], ['end', 'elabora_overview']]);
  await callAgentTool('elabora_get_screen', { id: 'chemin' }, { root: dir, author: agent });
  const deadline = Date.now() + 10_000;
  const sent = () => events.flatMap((event) => (event.type === 'activity' ? event.entries : []));
  while (sent().filter((entry) => entry.op === 'elabora_get_screen').length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(sent().map((entry) => [entry.phase, entry.op, entry.family, entry.screen]), [['start', 'elabora_get_screen', 'screen', 'chemin'], ['end', 'elabora_get_screen', 'screen', 'chemin']]);
});
