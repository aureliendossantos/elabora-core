import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { validateSchema } from '@elabora/format';
import { getRegistry, BEHAVIORS } from '@elabora/core/components/registry';
import { renderTemplate } from '@elabora/core/components/template';
import { applyDefaults } from '@elabora/core/components/props';
import { controlsOf } from '@elabora/core/components/controls';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { lessonMdExport } from '@elabora/core/interop/lesson-md';
import { projectMarkdown } from '@elabora/core/project/markdown';
import { extractUnits } from '@elabora/core/i18n/units';
import { labelsFor } from '@elabora/player/labels';
import { copyExample, readJSON, writeJSON, writeFixture } from '../helpers.ts';

// Panels (« Panneaux »: accordion, tabs, cards, stack), the character block (speech) and the
// gallery's carousel and zoom (D63): their schemas, templates and controls, their checks, what the
// build gives the player, their exports and translation.

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const ITEMS = [
  { id: 'routeur', title: 'Routeur', markdown: 'Il relie le réseau de l’agence à Internet.', image: 'images/a.svg', alt: 'Un routeur' },
  { id: 'switch', title: 'Commutateur', markdown: 'Il relie les postes de l’étage.' },
  { id: 'cable', title: 'Câble', markdown: 'Il porte le signal jusqu’au mur.' }
];

function course(blocks: unknown[]): string {
  const dir = copyExample();
  for (const name of ['a', 'b', 'c']) writeFixture(dir, `assets/images/${name}.svg`, SVG);
  writeFixture(dir, 'assets/personnages/marc.svg', SVG);
  const data = readJSON(dir, 'course.json');
  data.speakers = [{ id: 'marc', name: 'Marc', color: 'color.primary', look: { portrait: 'personnages/marc.svg' } }, { id: 'guide', name: 'Claire' }];
  writeJSON(dir, 'course.json', data);
  const chemin = readJSON(dir, 'screens/chemin.json');
  writeJSON(dir, 'screens/chemin.json', { ...chemin, blocks: [...chemin.blocks, ...blocks] });
  return dir;
}
const findings = (dir: string) => validateDir(dir).diagnostics;

test('panels, speech, gallery: schemas accept their presentations and refuse what they do not know', () => {
  const ok = (block: unknown) => assert.deepEqual(validateSchema('block', block), [], JSON.stringify(block));
  for (const presentation of ['accordion', 'tabs', 'cards', 'stack']) ok({ id: 'p', type: 'accordion', props: { presentation, items: ITEMS, prompt: 'Que fait chaque équipement ?', hint: false } });
  ok({ id: 'p', type: 'accordion', props: { items: [{ id: 'a', title: 'A', markdown: 'x', image: 'images/a.svg', alt: '', focus: { x: 0.2, y: 0.7 } }] } });
  ok({ id: 's', type: 'speech', props: { speaker: 'marc', side: 'end', kind: 'thought', lines: [{ id: 'l1', markdown: 'Encore le câble ?' }] } });
  ok({ id: 'g', type: 'gallery', props: { presentation: 'carousel', zoom: true, ratio: '16:9', images: [{ id: 'a', asset: 'images/a.svg', alt: 'A' }] } });
  ok({ id: 'i', type: 'image', props: { asset: 'images/a.svg', alt: 'A', zoom: true } });
  const refused = (block: unknown) => assert.ok(validateSchema('block', block).length, JSON.stringify(block));
  refused({ id: 'p', type: 'accordion', props: { presentation: 'carousel', items: ITEMS } });
  refused({ id: 's', type: 'speech', props: { speaker: 'marc', lines: [] } });
  refused({ id: 's', type: 'speech', props: { speaker: 'marc', lines: Array.from({ length: 7 }, (_, i) => ({ id: `l${i}`, markdown: 'x' })) } });
  refused({ id: 's', type: 'speech', props: { speaker: 'marc', kind: 'shout', lines: [{ id: 'l1', markdown: 'x' }] } });
  refused({ id: 's', type: 'speech', props: { lines: [{ id: 'l1', markdown: 'x' }] } });
});

