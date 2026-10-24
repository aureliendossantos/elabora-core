import { test, beforeEach, type TestContext } from 'node:test';
import { resources } from '../resources.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as edit from '@elabora/node/edit';
import { addResource } from '@elabora/node/edit/resources';
import { validateDir } from '@elabora/node/project-reader';
import { ROOT, readJSON } from '../helpers.ts';
import { textPdf } from '../sources-fixtures.ts';
import { openProject } from '@elabora/engine';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '@elabora/cli/mcp';

// « Ajouter une ressource » (D58): any file copied into assets/resources/ and added to the player's
// resources in one journaled change; its title given, else the PDF's own, else its name; undone, the
// copy goes.

let outside: string;
beforeEach(t => { outside = resources(t as TestContext).tempDir('elabora-resource-files-'); });
const write = (name: string, content: Buffer | string) => { const file = path.join(outside, name); fs.writeFileSync(file, content); return file; };
const titled = (title: string) => Buffer.from(textPdf(['Page']).toString('latin1').replace('/Root 1 0 R >>', `/Root 1 0 R /Info 99 0 R >>`).replace('trailer', `99 0 obj\n<< /Title (${title}) >>\nendobj\ntrailer`), 'latin1');

test('a PDF is copied under a readable name, titled by its own title, in one change that undo takes back', (t) => {
  const dir = resources(t as TestContext).copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const pdf = write('Procédure_SUP-NET-04 (v2).pdf', titled('Procédure de diagnostic réseau'));
  const added = addResource(dir, { path: pdf });
  assert.equal(added.op, 'add_resource');
  assert.equal(added.path, 'assets/resources/procedure-sup-net-04-v2.pdf');
  assert.equal(added.titleFrom, 'pdf');
  assert.deepEqual(added.resource, { id: 'procedure-sup-net-04-v2', title: 'Procédure de diagnostic réseau', asset: 'resources/procedure-sup-net-04-v2.pdf' });
  assert.deepEqual(fs.readFileSync(path.join(dir, added.path)), fs.readFileSync(pdf));
  assert.deepEqual(readJSON(dir, 'course.json').resources.at(-1), added.resource);
  assert.ok(!validateDir(dir).diagnostics.some((d) => d.severity === 'error'));
  // The same content again: named, not copied; another entry.
  const again = addResource(dir, { path: pdf, title: 'La même, ailleurs' });
  assert.equal(again.reused, true);
  assert.equal(again.path, added.path);
  assert.equal(again.resource.id, 'procedure-sup-net-04-v2-2');
  assert.equal(again.titleFrom, 'given');
  // Undone: the entry goes; the first undo keeps the file the first entry names.
  edit.undo(dir);
  assert.equal(fs.existsSync(path.join(dir, added.path)), true);
  edit.undo(dir);
  assert.equal(fs.existsSync(path.join(dir, added.path)), false, 'the copy goes with its change');
  assert.equal(readJSON(dir, 'course.json').resources.length, 2);
});

test('any file: a name taken by another file, a spreadsheet titled by its name, a CSV kept byte for byte', (t) => {
  const dir = resources(t).copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  // A file named as one already there, with another content.
  const sheet = addResource(dir, { path: write('equipements-siege.csv', 'nom;adresse\nimprimante;10.0.0.4\n') });
  assert.equal(sheet.path, 'assets/resources/equipements-siege-2.csv');
  assert.equal(sheet.resource.title, 'equipements-siege');
  assert.equal(sheet.titleFrom, 'name');
  // Excel's French CSV is Windows-1252: not UTF-8, copied as bytes.
  const latin = Buffer.from('nom;télé\n', 'latin1');
  const legacy = addResource(dir, { path: write('Inventaire_2026.csv', latin), description: 'Export du tableur.' });
  assert.deepEqual(fs.readFileSync(path.join(dir, legacy.path)), latin);
  assert.equal(legacy.resource.title, 'Inventaire 2026');
  assert.equal(legacy.resource.description, 'Export du tableur.');
  const xlsx = addResource(dir, { path: write('Plan de charge.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])) });
  assert.equal(xlsx.path, 'assets/resources/plan-de-charge.xlsx');
  assert.equal(xlsx.resource.title, 'Plan de charge');
  // A PDF without a title of its own: its name.
  assert.equal(addResource(dir, { path: write('scan_0042.pdf', textPdf(['Scan'])) }).resource.title, 'scan 0042');
  assert.throws(() => addResource(dir, { path: path.join(outside, 'absent.pdf') }), /No file at/);
});

test('the engine runs add_resource as a change of the app', async (t) => {
  const dir = resources(t).copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const session = resources(t).own(await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 }), value => value.close());
  try {
    await session.flush();
    const pdf = write('Charte.pdf', titled('Charte informatique du groupe'));
    const result = await session.run('add_resource', { path: pdf }, { kind: 'human' });
    assert.deepEqual(result.files, ['assets/resources/charte.pdf', 'course.json']);
    assert.deepEqual((result.result as { resource: unknown }).resource, { id: 'charte', title: 'Charte informatique du groupe', asset: 'resources/charte.pdf' });
    const copied = session.readFile('assets/resources/charte.pdf');
    assert.equal(copied.kind, 'binary');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'assets/resources/charte.pdf')), fs.readFileSync(pdf));
  } finally {
    await session.close();
  }
});

test('elabora player --add-resource and elabora_player addResources', async (t) => {
  const dir = resources(t).copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const run = spawnSync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), 'player', dir, '--add-resource', write('Guide.pdf', textPdf(['Guide'])), '--title', 'Guide du technicien', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const printed = JSON.parse(run.stdout) as { added: { resource: { id: string; title: string } }[] };
  assert.deepEqual(printed.added.map((entry) => entry.resource), [{ id: 'guide', title: 'Guide du technicien', asset: 'resources/guide.pdf' }]);
  const refused = spawnSync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), 'player', dir, '--title', 'Sans fichier'], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  const server = resources(t).own(createMcpServer(dir), value => value.close());
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = resources(t).own(new Client({ name: 'test', version: '1' }), value => value.close());
  await client.connect(clientSide);
  const result = await client.callTool({ name: 'elabora_player', arguments: { addResources: [{ path: write('Annuaire.pdf', titled('Annuaire du support')) }], enable: ['display'] } });
  const body = JSON.parse((result.content as { text: string }[])[0].text) as { added: { resource: { title: string }; titleFrom: string; change: unknown }[]; change: unknown };
  assert.equal(body.added[0].resource.title, 'Annuaire du support');
  assert.equal(body.added[0].titleFrom, 'pdf');
  assert.ok(body.added[0].change && body.change, 'two changes: the resource, then the player');
  await client.close();
});
