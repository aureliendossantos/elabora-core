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
  const r = edit.run(dir, 'add_block', { screen: 'chemin', block: { id: 'chemin-quiz', type: 'quiz', props: { stem: 'Q ?', mode: 'single', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }] } }, after: 'chemin-regle' });
  assert.equal(r.ok, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'E_FEEDBACK_MISSING'), 'diagnostics come back with the edit');
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks[3].id, 'chemin-quiz');
  edit.run(dir, 'update_block', { block: 'chemin-quiz', props: { stem: 'Question ?' } });
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks[3].props.stem, 'Question ?');
  edit.undo(dir);
  edit.undo(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8'), before);
});

test('a block added without an id gets one: its screen and type, then a random suffix (D77); an id in use is refused', () => {
  const dir = copyExample();
  const first = edit.run(dir, 'add_block', { screen: 'chemin', block: { type: 'text', props: { markdown: 'Un.' } }, after: 'chemin-regle' });
  const second = edit.run(dir, 'add_block', { screen: 'chemin', block: { type: 'text', props: { markdown: 'Deux.' } }, after: 'chemin-regle' });
  assert.match(first.block, /^chemin-text-[a-z0-9]{4}$/);
  assert.match(second.block, /^chemin-text-[a-z0-9]{4}$/);
  assert.notEqual(first.block, second.block);
  assert.deepEqual(readJSON(dir, 'screens/chemin.json').blocks.slice(2, 5).map((b: { id: string }) => b.id), ['chemin-regle', second.block, first.block]);
  // The suffix comes from the random numbers given: the same ones, the same ids.
  const seeded = () => { let n = 0; return () => ((n += 0.37) % 1); };
  const again = [copyExample(), copyExample()].map((d) => edit.run(d, 'add_block', { screen: 'chemin', block: { type: 'text', props: { markdown: 'Un.' } } }, { random: seeded() }).block);
  assert.equal(again[0], again[1]);
  assert.throws(() => edit.run(dir, 'add_block', { screen: 'chemin', block: { id: 'chemin-regle', type: 'text', props: { markdown: 'Trois.' } } }), /already used/);
});

test('a layer or an event written without an id is new and gets a free one; a variable still used is not removed', () => {
  const dir = copyExample();
  const layer = edit.run(dir, 'upsert_layer', { screen: 'chemin', layer: { title: 'Pour aller plus loin', blocks: [{ type: 'text', props: { markdown: 'Plus loin.' } }] } });
  assert.match(layer.layer, /^chemin-layer-[a-z0-9]{4}$/);
  assert.match(readJSON(dir, 'screens/chemin.json').layers[0].blocks[0].id, new RegExp(`^${layer.layer}-text-[a-z0-9]{4}$`));
  const first = edit.run(dir, 'upsert_event', { screen: 'chemin', event: { on: { type: 'screen.enter' }, do: [{ type: 'show-layer', layer: layer.layer }] } });
  const second = edit.run(dir, 'upsert_event', { screen: 'chemin', event: { on: { type: 'layer.closed', target: layer.layer }, do: [{ type: 'set-variable', variable: 'indiceVu', value: true }] } });
  assert.match(first.event, /^chemin-event-[a-z0-9]{4}$/);
  const screen = readJSON(dir, 'screens/chemin.json');
  assert.deepEqual(screen.layers.map((l: { id: string }) => l.id), [layer.layer]);
  assert.deepEqual(screen.events.map((e: { id: string }) => e.id), [first.event, second.event]);
  // Written again with its id: replaced in place.
  edit.run(dir, 'upsert_event', { screen: 'chemin', event: { id: first.event, on: { type: 'screen.enter' }, do: [{ type: 'go-to', screen: 'next' }] } });
  assert.deepEqual(readJSON(dir, 'screens/chemin.json').events.map((e: { do: { type: string }[] }) => e.do[0].type), ['go-to', 'set-variable']);
  // Its trigger chosen, its actions not yet: written as it is.
  const started = edit.run(dir, 'upsert_event', { screen: 'chemin', event: { on: { type: 'click', target: 'chemin-btn' }, do: [] } });
  assert.deepEqual(readJSON(dir, 'screens/chemin.json').events.find((e: { id: string }) => e.id === started.event).do, []);
  edit.run(dir, 'remove_event', { screen: 'chemin', id: started.event });
  assert.throws(() => edit.run(dir, 'remove_variable', { id: 'indiceVu' }), new RegExp(`used by events chemin/${second.event}, simulation/simulation-indice`));
  edit.run(dir, 'remove_event', { screen: 'chemin', id: second.event });
  edit.run(dir, 'remove_event', { screen: 'simulation', id: 'simulation-indice' });
  edit.run(dir, 'remove_variable', { id: 'indiceVu' });
  assert.ok(!(readJSON(dir, 'course.json').variables ?? []).some((v: { id: string }) => v.id === 'indiceVu'));
  assert.throws(() => edit.run(dir, 'remove_variable', { id: 'indiceVu' }), /No variable/);
});

