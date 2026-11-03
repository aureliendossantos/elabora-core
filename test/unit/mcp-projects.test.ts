import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpServer } from '@elabora/cli/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appLanguage, exportProject, newCourseId } from '@elabora/node/library/index';
import { readJournal } from '@elabora/node/journal/index';
import { ROOT } from '../helpers.ts';

// Agents start modules in the app's library (Claude's chat and Cowork have no shell): a new module,
// blank or from a template, a copy, an import. Served with no folder, the server serves the new
// module at the next call, under the name it returns.

async function connect(options: { readOnly?: boolean } = {}) {
  const server = createMcpServer([], options);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'claude-ai', version: '1' });
  await client.connect(clientSide);
  return client;
}
const body = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as { text: string }[])[0]!.text);

// An empty library of Elabora's, in a folder of the test, for the length of `run`.
async function withLibrary(env: Record<string, string | undefined>, run: (library: string) => Promise<void>) {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-local-'));
  const library = path.join(local, 'Library');
  fs.mkdirSync(library);
  const change: Record<string, string | undefined> = { ELABORA_LOCAL_DATA_DIR: local, ELABORA_LIBRARY: undefined, ...env };
  const before = Object.fromEntries(Object.keys(change).map((key) => [key, process.env[key]]));
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  set(change);
  try {
    await run(library);
  } finally {
    set(before);
    fs.rmSync(local, { recursive: true, force: true });
  }
}

test('MCP with no folder: a module created in the empty library is served at the next call, and its first work shows as the agent\'s', async () => {
  await withLibrary({ ELABORA_APP_LOCALE: 'fr' }, async (library) => {
    const client = await connect();
    assert.match(client.getInstructions() ?? '', /No course yet: create one when the author asks/);
    assert.match(client.getInstructions() ?? '', /elabora_projects_create, then its whole draft plan and all its screens in one go/);
    const created = body(await client.callTool({ name: 'elabora_projects_create', arguments: { title: 'Sécurité incendie', request: 'Un module sur la sécurité\nincendie' } }));
    assert.equal(created.course, 'securite-incendie');
    assert.equal(created.courseId, 'securite-incendie');
    assert.equal(path.dirname(created.folder), library);
    assert.match(path.basename(created.folder), /^elabora-module-[2-9a-z]{6}$/);
    assert.deepEqual([created.language, created.languageFrom, created.template], ['fr', 'app', null]);
    assert.match(created.next, /elabora:\/\/course\/securite-incendie\/AGENTS\.md/);
    // The author's request in the course's notes for agents; the agent's mark labels its work.
    assert.match(fs.readFileSync(path.join(created.folder, 'AGENTS.md'), 'utf8'), /- Demande : « Un module sur la sécurité incendie »/);
    const [mark] = readJournal(created.folder);
    assert.deepEqual(mark && mark.type === 'mark' ? [mark.request, mark.author] : null, ['Un module sur la sécurité incendie', { kind: 'agent', name: 'claude-ai' }]);
    // The existing tools read and write it, by its name.
    assert.ok(!(await client.callTool({ name: 'elabora_get_plan', arguments: { course: created.course } })).isError);
    const renamed = await client.callTool({ name: 'elabora_update_course', arguments: { course: created.course, description: 'Les bons gestes.' } });
    assert.ok(!renamed.isError, JSON.stringify(body(renamed)));
    const history = body(await client.callTool({ name: 'elabora_history', arguments: { course: created.course } }));
    assert.equal(JSON.stringify(history).includes('Un module sur la sécurité incendie'), true);
    await client.close();
  });
});

