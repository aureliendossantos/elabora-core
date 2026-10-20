import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffReports } from '@elabora/core/update-impact';
import type { UpdateReport } from '@elabora/core/update-impact';
import { createMcpServer } from '@elabora/cli/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { copyExample } from '../helpers.ts';
import { build } from '@elabora/node/build';
import * as edit from '@elabora/node/edit';

const readReport = (file: string): UpdateReport => JSON.parse(fs.readFileSync(file, 'utf8'));

// The JSON body of a tool result (its first content is the text).
async function callJSON(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: 'text'; text: string }[];
  return JSON.parse(first.text);
}

test('diff: adding a screen keeps learner progress; losing the lock breaks it', async () => {
  const dir = copyExample();
  const v1 = await build(dir, { profiles: ['docebo', '360learning'], out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-d1-')) });
  edit.createScreen(dir, { id: 'complement', title: 'Complément', covers: ['ITEM-2'], after: 'chemin' });
  const v2 = await build(dir, { profiles: ['docebo', '360learning'], out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-d2-')) });
  assert.ok(v1.ok && v2.ok);
  const d = diffReports(readReport(v1.reportPath), readReport(v2.reportPath));
  assert.equal(d.manifest.sameStructure, true);
  assert.equal(d.learnerState.resume, 'kept');
  assert.equal(d.perProfile.find((p) => p.profile === 'docebo')?.verdict, 'safe');
  assert.equal(d.perProfile.find((p) => p.profile === '360learning')?.verdict, 'progress-lost');
  fs.rmSync(path.join(dir, 'elabora.lock.json'));
  edit.createScreen(dir, { id: 'intro-bis', title: 'Intro bis', covers: ['ITEM-1'], position: 0, section: 'decouvrir' });
  const v3 = await build(dir, { profiles: ['docebo'], out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-d3-')) });
  assert.ok(v3.ok);
  assert.equal(diffReports(readReport(v1.reportPath), readReport(v3.reportPath)).learnerState.resume, 'broken');
});

test('MCP: tools are listed with annotations; edits return diagnostics; read-only hides writes', async () => {
  const dir = copyExample();
  const connect = async (opts?: { readOnly?: boolean }) => {
    const server = createMcpServer(dir, opts);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    return client;
  };
  const client = await connect();
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 25);
  assert.equal(tools.find((t) => t.name === 'elabora_validate')?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === 'elabora_remove_block')?.annotations?.destructiveHint, true);
  assert.ok(!tools.some((t) => /plan_approve|apply_change/.test(t.name)), 'no tool approves the plan');
  const body = await callJSON(client, 'elabora_update_block', { block: 'chemin-intro', props: { markdown: 'Nouveau texte.' } });
  assert.equal(body.ok, true);
  const bad = await client.callTool({ name: 'elabora_get_screen', arguments: { id: 'Not An Id' } });
  assert.equal(bad.isError, true);
  // Components through MCP: list, fork, read, duplicate.
  const list: { type: string; behavior?: string; forkable?: boolean }[] = await callJSON(client, 'elabora_list_components', {});
  assert.ok(list.some((c) => c.type === 'quiz' && c.behavior === 'quiz' && c.forkable));
  const fork = await callJSON(client, 'elabora_fork_component', { component: 'callout', id: 'note-card' });
  assert.equal(fork.component, 'note-card');
  const got = await callJSON(client, 'elabora_get_component', { id: 'note-card' });
  assert.deepEqual(got.lineage, ['note-card', 'callout']);
  assert.match(got.template, /t-callout/);
  const dup = await callJSON(client, 'elabora_duplicate_block', { block: 'chemin-intro' });
  assert.equal(dup.block, 'chemin-intro-copy');
  const ro = await connect({ readOnly: true });
  assert.ok((await ro.listTools()).tools.every((t) => t.annotations?.readOnlyHint));
});
