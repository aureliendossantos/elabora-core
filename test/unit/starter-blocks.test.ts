import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { validateSchema, LAYOUT_TYPES, isBuiltinLayoutType } from '@elabora/format';
import { getRegistry, BUILTINS, BUILTIN_LAYOUTS } from '@elabora/core/components/registry';
import { renderTemplate } from '@elabora/core/components/template';
import { applyDefaults } from '@elabora/core/components/props';
import { checkTemplate } from '@elabora/core/validate/components';
import { createReporter } from '@elabora/core/diagnostics/index';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { lessonMdExport } from '@elabora/core/interop/lesson-md';
import { projectMarkdown } from '@elabora/core/project/markdown';
import { extractUnits } from '@elabora/core/i18n/units';
import { labelsFor } from '@elabora/player/labels';
import { copyExample, readJSON, writeJSON, writeFixture, codes } from '../helpers.ts';

// The starter blocks of D63 (content and structure): their schemas, the built-in layout opening in
// the registry and the validator, their checks, what the build gives the player, and their exports.

const findings = (dir: string) => validateDir(dir).diagnostics;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

// The sample course with one screen of starter blocks (chemin), and its images.
function course(blocks: unknown[], screen: Record<string, unknown> = {}): string {
  const dir = copyExample();
  for (const name of ['a', 'b', 'c']) writeFixture(dir, `assets/images/${name}.svg`, SVG);
  const chemin = readJSON(dir, 'screens/chemin.json');
  writeJSON(dir, 'screens/chemin.json', { ...chemin, ...screen, blocks: [...chemin.blocks, ...blocks] });
  return dir;
}

test('starter blocks: schemas accept their presentations and refuse what they do not know', () => {
  const ok = (block: unknown) => assert.deepEqual(validateSchema('block', block), [], JSON.stringify(block));
  ok({ id: 'q', type: 'statement', props: { presentation: 'quote', markdown: 'La carte n’est pas le territoire.', author: 'A. Korzybski', role: 'linguiste', portrait: 'images/a.svg', align: 'start' } });
  ok({ id: 'd', type: 'divider', props: { presentation: 'number', size: 'large', restart: true } });
  ok({ id: 'g', type: 'gallery', props: { presentation: 'compare', images: [{ id: 'avant', asset: 'images/a.svg', alt: 'Avant', focus: { x: 0.2, y: 0.8 } }, { id: 'apres', asset: 'images/b.svg', alt: 'Après' }] } });
  ok({ id: 'c', type: 'columns', props: { count: 3, widths: 'wide-end', align: 'center' }, blocks: [] });
  ok({ id: 'i', type: 'image', width: 'bleed', props: { presentation: 'beside', side: 'end', share: 'third', asset: 'images/a.svg', alt: 'A', title: 'T', markdown: 'Texte' } });
  ok({ id: 't', type: 'text', props: { markdown: 'Texte', aside: 'Une note.' } });
  assert.ok(validateSchema('block', { id: 'x', type: 'statement', props: { presentation: 'banner', markdown: 'x' } }).length);
  assert.ok(validateSchema('block', { id: 'x', type: 'image', props: { asset: 'images/a.svg', focus: { x: 2, y: 0 } } }).length);
  assert.ok(validateSchema('block', { id: 'x', type: 'columns', props: { count: 4 } }).length);
  assert.ok(validateSchema('block', { id: 'x', type: 'gallery', props: { images: [{ id: 'Bad Id', asset: 'images/a.svg' }] } }).length);
});

test('starter blocks: built-in templates follow the rules agents follow, layouts included', () => {
  const project = loadProjectFromDir(copyExample());
  const registry = getRegistry(project);
  for (const id of [...Object.keys(BUILTINS).filter((type) => BUILTINS[type].render === 'template'), ...Object.keys(BUILTIN_LAYOUTS)]) {
    const reporter = createReporter();
    const component = registry.get(id);
    assert.ok(component, id);
    checkTemplate({ project, reporter }, component);
    assert.deepEqual(reporter.items.filter((d) => d.severity !== 'info').map((d) => `${d.code} ${d.message}`), [], id);
  }
});