test('panels: switching presentation keeps the items, and each item is one control named by its id in every form', () => {
  const project = loadProjectFromDir(copyExample());
  const accordion = getRegistry(project).get('accordion')!;
  const render = (props: Record<string, unknown>) => renderTemplate(accordion.tpl!, { props: applyDefaults(accordion.schema, props), schema: accordion.schema, id: 'b' }).html;
  const forms: Record<string, string> = {};
  for (const presentation of ['accordion', 'tabs', 'cards', 'stack']) {
    const html = render({ presentation, items: ITEMS, prompt: 'Que fait chaque équipement ?' });
    forms[presentation] = html;
    assert.match(html, new RegExp(`class="t-panels t-panels--${presentation}"`));
    assert.match(html, /<p class="t-panels-prompt">Que fait chaque équipement \?<\/p>/);
    assert.deepEqual([...controlsOf(html).keys()], ['routeur', 'switch', 'cable'], presentation);
    for (const item of ITEMS) assert.ok(html.includes(item.markdown.replace('’', '’')), `${presentation}: ${item.id}`);
  }
  assert.deepEqual(Object.fromEntries([...controlsOf(forms.accordion)]), { routeur: 'details', switch: 'details', cable: 'details' });
  // Tabs, and the accordion they become in a narrow container: one name each.
  assert.match(forms.tabs, /data-t-tabs/);
  assert.match(forms.tabs, /class="t-panels-narrow t-accordion"/);
  assert.equal(controlsOf(forms.tabs).get('switch'), 'tab');
  assert.equal(controlsOf(forms.cards).get('switch'), 'flip');
  assert.equal(controlsOf(forms.stack).get('switch'), 'item');
  assert.match(forms.cards, /data-hint="true"/);
  assert.match(render({ presentation: 'cards', items: ITEMS, hint: false }), /data-hint="false"/);
  // The accordion keeps its name grouping when one panel opens at a time.
  assert.match(render({ items: ITEMS, allowMultiple: false }), /name="t-acc-b" data-t-details="routeur"/);
  // An item's image with its alt; alt "" is decorative.
  assert.match(forms.cards, /<img class="t-panels-cover" src="assets\/images\/a\.svg" alt="Un routeur"/);
});

test('gallery carousel and zoom: one image at a time with thumbnails, zoom buttons with their captions; an image zooms', () => {
  const project = loadProjectFromDir(copyExample());
  const registry = getRegistry(project);
  const render = (type: string, props: Record<string, unknown>) => { const d = registry.get(type)!; return renderTemplate(d.tpl!, { props: applyDefaults(d.schema, props), schema: d.schema, id: 'g' }).html; };
  const images = [{ id: 'a', asset: 'images/a.svg', alt: 'A', caption: 'Légende A' }, { id: 'b', asset: 'images/b.svg', decorative: true }];
  const carousel = render('gallery', { presentation: 'carousel', images });
  assert.match(carousel, /data-t-sequence/);
  assert.deepEqual([...controlsOf(carousel).keys()], ['a', 'b']);
  assert.equal((carousel.match(/data-t-goto=/g) ?? []).length, 2);
  assert.doesNotMatch(carousel, /data-t-zoom/);
  const zoomed = render('gallery', { presentation: 'carousel', zoom: true, images });
  assert.equal((zoomed.match(/<button class="t-zoom" data-t-zoom>/g) ?? []).length, 2);
  assert.match(zoomed, /<figcaption data-t-caption>Légende A<\/figcaption>/);
  for (const presentation of ['grid', 'mosaic']) assert.equal((render('gallery', { presentation, zoom: true, images }).match(/data-t-zoom/g) ?? []).length, 2, presentation);
  assert.doesNotMatch(render('gallery', { presentation: 'compare', zoom: true, images }), /data-t-zoom/, 'compare has its slider instead');
  for (const presentation of ['centered', 'wide', 'beside']) assert.match(render('image', { presentation, asset: 'images/a.svg', alt: 'A', zoom: true }), /<button class="t-zoom" data-t-zoom><img src="assets\/images\/a\.svg" alt="A"/, presentation);
  for (const presentation of ['band', 'over']) assert.doesNotMatch(render('image', { presentation, asset: 'images/a.svg', alt: 'A', zoom: true }), /data-t-zoom/, presentation);
});

test('speech: a behaviour with its hooks; the build gives the player its speaker', () => {
  assert.deepEqual(BEHAVIORS.speech, { required: ['line'], optional: ['speaker', 'portrait'], each: { line: 'lines' } });
  const dir = course([
    { id: 'chemin-marc', type: 'speech', props: { speaker: 'marc', lines: [{ id: 'l1', markdown: 'Mon imprimante **ne répond plus**.' }] } },
    { id: 'chemin-guide', type: 'speech', props: { speaker: 'guide', side: 'end', kind: 'thought', lines: [{ id: 'l1', markdown: 'Le câble ?' }] } }
  ]);
  const project = loadProjectFromDir(dir);
  const data = compileCourseData(project, assignKeys(project, readLock(project), { dryRun: true }).keys, { buildId: 'test' });
  const blocks = data.screens.find((screen) => screen.id === 'chemin')!.blocks;
  const marc = blocks.find((block) => block.id === 'chemin-marc')!;
  assert.equal(marc.behavior, 'speech');
  assert.deepEqual((marc.props as { speaker: unknown }).speaker, { name: 'Marc', color: 'color.primary', look: { portrait: 'assets/personnages/marc.svg' } });
  assert.match(marc.html!, /<div class="t-speech t-speech--speech t-speech--start">/);
  assert.match(marc.html!, /data-t-line="l1"><div class="t-text"><p>Mon imprimante <strong>ne répond plus<\/strong>\.<\/p>/);
  const guide = blocks.find((block) => block.id === 'chemin-guide')!;
  assert.deepEqual((guide.props as { speaker: unknown }).speaker, { name: 'Claire' });
  assert.match(guide.html!, /t-speech--thought t-speech--end/);
});

