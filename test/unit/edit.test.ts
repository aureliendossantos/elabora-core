import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';
import * as edit from '@elabora/node/edit';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { findText } from '@elabora/core/commands/text';
import { translationTable } from '@elabora/core/i18n/translate';

test('edits are validated, journaled and undoable', () => {
  const dir = copyExample();
  const before = fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8');
  const r = edit.addBlock(dir, { screen: 'chemin', block: { id: 'chemin-quiz', type: 'quiz', props: { stem: 'Q ?', mode: 'single', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }] } }, after: 'chemin-regle' });
  assert.equal(r.ok, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'E_FEEDBACK_MISSING'), 'diagnostics come back with the edit');
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks[3].id, 'chemin-quiz');
  edit.updateBlock(dir, { block: 'chemin-quiz', props: { stem: 'Question ?' } });
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks[3].props.stem, 'Question ?');
  edit.undo(dir);
  edit.undo(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8'), before);
});

test('a block added without an id gets a free one; an id in use is refused', () => {
  const dir = copyExample();
  const first = edit.addBlock(dir, { screen: 'chemin', block: { type: 'text', props: { markdown: 'Un.' } }, after: 'chemin-regle' });
  const second = edit.addBlock(dir, { screen: 'chemin', block: { type: 'text', props: { markdown: 'Deux.' } }, after: 'chemin-regle' });
  assert.equal(first.block, 'chemin-text');
  assert.equal(second.block, 'chemin-text-2');
  assert.deepEqual(readJSON(dir, 'screens/chemin.json').blocks.slice(2, 5).map((b: { id: string }) => b.id), ['chemin-regle', 'chemin-text-2', 'chemin-text']);
  assert.throws(() => edit.addBlock(dir, { screen: 'chemin', block: { id: 'chemin-regle', type: 'text', props: { markdown: 'Trois.' } } }), /already used/);
});

test('a layer or an event written without an id is new and gets a free one; a variable still used is not removed', () => {
  const dir = copyExample();
  const layer = edit.upsertLayer(dir, { screen: 'chemin', layer: { title: 'Pour aller plus loin', blocks: [{ type: 'text', props: { markdown: 'Plus loin.' } }] } });
  assert.equal(layer.layer, 'chemin-layer');
  assert.equal(readJSON(dir, 'screens/chemin.json').layers[0].blocks[0].id, 'chemin-layer-text');
  const first = edit.upsertEvent(dir, { screen: 'chemin', event: { on: { type: 'screen.enter' }, do: [{ type: 'show-layer', layer: 'chemin-layer' }] } });
  const second = edit.upsertEvent(dir, { screen: 'chemin', event: { on: { type: 'layer.closed', target: 'chemin-layer' }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] } });
  assert.deepEqual([first.event, second.event], ['chemin-event', 'chemin-event-2']);
  const screen = readJSON(dir, 'screens/chemin.json');
  assert.deepEqual(screen.layers.map((l: { id: string }) => l.id), ['chemin-layer']);
  assert.deepEqual(screen.events.map((e: { id: string }) => e.id), ['chemin-event', 'chemin-event-2']);
  // Written again with its id: replaced in place.
  edit.upsertEvent(dir, { screen: 'chemin', event: { id: 'chemin-event', on: { type: 'screen.enter' }, do: [{ type: 'go-to', screen: 'next' }] } });
  assert.deepEqual(readJSON(dir, 'screens/chemin.json').events.map((e: { do: { type: string }[] }) => e.do[0].type), ['go-to', 'set-variable']);
  // Its trigger chosen, its actions not yet: written as it is.
  const started = edit.upsertEvent(dir, { screen: 'chemin', event: { on: { type: 'click', target: 'chemin-btn' }, do: [] } });
  assert.deepEqual(readJSON(dir, 'screens/chemin.json').events.find((e: { id: string }) => e.id === started.event).do, []);
  edit.removeEvent(dir, { screen: 'chemin', id: started.event });
  assert.throws(() => edit.removeVariable(dir, { id: 'indiceVu' }), /used by events chemin\/chemin-event-2, simulation\/simulation-indice/);
  edit.removeEvent(dir, { screen: 'chemin', id: 'chemin-event-2' });
  edit.removeEvent(dir, { screen: 'simulation', id: 'simulation-indice' });
  edit.removeVariable(dir, { id: 'indiceVu' });
  assert.ok(!(readJSON(dir, 'course.json').variables ?? []).some((v: { id: string }) => v.id === 'indiceVu'));
  assert.throws(() => edit.removeVariable(dir, { id: 'indiceVu' }), /No variable/);
});

