import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FORMAT } from '@elabora/format';
import {
  libraryRoot, setLibraryRoot, listProjects, getProject, createProject, duplicateProject, renameProject, trashProject, listTrash, restoreFromTrash, deleteFromTrash, emptyTrash, TRASH_RETENTION_DAYS,
  exportProject, inspectArchive, importArchive, importFolder, archiveName, LibraryError, MANIFEST_NAME, THUMBNAIL_FILE,
  type ArchiveManifest, type ImportedProject, type ImportResult, type LibraryErrorCode
} from '@elabora/node/library/index';
import { createVersion, listVersions, restore } from '@elabora/node/backups/index';
import { readJournal } from '@elabora/node/journal/index';
import { projectDataDir } from '@elabora/node/data-dir';
import { createZip, readZip } from '@elabora/node/zip';
import { writeZip } from '@elabora/node/packaging/zip-writer';
import { ZipReader, ZipFormatError } from '@elabora/node/packaging/zip-reader';
import { ROOT, copyExample, moduleUrl } from '../helpers.ts';
import { isIgnoredPath } from '@elabora/node/project-files';
import { seededRandom } from '../mutations.ts';

// Every test works in its own library, in a temp folder (ELABORA_LIBRARY): never the user's.
const savedEnvironment = { ELABORA_DATA_DIR: process.env.ELABORA_DATA_DIR, ELABORA_LIBRARY: process.env.ELABORA_LIBRARY };
beforeEach(() => { delete process.env.ELABORA_DATA_DIR; });
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};
function freshLibrary(): string {
  const root = path.join(tempDir('elabora-library-'), 'Library');
  process.env.ELABORA_LIBRARY = root;
  assert.equal(libraryRoot(), root);
  return root;
}
const example = (name: string): string => {
  const dir = copyExample(path.join(ROOT, 'examples', name));
  temporary.push(dir);
  return dir;
};
const noise = (length: number, seed = 42) => {
  const random = seededRandom(seed), bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(random() * 256);
  return bytes;
};
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Relative path → hash of every file of a folder outside tool folders and OS files (.DS_Store).
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!['.elabora', 'dist'].includes(entry.name)) walk(child);
      } else if (entry.isFile() && !isIgnoredPath(child)) out[child] = sha(path.join(dir, child));
    }
  };
  walk('');
  return out;
}
async function rejectsWith(promise: Promise<unknown>, code: LibraryErrorCode): Promise<LibraryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LibraryError, `expected a LibraryError ${code}, got ${(error as Error).stack}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}
function imported(result: ImportResult): ImportedProject {
  assert.equal(result.status, 'imported');
  return result as ImportedProject;
}
// The library holds nothing half-done: no staging leftovers.
const stagingIsEmpty = (root: string) => assert.deepEqual(fs.readdirSync(path.join(root, '.staging')), []);
const noLockLeft = (dir: string) => assert.equal(fs.existsSync(path.join(projectDataDir(dir), 'lock')), false, `lock left in ${dir}`);

test('library: create, list and the cached validation summary', async () => {
  const root = freshLibrary();
  assert.deepEqual(listProjects(), []);
  const project = await createProject({ id: 'premiers-secours', title: 'Premiers secours', language: 'fr' });
  assert.match(project.id, /^[0-9a-f-]{36}$/);
  assert.equal(project.path, path.join(root, project.id));
  assert.equal(fs.readFileSync(path.join(project.path, '.elabora', 'project-id'), 'utf8').trim(), project.id);
  assert.deepEqual([project.courseId, project.title, project.language, project.format], ['premiers-secours', 'Premiers secours', 'fr', FORMAT]);
  assert.ok(project.validation, 'createProject validates the new course');
  assert.equal(project.error, null);
  assert.equal(project.thumbnail, null);
  stagingIsEmpty(root);

  // The thumbnail is the app's to draw; the library reports it once it exists.
  fs.writeFileSync(path.join(projectDataDir(project.path), THUMBNAIL_FILE), 'png');
  assert.equal(getProject(project.id).thumbnail, path.join(project.path, '.elabora', THUMBNAIL_FILE));

  // Newest first; the summary stays cached while the files do not change.
  const second = await createProject({ id: 'gestes', title: 'Gestes', language: 'en' });
  const earlier = new Date(Date.UTC(2026, 9, 24, 12));
  fs.utimesSync(path.join(project.path, 'course.json'), earlier, earlier);
  getProject(project.id, { validate: true });
  const later = new Date(earlier.getTime() + 60_000);
  fs.utimesSync(path.join(second.path, 'course.json'), later, later);
  const listed = listProjects();
  assert.deepEqual(listed.map((p) => p.id), [second.id, project.id]);
  assert.equal(listed[0].validation, null, 'a changed file makes the cached summary stale');
  assert.ok(listed[1].validation);
  assert.ok(listProjects({ validate: true })[0].validation, 'validate: true fills it again');
  assert.ok(listed[1].size > 0 && listed[1].files === 5 && listed[1].modifiedAt);
});

test('library: projects that cannot be read are listed with their error, not hidden', async () => {
  const root = freshLibrary();
  const good = await createProject({ id: 'bon', title: 'Bon' });
  const broken = await createProject({ id: 'casse', title: 'Cassé' });
  fs.writeFileSync(path.join(broken.path, 'course.json'), '{ "id": "casse", ');
  const missing = await createProject({ id: 'vide', title: 'Vide' });
  fs.rmSync(path.join(missing.path, 'course.json'));
  // A folder copied into the library by hand: not named by a project id.
  fs.cpSync(good.path, path.join(root, 'Copie de bon'), { recursive: true });
  // An empty shell (left by a writer that locked a project being moved): not a project at all.
  fs.mkdirSync(path.join(root, '7d0f8d4c-0000-4000-8000-000000000000', '.elabora'), { recursive: true });

  const byId = new Map(listProjects().map((p) => [p.id, p]));
  assert.equal(byId.size, 4);
  assert.equal(byId.get(good.id)!.error, null);
  assert.match(byId.get(broken.id)!.error!, /course\.json is not valid JSON/);
  assert.equal(byId.get(broken.id)!.title, null);
  assert.equal(byId.get(missing.id)!.error, 'course.json is missing.');
  assert.match(byId.get('Copie de bon')!.error!, /folder name is not a project id/);
});

test('archives: export without history holds the project files and a manifest', async () => {
  freshLibrary();
  const dir = example('planetary-gearset');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'old-build.zip'), 'build');
  fs.writeFileSync(path.join(dir, 'notes (conflicted copy 2026-10-06).md'), 'conflict');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'notes');
  await createVersion(dir, { reason: 'manual' }); // history exists but is not asked for

  // Not inside the project, except in tool folders.
  await rejectsWith(exportProject(dir, path.join(dir, 'x.elabora')), 'E_ARCHIVE_TARGET');
  const out = path.join(tempDir('elabora-archive-'), archiveName('planetary-gearset'));
  assert.equal(path.basename(out), 'planetary-gearset.elabora');
  const progress: string[] = [];
  const result = await exportProject(dir, out, { onProgress: (p) => { if (!progress.includes(p.phase)) progress.push(p.phase); } });
  assert.deepEqual(progress, ['reading', 'writing']);
  assert.equal(result.courseId, 'planetary-gearset');
  assert.equal(result.history, null);
  assert.deepEqual(result.skipped, [{ path: 'notes (conflicted copy 2026-10-06).md', reason: 'conflict-copy' }]);
  noLockLeft(dir);

  const { files, meta } = readZip(fs.readFileSync(out));
  const manifest = JSON.parse(files.get(MANIFEST_NAME)!.toString('utf8')) as ArchiveManifest;
  assert.equal(manifest.format, 'elabora-archive/1');
  assert.equal(manifest.course.id, 'planetary-gearset');
  assert.equal(manifest.history, false);
  assert.deepEqual(manifest.historyFiles, []);
  const expected = contents(dir);
  delete expected['notes (conflicted copy 2026-10-06).md'];
  assert.deepEqual(Object.fromEntries(manifest.files.map((f) => [f.path, f.hash.slice(7)])), expected);
  assert.deepEqual([...files.keys()].filter((name) => name !== MANIFEST_NAME).sort(), Object.keys(expected).sort());
  assert.ok(![...files.keys()].some((name) => name.startsWith('.elabora') || name.startsWith('dist/')));
  // Text deflated, binaries stored as they are.
  for (const entry of meta) {
    if (/\.(json|md|css|html|svg)$/.test(entry.name) && entry.size > 200) assert.equal(entry.method, 8, entry.name);
    if (/\.(png|jpg|webp|mp4)$/.test(entry.name)) assert.equal(entry.method, 0, entry.name);
  }
  const inspected = await inspectArchive(out);
  assert.equal(inspected.archive.files, manifest.files.length);
  assert.deepEqual(inspected.existing, []);
});

// A project with history: two versions of a video, and journaled edits.
async function projectWithHistory(): Promise<{ dir: string; v1: Buffer; v2: Buffer }> {
  const root = libraryRoot();
  const imported = await importFolder(example('diagnostic-reseau'));
  const dir = path.join(root, imported.project.id);
  const v1 = noise(300_000);
  const v2 = noise(200_000);
  fs.mkdirSync(path.join(dir, 'assets', 'video'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'video', 'intro.mp4'), v1);
  await createVersion(dir, { reason: 'manual', name: 'First cut' });
  await renameProject(imported.project.id, 'Diagnostiquer une panne (v2)', { author: { kind: 'human' } });
  fs.writeFileSync(path.join(dir, 'assets', 'video', 'intro.mp4'), v2);
  await createVersion(dir, { reason: 'manual' });
  return { dir, v1, v2 };
}

test('archives: export with history, import as a copy, history restored', async () => {
  const root = freshLibrary();
  const { dir, v1, v2 } = await projectWithHistory();
  const versionsBefore = listVersions(dir);
  const journalBefore = readJournal(dir);
  assert.ok(versionsBefore.length >= 2 && journalBefore.length >= 1);

  const out = path.join(tempDir('elabora-archive-'), 'diag.elabora');
  const result = await exportProject(dir, out, { history: true });
  assert.ok(result.history);
  assert.equal(result.history.versions, versionsBefore.length);
  assert.equal(result.history.journalMonths, 1);
  assert.ok(result.history.blobs >= 1, 'the first cut of the video is only in the history');
  assert.ok(result.history.blobsInFiles >= 1, 'current files are not stored twice');
  const { files } = readZip(fs.readFileSync(out));
  const manifest = JSON.parse(files.get(MANIFEST_NAME)!.toString('utf8')) as ArchiveManifest;
  const v1Hash = `sha256:${crypto.createHash('sha256').update(v1).digest('hex')}`;
  const v2Hash = `sha256:${crypto.createHash('sha256').update(v2).digest('hex')}`;
  assert.ok(files.has(`history/blobs/${v1Hash.slice(7)}`));
  assert.ok(!files.has(`history/blobs/${v2Hash.slice(7)}`));
  assert.ok(manifest.historyBlobsInFiles.includes(v2Hash as `sha256:${string}`));
  noLockLeft(dir);

  // Same course in the library: ask first, then keep both.
  const asked = await importArchive(out);
  assert.equal(asked.status, 'exists');
  assert.deepEqual(asked.status === 'exists' && asked.existing.map((p) => p.path), [dir]);
  const copy = imported(await importArchive(out, { onExisting: 'copy' }));
  assert.equal(copy.mode, 'new');
  assert.notEqual(copy.project.id, path.basename(dir));
  assert.equal(copy.project.title, 'Diagnostiquer une panne (v2)');
  assert.deepEqual(contents(copy.project.path), contents(dir));
  assert.ok(copy.validation && copy.project.validation);
  assert.deepEqual(listVersions(copy.project.path).map((v) => [v.id, v.name, v.files]), versionsBefore.map((v) => [v.id, v.name, v.files]));
  assert.deepEqual(readJournal(copy.project.path).map((e) => e.id), journalBefore.map((e) => e.id));
  stagingIsEmpty(root);

  // The history works in the copy: back to the first cut, from contents the archive carried.
  const first = listVersions(copy.project.path).find((v) => v.name === 'First cut')!;
  await restore(copy.project.path, first.id);
  assert.ok(fs.readFileSync(path.join(copy.project.path, 'assets', 'video', 'intro.mp4')).equals(v1));
  assert.equal(JSON.parse(fs.readFileSync(path.join(copy.project.path, 'course.json'), 'utf8')).title, "Diagnostiquer une panne d'impression réseau");
});

test('archives: import as a replacement keeps the project id, its history, and trashes the old files', async () => {
  const root = freshLibrary();
  const { dir } = await projectWithHistory();
  const id = path.basename(dir);
  const out = path.join(tempDir('elabora-archive-'), 'diag.elabora');
  await exportProject(dir, out, { history: true });
  const exported = contents(dir);
  // Work continues here after the export…
  const localVersions = listVersions(dir).length;
  fs.writeFileSync(path.join(dir, 'screens', 'local-only.json'), '{}\n');

  const replaced = imported(await importArchive(out, { onExisting: 'replace', author: { kind: 'human' } }));
  assert.equal(replaced.mode, 'replace');
  assert.equal(replaced.project.id, id);
  assert.equal(replaced.project.path, dir);
  assert.deepEqual(contents(dir), exported, 'the files are the archive\'s');
  noLockLeft(dir);
  // The replaced files are in the trash; restoring the version taken just before undoes the import.
  const trash = listTrash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].reason, 'replaced');
  assert.equal(trash[0].entry, replaced.replaced!.trashEntry);
  assert.ok(fs.existsSync(path.join(trash[0].path, 'screens', 'local-only.json')));
  assert.equal(fs.existsSync(path.join(trash[0].path, '.elabora', 'lock')), false);
  const versions = listVersions(dir);
  assert.equal(versions.length, localVersions + 1, 'the local history, plus the version before the import (the archive\'s are the same)');
  assert.equal(versions.at(-1)!.reason, 'import');
  assert.equal(versions.at(-1)!.id, replaced.replaced!.version);
  const imports = fs.readdirSync(path.join(projectDataDir(dir), 'journal', 'imported'));
  assert.equal(imports.length, 1, 'the archive\'s journal is kept beside the local one');
  await restore(dir, replaced.replaced!.version!);
  assert.ok(fs.existsSync(path.join(dir, 'screens', 'local-only.json')));

  // Restoring the trashed files: their id is taken, they come back beside it.
  const back = await restoreFromTrash(trash[0].entry);
  assert.notEqual(back.id, id);
  assert.equal(back.courseId, 'diagnostic-reseau');
  assert.deepEqual(listTrash(), []);

  // Two projects hold the course now: which one to replace must be said.
  await rejectsWith(importArchive(out, { onExisting: 'replace' }), 'E_REPLACE_TARGET');
  const chosen = imported(await importArchive(out, { replace: back.id }));
  assert.equal(chosen.project.id, back.id);
  stagingIsEmpty(root);
});

// An archive rebuilt from parts, as a tamperer or a broken tool would.
function rebuild(archive: string, change: (files: Map<string, Uint8Array | string>, manifest: ArchiveManifest) => void): string {
  const { files } = readZip(fs.readFileSync(archive));
  const map = new Map<string, Uint8Array | string>(files);
  const manifest = JSON.parse(String(files.get(MANIFEST_NAME))) as ArchiveManifest;
  change(map, manifest);
  map.set(MANIFEST_NAME, JSON.stringify(manifest));
  const out = path.join(tempDir('elabora-tampered-'), 'x.elabora');
  fs.writeFileSync(out, createZip(map).zip);
  return out;
}

test('archives: a damaged or tampered archive is refused and leaves nothing behind', async () => {
  const root = freshLibrary();
  const { dir } = await projectWithHistory();
  const out = path.join(tempDir('elabora-archive-'), 'diag.elabora');
  await exportProject(dir, out, { history: true });
  const before = listProjects().length;
  const refused = async (archive: string, code: LibraryErrorCode) => {
    await rejectsWith(importArchive(archive, { onExisting: 'copy' }), code);
    assert.equal(listProjects().length, before);
    stagingIsEmpty(root);
  };

  // A screen edited after the export, manifest untouched.
  await refused(rebuild(out, (files) => files.set('screens/accueil.json', '{"id":"accueil","title":"Hacked"}\n')), 'E_ARCHIVE_DAMAGED');
  // Same edit, sizes fixed in the manifest: the hash still tells.
  await refused(rebuild(out, (files, manifest) => {
    const text = String(files.get('screens/accueil.json')).replace('"accueil"', '"accuei1"');
    files.set('screens/accueil.json', text);
    manifest.files.find((f) => f.path === 'screens/accueil.json')!.size = Buffer.byteLength(text);
  }), 'E_ARCHIVE_DAMAGED');
  // A file added without the manifest knowing, one removed, a history blob swapped.
  await refused(rebuild(out, (files) => files.set('screens/extra.json', '{}')), 'E_ARCHIVE_DAMAGED');
  await refused(rebuild(out, (files) => files.delete('plan.json')), 'E_ARCHIVE_DAMAGED');
  await refused(rebuild(out, (files) => {
    const blob = [...files.keys()].find((name) => name.startsWith('history/blobs/'))!;
    files.set(blob, noise(300_000, 99));
  }), 'E_ARCHIVE_DAMAGED');
  // Truncated: not a ZIP any more.
  const truncated = path.join(tempDir('elabora-truncated-'), 'x.elabora');
  fs.writeFileSync(truncated, fs.readFileSync(out).subarray(0, 4000));
  await refused(truncated, 'E_ARCHIVE_INVALID');
  // A ZIP that is not an archive (a zipped folder).
  const plain = path.join(tempDir('elabora-plain-'), 'x.elabora');
  fs.writeFileSync(plain, createZip(new Map([['course.json', '{}']])).zip);
  await refused(plain, 'E_ARCHIVE_INVALID');
  // A newer archive format.
  await refused(rebuild(out, (_files, manifest) => { (manifest as { format: string }).format = 'elabora-archive/2'; }), 'E_ARCHIVE_NEWER');
});

test('archives: entries that would escape the project are refused', async () => {
  const root = freshLibrary();
  const { dir } = await projectWithHistory();
  const out = path.join(tempDir('elabora-archive-'), 'diag.elabora');
  await exportProject(dir, out, { history: true });
  const outside = path.join(path.dirname(root), 'evil.txt');
  const refused = async (archive: string) => {
    const error = await rejectsWith(importArchive(archive, { onExisting: 'copy' }), 'E_ARCHIVE_UNSAFE_PATH');
    assert.equal(fs.existsSync(outside), false);
    stagingIsEmpty(root);
    return error;
  };
  const listed = (name: string, data = 'evil') => rebuild(out, (files, manifest) => {
    files.set(name, data);
    manifest.files.push({ path: name, size: Buffer.byteLength(data), hash: `sha256:${crypto.createHash('sha256').update(data).digest('hex')}` });
  });
  await refused(listed('../../evil.txt'));
  await refused(listed('screens/../../../evil.txt'));
  await refused(listed('/tmp/evil.txt'));
  await refused(listed('C:/evil.txt'));
  await refused(listed('screens\\..\\..\\evil.txt'));
  // Machine-local data is never imported as project files: a forged project id, lock or journal.
  await refused(listed('.elabora/project-id', '00000000-0000-4000-8000-000000000000'));
  await refused(listed('assets/.elabora/lock'));
  await refused(listed('node_modules/x/index.js'));
  // Unlisted, but unsafe all the same.
  await refused(rebuild(out, (files) => files.set('../evil.txt', 'evil')));
  // History only under its own names, and a journal that only touches project files.
  await refused(rebuild(out, (files, manifest) => {
    files.set('history/hooks/post-import.sh', 'evil');
    manifest.historyFiles.push({ path: 'history/hooks/post-import.sh', size: 4, hash: `sha256:${crypto.createHash('sha256').update('evil').digest('hex')}` });
  }));
  const error = await refused(rebuild(out, (files, manifest) => {
    const month = manifest.historyFiles.find((f) => f.path.startsWith('history/journal/'))!;
    const line = `${JSON.stringify({ type: 'change', seq: 99, id: 'x', at: new Date().toISOString(), ops: [{ op: 'write', file: '../../evil.txt', text: 'evil' }], inverse: [], files: [] })}\n`;
    const text = `${String(files.get(month.path))}${line}`;
    files.set(month.path, text);
    month.size = Buffer.byteLength(text);
    month.hash = `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
  }));
  assert.equal(error.details.path, '../../evil.txt');
  // Two names for one file on macOS and Windows.
  await refused(listed('Course.json', '{}'));
});