test('steps: a block of the screen takes a step (1 or null: from the start), the screen says how each step opens; a block of a layer has none', () => {
  const dir = copyExample();
  edit.run(dir, 'update_block', { block: 'chemin-regle', step: 2 });
  edit.run(dir, 'update_screen', { id: 'chemin', steps: { 2: { opens: 'continue', label: 'Voir la règle' } } });
  let screen = readJSON(dir, 'screens/chemin.json');
  assert.equal(screen.blocks.find((b: { id: string }) => b.id === 'chemin-regle').step, 2);
  assert.deepEqual(screen.steps, { 2: { opens: 'continue', label: 'Voir la règle' } });
  edit.run(dir, 'update_block', { block: 'chemin-regle', step: 1 });
  edit.run(dir, 'update_screen', { id: 'chemin', steps: null });
  screen = readJSON(dir, 'screens/chemin.json');
  assert.equal(screen.blocks.find((b: { id: string }) => b.id === 'chemin-regle').step, undefined);
  assert.equal(screen.steps, undefined);
  assert.throws(() => edit.run(dir, 'update_block', { block: 'rappel-texte', step: 2 }), /only blocks of the screen itself have a step/);
});

test('a variable renamed: course.json, the events that read or write it, its key for learners', () => {
  const dir = copyExample();
  // Its key in the lock, as a build gives it.
  writeJSON(dir, 'elabora.lock.json', { ...readJSON(dir, 'elabora.lock.json'), keys: { ...(readJSON(dir, 'elabora.lock.json').keys ?? {}), 'var:indiceVu': 'v9' } });
  edit.run(dir, 'upsert_event', { screen: 'chemin', event: { on: { type: 'variable.changed', variable: 'indiceVu' }, if: [{ variable: 'indiceVu', op: 'eq', value: true }], do: [{ type: 'set-variable', variable: 'indiceVu', value: false }] } });
  const result = edit.run(dir, 'rename_variable', { from: 'indiceVu', to: 'aideVue' });
  assert.equal(result.renamed.references, 5);
  assert.ok(readJSON(dir, 'course.json').variables.some((v: { id: string }) => v.id === 'aideVue'));
  assert.deepEqual(readJSON(dir, 'screens/simulation.json').events.find((e: { id: string }) => e.id === 'simulation-indice').do, [{ type: 'set-variable', variable: 'aideVue', value: true }]);
  const event = readJSON(dir, 'screens/chemin.json').events[0];
  assert.deepEqual([event.on.variable, event.if[0].variable, event.do[0].variable], ['aideVue', 'aideVue', 'aideVue']);
  assert.equal(readJSON(dir, 'elabora.lock.json').keys['var:aideVue'], 'v9');
  assert.throws(() => edit.run(dir, 'rename_variable', { from: 'aideVue', to: 'bonsReflexes' }), /already exists/);
  assert.throws(() => edit.run(dir, 'rename_variable', { from: 'aideVue', to: 'Aide-vue' }), /not a valid variable name/);
});

