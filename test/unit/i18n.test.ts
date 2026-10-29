import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatMessage } from '@elabora/player/message';
import { labelsFor, labelKeys, labelLanguages, formatLabel } from '@elabora/player/labels';
import { toXliff, readXliff } from '@elabora/core/i18n/xliff';
import { extractUnits } from '@elabora/core/i18n/units';
import { translatedCourse } from '@elabora/core/i18n/translate';
import { findText } from '@elabora/core/commands/text';
import { screenParts } from '@elabora/core/project/parts';
import { exportTranslation, translationStatus, buildTranslation, approveTranslation, translationFile, withCourseLanguage } from '@elabora/node/translate';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { validateDir } from '@elabora/node/project-reader';
import type { Block } from '@elabora/format';
import { ROOT, copyExample, readJSON, writeJSON, codes } from '../helpers.ts';

test('messages: values, plurals and selects follow the language', () => {
  assert.equal(formatMessage('Requirement {i} of {n}', { i: 1, n: 3 }), 'Requirement 1 of 3');
  const orbits = 'within {n, plural, one {# orbit} other {# orbits}}';
  assert.equal(formatMessage(orbits, { n: 1 }), 'within 1 orbit');
  assert.equal(formatMessage(orbits, { n: 3 }), 'within 3 orbits');
  assert.equal(formatMessage('{n, plural, one {# orbite} other {# orbites}}', { n: 1.5 }, 'fr'), '1,5 orbite');
  assert.equal(formatMessage('{n, plural, =0 {none} other {# left}}', { n: 0 }), 'none');
  assert.equal(formatMessage('{d, select, retro {{v} m/s back} other {no burn}}', { d: 'retro', v: '2.5' }), '2.5 m/s back');
  assert.equal(formatMessage('{gap} km', { gap: 1234.5 }, 'fr'), '1 234,5 km');
});

test('player labels: every language has every label, with plurals', () => {
  for (const lang of labelLanguages()) {
    const L = labelsFor(lang);
    for (const k of labelKeys()) assert.ok(L[k], `${lang}.${k}`);
    assert.notEqual(formatLabel(L.tryAgain, { n: 1 }, lang), formatLabel(L.tryAgain, { n: 2 }, lang), lang);
  }
  assert.ok(['fr', 'en', 'de', 'es', 'it', 'nl', 'pt'].every((l) => labelLanguages().includes(l)));
});

test('XLIFF: units survive a round trip, special characters included', () => {
  const units = [{ id: 'a.b', source: 'x < y & "z"\n\n$$\\frac{1}{2}$$', target: 'x < y & « z »', state: 'translated', notes: [{ category: 'format', text: 'markdown' }] }, { id: 'c', source: 'Only source' }];
  const back = readXliff(toXliff({ srcLang: 'en', trgLang: 'fr', original: 'c@1', units }));
  assert.equal(back.srcLang, 'en');
  assert.equal(back.trgLang, 'fr');
  assert.equal(back.units.get('a.b')?.source, units[0].source);
  assert.equal(back.units.get('a.b')?.target, units[0].target);
  assert.equal(back.units.get('a.b')?.state, 'translated');
  assert.equal(back.units.get('c')?.target, null);
});

