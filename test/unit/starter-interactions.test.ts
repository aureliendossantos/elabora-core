import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { validateSchema } from '@elabora/format';
import { getRegistry } from '@elabora/core/components/registry';
import { renderTemplate } from '@elabora/core/components/template';
import { applyDefaults } from '@elabora/core/components/props';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { lessonMdExport } from '@elabora/core/interop/lesson-md';
import { projectMarkdown } from '@elabora/core/project/markdown';
import { extractUnits } from '@elabora/core/i18n/units';
import { labelsFor, formatLabel } from '@elabora/player/labels';
import { copyExample, readJSON, writeJSON, writeFixture, codes } from '../helpers.ts';
import { addStarterInteractions, MARKERS, STARTER_SCREENS } from '../starter-interactions-fixture.ts';

// The starter interactions of D63: a steps block (« Étapes », not the screen's steps) and an interactive
// picture (« Image interactive »): their schemas, templates, checks, what the build gives the player,
// their exports and translation, and their labels.

const findings = (dir: string) => validateDir(dir).diagnostics;
const fixture = (options: { slides?: boolean } = {}) => { const dir = copyExample(); addStarterInteractions(dir, options); return dir; };
// The fixture with one screen's first block replaced.
function withBlock(screen: string, props: Record<string, unknown>, { slides = false }: { slides?: boolean } = {}): string {
  const dir = fixture({ slides });
  const data = readJSON(dir, `screens/${screen}.json`);
  data.blocks[0] = { ...data.blocks[0], props: { ...data.blocks[0].props, ...props } };
  writeJSON(dir, `screens/${screen}.json`, data);
  return dir;
}
const targets = (dir: string, code: string) => findings(dir).filter((d) => d.code === code).map((d) => d.target);

test('steps and hotspots: schemas accept their presentations and items, refuse what they do not know', () => {
  const ok = (block: unknown) => assert.deepEqual(validateSchema('block', block), [], JSON.stringify(block));
  ok({ id: 's', type: 'steps', props: { presentation: 'scroll', figure: 'focus', side: 'start', figureImage: 'images/a.svg', figureAlt: 'A', items: [{ id: 'a', title: 'Un', markdown: 'Texte', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }] } });
  ok({ id: 's', type: 'steps', props: { numbered: false, intro: { title: 'Intro' }, summary: { title: 'Fin', markdown: 'À retenir' }, items: [{ id: 'a', title: 'Un', markdown: 'Texte', image: 'images/a.svg', alt: 'A', date: '1990' }] } });
  ok({ id: 'h', type: 'hotspots', props: { presentation: 'tour', image: 'images/a.svg', alt: 'A', focus: { x: 0.5, y: 0.5 }, markerStyle: 'icon', icon: 'eye', prompt: 'Regardez.', items: [{ id: 'a', x: 0, y: 1, title: 'Un', markdown: 'Texte' }] } });
  assert.ok(validateSchema('block', { id: 's', type: 'steps', props: { presentation: 'slider', items: [{ id: 'a', title: 'Un', markdown: 'T' }] } }).length);
  assert.ok(validateSchema('block', { id: 's', type: 'steps', props: { items: [{ id: 'a', title: 'Un', markdown: 'T', region: { x: 0, y: 0, w: 0, h: 1 } }] } }).length, 'a region has a width');
  assert.ok(validateSchema('block', { id: 'h', type: 'hotspots', props: { image: 'images/a.svg', items: [{ id: 'a', x: 1.2, y: 0, title: 'Un', markdown: 'T' }] } }).length, 'x within the picture');
  assert.ok(validateSchema('block', { id: 'h', type: 'hotspots', props: { image: 'images/a.svg', icon: 'star', items: [{ id: 'a', x: 0, y: 0, title: 'Un', markdown: 'T' }] } }).length);
  // The screen's steps keep their meaning: a screen's steps and a steps block live side by side.
  assert.deepEqual(validateSchema('screen', { id: 'x', title: 'X', covers: ['ITEM-1'], steps: { 2: { opens: 'explored' } }, blocks: [{ id: 'x-s', type: 'steps', step: 2, props: { items: [{ id: 'a', title: 'Un', markdown: 'T' }] } }] }), []);
});

