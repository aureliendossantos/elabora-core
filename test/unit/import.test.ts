import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectImport, importCourse, ImportError, IMPORT_REPORT_FILE, vettedFont } from '@elabora/node/import/index';
import { validateDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { listTrash } from '@elabora/node/library/index';
import { htmlToMarkdown, htmlToText } from '@elabora/core/import/html-markdown';
import { parseXml, deepText } from '@elabora/core/import/xml';
import { findRiseCourse, readRiseLocale } from '@elabora/core/import/rise';
import { parseProvidedData, storylineFontFamily } from '@elabora/core/import/storyline-published';
import { layoutTree, flatten } from '@elabora/core/import/layout';
import { convertCourse } from '@elabora/core/import/convert';
import type { SourceCourse, SourceItem } from '@elabora/core/import/model';
import { riseCourse, riseScormFiles, riseLocaleFiles, storylinePublishedFiles, storySourceFiles, zipOf, writeFolder } from '../../scripts/make-import-fixtures.ts';
import { ROOT } from '../helpers.ts';

// The Storyline and Rise importer (beta, docs/decisions.md D47) on synthetic modules written by
// scripts/make-import-fixtures.ts: their structure imitates real exports, their content is ours.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix = 'elabora-import-'): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};
const asZip = (name: string, files: Map<string, string | Uint8Array>): string => {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, zipOf(files));
  return file;
};
const asFolder = (files: Map<string, string | Uint8Array>): string => {
  const dir = tempDir();
  writeFolder(dir, files);
  return dir;
};
const target = () => path.join(tempDir('elabora-import-out-'), 'module');
const readJson = (dir: string, file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const screens = (dir: string) => fs.readdirSync(path.join(dir, 'screens')).sort().map((file) => readJson(dir, `screens/${file}`));
const allBlocks = (screen: { blocks: unknown[]; layers?: { blocks: unknown[] }[] }) => [...screen.blocks, ...(screen.layers ?? []).flatMap((layer) => layer.blocks)] as { id: string; type: string; props: Record<string, unknown>; note?: string; step?: number; hidden?: boolean; width?: string }[];

describe('reading the sources', () => {
  test('HTML becomes the Markdown subset: emphasis, links, lists, tables; no raw HTML', () => {
    assert.equal(htmlToMarkdown('<p>Un <strong>mot</strong> et <em>un autre</em>, <a href="https://example.org">un lien</a>.</p><p>Fin $5</p>'), 'Un **mot** et *un autre*, [un lien](https://example.org).\n\nFin \\$5');
    assert.equal(htmlToMarkdown('<ol><li>Un</li><li>Deux</li></ol>'), '1. Un\n2. Deux');
    assert.equal(htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'), '| A | B |\n| --- | --- |\n| 1 | 2 |');
    assert.equal(htmlToMarkdown('<div data-editor-id="x"><p>Texte<script>alert(1)</script></p></div>'), 'Texte');
    assert.equal(htmlToText('<p>Ligne&nbsp;un</p><p>deux</p>'), 'Ligne un deux');
  });

  test('the XML reader keeps text and children in order, entities decoded', () => {
    const doc = parseXml('﻿<?xml version="1.0"?><a x="1 &amp; 2">Un <b>deux</b> trois<![CDATA[ <quatre> ]]></a>');
    assert.equal(doc?.attributes.x, '1 & 2');
    assert.equal(deepText(doc), 'Un deux trois <quatre> ');
  });

  test('Storyline data files and font names', () => {
    const provided = parseProvidedData(`﻿window.globalProvideData('slide', '{"title":"L\\'été","n":"a\\\\"b","u":"\\u00e9"}');`);
    assert.deepEqual(provided, { kind: 'slide', data: { title: 'L\'été', n: 'a"b', u: 'é' } });
    assert.equal(storylineFontFamily("'Articulate Charset0_v8MBBDD1F1C','Articulate'"), 'Articulate');
    assert.equal(storylineFontFamily("'Open SansBold CharsBoldE47A47C6'"), 'Open Sans');
    assert.equal(parseProvidedData('not a data file'), null);
  });

  test('each way Rise embeds its course is found', () => {
    const data = riseCourse();
    const b64 = Buffer.from(JSON.stringify(data)).toString('base64');
    const course = Buffer.from(JSON.stringify(data.course)).toString('base64');
    assert.equal((findRiseCourse(`<script>async function __fetchCourse() { return Promise.resolve(deserialize("${b64}")) }</script>`).data?.course as { title: string }).title, 'Sécurité au poste de travail');
    assert.equal((findRiseCourse(`window.labelSet = {};window.courseData = "${b64}";`).data?.course as { title: string }).title, 'Sécurité au poste de travail');
    assert.equal((findRiseCourse(`window.course = '${course}';`).data?.course as { title: string }).title, 'Sécurité au poste de travail');
    const page = findRiseCourse('<script>window.i18n = {"available":["und"],"default":"und"};</script>');
    assert.deepEqual(page, { localeFile: 'locales/und.js', data: null });
    assert.equal((readRiseLocale(`__resolveJsonp("course:und","${b64}")`)?.course as { title: string }).title, 'Sécurité au poste de travail');
  });

  test('a slide reads by its bands, then its columns, then top to bottom (D47)', () => {
    const item = (ref: string, x: number, y: number, width: number, height: number): SourceItem => ({ ref, kind: 'text', markdown: ref, box: { x, y, width, height } });
    const tree = layoutTree([item('right', 380, 120, 300, 200), item('footer', 40, 400, 640, 40), item('title', 40, 20, 640, 50), item('left-1', 40, 120, 300, 90), item('left-2', 40, 220, 300, 100)]);
    assert.deepEqual(flatten(tree).map((entry) => entry.ref), ['title', 'left-1', 'left-2', 'right', 'footer']);
    // The author's focus order wins.
    const ordered = layoutTree([{ ...item('b', 0, 0, 10, 10), order: 2 }, { ...item('a', 0, 100, 10, 10), order: 1 }]);
    assert.deepEqual(flatten(ordered).map((entry) => entry.ref), ['a', 'b']);
  });

  test('fonts without a web licence become vetted fonts of their kind', () => {
    assert.deepEqual(vettedFont('Lato'), { family: 'Lato', same: true });
    assert.deepEqual(vettedFont('Articulate'), { family: 'Source Sans 3', same: false });
    assert.deepEqual(vettedFont('Times New Roman'), { family: 'Source Serif 4', same: false });
    assert.deepEqual(vettedFont('Courier New'), { family: 'JetBrains Mono', same: false });
    assert.equal(vettedFont('+minor'), null);
  });
});

describe('detecting what a file is', () => {
  test('Rise, Storyline published and Storyline source, zipped or not', async () => {
    const rise = await detectImport(asZip('rise.zip', riseScormFiles()));
    assert.equal(rise.kind, 'rise');
    assert.equal(rise.root, 'scormcontent');
    assert.equal(rise.package, 'scorm');
    assert.equal(rise.beta, true);
    const web = await detectImport(asFolder(riseLocaleFiles()));
    assert.deepEqual([web.kind, web.root, web.container, web.package], ['rise', 'content', 'folder', 'web']);
    const published = asFolder(storylinePublishedFiles());
    assert.equal((await detectImport(published)).kind, 'storyline-published');
    // story.html stands for its folder.
    assert.equal((await detectImport(path.join(published, 'story.html'))).kind, 'storyline-published');
    // A published course zipped inside a folder of its own.
    const nested = new Map([...storylinePublishedFiles()].map(([name, content]) => [`Préparer une intervention - Storyline output/${name}`, content]));
    const nestedResult = await detectImport(asZip('published.zip', nested));
    assert.deepEqual([nestedResult.kind, nestedResult.root], ['storyline-published', 'Préparer une intervention - Storyline output']);
    assert.equal((await detectImport(asZip('fixture.story', storySourceFiles()))).kind, 'storyline-source');
  });

  test('Elabora archives and folders are told apart; anything else is not a source', async () => {
    assert.equal((await detectImport(path.join(ROOT, 'examples', 'diagnostic-reseau'))).kind, 'elabora-folder');
    assert.equal((await detectImport(asZip('x.elabora', new Map([['elabora-archive.json', '{}']])))).kind, 'elabora-archive');
    const other = await detectImport(asZip('photos.zip', new Map([['a.txt', 'hello']])));
    assert.equal(other.kind, null);
    assert.match(other.reason, /neither a Storyline project/);
    const notZip = path.join(tempDir(), 'notes.story');
    fs.writeFileSync(notZip, 'plain text');
    assert.equal((await detectImport(notZip)).kind, null);
    await assert.rejects(importCourse({ file: path.join(ROOT, 'examples', 'diagnostic-reseau'), dir: target() }), (error: unknown) => error instanceof ImportError && error.code === 'E_IMPORT_ELABORA');
    await assert.rejects(importCourse({ file: path.join(tempDir(), 'missing.story'), dir: target() }), (error: unknown) => error instanceof ImportError && error.code === 'E_IMPORT_UNREADABLE');
  });
});

describe('importing', () => {
  test('a Rise SCORM export: lessons, statements, accordions, steps, questions, quiz, fonts', async () => {
    const dir = target();
    const result = await importCourse({ file: asZip('rise.zip', riseScormFiles()), dir });
    assert.equal(result.kind, 'rise');
    assert.deepEqual(result.validation.errors, 0, JSON.stringify(validateDir(dir).diagnostics.filter((d: { severity: string }) => d.severity === 'error')));
    const course = readJson(dir, 'course.json');
    assert.equal(course.title, 'Sécurité au poste de travail');
    assert.equal(course.language, 'fr');
    assert.equal(course.presentation.mode, 'scroll');
    assert.deepEqual(course.sections.map((section: { title: string }) => section.title), ['Les bases']);
    assert.deepEqual(course.completion, { reportAs: 'passed-incomplete', masteryScore: 80 });
    const [quiz, lesson] = screens(dir);
    const blocks = allBlocks(lesson);
    assert.deepEqual(blocks.map((block) => block.type).slice(0, 8), ['heading', 'text', 'callout', 'text', 'image', 'accordion', 'accordion', 'quiz']);
    assert.equal(blocks[1].props.markdown, 'Un poste rangé évite **les chutes** et *les pertes*. Voir [le guide](https://example.org/guide).');
    assert.equal(blocks[4].props.alt, 'Un bureau rangé, vu de dessus');
    assert.ok(fs.existsSync(path.join(dir, 'assets', blocks[4].props.asset as string)));
    // Tabs have no block yet: an accordion, with a note for the author.
    assert.match(blocks[6].note ?? '', /Onglets/);
    // The continue divider: what follows is step 2, opened once the question above is answered when one is.
    assert.equal(blocks[7].step, 2);
    assert.equal((blocks[7].props.options as { feedback: string }[])[1].feedback, 'Non : on peut s\'y prendre les pieds.');
    // The button to a lesson is a button and an event.
    const button = blocks.find((block) => block.type === 'button')!;
    assert.deepEqual(lesson.events[0], { id: lesson.events[0].id, on: { type: 'click', target: button.id }, do: [{ type: 'go-to', screen: quiz.id }] });
    assert.deepEqual(allBlocks(quiz).map((block) => block.type), ['quiz', 'results']);
    assert.equal(allBlocks(quiz)[0].props.mode, 'multiple');
    assert.deepEqual(result.fonts.sort(), ['Lato', 'Merriweather']);
    // The report: on disk, and every loss there.
    const report = readJson(dir, IMPORT_REPORT_FILE);
    assert.equal(report.format, 'elabora-import-report/1');
    assert.equal(report.beta, true);
    assert.match(report.summary, /^2 leçons de l'export Rise deviennent 2 écrans/);
    const features = report.losses.map((loss: { feature: string }) => loss.feature);
    for (const feature of ['Onglets (Rise tabs)', 'Texte à trous (Rise fill in the blank)', 'Image interactive (Rise labeled graphic)', 'Bloc Storyline dans Rise']) assert.ok(features.includes(feature), feature);
    assert.ok(report.losses.every((loss: { message: string; status: string }) => loss.message && ['fallback', 'not-yet', 'dropped'].includes(loss.status)));
    // The plan is a draft with one item per screen, every screen covering its own.
    const plan = readJson(dir, 'plan.json');
    assert.equal(plan.status, undefined, 'a plan with no version yet');
    assert.deepEqual(plan.items.map((item: { id: string }) => item.id), ['ITEM-1', 'ITEM-2']);
  });

  test('a Rise web export whose course is in a locale file gives the same module', async () => {
    const a = target();
    const b = target();
    await importCourse({ file: asZip('rise.zip', riseScormFiles()), dir: a });
    await importCourse({ file: asFolder(riseLocaleFiles()), dir: b });
    assert.deepEqual(screens(a), screens(b));
  });

  test('a published Storyline course: title, columns, layer, hotspot, triggers, question, results, notes', async () => {
    const dir = target();
    const result = await importCourse({ file: asZip('published.zip', storylinePublishedFiles()), dir });
    assert.equal(result.validation.errors, 0, JSON.stringify(validateDir(dir).diagnostics.filter((d: { severity: string }) => d.severity === 'error')));
    const course = readJson(dir, 'course.json');
    assert.equal(course.title, 'Préparer une intervention');
    assert.equal(course.presentation.mode, 'slides');
    assert.deepEqual(course.sections.map((section: { title: string }) => section.title), ['Préparer une intervention']);
    // Only the variable a trigger uses; the player's own (CurrentQuiz_…) never.
    assert.deepEqual(course.variables, [{ id: 'visites', type: 'number', default: 0 }]);
    const welcome = screens(dir).find((screen) => screen.id === 'bienvenue')!;
    assert.equal(welcome.title, 'Bienvenue dans le module');
    const blocks = allBlocks(welcome);
    assert.deepEqual(blocks.slice(0, 2).map((block) => [block.type, block.width]), [['text', 'half'], ['image', 'half']]);
    assert.equal(blocks[1].props.alt, 'Une technicienne devant une armoire électrique');
    // The invisible hotspot over "Voir les consignes" is a button named by that text, which opens the layer.
    const hotspot = blocks.find((block) => block.type === 'button' && block.props.label === 'Voir les consignes')!;
    assert.ok(hotspot.note);
    const layer = welcome.layers[0];
    assert.equal(layer.presentation, 'dialog');
    const events = welcome.events as { on: { target: string }; do: { type: string; layer?: string; screen?: string }[] }[];
    assert.deepEqual(events.find((event) => event.on.target === hotspot.id)!.do, [{ type: 'show-layer', layer: layer.id }]);
    const start = blocks.find((block) => block.props.label === 'Commencer')!;
    assert.deepEqual(events.find((event) => event.on.target === start.id)!.do, [{ type: 'increment-variable', variable: 'visites', by: 1 }, { type: 'go-to', screen: 'question' }]);
    const close = blocks.find((block) => block.props.label === 'Fermer')!;
    assert.deepEqual(events.find((event) => event.on.target === close.id)!.do, [{ type: 'hide-layer' }]);
    // The question: its feedback layers became its options' feedback.
    const question = screens(dir).find((screen) => screen.id === 'question')!;
    const quiz = allBlocks(question).find((block) => block.type === 'quiz')!;
    assert.deepEqual((quiz.props.options as { text: string; correct: boolean; feedback: string }[]).map((option) => [option.text, option.correct, option.feedback]), [['Je coupe le courant', true, 'Oui : sans courant, aucun risque d\'électrisation.'], ['J\'ouvre l\'armoire', false, 'Non : l\'armoire est encore sous tension.']]);
    assert.equal(question.layers, undefined);
    assert.equal(allBlocks(screens(dir).find((screen) => screen.id === 'resultats')!).at(-1)!.type, 'results');
    // Notes go to the plan; the background, the JavaScript and the font are reported.
    assert.match(readJson(dir, 'plan.json').items[0].description, /Voix off/);
    const report = result.report;
    assert.deepEqual(report.decisions.map((decision) => decision.id), ['presentation', 'fonts', 'backgrounds', 'timing', 'hotspots']);
    assert.equal(report.decisions.find((decision) => decision.id === 'fonts')!.title, '10 textes en Articulate passent en Source Sans 3');
    assert.ok(report.losses.some((loss) => loss.code === 'javascript' && loss.status === 'dropped'));
    assert.ok(report.losses.some((loss) => loss.code === 'variable' && loss.feature === 'NonUtilisee'));
  });

  test('a Storyline source (.story): texts, pictures, hidden objects, conditions, questions, the Content Library left out', async () => {
    const dir = target();
    const result = await importCourse({ file: asZip('premiers-secours.story', storySourceFiles()), dir });
    assert.equal(result.kind, 'storyline-source');
    assert.equal(result.validation.errors, 0, JSON.stringify(validateDir(dir).diagnostics.filter((d: { severity: string }) => d.severity === 'error')));
    assert.equal(readJson(dir, 'course.json').title, 'Les gestes de premiers secours');
    const [first, second] = [screens(dir).find((screen) => screen.id === 'proteger-alerter-secourir')!, screens(dir).find((screen) => screen.id === 'question')!];
    assert.equal(first.title, 'Les trois gestes');
    const blocks = allBlocks(first);
    const tip = blocks.find((block) => block.props.markdown === 'Le 15 est le numéro du SAMU.')!;
    assert.equal(tip.hidden, true);
    const events = first.events as { id: string; on: { target: string }; if?: unknown; do: unknown[] }[];
    const show = blocks.find((block) => block.props.label === 'Voir l\'astuce')!;
    assert.deepEqual(events.find((event) => event.on.target === show.id)!.do, [{ type: 'show-block', block: tip.id }, { type: 'increment-variable', variable: 'essais', by: 1 }]);
    const next = blocks.find((block) => block.props.label === 'Suite')!;
    assert.deepEqual(events.find((event) => event.on.target === next.id), { id: events.find((event) => event.on.target === next.id)!.id, on: { type: 'click', target: next.id }, if: [{ variable: 'essais', op: 'gte', value: 1 }], do: [{ type: 'go-to', screen: 'question' }] });
    // The texture installed with Articulate is not taken, and the author is told where it was.
    assert.ok(!fs.readdirSync(path.join(dir, 'assets', 'images')).some((file) => file.includes('bois')));
    assert.equal(result.report.decisions.find((decision) => decision.id === 'content-library')?.count, 1);
    assert.ok(blocks.some((block) => /Content Library/.test(block.note ?? '')));
    const quiz = allBlocks(second).find((block) => block.type === 'quiz')!;
    assert.equal(quiz.props.stem, 'Quel numéro appeler ?');
    assert.deepEqual((quiz.props.options as { feedback: string }[]).map((option) => option.feedback), ['Oui, le 15 joint le SAMU.', 'Non, composez le 15.']);
    assert.deepEqual(second.layers.map((layer: { title: string; presentation: string }) => [layer.title, layer.presentation]), [['Rappel', 'panel']]);
    assert.deepEqual(readJson(dir, 'course.json').variables, [{ id: 'essais', type: 'number', default: 0 }]);
  });

  test('the report\'s choices change the import when it is run again with them', async () => {
    const file = asZip('published.zip', storylinePublishedFiles());
    const dir = target();
    const result = await importCourse({ file, dir, choices: { presentation: 'scroll', backgrounds: 'keep', timing: 'steps', fonts: 'theme' } });
    assert.equal(result.validation.errors, 0);
    assert.equal(readJson(dir, 'course.json').presentation.mode, 'scroll');
    const blocks = allBlocks(screens(dir).find((screen) => screen.id === 'bienvenue')!);
    assert.equal(blocks[0].type, 'image');
    assert.equal(blocks[0].props.decorative, true);
    assert.equal(blocks.find((block) => block.props.markdown === 'Prenez le temps de lire chaque écran.')!.step, 2);
    assert.deepEqual(result.fonts, []);
    assert.equal(result.report.decisions.find((decision) => decision.id === 'presentation')!.applied, 'scroll');
  });

  test('the same source gives the same module', async () => {
    const file = asZip('fixture.story', storySourceFiles());
    const [a, b] = [target(), target()];
    await importCourse({ file, dir: a });
    await importCourse({ file, dir: b });
    assert.deepEqual(screens(a), screens(b));
    assert.deepEqual(readJson(a, IMPORT_REPORT_FILE), readJson(b, IMPORT_REPORT_FILE));
  });

  test('into the library, as a new project; never into a folder that is not empty', async () => {
    const library = path.join(tempDir('elabora-import-library-'), 'Library');
    const saved = process.env.ELABORA_LIBRARY;
    process.env.ELABORA_LIBRARY = library;
    try {
      const result = await importCourse({ file: asZip('rise.zip', riseScormFiles()) });
      assert.ok(result.project);
      assert.equal(path.dirname(result.dir), library);
      assert.equal(result.project!.title, 'Sécurité au poste de travail');
      assert.ok(!fs.existsSync(path.join(library, '.staging')) || fs.readdirSync(path.join(library, '.staging')).length === 0);
    } finally {
      if (saved === undefined) delete process.env.ELABORA_LIBRARY; else process.env.ELABORA_LIBRARY = saved;
    }
    const full = tempDir();
    fs.writeFileSync(path.join(full, 'keep.txt'), 'mine');
    await assert.rejects(importCourse({ file: asZip('rise.zip', riseScormFiles()), dir: full }), (error: unknown) => error instanceof ImportError && error.code === 'E_IMPORT_TARGET');
  });

  test('a page whose objects say nothing keeps its title; images without alt are marked and reported', () => {
    const source: SourceCourse = {
      kind: 'storyline-published', title: 'Vide', slideSize: { width: 720, height: 540 }, variables: [], losses: [],
      sections: [{ ref: 's', title: 'Scène', pages: [
        { ref: 'p1', title: 'Rien', kind: 'content', positioned: true, items: [{ ref: 'shape', kind: 'shape', box: { x: 0, y: 0, width: 10, height: 10 } }], layers: [], triggers: [] },
        { ref: 'p2', title: 'Image', kind: 'content', positioned: true, items: [{ ref: 'img', kind: 'image', media: { path: 'mobile/a.png', kind: 'image' }, box: { x: 10, y: 10, width: 100, height: 100 } }], layers: [], triggers: [] }
      ] }]
    };
    const converted = convertCourse(source, { language: 'en' });
    const rien = JSON.parse(converted.files.get('screens/rien.json')!);
    assert.deepEqual(rien.blocks.map((block: { type: string; props: { text: string } }) => [block.type, block.props.text]), [['heading', 'Rien']]);
    const image = JSON.parse(converted.files.get('screens/image.json')!);
    assert.equal(image.blocks[0].props.decorative, true);
    assert.equal(converted.report.language, 'en');
    assert.match(converted.report.summary, /^2 slides of the published Storyline course became 2 screens/);
    assert.equal(converted.report.decisions.find((decision) => decision.id === 'alt-missing')!.title, '1 image without alternative text marked decorative');
  });
});

describe('the app\'s import: the brief, the report settled, the choices made again', () => {
  const inLibrary = async <T>(run: (library: string) => Promise<T>): Promise<T> => {
    const library = path.join(tempDir('elabora-import-library-'), 'Library');
    const saved = process.env.ELABORA_LIBRARY;
    process.env.ELABORA_LIBRARY = library;
    try { return await run(library); } finally { if (saved === undefined) delete process.env.ELABORA_LIBRARY; else process.env.ELABORA_LIBRARY = saved; }
  };
  const brief = { audience: 'Agents d\'accueil', businessGoal: 'Moins d\'accidents déclarés', duration: { min: 10, max: 20 }, presentation: 'scroll' as const, lms: ['moodle'], notes: 'La demande : reprendre le module de 2019.' };

  test('what the author said of the module is kept as a new course keeps it (D51); the language the source does not say is the one given', async () => {
    const dir = target();
    const result = await importCourse({ file: asZip('fixture.story', storySourceFiles()), dir, brief, defaultLanguage: 'en' });
    assert.equal(result.validation.errors, 0);
    const plan = readJson(dir, 'plan.json');
    const course = readJson(dir, 'course.json');
    assert.equal(plan.audience.role, 'Agents d\'accueil');
    assert.equal(plan.businessGoal, 'Moins d\'accidents déclarés');
    assert.deepEqual(plan.duration, { min: 10, max: 20 });
    assert.equal(plan.status, undefined, 'a plan with no version yet');
    assert.deepEqual(course.delivery, { lms: ['moodle'] });
    assert.equal(course.presentation.mode, 'scroll', 'the brief\'s presentation is the presentation choice\'s default');
    assert.equal(course.language, 'en');
    assert.equal(result.report.language, 'en');
    assert.equal(result.report.choices.presentation, 'scroll');
    assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('## Notes for this course\n<!--') && fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('La demande : reprendre le module de 2019.'));
    // Rise says its language: it is kept; its lessons always scroll.
    const rise = target();
    await importCourse({ file: asZip('rise.zip', riseScormFiles()), dir: rise, brief: { ...brief, presentation: 'slides' }, defaultLanguage: 'en' });
    assert.equal(readJson(rise, 'course.json').language, 'fr');
    assert.equal(readJson(rise, 'course.json').presentation.mode, 'scroll');
    await assert.rejects(importCourse({ file: asZip('fixture.story', storySourceFiles()), dir: target(), brief: { duration: { min: 30, max: 10 } } }), /brief\.duration/);
  });

  test('accepting a decision and closing the report are journaled changes that undo reverts', async () => {
    const dir = target();
    await importCourse({ file: asZip('published.zip', storylinePublishedFiles()), dir });
    const decisions = readJson(dir, IMPORT_REPORT_FILE).decisions as { accepted?: boolean }[];
    assert.ok(decisions.length > 1);
    edit.settleImportReport(dir, { accept: [1] });
    assert.equal(readJson(dir, IMPORT_REPORT_FILE).decisions[1].accepted, true);
    assert.equal(readJson(dir, IMPORT_REPORT_FILE).decisions[0].accepted, undefined);
    assert.throws(() => edit.settleImportReport(dir, { accept: [decisions.length] }), /has no decision/);
    edit.settleImportReport(dir, { close: true });
    assert.ok(!fs.existsSync(path.join(dir, IMPORT_REPORT_FILE)));
    assert.throws(() => edit.settleImportReport(dir, { close: true }), (error: unknown) => (error as { code?: string }).code === 'E_NO_IMPORT_REPORT');
    edit.undo(dir);
    assert.equal(readJson(dir, IMPORT_REPORT_FILE).decisions[1].accepted, true);
    assert.equal(validateDir(dir).summary.errors, 0);
  });

  test('imported again with other choices, the module keeps its place, history, sources, title, notes and brief; the one before goes to the trash with a version', async () => {
    await inLibrary(async (library) => {
      const file = asZip('fixture.story', storySourceFiles());
      const first = await importCourse({ file, brief, defaultLanguage: 'fr' });
      const dir = first.dir;
      const id = path.basename(dir);
      // The author's work since: a renamed module, a note of theirs, a source, the audience retold.
      edit.updateCourseSettings(dir, { title: 'Accueil en gare, version 2' });
      fs.appendFileSync(path.join(dir, 'AGENTS.md'), 'Une note de l\'auteur.\n');
      fs.mkdirSync(path.join(dir, 'sources'));
      fs.writeFileSync(path.join(dir, 'sources', 'brief.docx'), 'le brief');
      const course = readJson(dir, 'course.json');
      const fonts = first.report.decisions.findIndex((decision) => decision.id === 'fonts');
      edit.settleImportReport(dir, { accept: [fonts, first.report.decisions.findIndex((decision) => decision.id === 'timing')] });
      // Imported again from its own sources/, as the app does: the source closed before the folder moves.
      fs.copyFileSync(file, path.join(dir, 'sources', 'fixture.story'));
      const again = await importCourse({ file: path.join(dir, 'sources', 'fixture.story'), replace: id, choices: { ...first.report.choices, timing: 'steps' } });
      assert.equal(again.dir, dir);
      assert.equal(again.project!.id, id);
      assert.deepEqual(fs.readdirSync(library).filter((name) => !name.startsWith('.')), [id]);
      const now = readJson(dir, 'course.json');
      assert.equal(now.title, 'Accueil en gare, version 2');
      assert.equal(now.id, course.id);
      assert.equal(now.language, 'fr');
      assert.equal(now.presentation.mode, 'scroll', 'the earlier choices are kept');
      assert.deepEqual(now.delivery, { lms: ['moodle'] });
      assert.equal(readJson(dir, 'plan.json').audience.role, 'Agents d\'accueil');
      assert.equal(again.report.choices.timing, 'steps');
      // The fonts accepted stay accepted; the timing made otherwise is said as it is now, to accept again.
      assert.equal(again.report.decisions.find((decision) => decision.id === 'fonts')!.accepted, true);
      const timing = again.report.decisions.find((decision) => decision.id === 'timing')!;
      assert.equal(timing.accepted, undefined);
      assert.match(timing.title, /en étapes$/);
      assert.equal(readJson(dir, IMPORT_REPORT_FILE).decisions.find((decision: { id: string }) => decision.id === 'fonts').accepted, true);
      assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').endsWith('Une note de l\'auteur.\n'));
      assert.equal(fs.readFileSync(path.join(dir, 'sources', 'brief.docx'), 'utf8'), 'le brief');
      assert.ok(fs.existsSync(path.join(dir, 'sources', 'fixture.story')));
      assert.ok(again.replaced?.version, 'a version of the module just before');
      assert.ok(listTrash().some((entry) => entry.entry === again.replaced!.trashEntry && entry.reason === 'replaced'));
      assert.ok(edit.history(dir, 50).some((entry) => (entry as { op?: string }).op === 'update_course'), 'the history stays with the module');
      assert.equal(again.validation.errors, 0);
      await assert.rejects(importCourse({ file, replace: id, dir: target() }), (error: unknown) => error instanceof ImportError && error.code === 'E_IMPORT_TARGET');
      // The same source imported again as a new module gets a course id of its own.
      const other = await importCourse({ file });
      assert.equal(readJson(other.dir, 'course.json').id, `${course.id}-2`);
    });
  });
});

describe('elabora import', () => {
  test('imports a Storyline or Rise module into a folder and says what it lost', () => {
    const dir = target();
    const run = spawnSync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), 'import', asZip('fixture.story', storySourceFiles()), dir, '--choose', 'presentation=scroll'], { encoding: 'utf8', env: { ...process.env, ELABORA_AUTHOR: 'human' } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Beta import of a Storyline project/);
    assert.match(run.stdout, /presentation=slides · presentation=scroll \(applied\)/);
    assert.match(run.stdout, /loss\(es\), each in import-report\.json/);
    assert.equal(readJson(dir, 'course.json').presentation.mode, 'scroll');
    const bad = spawnSync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), 'import', asZip('fixture.story', storySourceFiles()), target(), '--choose', 'presentation=film'], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--choose takes decision=choice/);
    const archiveWithFolder = spawnSync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), 'import', path.join(ROOT, 'examples', 'diagnostic-reseau'), target()], { encoding: 'utf8' });
    assert.notEqual(archiveWithFolder.status, 0);
    assert.match(archiveWithFolder.stderr, /only those are imported into a folder/);
  });
});