test('XLIFF: word anchors as inline markers, read back where they were, other inline tags kept as text', () => {
  const source = "Ni l'imprimante & le partage ne marchent.";
  const target = 'Neither the printer & sharing work.';
  const units = [{ id: 'l2', source, sourceMarks: [{ id: 'w-imprimante', start: 5, end: 15 }, { id: 'w-partage', start: 21, end: 28 }], target, targetMarks: [{ id: 'w-imprimante', start: 12, end: 19 }], state: 'translated' }];
  const text = toXliff({ srcLang: 'fr', trgLang: 'en', original: 'c@1', units });
  assert.match(text, /<source>Ni l'<mrk id="w-imprimante" type="elabora:anchor">imprimante<\/mrk> &amp; le <mrk id="w-partage" type="elabora:anchor">partage<\/mrk> ne marchent\.<\/source>/);
  assert.match(text, /<target>Neither the <mrk id="w-imprimante" type="elabora:anchor">printer<\/mrk> &amp; sharing work\.<\/target>/);
  const back = readXliff(text).units.get('l2')!;
  assert.equal(back.source, source);
  assert.equal(back.target, target);
  assert.deepEqual(back.sourceMarks, units[0].sourceMarks);
  assert.deepEqual(back.targetMarks, units[0].targetMarks);
  // A CAT tool that wrote its own inline tags, or a marker without its type: the words stay, w- ids are anchors.
  const tool = text.replace('<target>Neither the <mrk id="w-imprimante" type="elabora:anchor">printer</mrk>', '<target><pc id="1">Neither</pc> the <mrk id="w-imprimante">printer</mrk>');
  const read = readXliff(tool).units.get('l2')!;
  assert.equal(read.target, target);
  assert.deepEqual(read.targetMarks, units[0].targetMarks);
});

test('translation units: plan, screens, blocks and free objects, with stable ids', () => {
  const units = extractUnits(loadProjectFromDir(copyExample()));
  const ids = new Set(units.map((u) => u.id));
  assert.ok(ids.has('course.title'));
  assert.ok([...ids].some((id) => id.startsWith('plan.text.')));
  assert.ok([...ids].some((id) => /^plan\.question\.[^.]+\.option\.[^.]+\.feedback$/.test(id)));
  assert.ok([...ids].some((id) => /^screen\.[^.]+\.title$/.test(id)));
  assert.ok([...ids].some((id) => /^block\.[^.]+\.a11y\.description$/.test(id)), 'object a11y text');
  assert.ok(units.every((u) => /^[A-Za-z0-9._-]+$/.test(u.id)), 'NMTOKEN ids');
  assert.equal(ids.size, units.length, 'unique ids');
});

test('translation: the words of a free-object list, also when a block leaves the list to the manifest', () => {
  const dir = copyExample();
  const mf = 'objects/diagnostic-reseau/object.manifest.json';
  const m = readJSON(dir, mf);
  m.props.properties.stops = {
    type: 'array', description: 'Étapes du parcours', 'x-control': 'list',
    items: { type: 'object', title: 'Étape', properties: { device: { type: 'string', title: 'Équipement', enum: ['routeur', 'parefeu'] }, description: { type: 'string', title: 'Note', 'x-translatable': true } } },
    default: [{ device: 'routeur', description: 'Premier saut' }, { device: 'parefeu', description: 'Filtrage' }]
  };
  writeJSON(dir, mf, m);
  const units = extractUnits(loadProjectFromDir(dir)).filter((u) => u.id.includes('.props.stops.'));
  assert.deepEqual(units.map((u) => [u.id, u.text, u.pointer]), [
    ['block.simulation-scene.props.stops.0.description', 'Premier saut', '/blocks/1/props/props/stops/0/description'],
    ['block.simulation-scene.props.stops.1.description', 'Filtrage', '/blocks/1/props/props/stops/1/description']
  ]);
  exportTranslation(dir, { to: 'en' });
  const x = readXliff(fs.readFileSync(translationFile(dir, 'en'), 'utf8'));
  const english: Record<string, string> = { 'block.simulation-scene.props.stops.0.description': 'First hop', 'block.simulation-scene.props.stops.1.description': 'Filtering' };
  fs.writeFileSync(translationFile(dir, 'en'), toXliff({ srcLang: 'fr', trgLang: 'en', original: 'x', units: [...x.units.values()].map((u) => ({ id: u.id, source: u.source, ...(english[u.id] ? { target: english[u.id], state: 'translated' } : {}) })) }));
  const screen = translatedCourse(loadProjectFromDir(dir), { to: 'en', allowMissing: true }).files.get('screens/simulation.json') as { blocks: Block[] };
  assert.deepEqual((screen.blocks[1].props as { props: { stops: unknown } }).props.stops, [{ device: 'routeur', description: 'First hop' }, { device: 'parefeu', description: 'Filtering' }]);
});

// The words of the network simulation's choices, as the example's manifest gives them.
const DEVICES = { commutateur: 'Commutateur', routeur: 'Routeur', parefeu: 'Pare-feu', serveur: "Serveur d'impression" };
const withDeviceLabels = (dir: string): void => {
  const mf = 'objects/diagnostic-reseau/object.manifest.json';
  const m = readJSON(dir, mf);
  m.props.properties.failingDevice['x-enum-labels'] = DEVICES;
  writeJSON(dir, mf, m);
};

test('translation: how a free object\'s choices read in the editor, translated in its block; not words learners find', () => {
  const dir = copyExample();
  withDeviceLabels(dir);
  const units = extractUnits(loadProjectFromDir(dir)).filter((u) => u.id.includes('.enumLabels.'));
  assert.deepEqual(units.map((u) => [u.id, u.text, u.pointer]), [
    ['block.simulation-scene.enumLabels.failingDevice.commutateur', 'Commutateur', '/blocks/1/props/enumLabels/failingDevice/commutateur'],
    ['block.simulation-scene.enumLabels.failingDevice.routeur', 'Routeur', '/blocks/1/props/enumLabels/failingDevice/routeur'],
    ['block.simulation-scene.enumLabels.failingDevice.parefeu', 'Pare-feu', '/blocks/1/props/enumLabels/failingDevice/parefeu'],
    ['block.simulation-scene.enumLabels.failingDevice.serveur', "Serveur d'impression", '/blocks/1/props/enumLabels/failingDevice/serveur']
  ]);
  assert.ok(units.every((u) => u.editor && u.maxLength === 60 && /Équipement en panne/.test(u.note ?? '')));
  assert.ok(!findText(loadProjectFromDir(dir), 'Routeur').some((match) => match.unit.includes('.enumLabels.')), 'authors read them, not learners');
  // The block's own wording is the source, and the translation writes there.
  const s = readJSON(dir, 'screens/simulation.json');
  s.blocks[1].props.enumLabels = { failingDevice: { routeur: 'Routeur de l\'étage' } };
  writeJSON(dir, 'screens/simulation.json', s);
  assert.equal(extractUnits(loadProjectFromDir(dir)).find((u) => u.id === 'block.simulation-scene.enumLabels.failingDevice.routeur')?.text, 'Routeur de l\'étage');
  exportTranslation(dir, { to: 'en' });
  const x = readXliff(fs.readFileSync(translationFile(dir, 'en'), 'utf8'));
  const english: Record<string, string> = { commutateur: 'Switch', routeur: 'Floor router', parefeu: 'Firewall', serveur: 'Print server' };
  fs.writeFileSync(translationFile(dir, 'en'), toXliff({ srcLang: 'fr', trgLang: 'en', original: 'x', units: [...x.units.values()].map((u) => {
    const value = /\.enumLabels\.failingDevice\.(\w+)$/.exec(u.id)?.[1];
    return { id: u.id, source: u.source, ...(value ? { target: english[value], state: 'translated' } : {}) };
  }) }));
  const screen = translatedCourse(loadProjectFromDir(dir), { to: 'en', allowMissing: true }).files.get('screens/simulation.json') as { blocks: Block[] };
  assert.deepEqual((screen.blocks[1].props as { enumLabels: unknown }).enumLabels, { failingDevice: english });
});

test('translation: the words the editor shows of the course\'s design (styles, backdrop variants, components, placed objects), translated in their own files; not words learners find', () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const course = readJSON(dir, 'course.json');
  course.theme.styles = { text: { encadre: 'Un paragraphe sur un fond pâle' } };
  course.theme.backdrop = { layers: ['fond'], variants: { calme: 'Un fond plus calme, derrière les écrans chargés' } };
  writeJSON(dir, 'course.json', course);
  const project = loadProjectFromDir(dir);
  const units = extractUnits(project).filter((u) => /^(theme|component|object)\./.test(u.id));
  const at = (id: string) => units.find((u) => u.id === id);
  assert.deepEqual([at('theme.style.text.encadre')?.pointer, at('theme.backdrop.variant.calme')?.pointer], ['/theme/styles/text/encadre', '/theme/backdrop/variants/calme']);
  assert.deepEqual([at('component.network-path.title')?.file, at('component.network-path.prop.steps.item.label.title')?.pointer], ['components/network-path/component.json', '/props/properties/steps/items/properties/label/title']);
  assert.deepEqual([at('object.diagnostic-reseau.prop.failingDevice.group')?.text, at('object.diagnostic-reseau.event.completed.description')?.pointer], ['Scénario', '/events/2/description']);
  assert.ok(units.every((u) => u.editor && /Editor only/.test(u.note ?? '')), 'authors read them, not learners');
  assert.ok(!units.some((u) => /instructions/.test(u.pointer)), 'a component\'s instructions are for agents');
  assert.deepEqual(findText(project, 'Ticket de support').filter((match) => match.unit.startsWith('component.')), []);
  // Translated into the files they come from.
  exportTranslation(dir, { to: 'en' });
  const x = readXliff(fs.readFileSync(translationFile(dir, 'en'), 'utf8'));
  const english: Record<string, string> = {
    'theme.backdrop.variant.calme': 'A calmer ground, behind dense screens',
    'component.support-ticket.title': 'Support ticket',
    'object.diagnostic-reseau.prop.failingDevice.group': 'Scenario'
  };
  fs.writeFileSync(translationFile(dir, 'en'), toXliff({ srcLang: 'fr', trgLang: 'en', original: 'x', units: [...x.units.values()].map((u) => ({ id: u.id, source: u.source, ...(english[u.id] ? { target: english[u.id], state: 'translated' as const } : {}) })) }));
  const { files } = translatedCourse(loadProjectFromDir(dir), { to: 'en', allowMissing: true });
  assert.equal((files.get('course.json') as { theme: { backdrop: { variants: Record<string, string> } } }).theme.backdrop.variants.calme, english['theme.backdrop.variant.calme']);
  assert.equal((files.get('components/support-ticket/component.json') as { title: string }).title, 'Support ticket');
  assert.equal((files.get('objects/diagnostic-reseau/object.manifest.json') as unknown as { props: { properties: Record<string, Record<string, string>> } }).props.properties.failingDevice!['x-group'], 'Scenario');
  // An object no block places has no settings in the editor: its words are not units.
  const s = readJSON(dir, 'screens/simulation.json');
  s.blocks = s.blocks.filter((block: Block) => block.type !== 'free-object');
  writeJSON(dir, 'screens/simulation.json', s);
  assert.ok(!extractUnits(loadProjectFromDir(dir)).some((u) => u.id.startsWith('object.')));
});

