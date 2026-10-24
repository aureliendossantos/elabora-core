import { test, type TestContext } from 'node:test';
import { resources } from '../resources.ts';
import { extractUnits } from '@elabora/core/i18n/units';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openProject } from '@elabora/engine';
import type { OpenOptions } from '@elabora/engine';
import * as edit from '@elabora/node/edit';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { translationFile } from '@elabora/node/translate';
import { readJournal } from '@elabora/node/journal/index';
import { readXliff, toXliff } from '@elabora/core/i18n/xliff';
import { screenTranslation, translatedCourse, translationStatus } from '@elabora/core/i18n/translate';
import { renderScreen } from '@elabora/core/render/screen';
import type { Block } from '@elabora/format';
import { readJSON, writeJSON } from '../helpers.ts';

// The app's « Traduction » beyond its table: a screen's texts in a language with where the canvas
// shows each (« En contexte »), the screen rendered while translations that break the text are being
// fixed, texts translated in batches (a language starts with them), the translated plan approved by a
// person, and a language built as its own package by the engine (« Versions »).

const copy = (t: TestContext) => resources(t).copyExample();

// Every unit translated as its source prefixed (maths, links and placeholders kept); units the prefix
// would make too long keep their source.
function translateAll(dir: string, language: string): void {
  edit.exportTranslationChange(dir, { to: language });
  const units = [...readXliff(fs.readFileSync(translationFile(dir, language), 'utf8')).units.values()];
  const write = (bad: Set<string>) => fs.writeFileSync(translationFile(dir, language), toXliff({ srcLang: 'fr', trgLang: language, original: 'x', units: units.map((unit) => ({ id: unit.id, source: unit.source, target: bad.has(unit.id) ? unit.source : `EN ${unit.source}`.slice(0, 190), state: 'translated' })) }));
  write(new Set());
  const status = translationStatus(loadProjectFromDir(dir), { to: language })[0];
  write(new Set(status?.exists ? status.problems.map((problem) => problem.id) : []));
}

test('a language starts with its first texts, translated in one change; a refused text refuses the batch', (t) => {
  const dir = copy(t);
  assert.equal(fs.existsSync(translationFile(dir, 'en')), false);
  const result = edit.translateText(dir, { language: 'en', texts: [{ unit: 'screen.chemin.title', target: 'The path of a print job' }, { unit: 'course.title', target: 'Diagnosing a network fault' }] });
  assert.deepEqual(result.units, ['screen.chemin.title', 'course.title']);
  const units = readXliff(fs.readFileSync(translationFile(dir, 'en'), 'utf8')).units;
  assert.equal(units.get('screen.chemin.title')?.target, 'The path of a print job');
  assert.equal(units.get('course.title')?.state, 'translated');
  assert.deepEqual([...units.keys()].sort(), extractUnits(loadProjectFromDir(dir)).map(unit => unit.id).sort(), 'every unit is exported');
  assert.equal(readJournal(dir).filter((entry) => entry.type === 'change').length, 1);
  // A unit the course does not have, or a translation that loses the source's bold… is not checked;
  // an unknown unit refuses everything.
  assert.throws(() => edit.translateText(dir, { language: 'en', texts: [{ unit: 'course.title', target: 'Other' }, { unit: 'nothing.here', target: 'x' }] }), /No unit "nothing\.here"/);
  assert.equal(readXliff(fs.readFileSync(translationFile(dir, 'en'), 'utf8')).units.get('course.title')?.target, 'Diagnosing a network fault');
  assert.throws(() => edit.translateText(dir, { language: 'en' }), /a unit and its target, or texts/);
});

