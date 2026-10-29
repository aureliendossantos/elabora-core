import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpServer } from '@elabora/cli/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, copyExample } from '../helpers.ts';

// The folders a host gives the MCP server (a plugin starts it wherever a session opens; the Claude
// extension, on the folders the author picks): one course, several, or none.
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
    assert.deepEqual(names, ['elabora_agent_guide', 'elabora_docs', 'elabora_projects_list', 'elabora_projects_path']);
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

// The plugins start the installed elabora themselves (plugins/elabora/.mcp.json); the Claude extension
// goes through its launcher, which finds the app and passes the folders the author picked.
test('the Claude extension\'s launcher starts elabora mcp on the folders it is given', async () => {
  const dir = copyExample();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/claude-desktop/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/server/launch.cjs', '${user_config.courses}']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/elabora/.mcp.json'), 'utf8')).mcpServers.elabora, { command: 'elabora', args: ['mcp', '.'] });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'plugins/claude-desktop/server/launch.cjs'), dir], env: { ...process.env as Record<string, string>, ELABORA_COMMAND: path.join(ROOT, 'bin/elabora.js') }, stderr: 'ignore' });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(transport);
    assert.match(client.getInstructions() ?? '', /scoped to one course/);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'elabora_overview'));
    await client.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
