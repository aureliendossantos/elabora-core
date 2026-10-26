import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { conversionsFor, conversionTargets, listItems, titled } from '@elabora/core/commands/convert';
import { translationTable } from '@elabora/core/i18n/translate';
import { copyExample, readJSON, writeJSON, writeFixture } from '../helpers.ts';
import { addStarterInteractions } from '../starter-interactions-fixture.ts';

// « Transformer en… » (convert_block, D63): a block becomes another type or presentation in place,
// its id and its items' ids kept; what is kept, lost and added is said; translations follow their
// item ids; refused conversions say why.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });

const PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><rect width="40" height="30" fill="#2563eb"/></svg>\n';
const PANELS = [
  { id: 'lien', title: 'Le lien', markdown: 'Le voyant du boîtier dit si le câble est branché.', image: 'images/a.svg', alt: 'Un voyant vert' },
  { id: 'adresse', title: 'L’adresse', markdown: 'Le poste reçoit une adresse du serveur DHCP.' },
  { id: 'nom', title: 'Le nom', markdown: 'Le DNS traduit le nom du serveur en adresse.' }
];

function course(): string {
  const dir = copyExample();
  temporary.push(dir);
  addStarterInteractions(dir);
  for (const name of ['a', 'b', 'c']) writeFixture(dir, `assets/images/${name}.svg`, PICTURE);
  const blocks = [
    { id: 'cv-panels', type: 'accordion', props: { prompt: 'Pensez à ce que vous vérifiez d’abord.', items: PANELS } },
    { id: 'cv-cards', type: 'accordion', props: { presentation: 'cards', items: PANELS.map(({ image: _image, alt: _alt, ...item }) => item) } },
    { id: 'cv-steps', type: 'steps', props: { intro: { title: 'Le trajet d’une demande' }, items: [
      { id: 'un', title: 'Le poste envoie', markdown: 'La demande part du poste.', date: '9 h' },
      { id: 'deux', title: 'Le routeur oriente', markdown: 'Il la fait passer au réseau des serveurs.', date: '9 h 01' },
      { id: 'trois', title: 'Le serveur répond', markdown: 'La page revient au poste.', date: '9 h 02' }
    ] } },
    { id: 'cv-gallery', type: 'gallery', props: { images: [{ id: 'g1', asset: 'images/a.svg', alt: 'Un voyant vert', caption: 'Allumé' }, { id: 'g2', asset: 'images/b.svg', alt: 'Un voyant éteint', caption: 'Éteint' }] } },
    { id: 'cv-gallery-one', type: 'gallery', props: { images: [{ id: 'seule', asset: 'images/c.svg', alt: 'Un boîtier', caption: 'Le boîtier' }] } },
    { id: 'cv-image', type: 'image', props: { asset: 'images/c.svg', alt: 'Un boîtier', caption: 'Le boîtier du bureau' } },
    { id: 'cv-statement', type: 'statement', props: { markdown: 'Cherchez la panne dans l’ordre du trajet.', author: 'Lucie', role: 'technicienne' } },
    { id: 'cv-callout', type: 'callout', props: { variant: 'tip', title: 'Astuce', markdown: 'Notez le message d’erreur mot pour mot.' } },
    { id: 'cv-list', type: 'text', props: { markdown: 'Trois gestes :\n\n- **Le câble** : vérifiez qu’il est branché.\n- Redémarrez le poste. Attendez une minute avant de tester.\n- Appelez le support si rien ne change.' } },
    { id: 'cv-long', type: 'accordion', props: { items: [{ id: 'x', title: 'Un titre', markdown: 'Un texte bien trop long pour un classement. '.repeat(8) }, { id: 'y', title: 'Un autre', markdown: 'Court.' }] } },
    { id: 'cv-quiz', type: 'quiz', props: { stem: 'Quel voyant dit que le lien est actif ?', mode: 'single', options: [{ id: 'a', text: 'Le vert', correct: true, feedback: 'Oui.' }, { id: 'b', text: 'Le rouge', correct: false, feedback: 'Non.' }] } },
    { id: 'cv-process', type: 'process', props: { takeaway: 'Trois gestes suffisent', items: [{ id: 'p1', title: 'Regarder', text: 'Le voyant.' }, { id: 'p2', title: 'Redémarrer' }] } }
  ];
  writeJSON(dir, 'screens/convertir.json', { id: 'convertir', title: 'Convertir', covers: ['ITEM-2'], completeWhen: 'interactions-done', blocks });
  const data = readJSON(dir, 'course.json');
  data.sections.find((section: { id: string }) => section.id === 'decouvrir').screens.push('convertir');
  writeJSON(dir, 'course.json', data);
  return dir;
}