test('a screen in a language: its texts with the block and the field that show them, the plan\'s included', (t) => {
  const dir = copy(t);
  edit.translateText(dir, { language: 'en', texts: [{ unit: 'screen.chemin.title', target: 'The path of a print job' }, { unit: 'plan.text.TXT-2', target: 'Always follow the path in order: **workstation → switch → router → firewall → print server**. Skip no step.' }] });
  const project = loadProjectFromDir(dir);
  const chemin = screenTranslation(project, { screen: 'chemin', language: 'en' });
  assert.equal(chemin.source, 'fr');
  assert.equal(chemin.exists, true);
  const row = (id: string) => chemin.rows.find((candidate) => candidate.id === id);
  assert.equal(chemin.rows[0]?.id, 'screen.chemin.title', 'the screen\'s own texts first');
  assert.deepEqual([row('screen.chemin.title')?.block, row('screen.chemin.title')?.field, row('screen.chemin.title')?.status], [null, null, 'translated']);
  assert.deepEqual([row('plan.text.TXT-2')?.block, row('plan.text.TXT-2')?.field, row('plan.text.TXT-2')?.status], ['chemin-regle', 'markdown', 'translated']);
  assert.deepEqual([row('block.chemin-intro.markdown')?.field, row('block.chemin-intro.markdown')?.status], ['markdown', 'to-translate']);
  assert.equal(row('block.chemin-roles.items.poste.title')?.field, 'items.0.title', 'list items by their index, as the canvas marks them');
  assert.equal(row('block.chemin-regle.title')?.field, 'title');
  assert.ok(!chemin.rows.some((candidate) => candidate.id === 'plan.text.TXT-1'), 'another screen\'s plan text');
  // Blocks in reading order.
  const blocks = chemin.rows.map((candidate) => candidate.block).filter((block): block is string => block !== null);
  assert.deepEqual([...new Set(blocks)], ['chemin-intro', 'chemin-schema', 'chemin-regle', 'chemin-roles'].filter((id) => blocks.includes(id)));
  // A question of the plan shows where the quiz block takes its words.
  const evaluation = screenTranslation(project, { screen: 'evaluation', language: 'en' });
  const stem = evaluation.rows.find((candidate) => candidate.id === 'plan.question.Q-1.stem');
  assert.deepEqual([stem?.block, stem?.field], ['evaluation-q1', 'stem']);
  assert.equal(evaluation.rows.find((candidate) => candidate.id === 'plan.question.Q-1.option.b.text')?.field, 'options.1.text');
  assert.throws(() => screenTranslation(project, { screen: 'absent', language: 'en' }), /No screen "absent"/);
});

test('a screen renders in a language while a translation breaks the text: that one keeps its source', (t) => {
  const dir = copy(t);
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.blocks.find((block: Block) => block.id === 'chemin-regle').step = 2;
  screen.steps = { 2: { label: 'Voir la règle' } };
  writeJSON(dir, 'screens/chemin.json', screen);
  edit.translateText(dir, { language: 'en', texts: [{ unit: 'screen.chemin.title', target: 'The path of a print job' }] });
  // A translator's file with a button text longer than its 40 characters.
  const file = translationFile(dir, 'en');
  const xliff = readXliff(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, toXliff({ srcLang: 'fr', trgLang: 'en', original: 'x', units: [...xliff.units.values()].map((unit) => (unit.id === 'screen.chemin.step.2.label' ? { ...unit, target: 'See the rule that every technician follows, always', state: 'translated' } : unit)) }));
  const project = loadProjectFromDir(dir);
  assert.throws(() => translatedCourse(project, { to: 'en', allowMissing: true }), /break the text/);
  assert.deepEqual(translatedCourse(project, { to: 'en', allowMissing: true, skipBroken: true }).broken, ['screen.chemin.step.2.label']);
  const render = renderScreen(project, 'chemin', { language: 'en' });
  assert.equal(render.course.language, 'en');
  assert.equal(render.course.screens[0]?.title, 'The path of a print job');
  assert.equal(render.course.screens[0]?.steps?.['2']?.label, 'Voir la règle');
});