test('panels, speech, gallery: too many items, long tab labels, an unknown speaker, an item image without alt', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, title: `Élément ${i}`, markdown: 'Texte.' }));
  const images = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, asset: 'images/a.svg', alt: `Image ${i}` }));
  const dir = course([
    { id: 'chemin-tabs', type: 'accordion', props: { presentation: 'tabs', items: [...many(7), { id: 'long', title: 'Un titre bien trop long pour un onglet', markdown: 'x' }] } },
    { id: 'chemin-acc', type: 'accordion', props: { items: many(12) } },
    { id: 'chemin-cards', type: 'accordion', props: { presentation: 'cards', items: [{ id: 'a', title: 'A', markdown: 'x', image: 'images/a.svg' }, { id: 'b', title: 'B', markdown: 'x', image: 'images/b.svg', alt: '' }] } },
    { id: 'chemin-car', type: 'gallery', props: { presentation: 'carousel', images: images(6) } },
    { id: 'chemin-grid', type: 'gallery', props: { presentation: 'grid', images: images(8) } },
    { id: 'chemin-who', type: 'speech', props: { speaker: 'personne', lines: [{ id: 'l1', markdown: 'Bonjour.' }] } }
  ]);
  const found = findings(dir);
  const at = (code: string) => found.filter((d) => d.code === code).map((d) => `${d.target}${d.measured !== undefined ? ` ${d.measured}` : ''}`);
  assert.deepEqual(at('W_ITEMS_MANY').sort(), ['chemin-car 6', 'chemin-tabs 8']);
  assert.deepEqual(at('W_TABS_LABEL_LONG'), ['chemin-tabs 38']);
  assert.deepEqual(at('E_SPEECH_SPEAKER'), ['chemin-who']);
  assert.deepEqual(at('E_IMAGE_ALT_MISSING'), ['chemin-cards']);
  // Seven tabs, five images in a carousel, a known speaker: nothing.
  const fixed = course([
    { id: 'chemin-tabs', type: 'accordion', props: { presentation: 'tabs', items: many(7) } },
    { id: 'chemin-car', type: 'gallery', props: { presentation: 'carousel', images: images(5) } },
    { id: 'chemin-who', type: 'speech', props: { speaker: 'marc', lines: [{ id: 'l1', markdown: 'Bonjour.' }] } }
  ]);
  assert.deepEqual(findings(fixed).filter((d) => ['W_ITEMS_MANY', 'W_TABS_LABEL_LONG', 'E_SPEECH_SPEAKER', 'E_IMAGE_ALT_MISSING', 'E_ASSET_MISSING'].includes(d.code)), []);
});

test('panels, speech, gallery: exports, the client and agent views, translation and the labels of what is left', () => {
  const dir = course([
    { id: 'chemin-cartes', type: 'accordion', props: { presentation: 'cards', prompt: 'Que fait chaque équipement ?', items: ITEMS } },
    { id: 'chemin-marc', type: 'speech', props: { speaker: 'marc', lines: [{ id: 'l1', markdown: 'Mon imprimante ne répond plus.' }, { id: 'l2', markdown: 'J’ai tout redémarré.' }] } }
  ]);
  const project = loadProjectFromDir(dir);
  const exported = lessonMdExport(project);
  const page = [...exported.output.entries()].find(([, text]) => text.includes('Que fait chaque'))?.[1] ?? '';
  assert.match(page, /_Que fait chaque équipement \?_/);
  assert.match(page, /::: accordion[\s\S]*## Routeur\n\n!\[Un routeur\]\(media\/images-a\.svg\)\n\nIl relie le réseau/);
  assert.match(page, /\*\*Marc:\*\* Mon imprimante ne répond plus\.\n\n\*\*Marc:\*\* J’ai tout redémarré\./);
  assert.ok(exported.losses.some((loss) => loss.block === 'chemin-cartes' && /cards/.test(loss.loss)));
  assert.ok(exported.losses.some((loss) => loss.block === 'chemin-marc'));
  const client = projectMarkdown(project, { audience: 'client', screen: 'chemin' });
  for (const words of ['_Que fait chaque équipement ?_', '**Routeur** Il relie le réseau', '**Marc:** Mon imprimante ne répond plus.']) assert.ok(client.includes(words), words);
  const agent = projectMarkdown(project, { audience: 'agent', screen: 'chemin' });
  assert.match(agent, /accordion \(cards\): Routeur · Commutateur · Câble · prompt « Que fait chaque équipement \? »/);
  assert.match(agent, /speech \(marc\) \*\*Marc:\*\* Mon imprimante/);
  const units = extractUnits(project).map((unit) => unit.id);
  for (const id of ['block.chemin-cartes.prompt', 'block.chemin-cartes.items.routeur.title', 'block.chemin-cartes.items.routeur.alt', 'block.chemin-marc.lines.l1.markdown', 'block.chemin-marc.lines.l2.markdown']) assert.ok(units.includes(id), id);
  for (const language of ['fr', 'en', 'de', 'es', 'it', 'nl', 'pt']) {
    const labels = labelsFor(language);
    for (const key of ['leftPanels', 'leftTabs', 'leftImages', 'leftCardsToSee'] as const) assert.match(labels[key], /\{n, plural, one \{.*#.*\} other \{.*#.*\}\}/, `${language} ${key}`);
  }
});