const screenBlock = (dir: string, id: string, screen = 'convertir') => readJSON(dir, `screens/${screen}.json`).blocks.find((block: { id: string }) => block.id === id);
const convert = (dir: string, block: string, type: string, presentation?: string) => edit.convertBlock(dir, { block, to: { type, ...(presentation ? { presentation } : {}) } }) as ReturnType<typeof edit.convertBlock> & { kept: string; lost: string; added: string; progress: { kept: boolean; lost: string[] } };
const errorsOf = (dir: string, screen = 'convertir') => validateDir(dir).diagnostics.filter((d) => d.severity === 'error' && d.file === `screens/${screen}.json`).map((d) => `${d.code} ${d.message}`);
const refusal = (dir: string, block: string, type: string, presentation?: string) => assert.throws(() => convert(dir, block, type, presentation), (error: Error & { code?: string }) => { assert.equal(error.code, 'E_CONVERT_REFUSED', error.message); return true; });

test('convert: the dry run lists the targets with what each keeps, loses and adds, in French and English; nothing is written', () => {
  const dir = course();
  const before = fs.readFileSync(path.join(dir, 'screens/convertir.json'), 'utf8');
  const result = edit.convertBlock(dir, { block: 'cv-panels', language: 'fr' });
  assert.equal(result.change, null);
  assert.equal(fs.readFileSync(path.join(dir, 'screens/convertir.json'), 'utf8'), before);
  assert.deepEqual(result.from, { type: 'accordion', presentation: 'accordion' });
  const names = result.targets!.map((target) => `${target.to.type}${target.to.presentation ? `:${target.to.presentation}` : ''}`);
  assert.deepEqual(names, ['accordion:tabs', 'accordion:cards', 'accordion:stack', 'steps', 'hotspots:popover', 'sort:pairs']);
  assert.equal(result.targets![0].kept, 'On garde tout le contenu.');
  const sort = result.targets!.find((target) => target.to.type === 'sort')!;
  assert.match(sort.kept, /chaque titre et son texte/);
  assert.match(sort.lost, /^On perd les images et la question posée avant d'ouvrir\. Les apprenants déjà commencés perdent/);
  assert.equal(sort.added, 'Reste à ajouter : la consigne et les retours.');
  assert.equal(sort.progress.kept, false);
  const english = conversionTargets(loadProjectFromDir(dir), 'cv-panels', 'en-GB');
  assert.equal(english.targets.find((target) => target.to.type === 'hotspots')!.added, 'The markers are placed on a grid: move them onto the parts of the picture.');
  // A gallery of three pictures does not offer the image; panels without pictures refuse the hotspots, with a reason.
  const cards = conversionsFor(loadProjectFromDir(dir), 'cv-cards');
  assert.deepEqual(cards.refused.map((entry) => [entry.to.type, entry.reason.en]), [['hotspots', 'An interactive picture needs a picture: no item has one.']]);
  assert.ok(!cards.targets.some((target) => target.to.type === 'gallery'), 'panels without pictures do not become a gallery');
});

test('convert: presentations of one block keep everything; what the new form needs starts empty', () => {
  const dir = course();
  const tabs = convert(dir, 'cv-panels', 'accordion', 'tabs');
  assert.equal(tabs.kept, 'Keeps all the content.');
  assert.deepEqual(screenBlock(dir, 'cv-panels').props, { presentation: 'tabs', prompt: 'Pensez à ce que vous vérifiez d’abord.', items: PANELS });
  const timeline = convert(dir, 'cv-steps', 'steps', 'timeline');
  assert.match(timeline.lost, /intro and the summary only show in the carousel/);
  const images = convert(dir, 'cv-quiz', 'quiz', 'images');
  assert.equal(images.added, 'To add: a picture for each option.');
  const zones = convert(dir, 'cv-quiz', 'quiz', 'image');
  assert.match(zones.added, /the picture the zones sit on.*zones are placed on a grid/);
  assert.deepEqual(screenBlock(dir, 'cv-quiz').props.options.map((option: { x: number; y: number }) => [option.x, option.y]), [[0.25, 0.5], [0.75, 0.5]]);
  assert.throws(() => convert(dir, 'cv-panels', 'accordion', 'tabs'), /already a accordion block in presentation tabs/);
  assert.throws(() => convert(dir, 'cv-panels', 'accordion', 'grid'), /accordion has no presentation "grid"/);
  refusal(dir, 'cv-gallery-one', 'gallery', 'compare');
});

test('convert: panels ↔ steps ↔ interactive picture keep each item (id, title, text, picture); round trip', () => {
  const dir = course();
  const steps = convert(dir, 'cv-panels', 'steps');
  assert.equal(steps.kept, 'Keeps the titles, the texts and the pictures.');
  assert.equal(steps.lost, 'Loses the prompt.');
  assert.deepEqual(screenBlock(dir, 'cv-panels'), { id: 'cv-panels', type: 'steps', props: { items: PANELS } });
  const back = convert(dir, 'cv-panels', 'accordion');
  assert.equal(back.lost, '');
  assert.deepEqual(screenBlock(dir, 'cv-panels').props, { items: PANELS }, 'the round trip gives the items back (the prompt was lost on the way)');

  const marker = convert(dir, 'cv-panels', 'hotspots', 'tour');
  assert.match(marker.kept, /picture of "Le lien" becomes the block's picture/);
  const hotspots = screenBlock(dir, 'cv-panels').props;
  assert.equal(hotspots.image, 'images/a.svg');
  assert.equal(hotspots.alt, 'Un voyant vert');
  assert.deepEqual(hotspots.items.map((item: { id: string; x: number; y: number }) => [item.id, item.x, item.y]), [['lien', 0.25, 0.25], ['adresse', 0.75, 0.25], ['nom', 0.25, 0.75]]);
  assert.deepEqual(errorsOf(dir), []);
  const fromMarkers = convert(dir, 'cv-panels', 'steps');
  assert.equal(fromMarkers.lost, 'Loses the markers\' positions.');
  assert.equal(screenBlock(dir, 'cv-panels').props.figureImage, 'images/a.svg', 'the picture becomes the scrolling figure');
  assert.equal(screenBlock(dir, 'cv-panels').props.figureAlt, 'Un voyant vert');

  // Steps with dates lose them as panels; the intro too.
  const panels = convert(dir, 'cv-steps', 'accordion', 'cards');
  assert.equal(panels.lost, 'Loses the dates and the intro. Learners who already started lose what they did in this block.', 'the intro was a visited mark');
  assert.deepEqual(screenBlock(dir, 'cv-steps').props.items.map((item: { id: string }) => item.id), ['un', 'deux', 'trois'], 'ids and order are kept');
  assert.deepEqual(errorsOf(dir), []);
});

test('convert: a gallery and items with pictures; an image and a gallery of one', () => {
  const dir = course();
  const cards = convert(dir, 'cv-gallery', 'accordion', 'cards');
  assert.equal(cards.added, 'To add: each item\'s text.');
  assert.deepEqual(screenBlock(dir, 'cv-gallery').props.items, [{ id: 'g1', title: 'Allumé', markdown: '', image: 'images/a.svg', alt: 'Un voyant vert' }, { id: 'g2', title: 'Éteint', markdown: '', image: 'images/b.svg', alt: 'Un voyant éteint' }]);
  const gallery = convert(dir, 'cv-gallery', 'gallery', 'carousel');
  assert.equal(gallery.lost, '');
  assert.deepEqual(screenBlock(dir, 'cv-gallery').props, { presentation: 'carousel', images: [{ id: 'g1', asset: 'images/a.svg', alt: 'Un voyant vert', caption: 'Allumé' }, { id: 'g2', asset: 'images/b.svg', alt: 'Un voyant éteint', caption: 'Éteint' }] }, 'round trip');
  refusal(dir, 'cv-gallery', 'image');
  refusal(dir, 'cv-cards', 'gallery');

  convert(dir, 'cv-image', 'gallery');
  assert.deepEqual(screenBlock(dir, 'cv-image').props, { images: [{ id: 'i1', asset: 'images/c.svg', alt: 'Un boîtier', caption: 'Le boîtier du bureau' }] });
  convert(dir, 'cv-image', 'image', 'wide');
  assert.deepEqual(screenBlock(dir, 'cv-image').props, { presentation: 'wide', asset: 'images/c.svg', alt: 'Un boîtier', caption: 'Le boîtier du bureau' });
  assert.deepEqual(errorsOf(dir), []);
});

test('convert: panels into a sort in pairs and steps into a sort in order, not scored; too long is refused; round trips', () => {
  const dir = course();
  const pairs = convert(dir, 'cv-cards', 'sort');
  assert.match(pairs.kept, /does not count in the score/);
  assert.deepEqual(screenBlock(dir, 'cv-cards').props, {
    presentation: 'pairs', scored: false,
    items: PANELS.map((panel) => ({ id: panel.id, text: panel.title, target: panel.id })),
    targets: PANELS.map((panel) => ({ id: panel.id, text: panel.markdown }))
  });
  assert.deepEqual(errorsOf(dir), []);
  const back = convert(dir, 'cv-cards', 'accordion', 'cards');
  assert.match(back.lost, /instruction, the feedback and the scoring settings/);
  assert.deepEqual(screenBlock(dir, 'cv-cards').props, { presentation: 'cards', items: PANELS.map(({ image: _image, alt: _alt, ...item }) => item) });
  refusal(dir, 'cv-long', 'sort');

  const order = convert(dir, 'cv-steps', 'sort');
  assert.deepEqual(screenBlock(dir, 'cv-steps').props, { presentation: 'order', scored: false, items: [{ id: 'un', text: 'Le poste envoie' }, { id: 'deux', text: 'Le routeur oriente' }, { id: 'trois', text: 'Le serveur répond' }] });
  assert.match(order.lost, /^Loses the texts, the dates and the intro\./);
  convert(dir, 'cv-steps', 'steps');
  assert.deepEqual(screenBlock(dir, 'cv-steps').props.items.map((item: { id: string; title: string }) => [item.id, item.title]), [['un', 'Le poste envoie'], ['deux', 'Le routeur oriente'], ['trois', 'Le serveur répond']], 'never reordered');
  refusal(dir, 'cv-panels', 'sort', 'categories');
});

test('convert: steps and the charts process and milestones (short labels, the takeaway from the intro)', () => {
  const dir = course();
  const chart = convert(dir, 'cv-steps', 'milestones');
  assert.match(chart.added, /takeaway is the intro's title/);
  assert.deepEqual(screenBlock(dir, 'cv-steps').props, { takeaway: 'Le trajet d’une demande', items: [
    { id: 'un', date: '9 h', title: 'Le poste envoie', text: 'La demande part du poste.' },
    { id: 'deux', date: '9 h 01', title: 'Le routeur oriente', text: 'Il la fait passer au réseau des serveurs.' },
    { id: 'trois', date: '9 h 02', title: 'Le serveur répond', text: 'La page revient au poste.' }
  ] });
  assert.deepEqual(errorsOf(dir), []);
  convert(dir, 'cv-steps', 'steps', 'timeline');
  assert.deepEqual(screenBlock(dir, 'cv-steps').props.intro, { title: 'Le trajet d’une demande' });
  const process = convert(dir, 'cv-process', 'steps');
  assert.match(process.kept, /takeaway as the intro/);
  assert.deepEqual(screenBlock(dir, 'cv-process').props, { intro: { title: 'Trois gestes suffisent' }, items: [{ id: 'p1', title: 'Regarder', markdown: 'Le voyant.' }, { id: 'p2', title: 'Redémarrer', markdown: '' }] });
  // Steps without dates are not offered as milestones; steps beyond seven are refused as a process.
  assert.ok(!conversionsFor(loadProjectFromDir(dir), 'cv-process').targets.some((target) => target.to.type === 'milestones'));
  refusal(dir, 'cv-process', 'milestones');
});

test('convert: statement, callout and text into one another; a text\'s list into panels or steps', () => {
  const dir = course();
  const callout = convert(dir, 'cv-statement', 'callout');
  assert.equal(callout.lost, 'Loses the author, their role and portrait.');
  assert.deepEqual(screenBlock(dir, 'cv-statement').props, { variant: 'info', markdown: 'Cherchez la panne dans l’ordre du trajet.' });
  const statement = convert(dir, 'cv-callout', 'statement', 'ruled');
  assert.equal(statement.lost, 'Loses the callout\'s title and the callout\'s kind.');
  assert.deepEqual(screenBlock(dir, 'cv-callout').props, { presentation: 'ruled', markdown: 'Notez le message d’erreur mot pour mot.' });
  convert(dir, 'cv-callout', 'text');
  assert.deepEqual(screenBlock(dir, 'cv-callout').props, { markdown: 'Notez le message d’erreur mot pour mot.' });

  const steps = convert(dir, 'cv-list', 'steps');
  assert.equal(steps.lost, 'Loses the paragraphs around the list.');
  assert.deepEqual(screenBlock(dir, 'cv-list').props.items, [
    { id: 'i1', title: 'Le câble', markdown: 'vérifiez qu’il est branché.' },
    { id: 'i2', title: 'Redémarrez le poste', markdown: 'Attendez une minute avant de tester.' },
    { id: 'i3', title: 'Appelez le support si rien ne change', markdown: '' }
  ]);
  assert.deepEqual(errorsOf(dir), []);
  refusal(dir, 'cv-callout', 'accordion');
});

test('convert: the list reader and titles', () => {
  assert.deepEqual(listItems('Avant\n\n1. Un\n2. Deux\n   suite\n\nAprès'), { items: ['Un', 'Deux suite'], rest: true });
  assert.deepEqual(listItems('- a\n- b'), { items: ['a', 'b'], rest: false });
  assert.deepEqual(titled('Une phrase très longue qui ne tient pas dans un titre de soixante caractères au plus, vraiment', 60).title, 'Une phrase très longue qui ne tient pas…');
});

test('convert: translations follow their item ids; learner progress is said; one undo gives the block back', () => {
  const dir = course();
  edit.exportTranslationChange(dir, { to: 'en' });
  const texts = [
    { unit: 'block.cv-cards.items.lien.title', target: 'The link' },
    { unit: 'block.cv-cards.items.lien.markdown', target: 'The box\'s light says whether the cable is plugged in.' },
    { unit: 'block.cv-gallery.images.g1.caption', target: 'On' },
    { unit: 'block.cv-panels.items.nom.title', target: 'The name' }
  ];
  edit.translateText(dir, { language: 'en', texts: texts.map(({ unit, target }) => ({ unit, target })) });
  const before = fs.readFileSync(path.join(dir, 'screens/convertir.json'), 'utf8');
  const sort = convert(dir, 'cv-cards', 'sort');
  assert.equal(sort.translations, 6, 'title → items.text and markdown → targets.text for each of the three pairs');
  convert(dir, 'cv-gallery', 'steps');
  const steps = convert(dir, 'cv-panels', 'steps', 'carousel');
  const rows = new Map(translationTable(loadProjectFromDir(dir), 'en').rows.map((row) => [row.id, row]));
  assert.equal(rows.get('block.cv-cards.items.lien.text')?.target, 'The link');
  assert.equal(rows.get('block.cv-cards.targets.lien.text')?.target, 'The box\'s light says whether the cable is plugged in.');
  assert.equal(rows.get('block.cv-cards.targets.lien.text')?.status, 'translated');
  assert.equal(rows.get('block.cv-gallery.items.g1.title')?.target, 'On');
  assert.equal(rows.get('block.cv-panels.items.nom.title')?.status, 'translated', 'same prop, same id: nothing to move');

  // Visited marks of panels are their items: steps keep them, a sort does not, panels have no intro.
  assert.deepEqual(steps.progress, { kept: true, lost: [] });
  assert.deepEqual(convert(dir, 'cv-steps', 'accordion').progress, { kept: false, lost: ['visit:cv-steps#intro'] });
  assert.equal(sort.progress.kept, false);
  assert.deepEqual(sort.progress.lost, ['visit:cv-cards#lien', 'visit:cv-cards#adresse', 'visit:cv-cards#nom']);

  edit.undo(dir); edit.undo(dir); edit.undo(dir); edit.undo(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'screens/convertir.json'), 'utf8'), before, 'each conversion is one change');
});

test('convert: the CLI lists, dry-runs and converts', async () => {
  const dir = course();
  const { spawnSync } = await import('node:child_process');
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(import.meta.dirname, '../../bin/elabora.js'), ...args], { encoding: 'utf8' });
  const list = run('convert', dir, 'convertir', 'cv-panels');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^cv-panels \(accordion:accordion\) converts into:\n {2}accordion:tabs {9}Keeps all the content\.\n/);
  const dry = run('convert', dir, 'convertir', 'cv-panels', '--to', 'accordion:cards', '--dry-run');
  assert.equal(dry.stdout, 'Dry run, nothing written. cv-panels: accordion:accordion → accordion:cards. Keeps all the content.\n');
  assert.equal(screenBlock(dir, 'cv-panels').props.presentation, undefined);
  const wrong = run('convert', dir, 'accueil', 'cv-panels', '--to', 'steps');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /is on screen "convertir", not "accueil"/);
  const done = run('convert', dir, 'convertir', 'cv-panels', '--to', 'steps', '--lang', 'fr');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^✔ cv-panels: accordion:accordion → steps:carousel\. On garde les titres, les textes et les images\. On perd la question posée avant d'ouvrir\./);
  assert.equal(screenBlock(dir, 'cv-panels').type, 'steps');
});