test('library: import a folder, duplicate, rename', async () => {
  const root = freshLibrary();
  const source = example('orbital-rendezvous');
  await createVersion(source, { reason: 'manual' });
  fs.symlinkSync(path.join(os.tmpdir()), path.join(source, 'assets', 'linked'));
  const before = contents(source);
  const result = await importFolder(source, {});
  assert.equal(result.mode, 'new');
  assert.deepEqual(result.skipped, [{ path: 'assets/linked', reason: 'symlink' }]);
  const dir = result.project.path;
  assert.equal(path.dirname(dir), root);
  assert.deepEqual(contents(source), before, 'the folder is left as it was');
  const copied = contents(dir);
  assert.deepEqual(Object.keys(copied).filter((p) => p.startsWith('assets/linked')), []);
  assert.deepEqual(copied, Object.fromEntries(Object.entries(before).filter(([p]) => !p.startsWith('assets/linked'))));
  assert.deepEqual(listVersions(dir), [], 'the copy starts its own history');
  assert.equal(fs.readFileSync(path.join(dir, '.elabora', 'project-id'), 'utf8').trim(), path.basename(dir));
  await rejectsWith(importFolder(dir), 'E_ALREADY_IN_LIBRARY');
  await rejectsWith(importFolder(tempDir('elabora-empty-')), 'E_NOT_A_COURSE');

  const duplicate = await duplicateProject(result.project.id, { title: 'Rendez-vous (copie)', author: { kind: 'human' } });
  assert.notEqual(duplicate.id, result.project.id);
  assert.equal(duplicate.title, 'Rendez-vous (copie)');
  assert.equal(duplicate.courseId, result.project.courseId);
  assert.equal(getProject(result.project.id).title, result.project.title, 'the original keeps its title');
  const change = readJournal(duplicate.path).filter((e) => e.type === 'change');
  assert.equal(change.length, 1, 'the new title is a journaled change of the copy');
  assert.equal(readJournal(dir).length, 0);
  assert.ok(duplicate.validation, 'the rename validated it');
  const plain = await duplicateProject(result.project.id);
  assert.equal(plain.title, result.project.title);
  assert.ok(plain.validation, 'same files, same sizes and times: the original\'s summary holds');
  noLockLeft(result.project.path);
  stagingIsEmpty(root);
});