test('how a free object\'s choices read: the block\'s words over the manifest\'s, for event editors (screenParts)', () => {
  const dir = copyExample();
  withDeviceLabels(dir);
  const s = readJSON(dir, 'screens/simulation.json');
  s.blocks[1].props.enumLabels = { failingDevice: { routeur: 'Routeur de l\'étage' } };
  writeJSON(dir, 'screens/simulation.json', s);
  const scene = screenParts(loadProjectFromDir(dir), 'simulation')?.blocks.find((block) => block.id === 'simulation-scene');
  assert.deepEqual(scene?.object?.props.find((prop) => prop.name === 'failingDevice')?.enumLabels, { ...DEVICES, routeur: 'Routeur de l\'étage' });
  assert.equal(scene?.object?.props.find((prop) => prop.name === 'packetSpeed')?.enumLabels, undefined);
});

test('translation: export, status, build, approval, then a stale unit when the source changes', async () => {
  const dir = copyExample();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-tr-'));
  const r = exportTranslation(dir, { to: 'en' });
  assert.ok(r.units > 20 && r.toTranslate === r.units);
  // Translate: here, every target is its source prefixed (maths and placeholders kept).
  const x = readXliff(fs.readFileSync(translationFile(dir, 'en'), 'utf8'));
  fs.writeFileSync(translationFile(dir, 'en'), toXliff({ srcLang: 'fr', trgLang: 'en', original: 'x', units: [...x.units.values()].map((u) => ({ id: u.id, source: u.source, target: `EN ${u.source}`.slice(0, 190), state: 'translated' })) }));
  let st = translationStatus(dir, { to: 'en' })[0];
  assert.ok(st.exists);
  const long = st.problems.filter((p) => !/characters|must NOT have more/.test(p.message));
  assert.deepEqual(long, [], JSON.stringify(st.problems.slice(0, 3)));
  // Units whose prefixed text broke a limit or a structure are translated back as their source.
  const bad = new Set(st.problems.map((p) => p.id));
  const x2 = readXliff(fs.readFileSync(translationFile(dir, 'en'), 'utf8'));
  fs.writeFileSync(translationFile(dir, 'en'), toXliff({ srcLang: 'fr', trgLang: 'en', original: 'x', units: [...x2.units.values()].map((u) => ({ ...u, target: bad.has(u.id) ? u.source : u.target })) }));
  st = translationStatus(dir, { to: 'en' })[0];
  assert.ok(st.exists);
  assert.equal(st.toTranslate, 0);
  assert.deepEqual(st.problems, []);
  const b = await buildTranslation(dir, { to: 'en', out });
  assert.equal(b.plan, 'draft');
  const course = readJSON(out, 'course.json');
  assert.equal(course.language, 'en');
  assert.equal(course.translationOf.id, readJSON(dir, 'course.json').id);
  assert.match(course.title, /^EN /);
  assert.ok(readJSON(out, 'plan.json').translationOf.contentHash.startsWith('sha256:'));
  assert.equal(validateDir(out).summary.errors, 0, JSON.stringify(validateDir(out).diagnostics.filter((d) => d.severity === 'error').slice(0, 3)));
  // A person approves the translated plan; the build carries the approval.
  approveTranslation(dir, { to: 'en', by: 'Test approver' }, { author: { kind: 'human' } });
  await buildTranslation(dir, { to: 'en', out });
  // The translated course holds it as its validated version, V1, and none of the source's versions.
  assert.deepEqual(readJSON(out, 'plan-versions/V1.json').validation.by, 'Test approver');
  assert.deepEqual(fs.readdirSync(path.join(out, 'plan-versions')), ['V1.json']);
  assert.equal(validateDir(out, { release: true }).summary.errors, 0);
  assert.ok(!codes(validateDir(out).diagnostics).some((code) => code.startsWith('W_PLAN_')));
  // The source changes: the unit is stale, its previous translation kept as a starting point.
  const c = readJSON(dir, 'course.json');
  c.title = `${c.title} (v2)`;
  writeJSON(dir, 'course.json', c);
  const again = exportTranslation(dir, { to: 'en' });
  assert.equal(again.stale, 1);
  assert.deepEqual(again.details.stale, ['course.title']);
  const after = readXliff(fs.readFileSync(translationFile(dir, 'en'), 'utf8')).units.get('course.title');
  assert.ok(after);
  assert.equal(after.state, 'initial');
  assert.ok(after.notes.some((n) => n.category === 'previous-source'));
  await assert.rejects(() => buildTranslation(dir, { to: 'en', out }), /stale/);
});

