import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BILINGUAL, copyExample as copyCourse, readJSON } from '../helpers.ts';
import * as edit from '@elabora/node/edit';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { build } from '@elabora/node/build';
import { buildLanguagePackages, languagePackagesOf } from '@elabora/node/language-packages';
import { moduleLanguages, packageLanguages } from '@elabora/core/player/config';
import { matchLanguage, preferenceList, startLanguage } from '@elabora/player/start-language';
import type { CourseData } from '@elabora/player/course-data';

// D71: the package's languages are the author's choice. A translation named goes in as it is, the
// build saying what it lacks (its plan not approved, texts still to translate); the Aperçu tries every
// translation; one package per language for LMSs that keep the language versions themselves; the
// language a learner starts in.

const courseData = (files: Map<string, Buffer>, name = 'elabora/course.js'): CourseData => JSON.parse(files.get(name)!.toString('utf8').replace(/^window\.ELABORA_COURSE = |^\(window\.ELABORA_COURSES = window\.ELABORA_COURSES \|\| \{\}\)\[[^\]]+\] = /, '').replace(/;\n$/, '')) as CourseData;
const codes = (diagnostics: readonly { code: string; target?: string }[], prefix = 'W_PACKAGE_') => diagnostics.filter((d) => d.code.startsWith(prefix)).map((d) => `${d.code} ${d.target ?? ''}`.trim()).sort();