test('a screen duplicated: after it in its section, new ids for its blocks, layers and events, its events pointing at its own', () => {
  const dir = copyExample();
  const result = edit.run(dir, 'duplicate_screen', { id: 'premier-reflexe', title: 'Premier réflexe (bis)' });
  // One random suffix for the copy and what it renames (D77).
  const tag = /^premier-reflexe-copy-([a-z0-9]{4})$/.exec(result.screen)?.[1] as string;
  assert.ok(tag, result.screen);
  assert.deepEqual(readJSON(dir, 'course.json').sections.find((s: { id: string }) => s.id === 'pratiquer').screens, ['premier-reflexe', result.screen, 'simulation']);
  const copy = readJSON(dir, `screens/${result.screen}.json`);
  assert.equal(copy.title, 'Premier réflexe (bis)');
  assert.deepEqual(copy.blocks.map((b: { id: string }) => b.id), [`reflexe-choix-copy-${tag}`]);
  assert.deepEqual(copy.layers.map((l: { id: string; blocks: { id: string }[] }) => [l.id, l.blocks.map((b) => b.id)]), [[`rappel-regle-copy-${tag}`, [`rappel-texte-copy-${tag}`]]]);
  assert.deepEqual(copy.events.map((e: { id: string; on: { target: string } }) => [e.id, e.on.target]), [[`reflexe-bon-copy-${tag}`, `reflexe-choix-copy-${tag}`], [`reflexe-serveur-copy-${tag}`, `reflexe-choix-copy-${tag}`]]);
  assert.deepEqual(copy.events[1].do, [{ type: 'show-layer', layer: `rappel-regle-copy-${tag}` }]);
  // Ids named after the screen follow its new id.
  const second = edit.run(dir, 'duplicate_screen', { id: 'chemin' });
  assert.match(second.screen, /^chemin-copy-[a-z0-9]{4}$/);
  assert.ok(readJSON(dir, `screens/${second.screen}.json`).blocks.every((b: { id: string }) => b.id.startsWith(`${second.screen}-`)));
  assert.equal(validateDir(dir).summary.errors, 0);
});

test('a screen with a dialogue duplicated: the dialogue\'s actions open and close the copy\'s layer, its texts translated as the source\'s', () => {
  const dir = copyExample(path.join(ROOT, 'examples/phishing-by-numbers'));
  // An event of the screen that waits for its dialogue's ending and starts it again.
  const practice = readJSON(dir, 'screens/practice.json');
  practice.events = [{ id: 'call-again', on: { type: 'dialogue.ended', target: 'bank-call' }, if: [{ dialogue: 'bank-call', ending: 'at-risk' }], do: [{ type: 'restart-dialogue', block: 'bank-call' }] }];
  writeJSON(dir, 'screens/practice.json', practice);
  const result = edit.run(dir, 'duplicate_screen', { id: 'practice' });
  const layer = result.renamed['the-email'];
  const dialogue = result.renamed['bank-call'];
  const [event] = readJSON(dir, `screens/${result.screen}.json`).events;
  assert.deepEqual([event.on.target, event.if[0].dialogue, event.do[0].block], [dialogue, dialogue, dialogue]);
  const actions = JSON.stringify(readJSON(dir, `screens/${result.screen}.json`).blocks).match(/"layer":"[^"]*"/g);
  assert.ok(actions?.length, 'the dialogue acts on a layer');
  assert.deepEqual([...new Set(actions)], [`"layer":"${layer}"`]);
  assert.equal(validateDir(dir).summary.errors, 0);
  // The copy's texts, translated as the source's (its audio is copied too).
  const rows = translationTable(loadProjectFromDir(dir), 'fr').rows;
  const ofScreen = (screen: string) => rows.filter((row) => row.screen === screen);
  const copied = ofScreen(result.screen);
  assert.equal(copied.length, ofScreen('practice').length);
  assert.ok(copied.length > 5);
  for (const row of ofScreen('practice')) {
    const copy = copied.find((candidate) => candidate.source === row.source && candidate.id !== row.id);
    assert.deepEqual([copy?.status, copy?.target], [row.status, row.target], row.id);
  }
});