test('translation checks use isolated copies, exclude Git and sources, and clean up after failure', async () => {
  const dir = copyExample();
  try {
    exportTranslation(dir, { to: 'en' });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'private repository configuration');
    fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sources', 'private.txt'), 'client brief');
    const paths: string[] = [];
    await Promise.all([0, 1].map(() => withCourseLanguage(dir, { language: 'en', allowMissing: true }, async (root) => {
      paths.push(root);
      assert.equal(readJSON(root, 'course.json').language, 'en');
      assert.equal(fs.existsSync(path.join(root, '.git')), false);
      assert.equal(fs.existsSync(path.join(root, 'sources')), false);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(fs.existsSync(path.join(root, 'course.json')), 'other calls cannot remove this copy');
    })));
    assert.notEqual(paths[0], paths[1]);
    assert.ok(paths.every((root) => !fs.existsSync(root)));
    await assert.rejects(withCourseLanguage(dir, { language: 'en', allowMissing: true }, () => { throw new Error('check failed'); }), /check failed/);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.elabora', 'translations')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('translation: a translation that loses maths or a placeholder is refused', () => {
  const dir = copyExample();
  const sc = readJSON(dir, 'screens/accueil.json');
  const block = sc.blocks.find((b: Block) => typeof b.props?.markdown === 'string');
  block.props.markdown += ' Ratio $x^2$.';
  writeJSON(dir, 'screens/accueil.json', sc);
  exportTranslation(dir, { to: 'en' });
  const x = readXliff(fs.readFileSync(translationFile(dir, 'en'), 'utf8'));
  const withMath = [...x.units.values()].find((u) => /\$[^$]+\$/.test(u.source));
  assert.ok(withMath, 'the example has maths');
  fs.writeFileSync(translationFile(dir, 'en'), toXliff({ srcLang: 'fr', trgLang: 'en', original: 'x', units: [...x.units.values()].map((u) => ({ id: u.id, source: u.source, target: u.id === withMath.id ? u.source.replace(/\$[^$]+\$/g, 'x') : u.source, state: 'translated' })) }));
  const st = translationStatus(dir, { to: 'en' })[0];
  assert.ok(st.exists);
  assert.ok(st.problems.some((p) => p.id === withMath.id && /maths/.test(p.message)));
});

test('player labels: scroll presentation names its screens pages, course.ui still has the last word', () => {
  assert.equal(labelsFor('fr', {}, 'scroll').screenOf, 'Page {n} sur {total}');
  assert.equal(labelsFor('fr', {}, 'slides').screenOf, 'Écran {n} sur {total}');
  assert.equal(labelsFor('en', {}, 'scroll').locked, 'Complete the activity on this page to continue.');
  assert.equal(labelsFor('xx', {}, 'scroll').screenOf, 'Page {n} of {total}', 'other languages: English');
  assert.equal(labelsFor('en', { screenOf: 'Lesson {n} of {total}' }, 'scroll').screenOf, 'Lesson {n} of {total}');
});

test('translation units: the text of a Continue button that opens a step', () => {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.blocks.find((block: Block) => block.id === 'chemin-regle').step = 2;
  screen.steps = { 2: { label: 'Voir la règle' } };
  writeJSON(dir, 'screens/chemin.json', screen);
  const unit = extractUnits(loadProjectFromDir(dir)).find((candidate) => candidate.id === 'screen.chemin.step.2.label');
  assert.ok(unit, 'unit extracted');
  assert.equal(unit.text, 'Voir la règle');
  assert.equal(unit.pointer, '/steps/2/label');
});
