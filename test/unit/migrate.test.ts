import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FORMAT } from '@elabora/format';
import { checkFormat, FORMAT_STEPS, type FormatStep } from '@elabora/core/format/migrations/index';
import { JsonText } from '@elabora/core/format/migrations/json-text';
import { compareFormats } from '@elabora/core/format/version';
import { readText, textFile } from '@elabora/core/project/files';
import { loadProject } from '@elabora/core/project/load';
import { readProjectFiles } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { readJournal } from '@elabora/node/journal/index';
import { listVersions } from '@elabora/node/backups/index';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';

// Format migrations (docs/architecture/operations.md, Identifiers and format version). elabora/0.1 is the first
// format: the chain is empty. The mechanism every later format will use (a pure step in the core,
// written as one system change after a backup, which undo reverts) runs here with a step of the
// test's own, elabora/0.0 → elabora/0.1, which renames a course.json field.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const copy = () => { const dir = copyExample(); temporary.push(dir); return dir; };
const folder = (dir: string) => Object.fromEntries([...readProjectFiles(dir).files].map(([file, content]) => [file, content.kind === 'text' ? content.text : `binary ${content.size}`]));

const step: FormatStep = {
  from: 'elabora/0.0',
  to: FORMAT,
  summary: 'The test step: course.json oldTitle becomes title.',
  migrate(files) {
    const document = new JsonText((readText(files, 'course.json') ?? '{}').replace('\n  "oldTitle": ', '\n  "title": '));
    document.set(['format'], FORMAT);
    return { files: new Map([['course.json', textFile(document.toString())]]), notes: [{ kind: 'changed', file: 'course.json', path: '/format', message: `format elabora/0.0 → ${FORMAT}` }] };
  }
};
function older(): { dir: string; current: Record<string, string> } {
  const dir = copy();
  const current = folder(dir);
  const text = fs.readFileSync(path.join(dir, 'course.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'course.json'), text.replace(`"format": "${FORMAT}"`, '"format": "elabora/0.0"').replace('\n  "title": ', '\n  "oldTitle": '));
  return { dir, current };
}

test('elabora/0.1 is the first format: no step, current courses need nothing', () => {
  assert.equal(FORMAT, 'elabora/0.1');
  assert.deepEqual(FORMAT_STEPS, []);
  assert.equal(compareFormats('elabora/0.10', 'elabora/0.9'), 1);
  assert.equal(checkFormat(readProjectFiles(copy()).files).status, 'current');
});

test('a step migrates in memory, and elabora migrate writes it as one system change after a backup; undo gives the files back', () => {
  const { dir, current } = older();
  const before = folder(dir);
  const check = checkFormat(readProjectFiles(dir).files, [step]);
  assert.ok(check.status === 'outdated');
  assert.equal(readJSON(dir, 'course.json').format, 'elabora/0.0', 'in memory only');
  assert.equal(edit.migrateProject(dir, { steps: [step], dryRun: true }).migrated, false);
  assert.deepEqual(folder(dir), before, 'a dry run writes nothing');

  const result = edit.migrateProject(dir, { steps: [step] });
  assert.equal(result.migrated, true);
  assert.deepEqual(folder(dir), current, 'the course as it was in the current format');
  const [change] = readJournal(dir);
  assert.ok(change?.type === 'change');
  assert.deepEqual(change.author, { kind: 'system' });
  assert.deepEqual(change.command, { name: 'migrate_format', args: { from: 'elabora/0.0', to: FORMAT } });
  assert.equal(listVersions(dir).at(-1)?.reason, 'migration');
  assert.equal(edit.migrateProject(dir, { steps: [step] }).migrated, false, 'nothing left to migrate');
  edit.undo(dir);
  assert.deepEqual(folder(dir), before, 'undo gives the older files back');
  assert.equal(edit.migrateIfOutdated(dir, { steps: [step] })?.to, FORMAT);
});

test('a newer format is refused and nothing past course.json is loaded; an unknown one loads as it is', () => {
  const dir = copy();
  const course = readJSON(dir, 'course.json');
  writeJSON(dir, 'course.json', { ...course, format: 'elabora/9.0' });
  const project = loadProject(readProjectFiles(dir).files, { root: dir });
  assert.deepEqual(project.loadErrors.map((error) => error.code), ['E_FORMAT_NEWER']);
  assert.throws(() => edit.migrateProject(dir), /newer than the one this version of Elabora reads \(elabora\/0\.1\)/);
  writeJSON(dir, 'course.json', { ...course, format: 'kitware/0.1' });
  assert.equal(checkFormat(readProjectFiles(dir).files).status, 'unknown');
  assert.equal(edit.migrateIfOutdated(dir), null);
});