test('the image block keeps its markup in its default presentation, and asks for the full width as a band', () => {
  const project = loadProjectFromDir(copyExample());
  const image = getRegistry(project).get('image')!;
  const render = (props: Record<string, unknown>) => renderTemplate(image.tpl!, { props: applyDefaults(image.schema, props), schema: image.schema, id: 'b' }).html;
  // Its image in a wrapper that is no box (t-media, display: contents), a button when it zooms (D63).
  assert.equal(render({ asset: 'images/a.png', alt: 'A', caption: 'C' }), '<figure class="t-figure"><span class="t-media"><img src="assets/images/a.png" alt="A" loading="lazy" decoding="async"></span><figcaption data-t-caption>C</figcaption></figure>');
  assert.equal(render({ asset: 'images/a.png', decorative: true }), '<figure class="t-figure"><span class="t-media"><img src="assets/images/a.png" alt="" loading="lazy" decoding="async"></span></figure>');
  // A band asks for the whole width from its root; its focal point is written only when given.
  assert.match(render({ asset: 'images/a.png', alt: 'A', presentation: 'band' }), /^<figure class="t-figure t-image t-image--band t-image--medium" data-t-bleed><div class="t-image-frame">/);
  assert.match(render({ asset: 'images/a.png', alt: 'A', presentation: 'band', focus: { x: 0.25, y: 0.75 } }), /data-t-bleed style="--focus-x: 0.25; --focus-y: 0.75"/);
  assert.match(render({ asset: 'images/a.png', alt: 'A', presentation: 'over', title: 'Titre' }), /data-t-bleed[^>]*>.*<h2 class="t-image-title">Titre<\/h2>/);
});

test('opening: a built-in screen layout in the registry and the format, refused as a block or a component name, forkable', () => {
  assert.deepEqual([...LAYOUT_TYPES], ['opening']);
  assert.ok(isBuiltinLayoutType('opening') && !isBuiltinLayoutType('statement'));
  const dir = course([{ id: 'chemin-suite', type: 'text', props: { markdown: 'La suite.' } }], { layout: 'opening', layoutProps: { presentation: 'band', image: 'images/a.svg', alt: 'Le chemin', lead: 'Ce que vous saurez faire.' } });
  const project = loadProjectFromDir(dir);
  const opening = getRegistry(project).get('opening')!;
  assert.equal(opening.level, 'screen');
  assert.ok(opening.builtin && opening.fullBleed);
  assert.deepEqual(opening.slots.map((slot) => slot.id), ['question', 'body']);
  assert.equal(opening.defaultSlot, 'body');
  assert.deepEqual(codes(findings(dir)).filter((code) => /^E_/.test(code)), []);

  // Its props are checked like a course layout's, its picture like an image's.
  const screen = readJSON(dir, 'screens/chemin.json');
  writeJSON(dir, 'screens/chemin.json', { ...screen, layoutProps: { presentation: 'poster', image: 'images/a.svg' } });
  let found = codes(findings(dir));
  assert.ok(found.includes('E_COMPONENT_PROPS'), found.join());
  writeJSON(dir, 'screens/chemin.json', { ...screen, layoutProps: { presentation: 'band', image: 'images/a.svg' } });
  assert.ok(codes(findings(dir)).includes('E_IMAGE_ALT_MISSING'));
  // A block of type opening, or a course component taking its name, is refused.
  writeJSON(dir, 'screens/chemin.json', { ...screen, blocks: [...screen.blocks, { id: 'chemin-o', type: 'opening', props: {} }] });
  assert.ok(codes(findings(dir)).includes('E_COMPONENT_LEVEL'));
  writeJSON(dir, 'screens/chemin.json', screen);
  writeFixture(dir, 'components/opening/component.json', { id: 'opening', title: 'Mine', version: '1.0.0', level: 'screen' });
  writeFixture(dir, 'components/opening/template.html', '<div data-slot="body"></div>');
  found = codes(findings(dir));
  assert.ok(found.includes('E_COMPONENT_ID'), found.join());
  // A fork keeps its slots and its lineage (and so the player's stylesheet of the opening).
  fs.rmSync(path.join(dir, 'components/opening'), { recursive: true });
  writeFixture(dir, 'components/chapter-opening/component.json', { id: 'chapter-opening', title: 'Chapter opening', version: '1.0.0', level: 'screen', extends: { component: 'opening' } });
  writeJSON(dir, 'screens/chemin.json', { ...screen, layout: 'chapter-opening' });
  const fork = getRegistry(loadProjectFromDir(dir)).get('chapter-opening')!;
  assert.deepEqual(fork.lineage, ['chapter-opening', 'opening']);
  assert.deepEqual(fork.slots.map((slot) => slot.id), ['question', 'body']);
  assert.deepEqual(codes(findings(dir)).filter((code) => /^E_/.test(code)), []);
  // Its own markup may show the reading time, never where the screen is (D63 amended).
  writeFixture(dir, 'components/chapter-opening/template.html', '<header><p data-t-duration></p><div data-title></div></header><div data-slot="question"></div><div data-slot="body"></div>');
  assert.deepEqual(codes(findings(dir)).filter((code) => /^E_/.test(code)), []);
  writeFixture(dir, 'components/chapter-opening/template.html', '<header><p data-t-lesson></p><div data-title></div></header><div data-slot="question"></div><div data-slot="body"></div>');
  found = codes(findings(dir));
  assert.ok(found.includes('E_COMPONENT_HOOK'), found.join());
});

