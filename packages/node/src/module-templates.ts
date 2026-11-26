// Module templates (docs/decisions/D68.md): courses with abstract content whose charter (theme, fonts,
// components, backdrop and its variants) is the product, in templates/ at the root of the core, CC0.
// `elabora templates` lists them; `elabora init --template` and the library's createProject make a
// new course from one: a copy under the author's id and title, in the language asked when the
// template has its translation, without the template's licence, history or builds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBrief, templateTexts, type CourseBrief } from '@elabora/core/commands/new-course';
import { buildTranslation } from './translate.ts';
import { fieldOf } from './util/values.ts';

export const MODULE_TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../templates');
export const MODULE_TEMPLATES_INDEX = 'index.json';
export const MODULE_TEMPLATES_FORMAT = 'elabora-templates/1';

// Words in the languages of the app's interface; English is always there.
export type Localized = { en: string } & Record<string, string>;

export interface ModuleTemplate {
  id: string; // the slug, also the folder's name
  name: Localized;
  summary: Localized; // one sentence: the concept and how it moves
  audiences: Localized; // who it suits, a few words
  language: string; // the language its texts are written in
  translations: string[]; // the languages it is translated into (translations/<lang>.xlf)
  variants: string[]; // its backdrop's variants (theme.backdrop.variants)
  screens: string[]; // its screens, in order
  version: string | null;
  dir: string;
}

interface IndexFile { format?: unknown; templates?: unknown }

// The templates of a folder (by default the core's), in the order of its index.json; a folder the
// index names without a course.json is left out.
export function listModuleTemplates(root: string = MODULE_TEMPLATES_DIR): ModuleTemplate[] {
  const file = path.join(root, MODULE_TEMPLATES_INDEX);
  if (!fs.existsSync(file)) return [];
  const index = JSON.parse(fs.readFileSync(file, 'utf8')) as IndexFile;
  if (index.format !== MODULE_TEMPLATES_FORMAT || !Array.isArray(index.templates)) throw new Error(`${file}: not an index of templates (${MODULE_TEMPLATES_FORMAT})`);
  const templates: ModuleTemplate[] = [];
  for (const entry of index.templates) {
    const id = fieldOf(entry, 'id');
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(id)) continue;
    const dir = path.join(root, id);
    const courseFile = path.join(dir, 'course.json');
    if (!fs.existsSync(courseFile)) continue;
    const course = JSON.parse(fs.readFileSync(courseFile, 'utf8')) as Record<string, unknown>;
    const translations = fs.existsSync(path.join(dir, 'translations'))
      ? fs.readdirSync(path.join(dir, 'translations')).filter((name) => name.endsWith('.xlf')).map((name) => name.slice(0, -4)).sort()
      : [];
    const sections = Array.isArray(course.sections) ? course.sections : [];
    templates.push({
      id,
      name: localized(fieldOf(entry, 'name'), id),
      summary: localized(fieldOf(entry, 'summary'), ''),
      audiences: localized(fieldOf(entry, 'audiences'), ''),
      language: typeof course.language === 'string' ? course.language : 'en',
      translations,
      variants: Object.keys((fieldOf(fieldOf(fieldOf(course, 'theme'), 'backdrop'), 'variants') ?? {}) as object),
      screens: sections.flatMap((section) => (Array.isArray(fieldOf(section, 'screens')) ? fieldOf(section, 'screens') as unknown[] : [])).filter((screen): screen is string => typeof screen === 'string'),
      version: typeof course.version === 'string' ? course.version : null,
      dir
    });
  }
  return templates;
}

// A template of the core by its id, or an error that lists them.
export function moduleTemplate(id: string, root: string = MODULE_TEMPLATES_DIR): ModuleTemplate {
  const templates = listModuleTemplates(root);
  const found = templates.find((template) => template.id === id);
  if (!found) throw new Error(`No template "${id}". Templates: ${templates.map((template) => template.id).join(', ') || 'none'} (elabora templates).`);
  return found;
}

