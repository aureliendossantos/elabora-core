import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '@elabora/cli/mcp';
import { stopLookServer } from '@elabora/node/look-client';
import { copyExample, readJSON } from '../helpers.ts';

// A shell-free client stays connected to the source course for the entire language workflow.
test('agent workflow: translate, see, check, package and test a language through one MCP connection', { timeout: 180000 }, async () => {
  const dir = copyExample();
  const server = createMcpServer(dir);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'plugin-agent', version: '1' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result.content).slice(0, 1500));
    return result;
  };
  const json = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    const first = (result.content as { type: string; text?: string }[])[0];
    assert.equal(first.type, 'text');
    return JSON.parse(first.text!);
  };
  try {
    const table = await json('elabora_translation_table', { language: 'en' });
    await json('elabora_translate_text', { language: 'en', texts: table.rows.map((row: { unit: string; source: string }) => ({ unit: row.unit, target: row.unit === 'screen.chemin.title' ? 'The print path' : row.source })) });
    assert.equal((await json('elabora_translation_status', { language: 'en' })).languages[0].ready, true);
    assert.ok(((await call('elabora_look', { language: 'en', screen: 'chemin' })).content as { type: string }[]).some((part) => part.type === 'image'));
    assert.equal((await json('elabora_validate', { language: 'en' })).ok, true);
    const fit = await json('elabora_check_fit', { language: 'en' });
    assert.equal(fit.language, 'en');
    assert.ok(((await call('elabora_preview_screenshot', { language: 'en', screen: 'chemin' })).content as { type: string; mimeType?: string }[]).some((part) => part.type === 'image' && part.mimeType === 'image/png'));
    const built = await json('elabora_build', { language: 'en', profiles: ['unknown'] });
    assert.equal(path.dirname(built.zip), path.join(dir, 'dist'));
    const tested = await json('elabora_test_package', { language: 'en', profiles: ['unknown'], modes: ['iframe'] });
    assert.equal(tested.ok, true);
    assert.equal(tested.language, 'en');
    assert.ok(tested.runs.length > 0);
    assert.equal(readJSON(dir, 'course.json').language, 'fr');
    assert.deepEqual(fs.readdirSync(path.join(dir, '.elabora', 'translations')), []);
  } finally {
    await stopLookServer(dir);
    await client.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
