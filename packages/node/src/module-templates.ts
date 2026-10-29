// Module templates (docs/decisions/D68.md): courses with abstract content whose charter (theme, fonts,
// components, backdrop and its variants) is the product, in templates/ at the root of the core, CC0.
// `elabora templates` lists them; `elabora init --template` and the library's createProject make a
// new course from one: a copy under the author's id and title, in the language asked when the
// template has its translation, without the template's licence, history or builds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringifyJSON } from '@elabora/core/util/json';
import { agentsFile, courseNotes, CLAUDE_FILE, CLAUDE_TEXT } from './agent-rules.ts';
import { checkBrief, TEMPLATES_DIR } from './scaffold.ts';
import type { CourseBrief } from './scaffold.ts';
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

// Makes a new course in `dir` from the template folder `source`: its files copied (or its translation
// built, when another language is asked), then the author's id and title on the course, the plan and
// the first screen (the cover), and AGENTS.md's notes saying where it comes from. The template's
// lock goes with it: its keys are the screens' and the activities', which the copy keeps. `dir` must not hold a course already; nothing is written there when a step fails.
export async function createFromTemplate(source: string, dir: string, options: FromTemplateOptions): Promise<FromTemplateResult> {
  const root = path.resolve(dir);
  if (fs.existsSync(path.join(root, 'course.json'))) throw new Error(`${root} already contains a course.json`);
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(options.id)) throw new Error('id: lowercase letters, digits and hyphens, starting with a letter');
  if (options.brief) checkBrief(options.brief);
  const template = JSON.parse(fs.readFileSync(path.join(source, 'course.json'), 'utf8')) as Record<string, unknown>;
  const own = typeof template.language === 'string' ? template.language : 'en';
  const language = options.language ?? own;
  const translated = language !== own;
  if (translated && !fs.existsSync(path.join(source, 'translations', `${language}.xlf`))) {
    const available = [own, ...fs.readdirSync(path.join(source, 'translations')).filter((name) => name.endsWith('.xlf')).map((name) => name.slice(0, -4))];
    throw new Error(`The template is in ${available.join(', ')}, not in ${language}.`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-template-'));
  try {
    const copy = path.join(work, 'copy');
    copyTemplate(source, copy);
    let made = copy;
    if (translated) {
      made = path.join(work, 'translated');
      await buildTranslation(copy, { to: language, out: made });
      fs.rmSync(path.join(made, 'translations'), { recursive: true, force: true });
    }
    personalize(made, { ...options, language }, typeof template.id === 'string' ? template.id : path.basename(source));
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

function personalize(dir: string, { id, title, language, brief }: FromTemplateOptions & { language: string }, template: string): void {
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
  const write = (file: string, value: unknown) => fs.writeFileSync(path.join(dir, file), stringifyJSON(value));
  const course = read('course.json');
  course.id = id;
  course.title = title.trim();
  course.language = language;
  course.version = '1.0.0';
  delete course.translationOf;
  // The catalogue's description was the template's.
  delete course.description;
  if (brief?.presentation) course.presentation = { ...(fieldOf(course, 'presentation') as object), mode: brief.presentation };
  if (brief?.lms?.length) course.delivery = { lms: [...new Set(brief.lms)] };
  write('course.json', course);

  const plan = read('plan.json');
  plan.id = id.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24);
  plan.title = title.trim();
  delete plan.translationOf;
  if (brief?.businessGoal?.trim()) plan.businessGoal = brief.businessGoal.trim();
  if (brief?.audience?.trim()) plan.audience = { ...(fieldOf(plan, 'audience') as object), role: brief.audience.trim() };
  if (brief?.duration) plan.duration = { ...(brief.duration.min ? { min: brief.duration.min } : {}), ...(brief.duration.max ? { max: brief.duration.max } : {}) };
  write('plan.json', plan);

  // The cover says the module's title from the start.
  const first = (Array.isArray(course.sections) ? course.sections : []).flatMap((section) => (fieldOf(section, 'screens') as unknown[] | undefined) ?? [])[0];
  if (typeof first === 'string' && fs.existsSync(path.join(dir, 'screens', `${first}.json`))) {
    const screen = read(`screens/${first}.json`);
    screen.title = title.trim();
    write(`screens/${first}.json`, screen);
  }

  const notes = [
    `This course starts from the template \`${template}\` (elabora templates): README.md says how its charter works (theme, fonts, components, backdrop and its variants) and how to make it the brand's. Its texts are placeholders at their real length: replace them, and change, add or remove screens and blocks as the storyboard asks; a new screen takes the charter as it is.`,
    brief?.notes?.trim() ?? ''
  ].filter(Boolean).join('\n\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), agentsFile(courseNotes(notes)));
  fs.writeFileSync(path.join(dir, CLAUDE_FILE), CLAUDE_TEXT);
  fs.copyFileSync(path.join(TEMPLATES_DIR, 'course', 'gitignore'), path.join(dir, '.gitignore'));
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
