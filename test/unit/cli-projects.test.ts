import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '@elabora/cli/mcp';
import { readJournal } from '@elabora/node/journal/index';
import { ROOT, copyExample } from '../helpers.ts';

// `elabora projects`, `elabora export` and `elabora import` as people and agents call them, each case on a
// library of its own in a temp folder (ELABORA_LIBRARY): never the user's library.

const BIN = path.join(ROOT, 'bin/elabora.js');
const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};
const example = (name = 'diagnostic-reseau'): string => {
  const dir = copyExample(path.join(ROOT, 'examples', name));
  temporary.push(dir);
  return dir;
};
const freshLibrary = (): string => path.join(tempDir('elabora-cli-library-'), 'Library');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function elabora(library: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: { ...process.env, ELABORA_LIBRARY: library, ELABORA_DATA_DIR: '', ELABORA_AUTHOR: 'human', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}
async function ok(library: string, args: string[], env?: Record<string, string>): Promise<Run> {
  const run = await elabora(library, args, env);
  assert.equal(run.status, 0, `elabora ${args.join(' ')}\n${run.stdout}\n${run.stderr}`);
  return run;
}
async function json(library: string, args: string[]): Promise<any> {
  return JSON.parse((await ok(library, args)).stdout);
}

// Each case has its own library and folders: they run side by side (each spawns the command several times).
describe('elabora projects, export and import', { concurrency: true }, () => {
  test('elabora projects: create, list, path, rename, duplicate', async () => {
    const library = freshLibrary();
    assert.match((await ok(library, ['projects', 'list'])).stdout, /^No projects in the library /);
    assert.equal((await ok(library, ['projects', 'path'])).stdout, `${library}\n`);

    const created = await ok(library, ['projects', 'create', 'premiers-secours', '--title', 'Premiers secours', '--language', 'fr']);
    assert.match(created.stdout, /^✔ Created "Premiers secours" \(premiers-secours\) as project [0-9a-f]{8}\./);
    const [project] = (await json(library, ['projects', 'list', '--json'])).projects;
    assert.equal(project.title, 'Premiers secours');
    assert.equal(project.courseId, 'premiers-secours');
    assert.equal(path.dirname(project.path), library);
    assert.ok(project.validation);
    const listed = (await ok(library, ['projects', 'list'])).stdout;
    assert.ok(listed.includes(project.id.slice(0, 8)) && listed.includes(project.path) && listed.includes('premiers-secours · fr ·'), listed);

    // A project by the first characters of its id.
    assert.equal((await ok(library, ['projects', 'path', project.id.slice(0, 6)])).stdout, `${project.path}\n`);
    const unknown = await elabora(library, ['projects', 'path', 'ffff']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /^✘ No project "ffff" in the library/);

    assert.match((await ok(library, ['projects', 'rename', project.id.slice(0, 8), '--title', 'Gestes qui sauvent'])).stdout, /is now "Gestes qui sauvent"/);
    assert.equal(readJournal(project.path).filter((entry) => entry.type === 'change').length, 1, 'the rename is a journaled change');
    const duplicated = await ok(library, ['projects', 'duplicate', project.id, '--title', 'Gestes (copie)']);
    assert.match(duplicated.stdout, /^✔ Duplicated as project [0-9a-f]{8} \("Gestes \(copie\)"\)\./);
    const titles = (await json(library, ['projects', 'list', '--json'])).projects.map((p: { title: string }) => p.title).sort();
    assert.deepEqual(titles, ['Gestes (copie)', 'Gestes qui sauvent']);

    // Usage errors: exit code 2.
    assert.equal((await elabora(library, ['projects'])).status, 2);
    assert.equal((await elabora(library, ['projects', 'create', 'x'])).status, 2);
    assert.equal((await elabora(library, ['projects', 'path', '--move'])).status, 2);
    assert.equal((await elabora(library, ['projects', 'list', '--nope'])).status, 2);
  });

  test('elabora projects trash: trash, list, restore, empty', async () => {
    const library = freshLibrary();
    await ok(library, ['projects', 'create', 'jete', '--title', 'Jeté']);
    const [project] = (await json(library, ['projects', 'list', '--json'])).projects;
    assert.match((await ok(library, ['projects', 'trash', project.id.slice(0, 8)])).stdout, /^✔ Moved "Jeté" to the trash \(\d{8}T\d{9}Z-[0-9a-f-]{36}\)\./);
    assert.deepEqual((await json(library, ['projects', 'list', '--json'])).projects, []);
    const trashList = (await ok(library, ['projects', 'trash', 'list'])).stdout;
    const entry = /^ {2}(\S+)\n/.exec(trashList)![1];
    assert.match(trashList, /Jeté · jete · trashed .* · deleted for good from /);
    assert.match((await ok(library, ['projects', 'trash', 'restore', entry])).stdout, /^✔ Restored "Jeté" as project /);
    assert.equal((await json(library, ['projects', 'list', '--json'])).projects[0].id, project.id);
    await ok(library, ['projects', 'trash', project.id]);
    assert.equal((await ok(library, ['projects', 'trash', 'empty', '--older-than', '30'])).stdout, 'Nothing to delete.\n');
    assert.match((await ok(library, ['projects', 'trash', 'empty'])).stdout, /^✔ Deleted 1 project\(s\) from the trash for good/);
    assert.equal((await ok(library, ['projects', 'trash', 'list'])).stdout, 'The trash is empty.\n');
    // One entry at a time: delete takes the entry's name, for good.
    await ok(library, ['projects', 'create', 'autre', '--title', 'Autre']);
    const [other] = (await json(library, ['projects', 'list', '--json'])).projects;
    await ok(library, ['projects', 'trash', other.id]);
    const otherEntry = /^ {2}(\S+)\n/.exec((await ok(library, ['projects', 'trash', 'list'])).stdout)![1];
    assert.equal((await elabora(library, ['projects', 'trash', 'delete'])).status, 2);
    assert.equal((await elabora(library, ['projects', 'trash', 'delete', 'nope'])).status, 1);
    assert.match((await ok(library, ['projects', 'trash', 'delete', otherEntry])).stdout, /^✔ Deleted "Autre" from the trash for good \(.*\)\. This cannot be undone\.\n$/);
    assert.equal((await ok(library, ['projects', 'trash', 'list'])).stdout, 'The trash is empty.\n');
    assert.equal((await elabora(library, ['projects', 'trash', 'empty', '--older-than', 'soon'])).status, 2);
    assert.equal((await elabora(library, ['projects', 'trash', 'restore', 'nope'])).status, 1);
  });

  test('elabora export and import: archives, folders, existing courses', async () => {
    const library = freshLibrary();
    const dir = example();
    // The default archive is dist/<course-id>.elabora in the project.
    const exported = await ok(library, ['export', dir]);
    const archive = path.join(dir, 'dist', 'diagnostic-reseau.elabora');
    assert.match(exported.stdout, new RegExp(`^✔ Exported diagnostic-reseau to ${archive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+ KB, \\d+ files\\)\\.\n$`));
    assert.ok(fs.existsSync(archive));
    const elsewhere = path.join(tempDir('elabora-cli-archive-'), 'x.elabora');
    const result = await json(library, ['export', dir, '--out', elsewhere, '--history', '--json']);
    assert.equal(result.file, elsewhere);
    assert.equal(result.courseId, 'diagnostic-reseau');
    assert.ok(result.history);

    // New course: imported. Again: nothing imported, the existing project is named.
    const first = await ok(library, ['import', archive]);
    assert.match(first.stdout, /^✔ Imported "Diagnostiquer une panne d'impression réseau" \(diagnostic-reseau\) as project ([0-9a-f]{8})\.\n {2}\S+\n {2}✔ 0 error\(s\)/);
    const again = await elabora(library, ['import', archive]);
    assert.equal(again.status, 1);
    assert.equal(again.stdout, '');
    assert.match(again.stderr, /^✘ The library holds the course diagnostic-reseau already:\n {2}[0-9a-f]{8} {2}Diagnostiquer/);
    assert.match(again.stderr, /Nothing imported\. Run again with --replace \(its files go to the trash, its history stays\) or --copy/);
    const asked = await elabora(library, ['import', archive, '--json']);
    assert.equal(asked.status, 1);
    assert.equal(JSON.parse(asked.stdout).status, 'exists');

    const copy = JSON.parse((await ok(library, ['import', archive, '--copy', '--json'])).stdout);
    assert.equal(copy.status, 'imported');
    assert.equal(copy.mode, 'new');
    // Two projects hold the course now: --replace needs the id; given first, the archive still comes.
    const ambiguous = await elabora(library, ['import', archive, '--replace']);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /2 projects hold the course diagnostic-reseau: say which one to replace/);
    const replaced = await ok(library, ['import', '--replace', copy.project.id.slice(0, 8), archive]);
    assert.match(replaced.stdout, new RegExp(`^✔ Replaced project ${copy.project.id.slice(0, 8)} with "Diagnostiquer`));
    assert.match(replaced.stdout, /The replaced files are in the trash \(\S+\)\. Backup version [0-9a-f]+ holds the project as it was\./);
    assert.match((await ok(library, ['import', elsewhere, '--copy'])).stdout, /History: \d+ version\(s\) and \d+ month\(s\) of journal added\./);
    // --replace before the archive, without an id: the archive is its value.
    const single = freshLibrary();
    await ok(single, ['import', archive]);
    assert.match((await ok(single, ['import', '--replace', archive])).stdout, /^✔ Replaced project [0-9a-f]{8} with "Diagnostiquer/);

    // A folder: always a new project.
    const fromFolder = await ok(library, ['import', example('planetary-gearset')]);
    assert.match(fromFolder.stdout, /^✔ Imported "Planetary gearsets: one gearset, many ratios" \(planetary-gearset\) as project/);
    const folderReplace = await elabora(library, ['import', dir, '--replace']);
    assert.equal(folderReplace.status, 1);
    assert.match(folderReplace.stderr, /A folder is always imported as a new project/);
    assert.equal((await elabora(library, ['import', archive, '--replace', '--copy'])).status, 2);
    assert.equal((await elabora(library, ['import'])).status, 2);
    const damaged = path.join(tempDir('elabora-cli-damaged-'), 'x.elabora');
    fs.writeFileSync(damaged, 'not a zip');
    const refused = await elabora(library, ['import', damaged]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /is not an Elabora archive/);
    // Not inside the project, except under dist/.
    assert.equal((await elabora(library, ['export', dir, '--out', path.join(dir, 'x.elabora')])).status, 1);
    assert.equal((await json(library, ['projects', 'list', '--json'])).projects.length, 4);
  });

  test('elabora export and import: progress on stderr for large projects, results on stdout', async () => {
    const library = freshLibrary();
    const dir = example();
    fs.mkdirSync(path.join(dir, 'assets', 'video'), { recursive: true });
    const handle = fs.openSync(path.join(dir, 'assets', 'video', 'x.mp4'), 'w');
    for (let i = 0; i < 40; i++) fs.writeSync(handle, crypto.randomBytes(1024 * 1024));
    fs.closeSync(handle);
    const exported = await ok(library, ['export', dir, '--json']);
    assert.equal(JSON.parse(exported.stdout).courseId, 'diagnostic-reseau');
    assert.match(exported.stderr, /^Reading the files: \d+% \([\d.]+ MB of 40\.\d MB\)$/m);
    assert.match(exported.stderr, /^Writing the archive: 100% \([\d.]+ MB of [\d.]+ MB\)$/m);
    const imported = await ok(library, ['import', path.join(dir, 'dist', 'diagnostic-reseau.elabora'), '--json']);
    assert.equal(JSON.parse(imported.stdout).status, 'imported');
    assert.match(imported.stderr, /^Extracting and checking: 100% /m);
    // Small projects: nothing on stderr.
    const small = example('planetary-gearset');
    assert.equal((await ok(library, ['export', small])).stderr, '');
  });

  test('elabora projects path --set: another folder for the library, projects moved along', async () => {
    // The location setting lives in the user's Elabora settings: a temp home folder stands for it.
    const home = tempDir('elabora-cli-home-');
    const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_DATA_HOME: path.join(home, '.local', 'share'), ELABORA_LOCAL_DATA_DIR: '' };
    const settings = path.join(home, process.platform === 'darwin' ? 'Library/Application Support/Elabora' : process.platform === 'win32' ? 'AppData/Local/Elabora' : '.local/share/elabora', 'settings.json');
    const first = (await ok('', ['projects', 'path'], env)).stdout.trim();
    assert.ok(first.startsWith(home), first);
    await ok('', ['projects', 'create', 'deplace', '--title', 'Déplacé'], env);
    const target = path.join(tempDir('elabora-cli-disk-'), 'Elabora');
    assert.match((await ok('', ['projects', 'path', '--set', target, '--move'], env)).stdout, /^✔ Moved the library to .*: 1 project\(s\), .* by renaming its folder\.\n$/);
    assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).libraryPath, target);
    assert.equal((await ok('', ['projects', 'path'], env)).stdout, `${target}\n`);
    const copyTarget = tempDir('elabora-cli-disk-');
    assert.match((await ok('', ['projects', 'path', '--set', copyTarget, '--copy'], env)).stdout, /by copying and checking every file\.\n$/);
    assert.equal(fs.existsSync(target), false);
    const listed = JSON.parse((await elabora('', ['projects', 'list', '--json'], env)).stdout);
    assert.equal(listed.library, copyTarget);
    assert.equal(listed.projects.length, 1);
    // Only a folder of its own: not one with other files in it.
    const busy = tempDir('elabora-cli-busy-');
    fs.writeFileSync(path.join(busy, 'mine.txt'), 'x');
    const refused = await elabora('', ['projects', 'path', '--set', busy, '--move'], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /is not empty/);
    // ELABORA_LIBRARY wins and cannot be changed by the command.
    const fixed = await elabora(freshLibrary(), ['projects', 'path', '--set', tempDir('elabora-cli-x-')], env);
    assert.equal(fixed.status, 1);
    assert.match(fixed.stderr, /ELABORA_LIBRARY is set/);
  });

  test('MCP: elabora_projects_list and elabora_projects_path find a project\'s folder, read only', async () => {
    const library = freshLibrary();
    await ok(library, ['import', example('planetary-gearset')]);
    await ok(library, ['import', example('diagnostic-reseau')]);
    const previous = process.env.ELABORA_LIBRARY;
    process.env.ELABORA_LIBRARY = library;
    try {
      const server = createMcpServer(example(), { readOnly: true });
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(clientSide);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        return { error: result.isError === true, body: JSON.parse((result.content as { text: string }[])[0].text) };
      };
      const all = await call('elabora_projects_list');
      assert.equal(all.body.library, library);
      assert.deepEqual(all.body.projects.map((p: { courseId: string }) => p.courseId).sort(), ['diagnostic-reseau', 'planetary-gearset']);
      const [gearset] = (await call('elabora_projects_list', { courseId: 'planetary-gearset' })).body.projects;
      assert.deepEqual(Object.keys(gearset).sort(), ['courseId', 'error', 'id', 'language', 'modifiedAt', 'path', 'size', 'title', 'validation']);
      assert.ok(fs.existsSync(path.join(gearset.path, 'course.json')));
      assert.deepEqual((await call('elabora_projects_path')).body, { library });
      assert.deepEqual((await call('elabora_projects_path', { id: gearset.id.slice(0, 8) })).body, { library, id: gearset.id, title: gearset.title, courseId: 'planetary-gearset', path: gearset.path });
      const missing = await call('elabora_projects_path', { id: 'ffffffff' });
      assert.equal(missing.error, true);
      assert.match(missing.body.error, /No project "ffffffff"/);
      await client.close();
    } finally {
      if (previous === undefined) delete process.env.ELABORA_LIBRARY;
      else process.env.ELABORA_LIBRARY = previous;
    }
  });
});