test('convert: the engine answers conversions in the app\'s language and runs convert_block as one undoable change', async () => {
  const { openProject, ProtocolClient } = await import('@elabora/engine');
  const dir = course();
  const session = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 });
  try {
    const client = new ProtocolClient((message) => { void session.handle(structuredClone(message)).then((response) => client.receive(structuredClone(response))); });
    assert.deepEqual(await client.request('conversions', { probe: true }), { supported: true, targets: [], refused: [] });
    const french = await client.request('conversions', { block: 'cv-panels', language: 'fr' });
    assert.equal(french.supported, true);
    assert.deepEqual(french.from, { type: 'accordion', presentation: 'accordion' });
    const cards = french.targets.find((target) => target.to.type === 'accordion' && target.to.presentation === 'cards')!;
    assert.deepEqual(cards, { to: { type: 'accordion', presentation: 'cards' }, kept: 'On garde tout le contenu.', lost: '', added: '', progress: { kept: true, lost: [] } });
    const german = await client.request('conversions', { block: 'cv-cards', language: 'de' });
    assert.deepEqual(german.refused, [{ to: { type: 'hotspots', presentation: 'popover' }, reason: 'An interactive picture needs a picture: no item has one.' }]);
    await assert.rejects(client.request('conversions', { block: 'absent' }), { kind: 'not-found' });
    const run = await client.request('run', { command: 'convert_block', args: { block: 'cv-panels', to: { type: 'accordion', presentation: 'cards' } } });
    assert.ok(run.change);
    assert.equal(run.result.kept, 'Keeps all the content.');
    assert.equal(screenBlock(dir, 'cv-panels').props.presentation, 'cards');
    await assert.rejects(client.request('run', { command: 'convert_block', args: { block: 'cv-cards', to: { type: 'hotspots' } } }), (error: Error & { kind?: string }) => error.kind === 'refused' && /needs a picture/.test(error.message));
    await client.request('undo', {});
    assert.equal(screenBlock(dir, 'cv-panels').props.presentation, undefined);
  } finally {
    await session.close();
  }
});