test('library: a copy made from an example keeps its origin, which no archive carries', async () => {
  const root = freshLibrary();
  const out = path.join(tempDir('elabora-archive-'), 'medieval-charts.elabora');
  await exportProject(example('medieval-charts'), out);
  const origin = { kind: 'example' as const, id: 'medieval-charts', version: '1.0.0' };
  const first = imported(await importArchive(out, { origin }));
  assert.deepEqual({ ...first.project.origin, at: undefined }, { ...origin, at: undefined });
  assert.ok(Date.parse(first.project.origin!.at) > 0);
  assert.deepEqual(listProjects().map((p) => p.origin?.id ?? null), ['medieval-charts']);

  // Another copy of the same example (« Repartir de l'exemple »), and one imported as any archive.
  const again = imported(await importArchive(out, { onExisting: 'copy', origin }));
  assert.notEqual(again.project.id, first.project.id);
  assert.equal(again.project.origin?.id, 'medieval-charts');
  const plain = imported(await importArchive(out, { onExisting: 'copy' }));
  assert.equal(plain.project.origin, null);
  // Machine-local: a duplicate is not the example's copy, an export does not carry it.
  assert.equal((await duplicateProject(first.project.id)).origin, null);
  const exported = path.join(tempDir('elabora-archive-'), 'copy.elabora');
  await exportProject(first.project.path, exported);
  assert.equal(imported(await importArchive(exported, { onExisting: 'copy' })).project.origin, null);
  // A replacement keeps it.
  const replaced = imported(await importArchive(out, { replace: first.project.id }));
  assert.equal(replaced.project.origin?.id, 'medieval-charts');
  stagingIsEmpty(root);
});