test('a translation named goes in as it is, said; all keeps the ready and approved ones; a language without a translation is left out', async () => {
  const dir = copyCourse(BILINGUAL);
  fs.rmSync(path.join(dir, 'translations/fr.approval.json'));
  const project = loadProjectFromDir(dir);
  assert.deepEqual(packageLanguages(project).languages, ['en'], 'nothing asked: the course\'s own');
  assert.deepEqual(packageLanguages(project, 'all'), { languages: ['en'], notes: [{ language: 'fr', kind: 'left out', lacks: ['its translated plan is not approved'] }] });
  assert.deepEqual(packageLanguages(project, ['fr', 'en']), { languages: ['en', 'fr'], notes: [{ language: 'fr', kind: 'not approved', lacks: ['its translated plan is not approved'] }] });
  assert.deepEqual(moduleLanguages(project), ['en', 'fr']);

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-languages-'));
  const named = await build(dir, { out: path.join(out, 'named'), emit: 'dir', target: 'web', writeLock: false, languages: ['fr', 'de'] });
  assert.ok(named.ok, JSON.stringify(named.diagnostics.filter((d) => d.severity === 'error')));
  assert.ok(named.files.has('elabora/course.fr.js'));
  assert.deepEqual(courseData(named.files).languages, ['en', 'fr']);
  assert.deepEqual(named.report.languages, ['en', 'fr']);
  assert.deepEqual(codes(named.diagnostics), ['W_PACKAGE_LANGUAGE_NOT_APPROVED fr', 'W_PACKAGE_LANGUAGE_UNKNOWN de']);
  assert.match(named.diagnostics.find((d) => d.code === 'W_PACKAGE_LANGUAGE_NOT_APPROVED')!.message, /tell the author/);

  // A text changed since: French goes in with it in English, said.
  edit.updateCourseSettings(dir, { title: 'Orbital rendezvous, again' });
  const stale = await build(dir, { out: path.join(out, 'stale'), emit: 'dir', target: 'web', writeLock: false, languages: ['fr'] });
  assert.ok(stale.ok);
  assert.deepEqual(codes(stale.diagnostics), ['W_PACKAGE_LANGUAGE_INCOMPLETE fr', 'W_PACKAGE_LANGUAGE_NOT_APPROVED fr']);
  assert.match(stale.diagnostics.find((d) => d.code === 'W_PACKAGE_LANGUAGE_INCOMPLETE')!.message, /1 text out of date .*read those texts in en/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('course.json delivery.languages and defaultLanguage: what every build holds, and where learners start', async () => {
  const dir = copyCourse(BILINGUAL);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-languages-'));
  edit.updateCourseSettings(dir, { delivery: { languages: ['en', 'fr'], defaultLanguage: 'fr' } });
  const kept = await build(dir, { out: path.join(out, 'kept'), emit: 'dir', target: 'web', writeLock: false });
  assert.ok(kept.ok);
  const data = courseData(kept.files);
  assert.deepEqual([data.languages, data.defaultLanguage], [['en', 'fr'], 'fr']);
  assert.deepEqual(codes(kept.diagnostics), [], 'approved and complete: nothing to say');
  // The French course data does not carry it again: the player reads the course's own.
  assert.equal(courseData(kept.files, 'elabora/course.fr.js').defaultLanguage, undefined);
  // all follows the approvals; a default the package does not hold is said, and learners start in English.
  edit.updateCourseSettings(dir, { delivery: { languages: 'all', defaultLanguage: 'de' } });
  const all = await build(dir, { out: path.join(out, 'all'), emit: 'dir', target: 'web', writeLock: false });
  assert.ok(all.ok);
  assert.deepEqual([courseData(all.files).languages, courseData(all.files).defaultLanguage], [['en', 'fr'], undefined]);
  assert.deepEqual(codes(all.diagnostics), ['W_PACKAGE_DEFAULT_LANGUAGE de']);
  // Asked for the course's own alone (a review, a package per language): nothing said of the default.
  const alone = await build(dir, { out: path.join(out, 'alone'), emit: 'dir', target: 'web', writeLock: false, languages: [] });
  assert.ok(alone.ok && !alone.files.has('elabora/course.fr.js'));
  assert.deepEqual(codes(alone.diagnostics), []);
  fs.rmSync(out, { recursive: true, force: true });
});

test('the Aperçu tries every translation, approved or not, with « Langue » shown whatever the player says', async () => {
  const dir = copyCourse(BILINGUAL);
  fs.rmSync(path.join(dir, 'translations/fr.approval.json'));
  edit.updatePlayer(dir, { disable: ['language'] });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-languages-'));
  const tried = await build(dir, { out, emit: 'dir', writeLock: false, preview: true, tryLanguages: true, media: 'link' });
  assert.ok(tried.ok);
  const data = courseData(tried.files);
  assert.deepEqual(data.languages, ['en', 'fr']);
  assert.ok([data.player.top, data.player.bottom].some((bar) => bar?.items.some((item) => item.id === 'language')), 'the language item shows');
  assert.deepEqual(codes(tried.diagnostics), [], 'the Aperçu says nothing of approvals');
  fs.rmSync(out, { recursive: true, force: true });
});

test('one package per language: the course\'s own, then each language asked, as it is', async () => {
  const dir = copyCourse(BILINGUAL);
  fs.rmSync(path.join(dir, 'translations/fr.approval.json'));
  assert.equal(languagePackagesOf(dir), 'one');
  edit.updateCourseSettings(dir, { delivery: { languages: ['en', 'fr'], languagePackages: 'each' } });
  assert.equal(languagePackagesOf(dir), 'each');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-languages-'));
  const made = await buildLanguagePackages(dir, { out, writeLock: false });
  assert.deepEqual(made.map((one) => [one.language, one.result.ok]), [['en', true], ['fr', true]]);
  const [english, french] = made;
  assert.ok(english.result.ok && french.result.ok);
  assert.equal(english.result.files.has('elabora/course.fr.js'), false);
  assert.equal(courseData(french.result.files).language, 'fr');
  assert.equal(courseData(french.result.files).languages, undefined);
  assert.notEqual(english.result.zipPath, french.result.zipPath);
  assert.ok(fs.existsSync(english.result.zipPath!) && fs.existsSync(french.result.zipPath!));
  assert.deepEqual(codes(french.result.diagnostics, 'W_PACKAGE_LANGUAGE'), ['W_PACKAGE_LANGUAGE_NOT_APPROVED fr']);
  assert.equal(french.translation?.plan, 'draft');
  assert.equal(readJSON(dir, 'course.json').delivery.languagePackages, 'each');
  fs.rmSync(out, { recursive: true, force: true });
});

test('the language a learner starts in: their choice, the page\'s, the LMS\'s, the author\'s, the course\'s own', () => {
  const languages = ['en', 'fr', 'pt-BR'];
  assert.equal(matchLanguage('FR', languages), 'fr');
  assert.equal(matchLanguage('fr_CA', languages), 'fr');
  assert.equal(matchLanguage('pt', languages), 'pt-BR');
  assert.equal(matchLanguage('pt-br', languages), 'pt-BR');
  assert.equal(matchLanguage('de', languages), null);
  assert.equal(matchLanguage('', languages), null);
  assert.deepEqual(preferenceList('en-US, fr-FR,,fr-BE'), ['en-US', 'fr-FR', 'fr-BE']);
  assert.equal(startLanguage({ languages, chosen: 'en', page: 'fr', lms: ['pt'], fallback: 'fr' }), 'en', 'the learner\'s own choice first');
  assert.equal(startLanguage({ languages, page: 'pt-BR', lms: ['fr'] }), 'pt-BR');
  assert.equal(startLanguage({ languages, page: 'de', lms: ['de-DE', 'fr-CA'], fallback: 'pt-BR' }), 'fr', 'the first preference the package holds');
  assert.equal(startLanguage({ languages, lms: [], fallback: 'pt-BR' }), 'pt-BR');
  assert.equal(startLanguage({ languages, chosen: 'it', fallback: 'de' }), 'en');
});
