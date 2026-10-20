import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjectFiles, validateDir } from '@elabora/node/project-reader';
import { build } from '@elabora/node/build';
import { translationStatus } from '@elabora/node/translate';
import * as edit from '@elabora/node/edit';
import { diffReports } from '@elabora/core/update-impact';
import { ROOT, copyExample, codes, readJSON, writeJSON } from '../helpers.ts';

// elabora rename (docs/architecture/operations.md, Identifiers and format version): ids are permanent, renaming
// is one explicit change that carries every reference and the state lock, so that a renamed
// course validates as before and learners keep their progress.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const example = (name: string) => { const dir = copyExample(path.join(ROOT, 'examples', name)); temporary.push(dir); return dir; };
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-rename-')); temporary.push(dir); return dir; };
const texts = (dir: string) => Object.fromEntries([...readProjectFiles(dir).files].filter(([, file]) => file.kind === 'text').map(([file, content]) => [file, content.kind === 'text' ? content.text : '']));

async function stateKeys(dir: string): Promise<Record<string, string>> {
  const result = await build(dir, { emit: 'dir', out: tempDir() });
  assert.ok(result.ok, JSON.stringify(result.diagnostics.filter((d) => d.severity === 'error')));
  return result.report.stateKeys;
}

// Renames, then checks: same findings, a build, every learner state key kept (the renamed element's
// under its new id), and undo gives every file back.
async function renameAndCheck(dir: string, from: string, to: string, kind: string): Promise<edit.EditResult & { renamed: { references: number } }> {
  const keys = await stateKeys(dir); // also writes the lock entries a build adds
  const files = texts(dir);
  const findings = codes(validateDir(dir).diagnostics);
  const result = edit.rename(dir, { from, to });
  assert.equal(result.renamed.kind, kind);
  assert.deepEqual(codes(validateDir(dir).diagnostics), findings, `${from} → ${to}: the same findings`);
  const renamedEntity = (entity: string) => entity.replace(new RegExp(`^([a-z]+):${from}(#.*)?$`), `$1:${to}$2`);
  assert.deepEqual(await stateKeys(dir), Object.fromEntries(Object.entries(keys).map(([entity, key]) => [renamedEntity(entity), key])), `${from} → ${to}: learner state keys`);
  const after = texts(dir);
  const courseFiles = Object.entries(after).filter(([file]) => file === 'course.json' || file.startsWith('screens/'));
  // Ids are values, never keys: a key of the same name (the orbits field of a list prop) is no reference.
  const named = new RegExp(`"${from}"(?!\\s*:)`);
  assert.ok(!courseFiles.some(([, text]) => named.test(text)), `${from} is named nowhere in the course any more`);
  edit.undo(dir);
  assert.deepEqual(texts(dir), files, `${from} → ${to}: undo gives every file back`);
  return result;
}

test('rename: a section, a screen, a layer, blocks and an event of diagnostic-reseau', async () => {
  const dir = example('diagnostic-reseau');
  await renameAndCheck(dir, 'pratiquer', 'sentrainer', 'section');
  const screen = await renameAndCheck(dir, 'premier-reflexe', 'premier-geste', 'screen');
  assert.ok(screen.files.includes('screens/premier-geste.json') && screen.files.includes('screens/premier-reflexe.json'));
  await renameAndCheck(dir, 'rappel-regle', 'rappel', 'layer');
  await renameAndCheck(dir, 'simulation-bravo', 'simulation-felicitations', 'block');
  await renameAndCheck(dir, 'reflexe-choix', 'reflexe-decision', 'block');
  await renameAndCheck(dir, 'evaluation-q1', 'evaluation-premiere', 'block');
  await renameAndCheck(dir, 'reflexe-bon', 'reflexe-juste', 'event');
});