test('steps: a block of the screen takes a step (1 or null: from the start), the screen says how each step opens; a block of a layer has none', () => {
  const dir = copyExample();
  edit.updateBlock(dir, { block: 'chemin-regle', step: 2 });
  edit.updateScreen(dir, { id: 'chemin', steps: { 2: { opens: 'continue', label: 'Voir la règle' } } });
  let screen = readJSON(dir, 'screens/chemin.json');
  assert.equal(screen.blocks.find((b: { id: string }) => b.id === 'chemin-regle').step, 2);
  assert.deepEqual(screen.steps, { 2: { opens: 'continue', label: 'Voir la règle' } });
  edit.updateBlock(dir, { block: 'chemin-regle', step: 1 });
  edit.updateScreen(dir, { id: 'chemin', steps: null });
  screen = readJSON(dir, 'screens/chemin.json');
  assert.equal(screen.blocks.find((b: { id: string }) => b.id === 'chemin-regle').step, undefined);
  assert.equal(screen.steps, undefined);
  assert.throws(() => edit.updateBlock(dir, { block: 'rappel-texte', step: 2 }), /only blocks of the screen itself have a step/);
});

test('a variable renamed: course.json, the events that read or write it, its key for learners', () => {
  const dir = copyExample();
  // Its key in the lock, as a build gives it.
  writeJSON(dir, 'elabora.lock.json', { ...readJSON(dir, 'elabora.lock.json'), keys: { ...(readJSON(dir, 'elabora.lock.json').keys ?? {}), 'var:indiceVu': 'v9' } });
  edit.upsertEvent(dir, { screen: 'chemin', event: { on: { type: 'variable.changed', variable: 'indiceVu' }, if: [{ variable: 'indiceVu', op: 'eq', value: true }], do: [{ type: 'set-variable', variable: 'indiceVu', value: false }] } });
  const result = edit.renameVariable(dir, { from: 'indiceVu', to: 'aideVue' });
  assert.equal(result.renamed.references, 5);
  assert.ok(readJSON(dir, 'course.json').variables.some((v: { id: string }) => v.id === 'aideVue'));
  assert.deepEqual(readJSON(dir, 'screens/simulation.json').events.find((e: { id: string }) => e.id === 'simulation-indice').do, [{ type: 'set-variable', variable: 'aideVue', value: true }]);
  const event = readJSON(dir, 'screens/chemin.json').events[0];
  assert.deepEqual([event.on.variable, event.if[0].variable, event.do[0].variable], ['aideVue', 'aideVue', 'aideVue']);
  assert.equal(readJSON(dir, 'elabora.lock.json').keys['var:aideVue'], 'v9');
  assert.throws(() => edit.renameVariable(dir, { from: 'aideVue', to: 'bonsReflexes' }), /already exists/);
  assert.throws(() => edit.renameVariable(dir, { from: 'aideVue', to: 'Aide-vue' }), /not a valid variable name/);
});

test('a screen duplicated: after it in its section, new ids for its blocks, layers and events, its events pointing at its own', () => {
  const dir = copyExample();
  const result = edit.duplicateScreen(dir, { id: 'premier-reflexe', title: 'Premier réflexe (bis)' });
  assert.equal(result.screen, 'premier-reflexe-copy');
  assert.deepEqual(readJSON(dir, 'course.json').sections.find((s: { id: string }) => s.id === 'pratiquer').screens, ['premier-reflexe', 'premier-reflexe-copy', 'simulation']);
  const copy = readJSON(dir, 'screens/premier-reflexe-copy.json');
  assert.equal(copy.title, 'Premier réflexe (bis)');
  assert.deepEqual(copy.blocks.map((b: { id: string }) => b.id), ['reflexe-choix-copy']);
  assert.deepEqual(copy.layers.map((l: { id: string; blocks: { id: string }[] }) => [l.id, l.blocks.map((b) => b.id)]), [['rappel-regle-copy', ['rappel-texte-copy']]]);
  assert.deepEqual(copy.events.map((e: { id: string; on: { target: string } }) => [e.id, e.on.target]), [['reflexe-bon-copy', 'reflexe-choix-copy'], ['reflexe-serveur-copy', 'reflexe-choix-copy']]);
  assert.deepEqual(copy.events[1].do, [{ type: 'show-layer', layer: 'rappel-regle-copy' }]);
  // Ids named after the screen follow its new id.
  const second = edit.duplicateScreen(dir, { id: 'chemin' });
  assert.equal(second.screen, 'chemin-copy');
  assert.ok(readJSON(dir, 'screens/chemin-copy.json').blocks.every((b: { id: string }) => b.id.startsWith('chemin-copy-')));
  assert.equal(validateDir(dir).summary.errors, 0);
});