test('the translated plan approved as a change, undone like any other', (t) => {
  const dir = copy(t);
  translateAll(dir, 'en');
  const before = translationStatus(loadProjectFromDir(dir), { to: 'en' })[0];
  assert.equal(before?.exists && before.plan, 'not approved');
  assert.throws(() => edit.approveTranslation(dir, { to: 'en', by: 'Agent' }, { author: { kind: 'agent' } }), /Only a person/);
  const approved = edit.approveTranslation(dir, { to: 'en', by: 'Emma Collins, Hélios', date: '2026-10-08' }, { author: { kind: 'human' } });
  assert.equal(approved.op, 'approve_translation');
  assert.equal(readJSON(dir, 'translations/en.approval.json').by, 'Emma Collins, Hélios');
  const status = translationStatus(loadProjectFromDir(dir), { to: 'en' })[0];
  assert.equal(status?.exists && status.plan, 'approved');
  edit.undo(dir);
  assert.equal(fs.existsSync(path.join(dir, 'translations/en.approval.json')), false);
  assert.throws(() => edit.approveTranslation(dir, { to: 'en', by: '' }, { author: { kind: 'human' } }), /--by/);
});

const QUIET: OpenOptions = { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 };

test('engine: a screen\'s texts in a language, and a language built as its own package into dist', async (t) => {
  const dir = copy(t);
  writeJSON(dir, 'course.json', { ...readJSON(dir, 'course.json'), delivery: { lms: ['moodle'] } });
  const session = resources(t).own(await openProject(dir, QUIET), value => value.close());
  await session.flush();
  const request = async <T>(type: string, params: unknown): Promise<{ ok: true; result: T } | { ok: false; error: { kind: string; message: string } }> => {
    const response = await session.handle({ kind: 'request', id: type, type, params } as never);
    return response as never;
  };
  await session.run('translate_text', { language: 'en', texts: [{ unit: 'screen.chemin.title', target: 'The path of a print job' }] });
  const shown = await request<{ rows: { id: string; field: string | null }[] }>('screenTranslation', { screen: 'chemin', language: 'en' });
  assert.ok(shown.ok && shown.result.rows.some((row) => row.id === 'plan.text.TXT-2' && row.field === 'markdown'));
  const absent = await request('screenTranslation', { screen: 'absent', language: 'en' });
  assert.equal(!absent.ok && absent.error.kind, 'not-found');
  // Unfinished: refused, unless as a draft.
  const before = readJournal(dir).length;
  const refused = await request('buildTranslation', { language: 'en' });
  assert.equal(!refused.ok && refused.error.kind, 'refused');
  assert.match(!refused.ok ? refused.error.message : '', /not translated or stale/);
  const draft = await session.buildTranslation({ language: 'en', allowMissing: true });
  assert.equal(draft.ok, true, JSON.stringify(draft.errors.slice(0, 3)));
  const course = readJSON(dir, 'course.json');
  assert.equal(draft.zip, path.join(dir, 'dist', `${course.id}-en-${course.version}-scorm12.zip`));
  assert.ok(draft.zip && fs.statSync(draft.zip).size === draft.size && draft.size > 0);
  assert.ok(draft.untranslated > 0 && draft.units > draft.untranslated);
  assert.equal(draft.plan, 'draft');
  // Built for the course's LMS, with what its build found that did not stop it (the package's
  // findings for its LMS among them): the translated plan is a draft.
  assert.deepEqual(readJSON(path.dirname(draft.report!), path.basename(draft.report!)).profiles.map((profile: { id: string }) => profile.id), ['moodle']);
  assert.ok(draft.warnings.some((d) => d.code === 'W_PLAN_DRAFT'), JSON.stringify(draft.warnings.map((d) => d.code)));
  assert.ok(draft.warnings.every((d) => d.severity === 'warning' && !d.waived));
  assert.equal(readJournal(dir).length, before, 'the source course is not written');
  assert.equal(fs.existsSync(path.join(dir, 'translations', 'en.xlf')), true);
});
