import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpServer } from '@elabora/cli/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ROOT, copyExample } from '../helpers.ts';
import { callAgentTool } from '@elabora/cli';

// The folders a host gives the MCP server: one course, several, none of them a course, or no folder
// at all (the courses Elabora knows, as the Claude extension serves them).
async function connect(dirs: string | string[]) {
  const server = createMcpServer(dirs, { readOnly: true });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}
const body = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as { text: string }[])[0]!.text);

test('MCP outside a course: the docs, skills and library only, and how to reach a course', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-nocourse-'));
  try {
    const client = await connect(empty);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['elabora_agent_guide', 'elabora_docs', 'elabora_projects_list', 'elabora_projects_path', 'elabora_templates']);
    assert.match(client.getInstructions() ?? '', /started outside a course: .* holds no Elabora course/);
    assert.match(client.getInstructions() ?? '', /elabora_projects_list gives the author's courses/);
    const { resources } = await client.listResources();
    assert.ok(resources.some((resource) => resource.uri === 'elabora://skills/elabora-course-authoring'));
    assert.ok(!resources.some((resource) => resource.uri.includes('AGENTS.md')));
    const docs = await client.callTool({ name: 'elabora_docs', arguments: {} });
    assert.ok(!docs.isError);
    assert.equal((await client.callTool({ name: 'elabora_overview', arguments: {} })).isError, true);
    await client.close();
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('MCP on several courses: each course operation takes course, by name or folder; a folder of courses counts', async () => {
  const a = copyExample();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-courses-'));
  const b = path.join(parent, 'second');
  fs.cpSync(a, b, { recursive: true });
  const course = JSON.parse(fs.readFileSync(path.join(b, 'course.json'), 'utf8'));
  try {
    const client = await connect([a, parent, path.join(parent, 'gone')]);
    const { tools } = await client.listTools();
    const overview = tools.find((tool) => tool.name === 'elabora_overview')!;
    assert.deepEqual(overview.inputSchema.required, ['course']);
    assert.equal(tools.find((tool) => tool.name === 'elabora_docs')!.inputSchema.properties?.course, undefined);
    // Both copies have the same course id: the second is named apart.
    const served = body(await client.callTool({ name: 'elabora_courses', arguments: {} }));
    assert.deepEqual(served.map((each: { name: string; folder: string }) => [each.name, each.folder]), [[course.id, a], [`${course.id}-2`, b]]);
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /serving 2 courses/);
    assert.match(instructions, new RegExp(`Not found, so not served: ${path.join(parent, 'gone').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    const byName = await client.callTool({ name: 'elabora_get_plan', arguments: { course: `${course.id}-2` } });
    const byFolder = await client.callTool({ name: 'elabora_get_plan', arguments: { course: a } });
    assert.ok(!byName.isError && !byFolder.isError);
    const none = await client.callTool({ name: 'elabora_get_plan', arguments: {} });
    assert.equal(none.isError, true);
    assert.match(body(none).error, /No course given: course is one of/);
    const { resources } = await client.listResources();
    assert.deepEqual(resources.filter((resource) => resource.uri.endsWith('AGENTS.md')).map((resource) => resource.uri), [`elabora://course/${course.id}/AGENTS.md`, `elabora://course/${course.id}-2/AGENTS.md`]);
    const rules = await client.readResource({ uri: `elabora://course/${course.id}-2/AGENTS.md` });
    assert.equal((rules.contents[0] as { text: string }).text, fs.readFileSync(path.join(b, 'AGENTS.md'), 'utf8'));
    await client.close();
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('MCP on one course: the tools as they are, without course', async () => {
  const dir = copyExample();
  try {
    const client = await connect(dir);
    const { tools } = await client.listTools();
    assert.ok(!tools.some((tool) => tool.name === 'elabora_courses' || 'course' in (tool.inputSchema.properties ?? {})));
    assert.match(client.getInstructions() ?? '', /scoped to one course/);
    assert.ok(!(await client.callTool({ name: 'elabora_get_plan', arguments: {} })).isError);
    await client.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP in a folder that holds one course: served as it is; its rules are brought up to date when an operation first works on it', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-parent-'));
  const dir = path.join(parent, 'module');
  const source = copyExample();
  fs.cpSync(source, dir, { recursive: true });
  fs.rmSync(source, { recursive: true, force: true });
  const rules = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(rules, fs.readFileSync(rules, 'utf8').replace(/revision=\d+/, 'revision=1'));
  const before = fs.readFileSync(rules, 'utf8');
  try {
    const server = createMcpServer(parent);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
    assert.match(client.getInstructions() ?? '', new RegExp(`scoped to one course: ${dir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    assert.equal(fs.readFileSync(rules, 'utf8'), before);
    assert.ok(!(await client.callTool({ name: 'elabora_get_plan', arguments: {} })).isError);
    assert.notEqual(fs.readFileSync(rules, 'utf8'), before);
    await client.close();
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('outside a course: a folder that is gone is an error when it is the only one; the library and docs answer without a course', async () => {
  assert.throws(() => createMcpServer(path.join(os.tmpdir(), 'elabora-no-such-folder')), /is not a folder this server can read/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-nocourse-'));
  try {
    const result = await callAgentTool('elabora_projects_path', {}, { root: empty, author: { kind: 'agent' } });
    assert.ok(!result.isError);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// Elabora's own data, in a folder of the test: its library (a course in it) and the app's settings
// (elabora-app.json, the folders it opened in place).
function elaboraData(opened: string[]) {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-local-'));
  const library = path.join(local, 'Library');
  fs.mkdirSync(library);
  const inLibrary = path.join(library, 'a-first');
  const source = copyExample();
  fs.cpSync(source, inLibrary, { recursive: true });
  fs.rmSync(source, { recursive: true, force: true });
  fs.writeFileSync(path.join(local, 'elabora-app.json'), JSON.stringify({ folders: opened, autoUpdate: true }));
  return { local, library, inLibrary };
}

// The environment of one test, put back after it.
async function withEnv(change: Record<string, string | undefined>, run: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(change).map((key) => [key, process.env[key]]));
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  set(change);
  try { await run(); } finally { set(before); }
}

test('MCP with no folder: the courses Elabora knows, its library and the folders the app opened, read again at each call', async () => {
  const outside = copyExample();
  const { local, library, inLibrary } = elaboraData([outside, path.join(os.tmpdir(), 'elabora-opened-then-gone')]);
  const id = JSON.parse(fs.readFileSync(path.join(outside, 'course.json'), 'utf8')).id;
  try {
    await withEnv({ ELABORA_LOCAL_DATA_DIR: local, ELABORA_LIBRARY: undefined }, async () => {
      const client = await connect([]);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.find((tool) => tool.name === 'elabora_overview')!.inputSchema.required, ['course']);
      assert.match(client.getInstructions() ?? '', /serving the courses of the Elabora app on this computer/);
      const courses = () => client.callTool({ name: 'elabora_courses', arguments: {} }).then((result) => body(result).map((each: { name: string; folder: string }) => [each.name, each.folder]));
      assert.deepEqual(await courses(), [[id, inLibrary], [`${id}-2`, outside]]);
      // A course created after the start (in the library, before the first one in its order) is
      // served at the next call, under a name of its own: the others keep theirs.
      const added = path.join(library, '0-added');
      fs.cpSync(inLibrary, added, { recursive: true });
      assert.deepEqual(await courses(), [[`${id}-3`, added], [id, inLibrary], [`${id}-2`, outside]]);
      assert.ok(!(await client.callTool({ name: 'elabora_get_plan', arguments: { course: `${id}-3` } })).isError);
      assert.ok(!(await client.callTool({ name: 'elabora_get_plan', arguments: { course: `${id}-2` } })).isError);
      const { resources } = await client.listResources();
      assert.ok(resources.some((resource) => resource.uri === `elabora://course/${id}-3/AGENTS.md`));
      await client.close();
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(local, { recursive: true, force: true });
  }
});

test('MCP with no folder, Elabora never opened here: one sentence says what to do, and its courses come once it is', async () => {
  const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-none-')), 'Elabora');
  try {
    await withEnv({ ELABORA_LOCAL_DATA_DIR: local, ELABORA_LIBRARY: undefined }, async () => {
      const client = await connect([]);
      assert.match(client.getInstructions() ?? '', /Elabora has not been opened on this computer yet: ask the author to open it once/);
      const missing = await client.callTool({ name: 'elabora_courses', arguments: {} });
      assert.equal(missing.isError, true);
      assert.match(body(missing).error, /^Elabora has not been opened on this computer yet/);
      assert.ok(!(await client.callTool({ name: 'elabora_docs', arguments: {} })).isError);
      fs.mkdirSync(path.join(local, 'Library'), { recursive: true });
      assert.deepEqual(body(await client.callTool({ name: 'elabora_courses', arguments: {} })), []);
      assert.match(body(await client.callTool({ name: 'elabora_get_plan', arguments: { course: 'x' } })).error, /there is no course yet: elabora_projects_create makes one/);
      await client.close();
    });
  } finally {
    fs.rmSync(path.dirname(local), { recursive: true, force: true });
  }
});

// The Claude extension goes through its launcher, which finds the app and starts its server with no
// folder: installing it asks nothing. Folders given to the launcher are served instead.
test('the Claude extension asks nothing: its launcher starts elabora mcp on Elabora\'s courses, or on the folders it is given', async () => {
  const dir = copyExample();
  const { local } = elaboraData([]);
  const start = async (args: string[]) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'plugins/claude-desktop/server/launch.cjs'), ...args], env: { ...process.env as Record<string, string>, ELABORA_COMMAND: path.join(ROOT, 'bin/elabora.js'), ELABORA_LOCAL_DATA_DIR: local }, stderr: 'ignore' });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(transport);
    return client;
  };
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/claude-desktop/manifest.json'), 'utf8'));
    assert.equal(manifest.user_config, undefined);
    assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/server/launch.cjs']);
    const known = await start([]);
    assert.match(known.getInstructions() ?? '', /serving the courses of the Elabora app on this computer/);
    assert.equal(body(await known.callTool({ name: 'elabora_courses', arguments: {} })).length, 1);
    await known.close();
    const given = await start([dir]);
    assert.match(given.getInstructions() ?? '', /scoped to one course/);
    assert.ok((await given.listTools()).tools.some((tool) => tool.name === 'elabora_overview'));
    await given.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(local, { recursive: true, force: true });
  }
});

// Claude's built-in Node.js, its default for an extension, runs the launcher in a host whose own
// stdin and stdout are not the connection (test/fixtures/claude-node-host.cjs): the launcher passes
// the server's input and output through process.stdin and process.stdout, which it gave to the
// server's process before, so that Claude saw the server close right after initialize.
class HostTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  stderr = '';
  private host?: ChildProcess;
  private buffer = '';
  private args: string[];
  private env: NodeJS.ProcessEnv;
  constructor(args: string[], env: NodeJS.ProcessEnv) {
    this.args = args;
    this.env = env;
  }
  async start() {
    const host = spawn(process.execPath, [path.join(ROOT, 'test/fixtures/claude-node-host.cjs'), ...this.args], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: this.env });
    this.host = host;
    host.stderr!.on('data', (chunk) => { this.stderr += chunk; });
    host.on('message', (message: { type: string; content: string }) => {
      if (message.type !== 'stdout') return;
      this.buffer += message.content;
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (line) this.onmessage?.(JSON.parse(line));
      }
    });
    host.on('exit', () => this.onclose?.());
  }
  async send(message: JSONRPCMessage) {
    this.host?.send({ type: 'stdin', data: JSON.stringify(message) });
  }
  async close() {
    this.host?.kill();
  }
}

test('the Claude extension\'s launcher serves through Claude\'s built-in Node.js, whose stdin and stdout are not the process\'s', async () => {
  const { local } = elaboraData([]);
  const transport = new HostTransport([path.join(ROOT, 'plugins/claude-desktop/server/launch.cjs')], { ...process.env, ELABORA_COMMAND: path.join(ROOT, 'bin/elabora.js'), ELABORA_LOCAL_DATA_DIR: local });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(transport).catch((error) => assert.fail(`${error.message}\n${transport.stderr}`));
    assert.match(client.getInstructions() ?? '', /serving the courses of the Elabora app on this computer/);
    assert.equal(body(await client.callTool({ name: 'elabora_courses', arguments: {} })).length, 1);
  } finally {
    await client.close();
    fs.rmSync(local, { recursive: true, force: true });
  }
});