test('emptying the trash removes only entries older than the chosen retention', async () => {
  const root = freshLibrary();
  const kept = await createProject({ id: 'garde', title: 'Gardé' });
  const old = await createProject({ id: 'ancien', title: 'Ancien' });
  const recent = await createProject({ id: 'recent', title: 'Récent' });
  const oldEntry = await trashProject(old.id);
  const recentEntry = await trashProject(recent.id);
  trashedAgo(root, oldEntry.entry, 10 * DAY);
  trashedAgo(root, recentEntry.entry, 2 * DAY);
  assert.deepEqual((await emptyTrash({ olderThanDays: 30, now: new Date(Date.UTC(2026, 9, 24, 12)) })).removed, []);
  const emptied = await emptyTrash({ olderThanDays: 5, now: new Date(Date.UTC(2026, 9, 24, 12)) });
  assert.deepEqual(emptied.removed.map(entry => entry.id), [old.id]);
  assert.ok(emptied.bytes > 0);
  assert.deepEqual(listTrash().map(entry => entry.id), [recent.id]);
  assert.deepEqual(listProjects().map(project => project.id), [kept.id]);
});

test('concurrent trash requests remove a project once and leave no empty shell', async () => {
  freshLibrary();
  const project = await createProject({ id: 'deux-fois', title: 'Deux fois' });
  const outcomes = await Promise.allSettled([trashProject(project.id), trashProject(project.id)]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')!.reason as LibraryError;
  assert.equal(failure.code, 'E_PROJECT_NOT_FOUND');
  assert.equal(fs.existsSync(project.path), false);
  assert.deepEqual(listTrash().map(entry => entry.id), [project.id]);
});

// The trash record of an entry, aged: what listTrash reads as the time it was trashed.
const DAY = 86_400_000;
function trashedAgo(root: string, entry: string, milliseconds: number, now = Date.UTC(2026, 9, 24, 12)): string {
  const file = path.join(root, '.trash', `${entry}.json`);
  const trashedAt = new Date(now - milliseconds).toISOString();
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), trashedAt }));
  return trashedAt;
}