test('a screen created with a layout of the course: its props written, its first block in the layout\'s default slot', () => {
  const dir = copyExample(path.join(ROOT, 'examples/medieval-charts'));
  const first = readJSON(dir, 'course.json').sections[0];
  edit.createScreen(dir, { id: 'page-blanche', title: 'A blank page', covers: [readJSON(dir, 'plan.json').items[0].id], section: first.id, layout: 'folio', layoutProps: { ornament: 'none' } });
  const screen = readJSON(dir, 'screens/page-blanche.json');
  assert.deepEqual([screen.layout, screen.layoutProps], ['folio', { ornament: 'none' }]);
  assert.equal(validateDir(dir).diagnostics.filter((d: { severity: string; file?: string }) => d.severity === 'error' && d.file === 'screens/page-blanche.json').length, 0);
});

test('a language started and translated text by text, as changes: stale when the source changes, a lost link refused, a new language started by its first text', () => {
  const dir = copyExample();
  const started = edit.exportTranslationChange(dir, { to: 'en' });
  assert.equal(started.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'translations/en.xlf')));
  let table = translationTable(loadProjectFromDir(dir), 'en');
  assert.equal(table.source, 'fr');
  assert.ok(table.rows.every((row) => row.status === 'to-translate'));
  const title = table.rows.find((row) => row.id === 'screen.chemin.title')!;
  assert.equal(title.screen, 'chemin');
  edit.translateText(dir, { language: 'en', unit: title.id, target: 'The path of a print job' });
  table = translationTable(loadProjectFromDir(dir), 'en');
  assert.deepEqual([table.rows.find((row) => row.id === title.id)?.status, table.rows.find((row) => row.id === title.id)?.target], ['translated', 'The path of a print job']);
  // The source changes: the translation is stale, with what it was translated from.
  edit.updateScreen(dir, { id: 'chemin', title: 'Le chemin d\'une demande d\'impression' });
  const stale = translationTable(loadProjectFromDir(dir), 'en').rows.find((row) => row.id === title.id)!;
  assert.deepEqual([stale.status, stale.previousSource], ['stale', title.source]);
  // A translation that loses a link of the source is refused.
  edit.addBlock(dir, { screen: 'chemin', block: { id: 'chemin-lien', type: 'text', props: { markdown: 'Voir [la procédure](https://intranet.example.com/p12).' } } });
  assert.throws(() => edit.translateText(dir, { language: 'en', unit: 'block.chemin-lien.markdown', target: 'See the procedure.' }), /links: 1 in the source, 0 here/);
  edit.translateText(dir, { language: 'en', unit: 'block.chemin-lien.markdown', target: 'See [the procedure](https://intranet.example.com/p12).' });
  edit.undo(dir);
  assert.equal(translationTable(loadProjectFromDir(dir), 'en').rows.find((row) => row.id === 'block.chemin-lien.markdown')?.status, 'to-translate');
  // A language the course does not have yet starts with its first text.
  edit.translateText(dir, { language: 'de', unit: title.id, target: 'Der Weg eines Druckauftrags' });
  const german = translationTable(loadProjectFromDir(dir), 'de');
  assert.equal(german.exists, true);
  assert.deepEqual(german.rows.filter((row) => row.status !== 'to-translate').map((row) => [row.id, row.target]), [[title.id, 'Der Weg eines Druckauftrags']]);
});

test('words found and replaced in one change: titles, blocks, an object\'s wording; never a link\'s address, code or the plan', () => {
  const dir = copyExample();
  edit.addBlock(dir, { screen: 'chemin', block: { id: 'chemin-lien', type: 'text', props: { markdown: 'Voir [la fiche de Marc](https://intranet.example.com/marc) et `marc.log`.' } } });
  const found = findText(loadProjectFromDir(dir), 'marc');
  assert.ok(found.some((match) => match.unit === 'screen.accueil.title' && match.screen === 'accueil' && match.block === null));
  assert.ok(found.every((match) => match.file !== 'plan.json'), 'the plan\'s validated texts change by a retouch');
  assert.equal(found.find((match) => match.block === 'chemin-lien')?.count, 1, 'the link\'s address and the code are not words');
  const files = ['course.json', 'screens/accueil.json', 'screens/chemin.json', 'screens/simulation.json'];
  const before = files.map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));
  const result = edit.replaceText(dir, { find: 'Marc', replace: 'Martine', caseSensitive: true });
  assert.equal(result.ok, true);
  assert.ok(result.replaced >= found.length);
  assert.equal(readJSON(dir, 'screens/accueil.json').title, 'Le ticket de Martine');
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.find((b: { id: string }) => b.id === 'chemin-lien').props.markdown, 'Voir [la fiche de Martine](https://intranet.example.com/marc) et `marc.log`.');
  assert.equal(validateDir(dir).summary.errors, 0);
  edit.undo(dir);
  assert.deepEqual(files.map((file) => fs.readFileSync(path.join(dir, file), 'utf8')), before, 'one change, one undo');
  // Only the matches chosen.
  edit.replaceText(dir, { find: 'pare-feu', replace: 'firewall', units: ['block.chemin-roles.items.pare-feu.title'] });
  const roles = readJSON(dir, 'screens/chemin.json').blocks.find((b: { id: string }) => b.id === 'chemin-roles');
  assert.equal(roles.props.items.find((item: { id: string }) => item.id === 'pare-feu').title, 'Le firewall');
  assert.match(JSON.stringify(readJSON(dir, 'screens/chemin.json').blocks.find((b: { id: string }) => b.id === 'chemin-schema')), /pare-feu/i);
  assert.throws(() => edit.replaceText(dir, { find: 'introuvable', replace: 'x' }), /is not in the words/);
});