test('MCP: templates by name, a module from one in the language asked, a course id numbered when taken; a read-only server creates nothing', async () => {
  await withLibrary({ ELABORA_APP_LOCALE: 'en' }, async () => {
    const client = await connect();
    const templates = body(await client.callTool({ name: 'elabora_templates', arguments: {} }));
    const organic = templates.find((template: { id: string }) => template.id === 'organic');
    assert.deepEqual([organic.name.fr, organic.languages], ['Organique', ['en', 'fr']]);
    assert.equal(typeof organic.summary.fr, 'string');
    const first = body(await client.callTool({ name: 'elabora_projects_create', arguments: { title: 'Onboarding' } }));
    assert.deepEqual([first.course, first.language, first.languageFrom], ['onboarding', 'en', 'app']);
    const second = body(await client.callTool({ name: 'elabora_projects_create', arguments: { title: 'Onboarding', template: 'organic', language: 'fr' } }));
    assert.deepEqual([second.courseId, second.course, second.template, second.language, second.languageFrom], ['onboarding-2', 'onboarding-2', 'organic', 'fr', 'given']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(second.folder, 'course.json'), 'utf8')).language, 'fr');
    const unknown = await client.callTool({ name: 'elabora_projects_create', arguments: { title: 'X', template: 'nope' } });
    assert.equal(unknown.isError, true);
    assert.match(body(unknown).error, /No template "nope"/);
    assert.equal((await client.callTool({ name: 'elabora_projects_create', arguments: { title: '' } })).isError, true);
    await client.close();
    const reading = await connect({ readOnly: true });
    const names = (await reading.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('elabora_templates') && !names.includes('elabora_projects_create') && !names.includes('elabora_import'));
    await reading.close();
  });
});

test('MCP: a copy of a module, an Elabora folder or archive imported; an archive of a course the library holds imports nothing until copy', async () => {
  await withLibrary({ ELABORA_APP_LOCALE: 'fr' }, async (library) => {
    const client = await connect();
    const created = body(await client.callTool({ name: 'elabora_projects_create', arguments: { title: 'Gestes' } }));
    const copy = body(await client.callTool({ name: 'elabora_projects_duplicate', arguments: { id: created.id, title: 'Gestes (copie)' } }));
    assert.deepEqual([copy.courseId, copy.title, copy.course], ['gestes', 'Gestes (copie)', 'gestes-2']);
    assert.notEqual(copy.folder, created.folder);
    const byFolder = body(await client.callTool({ name: 'elabora_projects_duplicate', arguments: { id: created.folder } }));
    assert.deepEqual([byFolder.courseId, byFolder.title], ['gestes', 'Gestes']);
    const relative = await client.callTool({ name: 'elabora_import', arguments: { file: 'examples/diagnostic-reseau' } });
    assert.match(body(relative).error, /is not an absolute path/);
    const folder = body(await client.callTool({ name: 'elabora_import', arguments: { file: path.join(ROOT, 'examples', 'diagnostic-reseau') } }));
    assert.equal(folder.kind, 'elabora-folder');
    assert.equal(path.dirname(folder.folder), library);
    assert.ok(folder.course);
    const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-archive-')), 'gestes.elabora');
    try {
      await exportProject(created.folder, archive);
      const refused = await client.callTool({ name: 'elabora_import', arguments: { file: archive } });
      assert.equal(refused.isError, true);
      assert.match(body(refused).error, /holds the course gestes already: nothing imported/);
      assert.equal(body(refused).existing.length, 3);
      const again = body(await client.callTool({ name: 'elabora_import', arguments: { file: archive, copy: true } }));
      assert.deepEqual([again.kind, again.courseId], ['elabora-archive', 'gestes']);
      const titled = await client.callTool({ name: 'elabora_import', arguments: { file: archive, title: 'Autre' } });
      assert.match(body(titled).error, /are for Storyline and Rise modules/);
    } finally {
      fs.rmSync(path.dirname(archive), { recursive: true, force: true });
    }
    await client.close();
  });
});

test('a new module\'s course id and language: the title\'s id, numbered when taken; the app\'s language', async () => {
  await withLibrary({ ELABORA_APP_LOCALE: 'fr' }, async () => {
    assert.equal(newCourseId('L’été « 2026 » !'), 'l-ete-2026');
    assert.equal(newCourseId('2026'), 'module-2026');
    assert.equal(newCourseId('!!!'), 'module');
    assert.equal(appLanguage(), 'fr');
    process.env.ELABORA_APP_LOCALE = 'en';
    assert.equal(appLanguage(), 'en');
    delete process.env.ELABORA_APP_LOCALE;
    assert.ok(['fr', 'en'].includes(appLanguage()));
  });
});