test('opening: the build gives the player the page\'s reading time, and nothing about where the screen is', () => {
  const words = 'Le paquet traverse le réseau jusqu’à l’imprimante. '.repeat(60);
  const dir = course([{ id: 'chemin-long', type: 'text', props: { markdown: words } }], { layout: 'opening', layoutProps: { lead: 'Ce que vous saurez faire.' } });
  const project = loadProjectFromDir(dir);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  const data = compileCourseData(project, keys, { buildId: 'test' });
  const chemin = data.screens.find((screen) => screen.id === 'chemin')!;
  assert.ok((chemin.layout?.minutes ?? 0) >= 3, JSON.stringify(chemin.layout?.minutes));
  // No line above the title (D63 amended): no section, no « Leçon 2 sur 6 ».
  assert.doesNotMatch(chemin.layout!.html, /data-t-(section|lesson)|t-opening-eyebrow/);
  assert.equal('place' in chemin.layout!, false);
  assert.match(chemin.layout!.html, /data-t-duration/);
  // Without duration, nothing to measure.
  writeJSON(dir, 'screens/chemin.json', { ...readJSON(dir, 'screens/chemin.json'), layoutProps: { duration: false } });
  const again = loadProjectFromDir(dir);
  const plain = compileCourseData(again, assignKeys(again, readLock(again), { dryRun: true }).keys, { buildId: 'test' }).screens.find((screen) => screen.id === 'chemin')!;
  assert.equal(plain.layout?.minutes, undefined);
  // Every language of the player words them.
  for (const language of ['fr', 'en', 'de', 'es', 'it', 'nl', 'pt']) {
    const labels = labelsFor(language);
    for (const key of ['readingTime', 'minutes', 'before', 'after', 'compare', 'compareValue'] as const) assert.ok(labels[key], `${language} ${key}`);
  }
});

