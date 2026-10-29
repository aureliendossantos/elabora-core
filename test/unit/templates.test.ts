import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { extractUnits } from '@elabora/core/i18n/units';
import { readXliff } from '@elabora/core/i18n/xliff';
import { translationStatus } from '@elabora/node/translate';
import { createFromTemplate, listModuleTemplates, moduleTemplate, MODULE_TEMPLATES_DIR } from '@elabora/node/module-templates';
import { createProject, libraryRoot } from '@elabora/node/library/index';
import { ROOT } from '../helpers.ts';

// The module templates (docs/decisions/D68.md): courses whose charter is the product, the same screens
// in each, CC0 with OFL fonts, and new courses made from them.

const BIN = path.join(ROOT, 'bin/elabora.js');
const SCREENS = ['cover', 'objectives', 'part-one', 'key-message', 'text-and-picture', 'cards', 'key-figures', 'practice', 'steps', 'quote', 'comparison', 'chart', 'recap', 'the-end'];
const SECTIONS = ['opening', 'part-1', 'part-2', 'part-3', 'closing'];
const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};
const readJSON = (dir: string, file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const files = (dir: string, base = dir): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name), base) : [path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/')]));

test('the templates: those of index.json, the same screens, sections and plan, each translated into French', () => {
  const templates = listModuleTemplates();
  assert.deepEqual(templates.map((template) => template.id), ['organic', 'flow', 'clear', 'shapes', 'editorial', 'paper', 'watercolor']);
  const folders = fs.readdirSync(MODULE_TEMPLATES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(folders, templates.map((template) => template.id).sort(), 'every folder of templates/ is in index.json');
  const titles = new Map<string, string>();
  const plans = new Set<string>();
  for (const template of templates) {
    assert.ok(template.name.fr && template.summary.fr && template.audiences.fr, `${template.id}: named in French`);
    assert.deepEqual(template.screens, SCREENS, template.id);
    assert.equal(template.language, 'en', template.id);
    assert.deepEqual(template.translations, ['fr'], template.id);
    assert.ok(template.variants.length >= 2 && template.variants.length <= 3, `${template.id}: two or three backdrop variants`);
    const course = readJSON(template.dir, 'course.json');
    assert.deepEqual(course.sections.map((section: { id: string }) => section.id), SECTIONS, template.id);
    assert.equal(course.title, 'Your module title', template.id);
    for (const id of SCREENS) {
      const { title } = readJSON(template.dir, `screens/${id}.json`);
      if (!titles.has(id)) titles.set(id, title);
      assert.equal(title, titles.get(id), `${template.id}: the screen ${id} has the same title as in ${templates[0].id}`);
    }
    plans.add(JSON.stringify(readJSON(template.dir, 'plan.json').items));
  }
  assert.equal(plans.size, 1, 'one plan for them all');
});

test('each template validates (only a template\'s two warnings), its French is complete, it is CC0 with OFL fonts and nothing generated', () => {
  for (const template of listModuleTemplates()) {
    const { diagnostics } = validateDir(template.dir);
    assert.deepEqual(diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.file ?? ''}: ${d.message}`), [], template.id);
    assert.deepEqual([...new Set(diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code))].sort(), ['W_PLAN_DRAFT', 'W_SPACING_MISSING'], template.id);
    const [french] = translationStatus(template.dir, { to: 'fr' });
    assert.ok(french.exists, `${template.id}: translated into French`);
    assert.deepEqual({ toTranslate: french.toTranslate, stale: french.stale, editor: french.editor, problems: french.problems.length }, { toTranslate: 0, stale: 0, editor: 0, problems: 0 }, `${template.id}: French complete and current, the charter's words included`);
    // The project's own data (.elabora/, written by any command run there) stays out of git.
    const all = files(template.dir).filter((file) => !file.startsWith('.elabora/'));
    assert.ok(!all.some((file) => /^(dist|captures)\//.test(file)), `${template.id}: nothing generated`);
    assert.match(fs.readFileSync(path.join(template.dir, '.gitignore'), 'utf8'), /^\.elabora\/$/m, template.id);
    assert.match(fs.readFileSync(path.join(template.dir, 'LICENSE.md'), 'utf8'), /CC0 1\.0/, template.id);
    const fonts = all.filter((file) => /^theme\/fonts\/.+\.woff2$/.test(file));
    assert.ok(fonts.length, `${template.id}: its fonts embedded`);
    for (const font of fonts) assert.ok(fs.existsSync(path.join(template.dir, path.dirname(font), 'OFL.txt')), `${template.id}: ${font} beside its OFL`);
    // Nothing from the network: no URL in the stylesheets, components or the backdrop's code.
    for (const file of all.filter((name) => /\.(css|js|mjs|html)$/.test(name))) {
      assert.doesNotMatch(fs.readFileSync(path.join(template.dir, file), 'utf8'), /url\(\s*['"]?https?:|fetch\(|import\(\s*['"]https?:/, `${template.id}: ${file}`);
    }
  }
});

test('a course from a template: its id and title, the cover saying it, in French from the translation, without the licence or the template\'s notes', async () => {
  const dir = path.join(tempDir('elabora-template-'), 'accueil');
  const made = await createFromTemplate(moduleTemplate('flow').dir, dir, { id: 'accueil-equipe', title: 'Accueillir un nouvel arrivant', language: 'fr', brief: { audience: 'Managers', notes: 'Ton chaleureux.' } });
  assert.equal(made.language, 'fr');
  const course = readJSON(dir, 'course.json');
  assert.equal(course.id, 'accueil-equipe');
  assert.equal(course.title, 'Accueillir un nouvel arrivant');
  assert.equal(course.language, 'fr');
  assert.equal(course.translationOf, undefined);
  assert.equal(course.description, undefined);
  assert.equal(course.sections[0].title, 'Pour commencer');
  assert.equal(readJSON(dir, 'screens/cover.json').title, 'Accueillir un nouvel arrivant');
  assert.equal(readJSON(dir, 'screens/objectives.json').title, 'Ce que vous saurez faire');
  const plan = readJSON(dir, 'plan.json');
  assert.equal(plan.title, 'Accueillir un nouvel arrivant');
  assert.equal(plan.audience.role, 'Managers');
  assert.equal(plan.translationOf, undefined);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /starts from the template `flow`/);
  assert.match(agents, /Ton chaleureux\./);
  assert.doesNotMatch(agents, /Generated translation/);
  for (const gone of ['LICENSE.md', 'translations', 'dist']) assert.ok(!fs.existsSync(path.join(dir, gone)), gone);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'the charter\'s guide comes along');
  assert.equal(validateDir(dir).summary.errors, 0);

  // In the template's own language, its translations come along.
  const english = path.join(tempDir('elabora-template-'), 'en');
  await createFromTemplate(moduleTemplate('shapes').dir, english, { id: 'methods', title: 'A method in four steps', language: 'en' });
  assert.equal(readJSON(english, 'course.json').language, 'en');
  assert.ok(fs.existsSync(path.join(english, 'translations/fr.xlf')));
  assert.equal(validateDir(english).summary.errors, 0);

  // Refused before anything is written: a language it is not in, a folder that holds a course, a bad id.
  await assert.rejects(createFromTemplate(moduleTemplate('clear').dir, path.join(tempDir('elabora-template-'), 'de'), { id: 'x', title: 'X', language: 'de' }), /in en, fr, not in de/);
  await assert.rejects(createFromTemplate(moduleTemplate('clear').dir, english, { id: 'x', title: 'X' }), /already contains a course\.json/);
  await assert.rejects(createFromTemplate(moduleTemplate('clear').dir, path.join(tempDir('elabora-template-'), 'id'), { id: 'Bad Id', title: 'X' }), /^Error: id:/);
  assert.throws(() => moduleTemplate('nope'), /No template "nope"\. Templates: organic, flow, clear, shapes/);
});

test('a module made in French from a template has no English left: what learners read, and what the editor shows of its charter', async () => {
  const words = (value: unknown): value is string => typeof value === 'string' && /\p{L}/u.test(value);
  // What the editor shows of a course's own design (the Charte, the block picker, the inspector), by
  // file and pointer, read from the files rather than from the translation units: a text the units
  // leave out is found too. A component's instructions are for agents and stay in English.
  const design = (dir: string): Map<string, string> => {
    const found = new Map<string, string>();
    const put = (file: string, pointer: string, value: unknown) => { if (words(value)) found.set(`${file}#${pointer}`, value); };
    const theme = readJSON(dir, 'course.json').theme ?? {};
    for (const [kind, styles] of Object.entries<Record<string, unknown>>(theme.styles ?? {})) for (const [name, text] of Object.entries(styles)) put('course.json', `/theme/styles/${kind}/${name}`, text);
    for (const [name, text] of Object.entries(theme.backdrop?.variants ?? {})) put('course.json', `/theme/backdrop/variants/${name}`, text);
    const setting = (file: string, node: Record<string, unknown>, at: string): void => {
      put(file, `${at}/title`, node.title);
      put(file, `${at}/description`, node.description);
      for (const [name, child] of Object.entries<Record<string, unknown>>((node.properties ?? {}) as Record<string, Record<string, unknown>>)) setting(file, child, `${at}/properties/${name}`);
      if (node.items && typeof node.items === 'object') setting(file, node.items as Record<string, unknown>, `${at}/items`);
    };
    const components = path.join(dir, 'components');
    for (const id of fs.existsSync(components) ? fs.readdirSync(components) : []) {
      const file = `components/${id}/component.json`;
      const component = readJSON(dir, file);
      put(file, '/title', component.title);
      put(file, '/description', component.description);
      (component.slots ?? []).forEach((slot: { label?: unknown }, i: number) => put(file, `/slots/${i}/label`, slot.label));
      for (const [name, child] of Object.entries<Record<string, unknown>>(component.props?.properties ?? {})) setting(file, child, `/props/properties/${name}`);
    }
    return found;
  };
  const units = (dir: string) => new Map(extractUnits(loadProjectFromDir(dir)).map((unit) => [unit.id, unit.text]));
  for (const template of listModuleTemplates()) {
    const french = path.join(tempDir('elabora-template-'), template.id);
    await createFromTemplate(template.dir, french, { id: `essai-${template.id}`, title: 'Un module en français', language: 'fr' });
    // Words that are the same in both languages are the translation's own choice (« Page »).
    const same = new Set([...readXliff(fs.readFileSync(path.join(template.dir, 'translations/fr.xlf'), 'utf8')).units.values()].filter((unit) => unit.target === unit.source).map((unit) => unit.source));
    const left: string[] = [];
    for (const [english, made] of [[units(template.dir), units(french)], [design(template.dir), design(french)]]) {
      for (const [where, text] of made) if (english.get(where) === text && !same.has(text)) left.push(`${where}: ${text}`);
    }
    assert.deepEqual(left, [], `${template.id}: English left in a module made in French`);
  }
});

test('the library creates a project from a template and records where it comes from', async () => {
  delete process.env.ELABORA_DATA_DIR;
  process.env.ELABORA_LIBRARY = path.join(tempDir('elabora-library-'), 'Library');
  assert.equal(libraryRoot(), process.env.ELABORA_LIBRARY);
  const project = await createProject({ id: 'bien-etre', title: 'Le bien-être au travail', language: 'fr', template: moduleTemplate('organic').dir });
  assert.equal(project.courseId, 'bien-etre');
  assert.equal(project.title, 'Le bien-être au travail');
  assert.equal(project.language, 'fr');
  assert.deepEqual({ ...project.origin, at: undefined }, { kind: 'template', id: 'organic', version: '1.0.0', at: undefined });
  assert.equal(project.validation?.errors, 0);
});

test('elabora templates lists them; elabora init --template makes the course', () => {
  const list = spawnSync(process.execPath, [BIN, 'templates', '--json'], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).map((template: { id: string }) => template.id), ['organic', 'flow', 'clear', 'shapes', 'editorial', 'paper', 'watercolor']);
  const dir = path.join(tempDir('elabora-template-'), 'course');
  const init = spawnSync(process.execPath, [BIN, 'init', dir, '--template', 'clear', '--id', 'procedure', '--title', 'The incident procedure', '--lang', 'en'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^Created .+ from the template clear \(Clear\), in en: \d+ files\./);
  assert.equal(readJSON(dir, 'course.json').title, 'The incident procedure');
  const unknown = spawnSync(process.execPath, [BIN, 'init', path.join(tempDir('elabora-template-'), 'x'), '--template', 'nope', '--id', 'x', '--title', 'X'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No template "nope"/);
});
