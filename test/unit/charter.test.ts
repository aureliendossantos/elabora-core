import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDir } from '@elabora/node/project-reader';
import { initProject } from '@elabora/node/scaffold';
import { copyCharter } from '@elabora/node/charter';
import { listModuleTemplates } from '@elabora/node/module-templates';
import { createModule, libraryRoot } from '@elabora/node/library/index';
import { ROOT } from '../helpers.ts';

// A course's charter taken by a new course (docs/decisions/D69.md): from every template and every
// example, a blank course that validates, in their theme, fonts, components and backdrop, with none of
// what they say.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};
const readJSON = (dir: string, file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const EXAMPLES = path.join(ROOT, 'examples');
const sources = [
  ...listModuleTemplates().map((template) => template.dir),
  ...fs.readdirSync(EXAMPLES).map((name) => path.join(EXAMPLES, name)).filter((dir) => fs.existsSync(path.join(dir, 'course.json')))
];

test('a blank course in the charter of each template and example: its theme, its files, no error, nothing of what it says', () => {
  assert.ok(sources.length >= 14, `the seven templates and the examples (${sources.length})`);
  for (const source of sources) {
    const name = path.basename(source);
    const dir = path.join(tempDir('elabora-charter-'), 'course');
    initProject(dir, { id: 'charter-test', title: 'Charter test', language: 'en' });
    const copy = copyCharter(source, dir);
    const course = readJSON(dir, 'course.json');
    const original = readJSON(source, 'course.json');
    assert.deepEqual(course.theme, original.theme, `${name}: the theme`);
    assert.deepEqual(course.player, original.player, `${name}: the player's bars`);
    if (original.presentation) assert.deepEqual(course.presentation, original.presentation, `${name}: the presentation`);
    assert.equal(course.title, 'Charter test', name);
    assert.deepEqual(course.sections.flatMap((section: { screens: string[] }) => section.screens), ['intro'], `${name}: one screen, the blank course's`);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'screens')), ['intro.json'], name);
    for (const face of original.theme.fonts ?? []) assert.ok(fs.existsSync(path.join(dir, face.src)), `${name}: the font ${face.src}`);
    if (original.theme.stylesheet) assert.ok(fs.existsSync(path.join(dir, original.theme.stylesheet)), `${name}: the stylesheet`);
    const components = fs.existsSync(path.join(source, 'components')) ? fs.readdirSync(path.join(source, 'components')).filter((entry) => !entry.startsWith('.')).sort() : [];
    assert.deepEqual(copy.components, components, `${name}: every component`);
    const object = original.theme.backdrop?.object?.id ?? null;
    assert.equal(copy.object, object, `${name}: the backdrop's decoration`);
    // The free objects its blocks place are what it says: left behind.
    const objects = fs.existsSync(path.join(dir, 'objects')) ? fs.readdirSync(path.join(dir, 'objects')) : [];
    assert.deepEqual(objects, object ? [object] : [], `${name}: only the decoration among the free objects`);
    for (const left of ['plan-versions', 'translations', 'sources', 'LICENSE.md', 'README.md', 'elabora.lock.json']) assert.ok(!fs.existsSync(path.join(dir, left)), `${name}: no ${left}`);
    const { diagnostics } = validateDir(dir);
    assert.deepEqual(diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.file ?? ''}: ${d.message}`), [], name);
  }
});

test('what a charter takes with its files: the stylesheet\'s pictures, the logo, the generators that drew them, not those of the subject', () => {
  const dir = (source: string) => {
    const made = path.join(tempDir('elabora-charter-'), 'course');
    initProject(made, { id: 'charter-test', title: 'Charter test', language: 'en' });
    return { made, copy: copyCharter(source, made) };
  };
  // Organique: its grain, drawn by its generator, with its provenance.
  const organic = dir(listModuleTemplates().find((template) => template.id === 'organic')!.dir);
  assert.ok(organic.copy.files.includes('assets/images/grain.svg'), 'the picture its stylesheet draws');
  assert.deepEqual(organic.copy.generators, ['generators/organic.mjs']);
  assert.deepEqual(Object.keys(readJSON(organic.made, 'generators/provenance.json').assets).sort(), ['images/grain.svg']);
  // Aquarelle: its generator imports from its backdrop's decoration, which comes with it.
  const watercolor = dir(listModuleTemplates().find((template) => template.id === 'watercolor')!.dir);
  assert.deepEqual(watercolor.copy.generators, ['generators/watercolor.mjs']);
  assert.ok(watercolor.copy.files.includes('objects/bloom/wash.js'));
  // Diagnostic réseau: the client's logo in the top bar.
  const network = dir(path.join(EXAMPLES, 'diagnostic-reseau'));
  assert.ok(network.copy.files.includes('assets/images/logo-helios.svg'), 'the logo');
  // Orbital rendezvous: the sky, not the figures of its subject (they come from its free object).
  const orbital = dir(path.join(EXAMPLES, 'orbital-rendezvous'));
  assert.deepEqual(orbital.copy.generators, ['generators/sky.mjs']);
  assert.ok(!orbital.copy.files.some((file) => file.startsWith('objects/')), 'its phasing lab stays behind');
});

test('the presentation the author chose stays; the rest of it is the charter\'s', () => {
  const made = path.join(tempDir('elabora-charter-'), 'course');
  initProject(made, { id: 'charter-test', title: 'Charter test', language: 'en', brief: { presentation: 'scroll' } });
  copyCharter(path.join(EXAMPLES, 'planetary-gearset'), made, { presentation: 'scroll' });
  const { presentation } = readJSON(made, 'course.json');
  assert.equal(presentation.mode, 'scroll');
  assert.equal(presentation.contentWidth, readJSON(path.join(EXAMPLES, 'planetary-gearset'), 'course.json').presentation.contentWidth);
});

test('createModule with a charter: a module of the library in another module\'s charter, its note for agents, never with a template', async () => {
  process.env.ELABORA_LIBRARY = path.join(tempDir('elabora-library-'), 'Library');
  assert.equal(libraryRoot(), process.env.ELABORA_LIBRARY);
  const first = await createModule({ title: 'Le bien-être au travail', language: 'fr', template: 'organic' });
  const made = await createModule({ title: 'La pause active', language: 'fr', charter: first.project.id, request: 'Un module court sur la pause active' });
  assert.equal(made.charter?.dir, first.project.path);
  assert.equal(made.charter?.title, 'Le bien-être au travail');
  const course = readJSON(made.project.path, 'course.json');
  assert.deepEqual(course.theme, readJSON(first.project.path, 'course.json').theme);
  assert.equal(course.title, 'La pause active');
  assert.equal(course.language, 'fr');
  const notes = fs.readFileSync(path.join(made.project.path, 'AGENTS.md'), 'utf8');
  assert.match(notes, /charter is copied from the module « Le bien-être au travail »/);
  assert.match(notes, /Un module court sur la pause active/);
  assert.deepEqual(validateDir(made.project.path).diagnostics.filter((d) => d.severity === 'error'), []);
  // A course folder too, and not both.
  const byFolder = await createModule({ title: 'Autre', language: 'fr', charter: path.join(EXAMPLES, 'phishing-by-numbers') });
  assert.equal(readJSON(byFolder.project.path, 'course.json').theme.tokens['color.primary'], readJSON(path.join(EXAMPLES, 'phishing-by-numbers'), 'course.json').theme.tokens['color.primary']);
  // A folder relative to the current one (the path of a shell), not taken for a project id.
  const here = process.cwd();
  try {
    process.chdir(EXAMPLES);
    const relative = await createModule({ title: 'Relatif', language: 'fr', charter: 'phishing-by-numbers' });
    assert.equal(relative.charter?.dir, path.join(EXAMPLES, 'phishing-by-numbers'));
    const dotted = await createModule({ title: 'Pointé', language: 'fr', charter: './phishing-by-numbers/' });
    assert.equal(dotted.charter?.dir, path.join(EXAMPLES, 'phishing-by-numbers'));
    process.chdir(ROOT);
    const nested = await createModule({ title: 'Imbriqué', language: 'fr', charter: 'examples/phishing-by-numbers' });
    assert.equal(nested.charter?.dir, path.join(EXAMPLES, 'phishing-by-numbers'));
  } finally { process.chdir(here); }
  await assert.rejects(createModule({ title: 'Les deux', template: 'organic', charter: first.project.id }), /template or from another module's charter/);
  await assert.rejects(createModule({ title: 'Aucun', charter: 'mod-inconnu' }));
});