test('captions: a SubRip file becomes WebVTT under assets/captions, named after the video; undone at once', () => {
  const dir = copyExample();
  edit.addBlock(dir, { screen: 'chemin', block: { id: 'chemin-video', type: 'video', props: { asset: 'video/demo.mp4', title: 'Démonstration' } } });
  const result = edit.setCaptions(dir, { block: 'chemin-video', text: '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nBonjour Marc.\r\n' });
  assert.equal(result.captions, 'captions/chemin-video.vtt');
  assert.equal(fs.readFileSync(path.join(dir, 'assets/captions/chemin-video.vtt'), 'utf8'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nBonjour Marc.\n');
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.at(-1).props.captions, 'captions/chemin-video.vtt');
  assert.throws(() => edit.setCaptions(dir, { block: 'chemin-video', text: 'Bonjour Marc.' }), /no cue/);
  assert.throws(() => edit.setCaptions(dir, { block: 'chemin-regle', text: 'WEBVTT\n\n00:00.000 --> 00:01.000\nx' }), /captions go on a video/);
  edit.undo(dir);
  assert.equal(fs.existsSync(path.join(dir, 'assets/captions/chemin-video.vtt')), false);
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.at(-1).props.captions, undefined);
});

test('schema-invalid edits are refused before touching the disk', () => {
  const dir = copyExample();
  const before = fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8');
  assert.throws(() => edit.addBlock(dir, { screen: 'chemin', block: { id: 'x', type: 'quiz', props: { stem: 1 } } }), (e) => e instanceof edit.EditError && e.diagnostics.some((d) => d.code === 'E_SCHEMA'));
  assert.equal(fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8'), before);
});

test('free-object planRefs cannot be changed outside a change request', () => {
  const dir = copyExample();
  const m = readJSON(dir, 'objects/diagnostic-reseau/object.manifest.json');
  m.planRefs.objectives = ['OBJ-1'];
  assert.throws(() => edit.writeObjectFile(dir, { object: 'diagnostic-reseau', file: 'object.manifest.json', content: JSON.stringify(m) }), /propose_plan_change/);
});

test('screens: create, move, delete', () => {
  const dir = copyExample();
  edit.createScreen(dir, { id: 'rappel', title: 'Rappel', covers: ['ITEM-6'], section: 'valider' });
  assert.ok(readJSON(dir, 'course.json').sections[2].screens.includes('rappel'));
  edit.moveScreen(dir, { id: 'rappel', after: 'accueil' });
  assert.deepEqual(readJSON(dir, 'course.json').sections[0].screens, ['accueil', 'rappel', 'chemin']);
  edit.deleteScreen(dir, { id: 'rappel' });
  assert.ok(!fs.existsSync(path.join(dir, 'screens/rappel.json')));
});

test('course delivery: update_course sets the media preset, checked against the schema', () => {
  const dir = copyExample();
  edit.updateCourseSettings(dir, { delivery: { mediaQuality: 'low' } });
  assert.deepEqual(readJSON(dir, 'course.json').delivery, { mediaQuality: 'low' });
  const before = fs.readFileSync(path.join(dir, 'course.json'), 'utf8');
  // @ts-expect-error: a preset the format does not have
  assert.throws(() => edit.updateCourseSettings(dir, { delivery: { mediaQuality: 'ultra' } }), (e) => e instanceof edit.EditError && e.diagnostics.some((d) => d.code === 'E_SCHEMA' && d.path === '/delivery/mediaQuality'));
  assert.equal(fs.readFileSync(path.join(dir, 'course.json'), 'utf8'), before);
  // The presentation too: slides, the size they are designed for.
  edit.updateCourseSettings(dir, { presentation: { mode: 'slides', fit: { reference: '1280x720' } } });
  assert.deepEqual(readJSON(dir, 'course.json').presentation, { mode: 'slides', fit: { reference: '1280x720' } });
});