test('starter blocks: a statement that repeats its screen, a hidden column, a comparison of three, images without alt', () => {
  const dir = course([
    { id: 'chemin-p', type: 'text', props: { markdown: 'Suivez toujours le chemin dans l’ordre : un seul équipement en panne suffit à tout bloquer.' } },
    { id: 'chemin-enonce', type: 'statement', props: { markdown: 'Un seul équipement en panne suffit à **tout bloquer**.' } },
    { id: 'chemin-cols', type: 'columns', props: {}, blocks: [{ id: 'chemin-c1', type: 'text', slot: 'first', props: { markdown: 'Un' } }, { id: 'chemin-c3', type: 'text', slot: 'third', props: { markdown: 'Trois' } }] },
    { id: 'chemin-galerie', type: 'gallery', props: { presentation: 'compare', images: [{ id: 'a', asset: 'images/a.svg', alt: 'A' }, { id: 'b', asset: 'images/b.svg' }, { id: 'c', asset: 'images/c.svg', decorative: true }] } },
    { id: 'chemin-image', type: 'statement', props: { presentation: 'image', image: 'images/a.svg', markdown: 'Le chemin, toujours.' } }
  ]);
  const found = findings(dir);
  const at = (code: string) => found.filter((d) => d.code === code).map((d) => d.target);
  assert.deepEqual(at('W_QUOTE_REPEATS'), ['chemin-enonce']);
  assert.deepEqual(at('W_COLUMNS_HIDDEN'), ['chemin-c3']);
  assert.deepEqual(at('E_GALLERY_COMPARE'), ['chemin-galerie']);
  assert.deepEqual(at('E_IMAGE_ALT_MISSING').sort(), ['chemin-galerie', 'chemin-image']);
  // A statement that says something else, columns of three, two images: nothing.
  const fixed = course([
    { id: 'chemin-enonce', type: 'statement', props: { markdown: 'Le chemin d’abord, la cause ensuite.' } },
    { id: 'chemin-cols', type: 'columns', props: { count: 3 }, blocks: [{ id: 'chemin-c3', type: 'text', slot: 'third', props: { markdown: 'Trois' } }] },
    { id: 'chemin-galerie', type: 'gallery', props: { presentation: 'compare', images: [{ id: 'a', asset: 'images/a.svg', alt: 'A' }, { id: 'b', asset: 'images/b.svg', alt: 'B' }] } }
  ]);
  assert.deepEqual(codes(findings(fixed)).filter((code) => ['W_QUOTE_REPEATS', 'W_COLUMNS_HIDDEN', 'E_GALLERY_COMPARE', 'E_IMAGE_ALT_MISSING', 'E_ASSET_MISSING'].includes(code)), []);
  // A gallery's missing image is a missing asset, as an image block's.
  const missing = course([{ id: 'chemin-galerie', type: 'gallery', props: { images: [{ id: 'a', asset: 'images/none.svg', alt: 'A' }] } }]);
  assert.ok(codes(findings(missing)).includes('E_ASSET_MISSING'));
});

test('starter blocks: exports, the client view and translation carry their words', () => {
  const dir = course([
    { id: 'chemin-enonce', type: 'statement', props: { presentation: 'quote', markdown: 'Le chemin d’abord.', author: 'Marc', role: 'technicien' } },
    { id: 'chemin-sep', type: 'divider', props: { presentation: 'ornament' } },
    { id: 'chemin-galerie', type: 'gallery', props: { images: [{ id: 'a', asset: 'images/a.svg', alt: 'Le poste', caption: 'Le poste de Marc' }, { id: 'b', asset: 'images/b.svg', alt: 'Le routeur' }] } },
    { id: 'chemin-cols', type: 'columns', props: {}, blocks: [{ id: 'chemin-c1', type: 'text', slot: 'first', props: { markdown: 'Colonne une', aside: 'Une note en marge.' } }] },
    { id: 'chemin-cote', type: 'image', props: { presentation: 'beside', asset: 'images/c.svg', alt: 'Le pare-feu', title: 'Le pare-feu', markdown: 'Il filtre.' } }
  ], { layout: 'opening', layoutProps: { lead: 'Le chemin d’une impression.' } });
  const project = loadProjectFromDir(dir);
  const exported = lessonMdExport(project);
  const page = [...exported.output.entries()].find(([, text]) => text.includes('Le chemin d’abord'))?.[1] ?? '';
  assert.match(page, /> Le chemin d’abord\.\n>\n> — Marc, technicien/);
  assert.match(page, /::: image\nsrc: media\/images-a\.svg\nalt: Le poste\ncaption: Le poste de Marc/);
  assert.match(page, /Colonne une[\s\S]*::: note\nvariant: 1\n\nUne note en marge\./);
  assert.match(page, /### Le pare-feu\n\nIl filtre\./);
  assert.match(page, /Le chemin d’une impression\./);
  assert.ok(exported.losses.some((loss) => loss.block === 'chemin-galerie'));
  const client = projectMarkdown(project, { audience: 'client', screen: 'chemin' });
  for (const words of ['« Le chemin d’abord. » — Marc, technicien', '"Le poste" — Le poste de Marc', 'Colonne une', 'Une note en marge.', 'Le chemin d’une impression.']) assert.ok(client.includes(words), words);
  const units = extractUnits(project).map((unit) => unit.id);
  for (const id of ['block.chemin-enonce.markdown', 'block.chemin-enonce.author', 'block.chemin-enonce.role', 'block.chemin-galerie.images.a.alt', 'block.chemin-galerie.images.a.caption', 'block.chemin-c1.aside', 'block.chemin-cote.title', 'screen.chemin.layout.lead']) assert.ok(units.includes(id), id);
});