test('add_block takes optional (only written when true); W_COMPLETION_MISMATCH leaves optional activities out', () => {
  const dir = course();
  const data = readJSON(dir, 'screens/convertir.json');
  data.completeWhen = 'viewed';
  data.blocks = data.blocks.filter((block: { type: string }) => !['quiz', 'sort', 'fill-in', 'reflection'].includes(block.type));
  writeJSON(dir, 'screens/convertir.json', data);
  const mismatch = () => validateDir(dir).diagnostics.filter((d) => d.code === 'W_COMPLETION_MISMATCH' && d.file === 'screens/convertir.json').length;
  assert.equal(mismatch(), 0);
  const quiz = { type: 'quiz', props: { stem: 'Un exercice en plus ?', mode: 'single', options: [{ id: 'a', text: 'Oui', correct: true, feedback: 'Oui.' }, { id: 'b', text: 'Non', correct: false, feedback: 'Non.' }] } };
  const added = edit.addBlock(dir, { screen: 'convertir', block: { ...quiz, id: 'cv-extra', optional: true } });
  assert.equal(added.block, 'cv-extra');
  assert.equal(screenBlock(dir, 'cv-extra').optional, true);
  assert.equal(mismatch(), 0, 'an optional activity does not ask for interactions-done');
  edit.addBlock(dir, { screen: 'convertir', block: { ...quiz, id: 'cv-required', optional: false } });
  assert.equal('optional' in screenBlock(dir, 'cv-required'), false, 'optional: false is not written');
  assert.equal(mismatch(), 1);
  // A course component (a fork of the quiz) converts into nothing: no targets, not an error; convert_block says to detach it.
  edit.forkComponent(dir, { component: 'quiz', id: 'quiz-maison', title: 'Quiz maison' });
  edit.updateBlock(dir, { block: 'cv-extra', props: {} });
  const forked = readJSON(dir, 'screens/convertir.json');
  forked.blocks.find((block: { id: string }) => block.id === 'cv-extra').type = 'quiz-maison';
  writeJSON(dir, 'screens/convertir.json', forked);
  assert.deepEqual(conversionsFor(loadProjectFromDir(dir), 'cv-extra'), { block: 'cv-extra', from: { type: 'quiz-maison' }, targets: [], refused: [] });
  assert.throws(() => convert(dir, 'cv-extra', 'quiz', 'images'), /course component: detach it first/);
});