test('a block duplicated: its copy\'s texts translated as its original\'s', () => {
  const dir = copyExample(path.join(ROOT, 'examples/phishing-by-numbers'));
  const result = edit.run(dir, 'duplicate_block', { block: 'clicked-quiz' });
  const rows = translationTable(loadProjectFromDir(dir), 'fr').rows;
  const of = (block: string) => rows.filter((row) => row.block === block);
  assert.ok(of('clicked-quiz').length > 3);
  assert.deepEqual(of(result.block).map((row) => [row.source, row.status, row.target]), of('clicked-quiz').map((row) => [row.source, row.status, row.target]));
});

test('a screen created with a layout of the course: its props written, its first block in the layout\'s default slot', () => {
  const dir = copyExample(path.join(ROOT, 'examples/medieval-charts'));
  const first = readJSON(dir, 'course.json').sections[0];
  edit.run(dir, 'create_screen', { id: 'page-blanche', title: 'A blank page', covers: [readJSON(dir, 'plan.json').items[0].id], section: first.id, layout: 'folio', layoutProps: { ornament: 'none' } });
  const screen = readJSON(dir, 'screens/page-blanche.json');
  assert.deepEqual([screen.layout, screen.layoutProps], ['folio', { ornament: 'none' }]);
  assert.equal(validateDir(dir).diagnostics.filter((d: { severity: string; file?: string }) => d.severity === 'error' && d.file === 'screens/page-blanche.json').length, 0);
});

test('a block added without a slot goes in a slot that takes it: the one of the block it follows, the default, then the first that has room for its type', () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const slotErrors = () => validateDir(dir).diagnostics.filter((d: { code: string; file?: string }) => d.code === 'E_COMPONENT_SLOT' && d.file === 'screens/accueil.json');
  const slotOf = (id: string) => readJSON(dir, 'screens/accueil.json').blocks.find((block: { id: string }) => block.id === id)?.slot;
  assert.deepEqual(slotErrors(), []);
  // After the free object, whose « scene » takes no text: the default slot, which has room for one more.
  const first = edit.run(dir, 'add_block', { screen: 'accueil', after: 'accueil-reseau', block: { type: 'text', props: { markdown: 'Un.' } } });
  assert.equal(slotOf(first.block), undefined);
  // The default slot full (four blocks): the next slot that takes a text.
  const second = edit.run(dir, 'add_block', { screen: 'accueil', after: 'accueil-reseau', block: { type: 'text', props: { markdown: 'Deux.' } } });
  assert.equal(slotOf(second.block), 'note');
  // After a block of « note »: « note » again.
  const third = edit.run(dir, 'add_block', { screen: 'accueil', after: second.block, block: { type: 'callout', props: { markdown: 'Trois.' } } });
  assert.equal(slotOf(third.block), 'note');
  assert.deepEqual(slotErrors(), []);
  // An image after a text, the scene emptied: the first slot that accepts an image.
  edit.run(dir, 'remove_block', { block: 'accueil-reseau' });
  const image = edit.run(dir, 'add_block', { screen: 'accueil', after: first.block, block: { type: 'image', props: { asset: 'images/portrait-marc.svg', alt: 'Marc' } } });
  assert.equal(slotOf(image.block), 'scene');
  assert.deepEqual(slotErrors(), []);
  // In place of a block (the paragraph « / » was typed in), in one change: its slot, which it frees, though full.
  const before = readJSON(dir, 'screens/accueil.json').blocks.map((block: { id: string }) => block.id);
  const replaced = edit.run(dir, 'add_block', { screen: 'accueil', replace: image.block, block: { type: 'image', props: { asset: 'images/logo-helios.svg', alt: 'Helios' } } });
  assert.deepEqual(readJSON(dir, 'screens/accueil.json').blocks.map((block: { id: string }) => block.id), before.map((id: string) => (id === image.block ? replaced.block : id)));
  assert.equal(slotOf(replaced.block), 'scene');
  assert.deepEqual(slotErrors(), []);
  edit.undo(dir);
  assert.deepEqual(readJSON(dir, 'screens/accueil.json').blocks.map((block: { id: string }) => block.id), before, 'one step undoes it');
  // A slot named is the caller's.
  const named = edit.run(dir, 'add_block', { screen: 'accueil', block: { type: 'text', slot: 'body', props: { markdown: 'Cinq.' } } });
  assert.equal(slotOf(named.block), 'body');
});