test('steps and hotspots: the fixture validates without errors nor warnings of theirs', () => {
  const found = findings(fixture());
  assert.deepEqual(found.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`), []);
  assert.deepEqual(codes(found).filter((code) => ['W_ITEMS_MANY', 'W_HOTSPOTS_CLOSE', 'W_STEPS_SCROLL_SLIDES', 'E_STEPS_FIGURE', 'E_BLOCK_ITEM_DUPLICATE'].includes(code)), []);
});

test('steps and hotspots: templates give each presentation its hooks and words', () => {
  const project = loadProjectFromDir(copyExample());
  const registry = getRegistry(project);
  const render = (type: string, props: Record<string, unknown>) => { const component = registry.get(type)!; return renderTemplate(component.tpl!, { props: applyDefaults(component.schema, props), schema: component.schema, id: 'b' }).html; };
  const items = [{ id: 'un', title: 'Un', markdown: 'Premier', image: 'images/a.svg', alt: 'A' }, { id: 'deux', title: 'Deux', markdown: 'Second' }];
  const carousel = render('steps', { intro: { title: 'Avant' }, summary: { title: 'Après' }, items });
  assert.match(carousel, /^<div class="t-steps t-steps--carousel" data-t-sequence>/);
  assert.deepEqual([...carousel.matchAll(/data-t-item="([^"]+)"/g)].map((m) => m[1]), ['intro', 'un', 'deux', 'summary'], 'the intro and the summary are items of the sequence');
  assert.match(carousel, /data-t-next data-t-label="beginSteps"/);
  assert.doesNotMatch(render('steps', { items }), /data-t-item="intro"/);
  const timeline = render('steps', { presentation: 'timeline', items: items.map((item) => ({ ...item, date: '1999' })) });
  assert.deepEqual([...timeline.matchAll(/data-t-reveal="([^"]+)"/g)].map((m) => m[1]), ['un', 'deux']);
  assert.match(timeline, /<p class="t-steps-date">1999<\/p>/);
  const scroll = render('steps', { presentation: 'scroll', figure: 'build', figureImage: 'images/b.svg', figureAlt: 'B', items });
  assert.match(scroll, /class="t-steps t-steps--scroll t-steps--build t-steps--side-end" data-t-follow/);
  assert.match(scroll, /<div class="t-steps-stage" aria-hidden="true">/);
  assert.match(scroll, /style="--layer: 1"/);
  assert.match(scroll, /role="img" aria-label="A"/, 'a step\'s own figure is named by its alt');
  const popover = render('hotspots', { image: 'images/a.svg', alt: 'A', items: [{ id: 'm', x: 0.25, y: 0.75, title: 'Le voyant', markdown: 'Vert' }] });
  assert.match(popover, /data-t-exclusive="popover"/);
  assert.match(popover, /data-t-toggle="m" style="--x: 0.25; --y: 0.75" aria-label="1. Le voyant"/);
  assert.match(popover, /data-t-reveal="m"[^>]*>\s*<div class="t-hotspots-panel" data-t-part="m">/, 'its entry counts once seen in the list');
  assert.doesNotMatch(popover, /data-focus/, 'never cropped without a focal point');
  const tour = render('hotspots', { presentation: 'tour', image: 'images/a.svg', alt: 'A', focus: { x: 0.3, y: 0.5 }, items: [{ id: 'm', x: 0.25, y: 0.75, title: 'Le voyant', markdown: 'Vert' }] });
  assert.match(tour, /data-focus="0.3"/);
  assert.match(tour, /data-t-sequence/);
  assert.match(tour, /<button class="t-hotspots-marker" data-t-goto="m"/);
  assert.match(render('hotspots', { presentation: 'side', markerStyle: 'icon', icon: 'question', image: 'images/a.svg', alt: 'A', items: [{ id: 'm', x: 0, y: 0, title: 'T', markdown: 'M' }] }), /data-t-exclusive>[\s\S]*t-hotspots-icon[\s\S]*data-t-label="hotspotsHint"/);
});

test('steps: a scroll whose figure lacks what it follows, a scroll in slides, too many steps, ids that clash, pictures without alt', () => {
  assert.deepEqual(targets(withBlock('etapes-zoom', { figureImage: undefined }), 'E_STEPS_FIGURE'), ['etapes-zoom-bloc']);
  assert.deepEqual(targets(withBlock('etapes-construire', { items: [{ id: 'a', title: 'Un', markdown: 'T' }] }), 'E_STEPS_FIGURE'), ['etapes-construire-bloc']);
  assert.ok(targets(withBlock('etapes-defile', {}, { slides: true }), 'W_STEPS_SCROLL_SLIDES').includes('etapes-defile-bloc'));
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `Étape ${i}`, markdown: 'Texte' }));
  assert.deepEqual(targets(withBlock('etapes-carrousel', { items: many }), 'W_ITEMS_MANY'), ['etapes-carrousel-bloc']);
  assert.deepEqual(targets(withBlock('etapes-frise', { items: many }), 'W_ITEMS_MANY'), [], 'a timeline lists them');
  assert.deepEqual(targets(withBlock('etapes-carrousel', { items: [{ id: 'summary', title: 'Un', markdown: 'T' }, { id: 'a', title: 'A', markdown: 'T' }, { id: 'a', title: 'B', markdown: 'T' }] }), 'E_BLOCK_ITEM_DUPLICATE'), ['etapes-carrousel-bloc', 'etapes-carrousel-bloc']);
  assert.deepEqual(targets(withBlock('etapes-carrousel', { summary: undefined, items: [{ id: 'summary', title: 'Un', markdown: 'T' }] }), 'E_BLOCK_ITEM_DUPLICATE'), [], 'without a summary, the id is free');
  assert.deepEqual(targets(withBlock('etapes-defile', { items: [{ id: 'a', title: 'A', markdown: 'T', image: 'images/etape-1.svg' }] }), 'E_IMAGE_ALT_MISSING'), ['etapes-defile-bloc']);
  assert.deepEqual(targets(withBlock('etapes-zoom', { figureAlt: undefined }), 'E_IMAGE_ALT_MISSING'), ['etapes-zoom-bloc']);
  assert.ok(codes(findings(withBlock('etapes-defile', { items: [{ id: 'a', title: 'A', markdown: 'T', image: 'images/none.svg', alt: 'A' }] }))).includes('E_ASSET_MISSING'));
});

test('hotspots: too many markers, markers that overlap on a phone (with and without a focal point), a picture without alt', () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, x: (i % 3) / 3 + 0.15, y: Math.floor(i / 3) / 3 + 0.15, title: `Repère ${i}`, markdown: 'Texte' }));
  assert.deepEqual(targets(withBlock('image-dessous', { items: nine }), 'W_ITEMS_MANY'), ['image-dessous-bloc']);
  // 0.08 of a 1600 × 900 picture 337 px wide on a phone: 27 px apart, less than a marker.
  const close = [MARKERS[0], { ...MARKERS[1], x: MARKERS[0].x + 0.08, y: MARKERS[0].y }];
  const found = findings(withBlock('image-dessous', { items: close })).filter((d) => d.code === 'W_HOTSPOTS_CLOSE');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /markers 1 and 2 \(27 px\)/);
  assert.doesNotMatch(found[0].message, /taken as 4:3/, 'the SVG says its proportions');
  // Half as large again with a focal point: 40 px, still too close; 0.1 apart then fits (51 px).
  assert.deepEqual(targets(withBlock('image-dessous', { items: close, focus: { x: 0.5, y: 0.5 } }), 'W_HOTSPOTS_CLOSE'), ['image-dessous-bloc']);
  assert.deepEqual(targets(withBlock('image-dessous', { items: [MARKERS[0], { ...MARKERS[1], x: MARKERS[0].x + 0.1, y: MARKERS[0].y }], focus: { x: 0.5, y: 0.5 } }), 'W_HOTSPOTS_CLOSE'), []);
  assert.deepEqual(targets(withBlock('image-dessous', { alt: undefined }), 'E_IMAGE_ALT_MISSING'), ['image-dessous-bloc']);
  assert.deepEqual(targets(withBlock('image-dessous', { items: [MARKERS[0], MARKERS[0]] }), 'E_BLOCK_ITEM_DUPLICATE'), ['image-dessous-bloc']);
});

test('steps and hotspots: the build names their controls and what they are for a locked Continue', () => {
  const dir = fixture();
  const project = loadProjectFromDir(dir);
  const data = compileCourseData(project, assignKeys(project, readLock(project), { dryRun: true }).keys, { buildId: 'test' });
  const block = (screen: string) => data.screens.find((candidate) => candidate.id === screen)!.blocks[0];
  assert.deepEqual(Object.keys(block('etapes-carrousel').visits ?? {}).sort(), ['commutateur', 'intro', 'pare-feu', 'poste', 'routeur', 'serveur', 'summary']);
  assert.deepEqual(STARTER_SCREENS.map((screen) => block(screen).explore), ['steps', 'events', 'steps', 'steps', 'steps', 'markers', 'markers', 'markers', 'markers']);
  assert.deepEqual(Object.keys(block('image-repere').visits ?? {}).sort(), ['boitier', 'cable', 'ecran', 'imprimante'], 'a marker and its entry are one control');
  // A template whose follow holds no reveal is refused.
  writeFixture(dir, 'components/my-follow/component.json', { id: 'my-follow', title: 'Mine', version: '1.0.0', level: 'block', props: { type: 'object', properties: {} } });
  writeFixture(dir, 'components/my-follow/template.html', '<div data-t-follow><p>Rien</p></div>');
  const hooks = findings(dir).filter((d) => d.code === 'E_COMPONENT_HOOK' && d.target === 'my-follow');
  assert.match(hooks[0]?.message ?? '', /data-t-follow holds the data-t-reveal elements/);
});

test('steps and hotspots: exports, the client view and translation carry their words', () => {
  const project = loadProjectFromDir(fixture());
  const exported = lessonMdExport(project);
  const all = [...exported.output.values()].join('\n');
  assert.match(all, /## Le trajet d’une impression\n\nUne demande d’impression traverse/);
  assert.match(all, /## 1\. Le poste envoie\n\nMarc clique/);
  assert.match(all, /## 9 h 00 — Le poste envoie/);
  assert.match(all, /## À retenir/);
  assert.match(all, /::: image\nsrc: media\/images-bureau\.svg\nalt: Un bureau/);
  assert.match(all, /## 2\. Le voyant\n\nLe voyant vert/);
  assert.ok(exported.losses.some((loss) => loss.block === 'image-repere-bloc') && exported.losses.some((loss) => loss.block === 'etapes-defile-bloc'));
  const client = projectMarkdown(project, { audience: 'client' });
  for (const words of ['**Le trajet d’une impression** Une demande', '1. **Le poste envoie** Marc clique', '9 h 00 — **Le poste envoie**', '"Un bureau : un écran', '2. **Le voyant** Le voyant vert']) assert.ok(client.includes(words), words);
  const agent = projectMarkdown(project, { audience: 'agent' });
  assert.match(agent, /steps \(scroll, figure build\)/);
  assert.match(agent, /hotspots \(tour\) `images\/bureau\.svg`/);
  const units = extractUnits(project).map((unit) => unit.id);
  for (const id of ['block.etapes-carrousel-bloc.intro.title', 'block.etapes-carrousel-bloc.summary.markdown', 'block.etapes-carrousel-bloc.items.poste.title', 'block.etapes-frise-bloc.items.poste.date', 'block.etapes-construire-bloc.figureAlt', 'block.etapes-defile-bloc.items.poste.alt', 'block.image-repere-bloc.prompt', 'block.image-repere-bloc.items.boitier.markdown', 'block.image-repere-bloc.items.boitier.alt', 'block.image-repere-bloc.alt']) assert.ok(units.includes(id), id);
});

test('steps and hotspots: their labels in every language of the player', () => {
  for (const language of ['fr', 'en', 'de', 'es', 'it', 'nl', 'pt']) {
    const labels = labelsFor(language);
    for (const key of ['beginSteps', 'hotspotsHint', 'leftSteps', 'leftEvents', 'leftMarkers'] as const) assert.ok(labels[key], `${language} ${key}`);
    for (const key of ['leftSteps', 'leftEvents', 'leftMarkers'] as const) assert.match(formatLabel(labels[key], { n: 2 }, language), /2/, `${language} ${key}`);
  }
  assert.equal(formatLabel(labelsFor('fr').leftMarkers, { n: 1 }, 'fr'), 'Il reste 1 repère à ouvrir.');
  assert.equal(formatLabel(labelsFor('en').leftSteps, { n: 3 }, 'en'), '3 steps left to see.');
});