test('trash: the list gives each entry its title, when it was trashed and when it will be deleted, newest first', async () => {
  const root = freshLibrary();
  assert.equal(TRASH_RETENTION_DAYS, 30);
  assert.deepEqual(listTrash(), []);
  const first = await createProject({ id: 'premier', title: 'Premier module' });
  const second = await createProject({ id: 'second', title: 'Second module' });
  const third = await createProject({ id: 'sans-fiche', title: 'Sans fiche' });
  const kept = await createProject({ id: 'reste', title: 'Reste dans la bibliothèque' });
  const a = await trashProject(first.id);
  const b = await trashProject(second.id);
  const c = await trashProject(third.id);
  const now = Date.UTC(2026, 9, 24, 12);
  const trashedA = trashedAgo(root, a.entry, 20 * DAY, now);
  const trashedB = trashedAgo(root, b.entry, 2 * DAY, now);

  // Without its record (a crash just after the move) the entry's name tells the time.
  fs.rmSync(path.join(root, '.trash', `${c.entry}.json`));
  const list = listTrash();
  assert.deepEqual(list.map((e) => e.title), ['Sans fiche', 'Second module', 'Premier module'], 'newest first');
  const byTitle = Object.fromEntries(list.map((e) => [e.title, e]));
  assert.equal(byTitle['Premier module'].trashedAt, trashedA);
  assert.equal(byTitle['Premier module'].expiresAt, new Date(Date.parse(trashedA) + 30 * DAY).toISOString());
  assert.equal(byTitle['Second module'].expiresAt, new Date(Date.parse(trashedB) + 30 * DAY).toISOString());
  assert.equal(byTitle['Sans fiche'].expiresAt, new Date(Date.parse(c.trashedAt) + 30 * DAY).toISOString());
  assert.equal(byTitle['Sans fiche'].trashedAt, c.trashedAt);
  for (const entry of list) {
    assert.equal(entry.reason, 'trashed');
    assert.ok(entry.size > 0);
    assert.ok(entry.entry && !entry.entry.includes(path.sep));
    assert.ok(fs.existsSync(entry.path));
  }
  assert.deepEqual(listProjects().map((p) => p.id), [kept.id], 'the library lists what is not in the trash');

  // The date that listTrash says is the one emptyTrash goes by: just before it nothing goes, from it the entry does.
  const before = await emptyTrash({ olderThanDays: TRASH_RETENTION_DAYS, now: new Date(Date.parse(byTitle['Premier module'].expiresAt) - 1000) });
  assert.deepEqual(before.removed.filter((e) => e.title === 'Premier module'), []);
  const from = await emptyTrash({ olderThanDays: TRASH_RETENTION_DAYS, now: new Date(Date.parse(byTitle['Premier module'].expiresAt) + 1000) });
  assert.deepEqual(from.removed.map((e) => e.title), ['Premier module']);
});