test('rename: translation units and stylesheet selectors follow (orbital-rendezvous)', async () => {
  const dir = example('orbital-rendezvous');
  const section = await renameAndCheck(dir, 'practise', 'practice', 'section');
  assert.ok(section.files.includes('theme/theme.css') && section.files.includes('translations/fr.xlf'));
  await renameAndCheck(dir, 'orbits', 'orbit-speeds', 'screen');
  await renameAndCheck(dir, 'orbits-hot-1', 'orbits-marker-1', 'block'); // a click trigger target with named controls (visit keys)

  edit.rename(dir, { from: 'practise', to: 'practice' });
  edit.rename(dir, { from: 'orbits', to: 'orbit-speeds' });
  const theme = fs.readFileSync(path.join(dir, 'theme/theme.css'), 'utf8');
  assert.ok(theme.includes('.t-backdrop[data-section="practice"]') && !theme.includes('"practise"'));
  const xliff = fs.readFileSync(path.join(dir, 'translations/fr.xlf'), 'utf8');
  assert.ok(xliff.includes('<unit id="course.section.practice.title">') && xliff.includes('<unit id="screen.orbit-speeds.title">'));
  assert.ok(xliff.includes('<note category="location">screens/orbit-speeds.json /title</note>') && !xliff.includes('screens/orbits.json'));
  const [status] = translationStatus(dir, { to: 'fr' });
  assert.ok(status.exists);
  assert.deepEqual([status.translated, status.toTranslate, status.stale, status.removed], [status.units, 0, 0, 0], 'the translation still matches every unit');
});

test('rename: layers, a fork of quiz and a screen of planetary-gearset; elabora diff sees the same progress', async () => {
  const dir = example('planetary-gearset');
  await renameAndCheck(dir, 'hoist-bench-a', 'hoist-light-load', 'layer');
  await renameAndCheck(dir, 'assessment-q3', 'assessment-config', 'block');
  const first = await build(dir, { emit: 'dir', out: tempDir() });
  edit.rename(dir, { from: 'lab', to: 'test-bench' });
  edit.rename(dir, { from: 'assessment-q1', to: 'assessment-first' });
  const second = await build(dir, { emit: 'dir', out: tempDir() });
  assert.ok(first.ok && second.ok);
  const impact = diffReports(first.report, second.report);
  assert.equal(impact.learnerState.resume, 'kept');
  assert.deepEqual(impact.learnerState.renamed, [{ from: 'screen:lab', to: 'screen:test-bench' }, { from: 'quiz:assessment-q1', to: 'quiz:assessment-first' }]);
  assert.deepEqual([impact.learnerState.removed, impact.learnerState.added], [[], []]);
});

test('rename refuses an id in use, an invalid id and an unknown one, and writes nothing', () => {
  const dir = example('diagnostic-reseau');
  const before = texts(dir);
  const refused = (from: string, to: string, message: RegExp) => assert.throws(() => edit.rename(dir, { from, to }), (error) => error instanceof edit.EditError && message.test(error.message));
  refused('evaluation-q1', 'evaluation-q2', /already used/);
  refused('evaluation-q1', 'bilan', /already used/);
  refused('evaluation-q1', 'decouvrir', /already used/);
  refused('evaluation-q1', 'Evaluation Q1', /not a valid id/);
  refused('evaluation-q1', 'evaluation-q1', /already has this id/);
  refused('nothing-here', 'something', /No section, screen, layer, block or event "nothing-here"/);
  assert.deepEqual(texts(dir), before);
});

test('rename: waivers of the plan that name the id follow it, and the plan\'s diff shows it (D52)', () => {
  const dir = example('diagnostic-reseau');
  const plan = readJSON(dir, 'plan.json');
  plan.waivers = [{ code: 'W_TEXT_DENSITY', target: 'chemin', reason: 'Dense on purpose', approvedBy: 'Client' }];
  writeJSON(dir, 'plan.json', plan);
  const result = edit.rename(dir, { from: 'chemin', to: 'chemin-impression' });
  assert.equal(result.waivers, 1);
  assert.ok(result.files.includes('plan.json'));
  assert.equal(readJSON(dir, 'plan.json').waivers[0].target, 'chemin-impression');
});