test('in a layer, a block added after one in a column of a columns block goes in that column', () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  edit.run(dir, 'upsert_layer', { screen: 'accueil', layer: { id: 'accueil-aide', title: 'Aide', blocks: [{ id: 'aide-colonnes', type: 'columns', props: {}, blocks: [{ id: 'aide-a', type: 'text', slot: 'first', props: { markdown: 'A.' } }, { id: 'aide-b', type: 'text', slot: 'second', props: { markdown: 'B.' } }] }] } });
  const added = edit.run(dir, 'add_block', { screen: 'accueil', layer: 'accueil-aide', parent: 'aide-colonnes', after: 'aide-b', block: { type: 'text', props: { markdown: 'C.' } } });
  const columns = readJSON(dir, 'screens/accueil.json').layers.find((layer: { id: string }) => layer.id === 'accueil-aide').blocks[0];
  assert.equal(columns.blocks.find((block: { id: string }) => block.id === added.block).slot, 'second');
});

test('a language started and translated text by text, as changes: stale when the source changes, a lost link refused, a new language started by its first text', () => {
  const dir = copyExample();
  const started = edit.run(dir, 'export_translation', { to: 'en' });
  assert.equal(started.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'translations/en.xlf')));
  let table = translationTable(loadProjectFromDir(dir), 'en');
  assert.equal(table.source, 'fr');
  assert.ok(table.rows.every((row) => row.status === 'to-translate'));
  const title = table.rows.find((row) => row.id === 'screen.chemin.title')!;
  assert.equal(title.screen, 'chemin');
  edit.run(dir, 'translate_text', { language: 'en', unit: title.id, target: 'The path of a print job' });
  table = translationTable(loadProjectFromDir(dir), 'en');
  assert.deepEqual([table.rows.find((row) => row.id === title.id)?.status, table.rows.find((row) => row.id === title.id)?.target], ['translated', 'The path of a print job']);
  // The source changes: the translation is stale, with what it was translated from.
  edit.run(dir, 'update_screen', { id: 'chemin', title: 'Le chemin d\'une demande d\'impression' });
  const stale = translationTable(loadProjectFromDir(dir), 'en').rows.find((row) => row.id === title.id)!;
  assert.deepEqual([stale.status, stale.previousSource], ['stale', title.source]);
  // A translation that loses a link of the source is refused.
  edit.run(dir, 'add_block', { screen: 'chemin', block: { id: 'chemin-lien', type: 'text', props: { markdown: 'Voir [la procédure](https://intranet.example.com/p12).' } } });
  assert.throws(() => edit.run(dir, 'translate_text', { language: 'en', unit: 'block.chemin-lien.markdown', target: 'See the procedure.' }), /links: 1 in the source, 0 here/);
  edit.run(dir, 'translate_text', { language: 'en', unit: 'block.chemin-lien.markdown', target: 'See [the procedure](https://intranet.example.com/p12).' });
  edit.undo(dir);
  assert.equal(translationTable(loadProjectFromDir(dir), 'en').rows.find((row) => row.id === 'block.chemin-lien.markdown')?.status, 'to-translate');
  // A language the course does not have yet starts with its first text.
  edit.run(dir, 'translate_text', { language: 'de', unit: title.id, target: 'Der Weg eines Druckauftrags' });
  const german = translationTable(loadProjectFromDir(dir), 'de');
  assert.equal(german.exists, true);
  assert.deepEqual(german.rows.filter((row) => row.status !== 'to-translate').map((row) => [row.id, row.target]), [[title.id, 'Der Weg eines Druckauftrags']]);
});