test('trash: restoring brings the module back with its history, under its id when that is free', async () => {
  const root = freshLibrary();
  const project = await createProject({ id: 'a-restaurer', title: 'À restaurer' });
  fs.writeFileSync(path.join(project.path, 'notes.txt'), 'travail en cours');
  const history = path.join(projectDataDir(project.path), 'history-marker');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, 'l’historique suit');
  const entry = await trashProject(project.id);
  assert.equal(fs.existsSync(project.path), false);

  const back = await restoreFromTrash(entry.entry);
  assert.equal(back.id, project.id, 'the id was free: it keeps it');
  assert.equal(back.path, project.path);
  assert.equal(back.title, 'À restaurer');
  assert.equal(fs.readFileSync(path.join(back.path, 'notes.txt'), 'utf8'), 'travail en cours');
  assert.equal(fs.readFileSync(path.join(projectDataDir(back.path), 'history-marker'), 'utf8'), 'l’historique suit');
  assert.deepEqual(listTrash(), []);
  assert.deepEqual(fs.readdirSync(path.join(root, '.trash')), [], 'its record goes too');
  noLockLeft(back.path);

  // An empty shell on its id (a writer that locked it while it was moved) does not take it.
  const shell = await trashProject(back.id);
  fs.mkdirSync(path.join(back.path, '.elabora'), { recursive: true });
  assert.equal((await restoreFromTrash(shell.entry)).id, project.id);

  // Entries that are not there are refused, and nothing outside the trash is reached through a name.
  const gone = await trashProject(project.id);
  fs.writeFileSync(path.join(root, 'bibliotheque.txt'), 'à garder');
  for (const name of ['', '.', '..', '../bibliotheque.txt', '.staging', 'nope']) await rejectsWith(restoreFromTrash(name), 'E_TRASH_ENTRY');
  await restoreFromTrash(gone.entry);
  await rejectsWith(restoreFromTrash(gone.entry), 'E_TRASH_ENTRY');
  assert.ok(fs.existsSync(path.join(root, 'bibliotheque.txt')));
});

test('trash: restoring a module whose id is taken again puts it beside the other, with its own id and its history', async () => {
  const root = freshLibrary();
  const original = await createProject({ id: 'meme-id', title: 'Même identifiant' });
  fs.writeFileSync(path.join(original.path, 'version.txt'), 'celle de la corbeille');
  const history = path.join(projectDataDir(original.path), 'history-marker');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, 'historique de la corbeille');
  const entry = await trashProject(original.id);
  // Something else holds the id now: a copy put in the library by hand, with its own files.
  fs.cpSync(entry.path, original.path, { recursive: true });
  fs.writeFileSync(path.join(original.path, 'version.txt'), 'celle qui occupe la place');
  fs.rmSync(path.join(projectDataDir(original.path), 'history-marker'));

  const back = await restoreFromTrash(entry.entry);
  assert.notEqual(back.id, original.id, 'a new id: it does not replace the module that holds the old one');
  assert.equal(back.title, 'Même identifiant');
  assert.equal(path.basename(back.path), back.id);
  assert.equal(fs.readFileSync(path.join(back.path, 'version.txt'), 'utf8'), 'celle de la corbeille');
  assert.equal(fs.readFileSync(path.join(original.path, 'version.txt'), 'utf8'), 'celle qui occupe la place', 'the module that held the id is untouched');
  assert.equal(fs.readFileSync(path.join(projectDataDir(back.path), 'history-marker'), 'utf8'), 'historique de la corbeille');
  assert.deepEqual(listProjects().map((p) => p.id).sort(), [original.id, back.id].sort());
  assert.deepEqual(listTrash(), []);
  noLockLeft(back.path);
  stagingIsEmpty(root);
});

test('trash: with the data kept outside the project, a restored module keeps its history under its new id', async () => {
  freshLibrary();
  const data = tempDir('elabora-data-');
  process.env.ELABORA_DATA_DIR = data;
  try {
    const original = await createProject({ id: 'donnees-externes', title: 'Données ailleurs' });
    const marker = (project: { path: string }) => path.join(projectDataDir(project.path), 'history-marker');
    fs.mkdirSync(path.dirname(marker(original)), { recursive: true });
    fs.writeFileSync(marker(original), 'historique');
    const entry = await trashProject(original.id);
    // Its id is taken again: a copy of the files with the same project id.
    fs.cpSync(entry.path, original.path, { recursive: true });
    const back = await restoreFromTrash(entry.entry);
    assert.notEqual(back.id, original.id);
    assert.equal(fs.readFileSync(marker(back), 'utf8'), 'historique');
    assert.ok(marker(back).startsWith(path.join(data, 'projects', back.id)));
    assert.equal(fs.readFileSync(marker(original), 'utf8'), 'historique', 'the data of the module that holds the old id stays where it was');
  } finally {
    delete process.env.ELABORA_DATA_DIR;
  }
});

test('trash: deleting one entry for good removes its folder, its history and its record, and nothing else', async () => {
  const root = freshLibrary();
  const kept = await createProject({ id: 'reste', title: 'Reste' });
  const doomed = await createProject({ id: 'a-supprimer', title: 'À supprimer' });
  const other = await createProject({ id: 'autre', title: 'Autre entrée' });
  fs.mkdirSync(path.join(doomed.path, 'media'), { recursive: true });
  fs.writeFileSync(path.join(doomed.path, 'media', 'son.wav'), Buffer.alloc(4096, 1));
  const doomedEntry = await trashProject(doomed.id);
  const otherEntry = await trashProject(other.id);
  fs.writeFileSync(path.join(root, 'bibliotheque.txt'), 'à garder');

  const removed = await deleteFromTrash(doomedEntry.entry);
  assert.equal(removed.entry, doomedEntry.entry);
  assert.equal(removed.title, 'À supprimer');
  assert.ok(removed.size >= 4096, 'it tells how much it freed');
  assert.equal(fs.existsSync(doomedEntry.path), false);
  assert.equal(fs.existsSync(`${doomedEntry.path}.json`), false, 'the record goes with it');
  assert.deepEqual(listTrash().map((e) => e.entry), [otherEntry.entry], 'the other entry stays');
  assert.ok(fs.existsSync(path.join(otherEntry.path, 'course.json')));
  assert.ok(fs.existsSync(`${otherEntry.path}.json`));
  assert.deepEqual(listProjects().map((p) => p.id), [kept.id]);
  assert.ok(fs.existsSync(path.join(root, 'bibliotheque.txt')));

  // Gone already, or never there: refused, and a name cannot reach anything outside the trash.
  await rejectsWith(deleteFromTrash(doomedEntry.entry), 'E_TRASH_ENTRY');
  for (const name of ['', '.', '..', '../bibliotheque.txt', `../${kept.id}`, '.staging']) await rejectsWith(deleteFromTrash(name), 'E_TRASH_ENTRY');
  assert.ok(fs.existsSync(path.join(root, 'bibliotheque.txt')));
  assert.ok(fs.existsSync(path.join(kept.path, 'course.json')));
  assert.ok(fs.existsSync(root));

  // A recent entry goes too, whatever its age; the library and the other entry are untouched.
  await deleteFromTrash(otherEntry.entry);
  assert.deepEqual(listTrash(), []);
  assert.deepEqual(fs.readdirSync(path.join(root, '.trash')), []);
  assert.ok(fs.existsSync(path.join(kept.path, 'course.json')));
});