export interface FromTemplateOptions {
  id: string; // the new course's id
  title: string;
  // The language of the new course's texts: the template's, or one it is translated into. By default
  // the template's.
  language?: string;
  brief?: CourseBrief; // as elabora init keeps it
}

export interface FromTemplateResult {
  dir: string;
  language: string;
  files: number;
}

// What a copy leaves behind: the project's own data, builds, and the template's licence (the fonts
// keep theirs, beside them in theme/fonts).
const LEFT_OUT = /^(\.elabora|dist|node_modules|plan-versions|LICENSE\.md|\.DS_Store)$/;

// The files of the template folder `source` in a language, as a copy of it is before it is made the
// author's, written into `out` (a folder that does not exist yet): its files without its licence, history
// or builds, or, in another language than its own, its translation built (without translations/). Gives
// the language. A browser's host ships these copies (D124).
export async function templateCopy(source: string, out: string, language?: string): Promise<string> {
  const template = JSON.parse(fs.readFileSync(path.join(source, 'course.json'), 'utf8')) as Record<string, unknown>;
  const own = typeof template.language === 'string' ? template.language : 'en';
  const wanted = language ?? own;
  if (wanted !== own && !fs.existsSync(path.join(source, 'translations', `${wanted}.xlf`))) {
    const available = [own, ...fs.readdirSync(path.join(source, 'translations')).filter((name) => name.endsWith('.xlf')).map((name) => name.slice(0, -4))];
    throw new Error(`The template is in ${available.join(', ')}, not in ${wanted}.`);
  }
  if (wanted === own) { copyTemplate(source, out); return wanted; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-template-'));
  try {
    const copy = path.join(work, 'copy');
    copyTemplate(source, copy);
    await buildTranslation(copy, { to: wanted, out });
    fs.rmSync(path.join(out, 'translations'), { recursive: true, force: true });
    return wanted;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Makes a new course in `dir` from the template folder `source`: its copy in the language asked
// (templateCopy), then the author's id and title on the course, the plan and the first screen (the
// cover), and AGENTS.md's notes saying where it comes from (templateTexts, the browser's bytes). The
// template's lock goes with it: its keys are the screens' and the activities', which the copy keeps.
// `dir` must not hold a course already; nothing is written there when a step fails.
export async function createFromTemplate(source: string, dir: string, options: FromTemplateOptions): Promise<FromTemplateResult> {
  const root = path.resolve(dir);
  if (fs.existsSync(path.join(root, 'course.json'))) throw new Error(`${root} already contains a course.json`);
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(options.id)) throw new Error('id: lowercase letters, digits and hyphens, starting with a letter');
  if (options.brief) checkBrief(options.brief);
  const template = JSON.parse(fs.readFileSync(path.join(source, 'course.json'), 'utf8')) as Record<string, unknown>;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-template-'));
  try {
    const made = path.join(work, 'made');
    const language = await templateCopy(source, made, options.language);
    const read = (rel: string) => { const file = path.join(made, rel); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
    for (const [rel, text] of templateTexts(read, { ...options, language }, typeof template.id === 'string' ? template.id : path.basename(source))) fs.writeFileSync(path.join(made, rel), text);
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(made)) fs.cpSync(path.join(made, entry), path.join(root, entry), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    return { dir: root, language, files: countFiles(made) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function copyTemplate(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    if (LEFT_OUT.test(entry)) continue;
    fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true, mode: fs.constants.COPYFILE_FICLONE, filter: (from) => !/[\\/]\.DS_Store$/.test(from) });
  }
}

function localized(value: unknown, fallback: string): Localized {
  const words: Record<string, string> = {};
  if (value && typeof value === 'object') for (const [language, text] of Object.entries(value)) if (typeof text === 'string') words[language] = text;
  return { ...words, en: words.en ?? fallback };
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  return count;
}