test('words found and replaced in one change: titles, blocks, an object\'s wording; never a link\'s address, code or the plan', () => {
  const dir = copyExample();
  edit.run(dir, 'add_block', { screen: 'chemin', block: { id: 'chemin-lien', type: 'text', props: { markdown: 'Voir [la fiche de Marc](https://intranet.example.com/marc) et `marc.log`.' } } });
  const found = findText(loadProjectFromDir(dir), 'marc');
  assert.ok(found.some((match) => match.unit === 'screen.accueil.title' && match.screen === 'accueil' && match.block === null));
  assert.ok(found.every((match) => match.file !== 'plan.json'), 'the plan\'s validated texts change by a retouch');
  assert.equal(found.find((match) => match.block === 'chemin-lien')?.count, 1, 'the link\'s address and the code are not words');
  const files = ['course.json', 'screens/accueil.json', 'screens/chemin.json', 'screens/simulation.json'];
  const before = files.map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));
  const result = edit.run(dir, 'replace_text', { find: 'Marc', replace: 'Martine', caseSensitive: true });
  assert.equal(result.ok, true);
  assert.ok(result.replaced >= found.length);
  assert.equal(readJSON(dir, 'screens/accueil.json').title, 'Le ticket de Martine');
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.find((b: { id: string }) => b.id === 'chemin-lien').props.markdown, 'Voir [la fiche de Martine](https://intranet.example.com/marc) et `marc.log`.');
  assert.equal(validateDir(dir).summary.errors, 0);
  edit.undo(dir);
  assert.deepEqual(files.map((file) => fs.readFileSync(path.join(dir, file), 'utf8')), before, 'one change, one undo');
  // Only the matches chosen.
  edit.run(dir, 'replace_text', { find: 'pare-feu', replace: 'firewall', units: ['block.chemin-roles.items.pare-feu.title'] });
  const roles = readJSON(dir, 'screens/chemin.json').blocks.find((b: { id: string }) => b.id === 'chemin-roles');
  assert.equal(roles.props.items.find((item: { id: string }) => item.id === 'pare-feu').title, 'Le firewall');
  assert.match(JSON.stringify(readJSON(dir, 'screens/chemin.json').blocks.find((b: { id: string }) => b.id === 'chemin-schema')), /pare-feu/i);
  assert.throws(() => edit.run(dir, 'replace_text', { find: 'introuvable', replace: 'x' }), /is not in the words/);
});

test('captions: a SubRip file becomes WebVTT under assets/captions, named after the video; undone at once', () => {
  const dir = copyExample();
  edit.run(dir, 'add_block', { screen: 'chemin', block: { id: 'chemin-video', type: 'video', props: { asset: 'video/demo.mp4', title: 'Démonstration' } } });
  const result = edit.run(dir, 'set_captions', { block: 'chemin-video', text: '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nBonjour Marc.\r\n' });
  assert.equal(result.captions, 'captions/chemin-video.vtt');
  assert.equal(fs.readFileSync(path.join(dir, 'assets/captions/chemin-video.vtt'), 'utf8'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nBonjour Marc.\n');
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.at(-1).props.captions, 'captions/chemin-video.vtt');
  assert.throws(() => edit.run(dir, 'set_captions', { block: 'chemin-video', text: 'Bonjour Marc.' }), /no cue/);
  assert.throws(() => edit.run(dir, 'set_captions', { block: 'chemin-regle', text: 'WEBVTT\n\n00:00.000 --> 00:01.000\nx' }), /captions go on a video/);
  edit.undo(dir);
  assert.equal(fs.existsSync(path.join(dir, 'assets/captions/chemin-video.vtt')), false);
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.at(-1).props.captions, undefined);
});