test('trash: deleting an entry for good keeps the data outside the project that a module or another entry still uses', async () => {
  freshLibrary();
  const data = tempDir('elabora-data-');
  process.env.ELABORA_DATA_DIR = data;
  try {
    const marker = (project: { path: string }) => path.join(projectDataDir(project.path), 'history-marker');
    const write = (project: { path: string }) => {
      fs.mkdirSync(path.dirname(marker(project)), { recursive: true });
      fs.writeFileSync(marker(project), 'historique');
    };

    // Alone: its data goes with it.
    const alone = await createProject({ id: 'seul', title: 'Seul' });
    write(alone);
    const aloneData = projectDataDir(alone.path);
    const aloneEntry = await trashProject(alone.id);
    await deleteFromTrash(aloneEntry.entry);
    assert.equal(fs.existsSync(aloneData), false);

    // A module of the library has the same id (a replaced module): the data stays.
    const shared = await createProject({ id: 'partage', title: 'Partagé' });
    write(shared);
    const sharedEntry = await trashProject(shared.id);
    fs.cpSync(sharedEntry.path, shared.path, { recursive: true });
    await deleteFromTrash(sharedEntry.entry);
    assert.equal(fs.readFileSync(marker(shared), 'utf8'), 'historique');

    // Two entries with one id: the data goes with the last.
    const twice = await createProject({ id: 'deux-fois', title: 'Deux fois' });
    write(twice);
    const twiceData = projectDataDir(twice.path);
    const first = await trashProject(twice.id);
    fs.cpSync(first.path, twice.path, { recursive: true });
    const second = await trashProject(twice.id);
    await deleteFromTrash(first.entry);
    assert.ok(fs.existsSync(twiceData), 'the other entry has this history');
    await deleteFromTrash(second.entry);
    assert.equal(fs.existsSync(twiceData), false);
    assert.deepEqual(listTrash(), []);
  } finally {
    delete process.env.ELABORA_DATA_DIR;
  }
});

// Where localDataRoot puts the settings under a home folder, on each system.
const settingsPath = (home: string) => path.join(home, { darwin: 'Library/Application Support/Elabora', win32: 'AppData/Local/Elabora' }[os.platform() as string] ?? '.local/share/elabora', 'settings.json');