test('schema-invalid edits are refused before touching the disk', () => {
  const dir = copyExample();
  const before = fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8');
  assert.throws(() => edit.run(dir, 'add_block', { screen: 'chemin', block: { id: 'x', type: 'quiz', props: { stem: 1 } } }), (e) => e instanceof edit.EditError && e.diagnostics.some((d) => d.code === 'E_SCHEMA'));
  assert.equal(fs.readFileSync(path.join(dir, 'screens/chemin.json'), 'utf8'), before);
});

test('free-object planRefs cannot be changed outside a change request', () => {
  const dir = copyExample();
  const m = readJSON(dir, 'objects/diagnostic-reseau/object.manifest.json');
  m.planRefs.objectives = ['OBJ-1'];
  assert.throws(() => edit.run(dir, 'write_object_file', { object: 'diagnostic-reseau', file: 'object.manifest.json', content: JSON.stringify(m) }), /propose_plan_change/);
});

test('screens: create, move, delete', () => {
  const dir = copyExample();
  edit.run(dir, 'create_screen', { id: 'rappel', title: 'Rappel', covers: ['ITEM-6'], section: 'valider' });
  assert.ok(readJSON(dir, 'course.json').sections[2].screens.includes('rappel'));
  edit.run(dir, 'move_screen', { id: 'rappel', after: 'accueil' });
  assert.deepEqual(readJSON(dir, 'course.json').sections[0].screens, ['accueil', 'rappel', 'chemin']);
  edit.run(dir, 'delete_screen', { id: 'rappel' });
  assert.ok(!fs.existsSync(path.join(dir, 'screens/rappel.json')));
});

test('course delivery: update_course sets the media preset, checked against the schema', () => {
  const dir = copyExample();
  edit.run(dir, 'update_course', { delivery: { mediaQuality: 'low' } });
  assert.deepEqual(readJSON(dir, 'course.json').delivery, { mediaQuality: 'low' });
  const before = fs.readFileSync(path.join(dir, 'course.json'), 'utf8');
  // @ts-expect-error: a preset the format does not have
  assert.throws(() => edit.run(dir, 'update_course', { delivery: { mediaQuality: 'ultra' } }), (e) => e instanceof edit.EditError && e.diagnostics.some((d) => d.code === 'E_SCHEMA' && d.path === '/delivery/mediaQuality'));
  assert.equal(fs.readFileSync(path.join(dir, 'course.json'), 'utf8'), before);
  // The presentation too: slides, the size they are designed for.
  edit.run(dir, 'update_course', { presentation: { mode: 'slides', fit: { reference: '1280x720' } } });
  assert.deepEqual(readJSON(dir, 'course.json').presentation, { mode: 'slides', fit: { reference: '1280x720' } });
});

test('update_course: null removes a setting (the last pronunciation, the sounds), never one a course needs', () => {
  const dir = copyExample();
  edit.run(dir, 'update_course', { pronunciations: { fr: [{ text: 'DNS', say: 'dé enne esse' }] }, sounds: { interface: { when: 'on' } } });
  assert.deepEqual(readJSON(dir, 'course.json').sounds, { interface: { when: 'on' } });
  edit.run(dir, 'update_course', { pronunciations: null, sounds: null });
  const course = readJSON(dir, 'course.json');
  assert.ok(!('pronunciations' in course) && !('sounds' in course));
  // Left out, a setting stays as it is.
  edit.run(dir, 'update_course', { sounds: undefined, title: course.title });
  assert.ok(!('sounds' in readJSON(dir, 'course.json')));
  assert.throws(() => edit.run(dir, 'update_course', { title: null }), /title: a course needs it/);
});