// The location setting lives in the user's Elabora settings: each case runs in a child process whose
// home folder is a temp folder, so the real settings are never touched.
function inChild(home: string, code: string): any {
  const environment = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_DATA_HOME: path.join(home, '.local', 'share'), ELABORA_LIBRARY: '', ELABORA_DATA_DIR: '', ELABORA_LOCAL_DATA_DIR: '' };
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const library = await import(${JSON.stringify(moduleUrl('packages/node/src/library/index.ts'))});
    const { localDataRoot } = await import(${JSON.stringify(moduleUrl('packages/node/src/data-dir.ts'))});
    if (!localDataRoot().startsWith(${JSON.stringify(home)})) throw new Error('not in the temp home: ' + localDataRoot());
    const result = await (async () => { ${code} })();
    console.log(JSON.stringify(result));
  `], { env: environment, cwd: ROOT }).toString();
  return JSON.parse(output.trim().split('\n').pop()!);
}

test('library: move the library (rename, then copy and check), and find it after a crash', async () => {
  const home = tempDir('elabora-home-');
  const first = inChild(home, `
    const project = await library.createProject({ id: 'deplace', title: 'Déplacé' });
    const trashed = await library.createProject({ id: 'jete', title: 'Jeté' });
    await library.trashProject(trashed.id);
    return { root: library.libraryRoot(), project };
  `);
  assert.ok(first.root.startsWith(home));
  const second = path.join(tempDir('elabora-disk-'), 'Elabora Library');
  const moved = inChild(home, `
    const move = await library.setLibraryRoot(${JSON.stringify(second)}, { move: true });
    return { move, root: library.libraryRoot(), projects: library.listProjects(), trash: library.listTrash() };
  `);
  assert.equal(moved.move.method, 'rename');
  assert.equal(moved.root, second);
  assert.deepEqual(moved.projects.map((p: { id: string }) => p.id), [first.project.id]);
  assert.equal(moved.trash.length, 1);
  assert.equal(fs.existsSync(first.root), false);
  assert.equal(fs.existsSync(path.join(second, first.project.id, '.elabora', 'lock')), false);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath(home), 'utf8')).libraryPath, second);

  // Copy and check (the way to another disk), into an empty folder that exists.
  const third = tempDir('elabora-disk-');
  const copied = inChild(home, `
    const move = await library.setLibraryRoot(${JSON.stringify(third)}, { move: true, copy: true });
    return { move, root: library.libraryRoot(), projects: library.listProjects(), trash: library.listTrash() };
  `);
  assert.equal(copied.move.method, 'copy');
  assert.equal(copied.root, third);
  assert.deepEqual(copied.projects.map((p: { id: string; error: string | null }) => [p.id, p.error]), [[first.project.id, null]]);
  assert.equal(copied.trash.length, 1);
  assert.equal(fs.existsSync(second), false, 'the originals are removed once the copy is checked');

  // Refused: a folder that is not empty, the library's own subfolder.
  const busy = tempDir('elabora-busy-');
  fs.writeFileSync(path.join(busy, 'mine.txt'), 'x');
  const refusals = inChild(home, `
    const codes = [];
    for (const target of [${JSON.stringify(busy)}, ${JSON.stringify(path.join(third, 'inner'))}]) {
      try { await library.setLibraryRoot(target, { move: true }); codes.push('moved'); } catch (error) { codes.push(error.code); }
    }
    return codes;
  `);
  assert.deepEqual(refusals, ['E_LIBRARY_LOCATION', 'E_LIBRARY_LOCATION']);

  // A move interrupted after the rename, before the settings were written: the library is found
  // where its marker is.
  const settingsFile = settingsPath(home);
  const fourth = path.join(tempDir('elabora-disk-'), 'L');
  fs.renameSync(third, fourth);
  fs.writeFileSync(settingsFile, JSON.stringify({ libraryPath: third, libraryMove: { from: third, to: fourth }, theme: 'dark' }));
  assert.equal(inChild(home, 'return library.libraryRoot();'), fourth);
  // Other settings survive a change of location.
  inChild(home, `return await library.setLibraryRoot(${JSON.stringify(fourth)}, {});`);
  inChild(home, `return await library.setLibraryRoot(${JSON.stringify(path.join(tempDir('elabora-disk-'), 'Empty'))}, {});`);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).theme, 'dark');
  // ELABORA_LIBRARY wins, and cannot be changed from here.
  process.env.ELABORA_LIBRARY = tempDir('elabora-env-');
  await rejectsWith(setLibraryRoot(tempDir('elabora-x-')), 'E_LIBRARY_LOCATION');
});

test('ZIP reader: streams what the writer wrote, refuses entries that lie about their size', async () => {
  const dir = tempDir('elabora-zip-reader-');
  const media = noise(3 * 1024 * 1024 + 17);
  fs.writeFileSync(path.join(dir, 'clip.mp4'), media);
  const text = 'lorem ipsum '.repeat(50_000);
  const archive = path.join(dir, 'a.zip');
  await writeZip(archive, [{ name: 'clip.mp4', file: path.join(dir, 'clip.mp4') }, { name: 'text/a.md', data: text }, { name: 'empty.txt', data: '' }]);
  const reader = await ZipReader.open(archive);
  try {
    assert.deepEqual(reader.entries.map((e) => [e.name, e.method]), [['clip.mp4', 0], ['empty.txt', 0], ['text/a.md', 8]]);
    const out = path.join(dir, 'clip-out.mp4');
    const extracted = await reader.extractEntry(reader.entries[0], out);
    assert.equal(extracted.sha256, crypto.createHash('sha256').update(media).digest('hex'));
    assert.ok(fs.readFileSync(out).equals(media));
    await assert.rejects(reader.extractEntry(reader.entries[0], out), /EEXIST/);
    assert.equal((await reader.readEntry(reader.entries[2])).toString(), text);
    assert.equal((await reader.readEntry(reader.entries[1])).length, 0);
  } finally {
    await reader.close();
  }
  // A deflated entry whose directory says it is small: inflating stops there.
  const bytes = Buffer.from(fs.readFileSync(archive));
  const central = bytes.lastIndexOf(Buffer.from('text/a.md')) - 46;
  bytes.writeUInt32LE(1000, central + 24);
  fs.writeFileSync(archive, bytes);
  const lying = await ZipReader.open(archive);
  try {
    await assert.rejects(lying.readEntry(lying.entries.find((e) => e.name === 'text/a.md')!), ZipFormatError);
    await assert.rejects(lying.extractEntry(lying.entries.find((e) => e.name === 'text/a.md')!, path.join(dir, 'a.md')), ZipFormatError);
    assert.equal(fs.existsSync(path.join(dir, 'a.md')), false, 'a refused entry leaves no file');
  } finally {
    await lying.close();
  }
});

test('archives: a 50 MB video is streamed through export and import (peak memory stays low)', () => {
  const library = tempDir('elabora-library-');
  const project = example('diagnostic-reseau');
  fs.mkdirSync(path.join(project, 'assets', 'video'), { recursive: true });
  const video = path.join(project, 'assets', 'video', 'x.mp4');
  const handle = fs.openSync(video, 'w');
  for (let i = 0; i < 50; i++) fs.writeSync(handle, noise(1024 * 1024));
  fs.closeSync(handle);
  const out = path.join(tempDir('elabora-archive-'), 'big.elabora');
  const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const library = await import(${JSON.stringify(moduleUrl('packages/node/src/library/index.ts'))});
    const { validateDir } = await import(${JSON.stringify(moduleUrl('packages/node/src/project-reader.ts'))});
    // The validator's schemas and templates are loaded once (about 25 MB): not part of streaming.
    validateDir(${JSON.stringify(project)});
    const baseline = process.resourceUsage().maxRSS * 1024;
    const exported = await library.exportProject(${JSON.stringify(project)}, ${JSON.stringify(out)});
    const result = await library.importArchive(${JSON.stringify(out)});
    console.log(JSON.stringify({ baseline, peak: process.resourceUsage().maxRSS * 1024, size: exported.size, imported: result.project.path }));
  `], { env: { ...process.env, ELABORA_LIBRARY: library, ELABORA_DATA_DIR: '' } }).toString());
  assert.equal(sha(path.join(report.imported, 'assets', 'video', 'x.mp4')), sha(video));
  assert.ok(report.size > 50 * 1024 * 1024);
  const growth = (report.peak - report.baseline) / 1024 / 1024;
  console.log(`50 MB video: baseline ${(report.baseline / 1048576).toFixed(0)} MB, peak ${(report.peak / 1048576).toFixed(0)} MB, growth ${growth.toFixed(0)} MB`);
  // Holding the video whole once would add 50 MB.
  assert.ok(growth < 30, `peak memory grew by ${growth.toFixed(0)} MB`);
});

test('library: a course in a newer format is refused on import, folder or archive', async () => {
  const root = freshLibrary();
  const source = copyExample(path.join(ROOT, 'test/fixtures/format-0.1/diagnostic-reseau'));
  temporary.push(source);
  const course = JSON.parse(fs.readFileSync(path.join(source, 'course.json'), 'utf8'));
  course.format = 'elabora/9.0';
  fs.writeFileSync(path.join(source, 'course.json'), JSON.stringify(course));
  await rejectsWith(importFolder(source), 'E_ARCHIVE_NEWER');
  const newer = path.join(tempDir('elabora-archive-'), 'newer.elabora');
  await exportProject(source, newer);
  await rejectsWith(importArchive(newer, { onExisting: 'copy' }), 'E_ARCHIVE_NEWER');
  stagingIsEmpty(root);
});
