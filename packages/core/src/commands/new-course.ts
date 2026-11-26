import { getProfile } from '../lms/profiles.ts';
import { stringifyJSON } from '../util/json.ts';
import { binaryFile, isTextPath, projectPath, textFile, type FileHash } from '../project/files.ts';
import { AGENT_RULES, COURSE_TEMPLATE } from '../project/course-template.generated.ts';
import { CommandError, type CommandContext, type CommandOutput } from './context.ts';

// A new module's files (docs/decisions/D111.md): course.json, plan.json (a draft), an intro screen,
// the rules for agents (AGENTS.md and the CLAUDE.md that points to it) and .gitignore, made from the
// template the core carries (course-template.generated.ts, from packages/node/templates/course/), so
// that a computer (@elabora/node initProject) and a browser write the same bytes. create_course writes
// them as the first change of an empty project (D112).

// What the author said of the course as they created it (the app's « Nouveau module » page, D51),
// kept in the course so that every request after the first reads it, and creating it by hand loses
// nothing: who it is for, the business goal and the duration in the plan (a draft the agent goes on
// writing); the presentation and the LMS in course.json; the rest (the tone, the brand wanted, what
// the author left to the agent, the request itself) as notes for agents, under AGENTS.md's « Notes
// for this course », in the author's words.
export interface CourseBrief {
  audience?: string; // plan.json audience.role
  businessGoal?: string; // plan.json businessGoal
  duration?: { min?: number; max?: number }; // plan.json duration, in minutes
  presentation?: 'scroll' | 'slides'; // course.json presentation.mode
  lms?: readonly string[]; // course.json delivery.lms, ids of LMS profiles
  notes?: string; // Markdown, after the notes' heading
}

export interface NewCourseOptions {
  id: string;
  title: string;
  language?: string; // default fr
  brief?: CourseBrief;
  // What it starts from in a browser (D124): a module template's files, or a template's charter.
  from?: CourseStart;
}

// A file a new module starts with, as a browser's host gives it: a text, or a medium by its hash and size
// (the host holds its bytes; the copy takes them before the change is sent).
export type StartFile = { kind: 'text'; text: string } | { kind: 'binary'; hash: FileHash; size: number };

// What a module made in a browser starts from (D124), the bytes of the desktop's:
// - template: a module template (D68) in the course's language, its files as a copy of it is before it is
//   made the author's (@elabora/node templateCopy: without its licence, history, builds and translations,
//   its translation built when the language is not its own); the copy takes the author's id, title,
//   language and brief (templateTexts), as createFromTemplate makes it on a computer.
// - charter: the charter of a course in another language (D69): a blank module (newCourseFiles), the files
//   the charter takes (@elabora/node copyCharter) and its course's theme, presentation and player.
export type CourseStart =
  | { kind: 'template'; template: string; files: Record<string, StartFile> }
  | { kind: 'charter'; title: string; courseId: string | null; files: Record<string, StartFile>; course: CharterCourse };

// The fields of course.json a charter brings (copyCharter).
export interface CharterCourse { theme?: unknown; presentation?: unknown; player?: unknown }

export const AGENTS_FILE = 'AGENTS.md';
export const CLAUDE_FILE = 'CLAUDE.md';
// Claude Code reads AGENTS.md only where no CLAUDE.md is found in the folder or above it: the course's
// CLAUDE.md points to its AGENTS.md (D34).
export const CLAUDE_TEXT = '@AGENTS.md\n';
export const RULES_END = '\n<!-- elabora:rules end -->\n';
export const NOTES = '\n## Notes for this course\n<!-- What agents should know about this course: its audience, its voice, decisions taken. Elabora never changes this part. -->\n';

// The notes of a new course: what the author said as they created it (D51), in their words.
export const courseNotes = (text?: string): string => (text?.trim() ? `${NOTES}\n${text.trim()}\n` : NOTES);

// AGENTS.md as Elabora writes it: the rules of this Elabora between their markers, then the notes.
export function agentsFile(notes: string = NOTES): string {
  const { text, revision, sha } = AGENT_RULES;
  return `<!-- elabora:rules revision=${revision} sha256=${sha} · Elabora keeps the rules down to « elabora:rules end » up to date while nobody edits them; write your own notes after it. -->\n${text.endsWith('\n') ? text.slice(0, -1) : text}${RULES_END}${notes}`;
}

// The texts a new course starts with, to be replaced by the storyboard's, in the course language
// (another language gets the English ones). The plan has one item, the intro its screen covers,
// serving the one objective: a course just created has nothing to fix (no item waits for a screen).
const STARTER_TEXTS: Record<'fr' | 'en', Record<string, string>> = {
  fr: {
    __TEXT_INTRODUCTION__: 'Introduction',
    __TEXT_OBJECTIVE__: 'À remplacer par un comportement observable : verbe d\'action, condition, critère.',
    __TEXT_INTRO__: 'À remplacer par l\'introduction validée dans le storyboard.'
  },
  en: {
    __TEXT_INTRODUCTION__: 'Introduction',
    __TEXT_OBJECTIVE__: 'Replace with an observable behaviour: action verb, condition, criterion.',
    __TEXT_INTRO__: 'Replace with the introduction validated in the storyboard.'
  }
};

const starterTexts = (language: string): Record<string, string> => {
  const short = language.slice(0, 2).toLowerCase();
  return short === 'fr' || short === 'en' ? STARTER_TEXTS[short] : STARTER_TEXTS.en;
};

export const COURSE_ID = /^[a-z][a-z0-9-]{0,47}$/;

// A new course's files, by their path in the project, in the order they are written. Refused before
// anything is made: an id that is not a slug, a brief beyond the plan's limits.
export function newCourseFiles({ id, title, language = 'fr', brief }: NewCourseOptions): Map<string, string> {
  if (!COURSE_ID.test(id)) throw new CommandError('id: lowercase letters, digits and hyphens, starting with a letter');
  if (brief) checkBrief(brief);
  const planId = id.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24);
  const texts = Object.entries(starterTexts(language));
  // Inside JSON strings: a title's quotes, backslashes and control characters escaped.
  const json = (value: string) => JSON.stringify(value).slice(1, -1);
  const fill = (text: string) => texts.reduce((filled, [token, value]) => filled.replaceAll(token, json(value)), text)
    .replaceAll('__ID__', id).replaceAll('__TITLE__', json(title)).replaceAll('__LANG__', json(language)).replaceAll('__PLANID__', planId);
  const made = (from: string, change?: (value: Record<string, unknown>) => void): string => {
    const text = fill(COURSE_TEMPLATE[from]!);
    if (!change) return text;
    const value = JSON.parse(text) as Record<string, unknown>;
    change(value);
    return stringifyJSON(value);
  };
  const files = new Map<string, string>();
  files.set('course.json', made('course.json', brief && (brief.presentation || brief.lms?.length) ? (course) => {
    if (brief.presentation) course.presentation = { mode: brief.presentation };
    if (brief.lms?.length) course.delivery = { lms: [...new Set(brief.lms)] };
  } : undefined));
  files.set('plan.json', made('plan.json', brief && (brief.audience?.trim() || brief.businessGoal?.trim() || brief.duration) ? (plan) => {
    if (brief.businessGoal?.trim()) plan.businessGoal = brief.businessGoal.trim();
    if (brief.audience?.trim()) plan.audience = { ...(plan.audience as object), role: brief.audience.trim() };
    if (brief.duration) plan.duration = { ...(brief.duration.min ? { min: brief.duration.min } : {}), ...(brief.duration.max ? { max: brief.duration.max } : {}) };
  } : undefined));
  files.set('screens/intro.json', made('screens/intro.json'));
  // The rules for agents between their markers, kept up to date by Elabora (D34); the author's notes
  // after them, which Elabora never changes.
  files.set(AGENTS_FILE, agentsFile(courseNotes(brief?.notes)));
  files.set(CLAUDE_FILE, CLAUDE_TEXT);
  files.set('.gitignore', made('gitignore'));
  return files;
}

// Refused before anything is written, with the plan's limits (plan.schema.json).
export function checkBrief(brief: CourseBrief): void {
  if (brief.audience && brief.audience.trim().length > 200) throw new CommandError('brief.audience: at most 200 characters (plan.json audience.role)');
  if (brief.businessGoal && brief.businessGoal.trim().length > 1000) throw new CommandError('brief.businessGoal: at most 1000 characters (plan.json businessGoal)');
  if (brief.duration) {
    const { min, max } = brief.duration;
    const minutes = (value: number | undefined) => value === undefined || (Number.isInteger(value) && value >= 1 && value <= 600);
    if ((min === undefined && max === undefined) || !minutes(min) || !minutes(max) || (min !== undefined && max !== undefined && min > max)) {
      throw new CommandError('brief.duration: whole minutes from 1 to 600, min not above max (plan.json duration)');
    }
  }
  if (brief.presentation && brief.presentation !== 'scroll' && brief.presentation !== 'slides') throw new CommandError('brief.presentation: scroll or slides');
  for (const lms of brief.lms ?? []) getProfile(lms);
}

// The texts a copy of a template changes as it becomes the author's module (D68): the author's id and
// title on the course, the plan and the first screen (the cover), the course's language, its brief, and
// AGENTS.md's notes saying where it comes from, with CLAUDE.md and .gitignore. read gives a text of the
// copy (null: not there). The same bytes on a computer (createFromTemplate) and in a browser (D124).
export function templateTexts(read: (rel: string) => string | null, { id, title, language, brief }: NewCourseOptions, template: string): Map<string, string> {
  if (!COURSE_ID.test(id)) throw new CommandError('id: lowercase letters, digits and hyphens, starting with a letter');
  if (brief) checkBrief(brief);
  const json = (rel: string): Record<string, unknown> => {
    const text = read(rel);
    if (text === null) throw new CommandError(`The template has no ${rel}.`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const texts = new Map<string, string>();
  const course = json('course.json');
  course.id = id;
  course.title = title.trim();
  // Without a language asked, the template's own: its files are in it.
  course.language = language ?? (typeof course.language === 'string' ? course.language : 'fr');
  course.version = '1.0.0';
  delete course.translationOf;
  // The catalogue's description was the template's.
  delete course.description;
  if (brief?.presentation) course.presentation = { ...(isObject(course.presentation) ? course.presentation : {}), mode: brief.presentation };
  if (brief?.lms?.length) course.delivery = { lms: [...new Set(brief.lms)] };
  texts.set('course.json', stringifyJSON(course));

  const plan = json('plan.json');
  plan.id = id.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24);
  plan.title = title.trim();
  delete plan.translationOf;
  if (brief?.businessGoal?.trim()) plan.businessGoal = brief.businessGoal.trim();
  if (brief?.audience?.trim()) plan.audience = { ...(isObject(plan.audience) ? plan.audience : {}), role: brief.audience.trim() };
  if (brief?.duration) plan.duration = { ...(brief.duration.min ? { min: brief.duration.min } : {}), ...(brief.duration.max ? { max: brief.duration.max } : {}) };
  texts.set('plan.json', stringifyJSON(plan));

  // The cover says the module's title from the start.
  const sections = Array.isArray(course.sections) ? course.sections as unknown[] : [];
  const first = sections.flatMap((section) => (isObject(section) && Array.isArray(section.screens) ? section.screens as unknown[] : []))[0];
  if (typeof first === 'string' && read(`screens/${first}.json`) !== null) {
    const screen = json(`screens/${first}.json`);
    screen.title = title.trim();
    texts.set(`screens/${first}.json`, stringifyJSON(screen));
  }

  const notes = [
    `This course starts from the template \`${template}\` (elabora templates): README.md says how its charter works (theme, fonts, components, backdrop and its variants) and how to make it the brand's. Its texts are placeholders at their real length: replace them, and change, add or remove screens and blocks as the storyboard asks; a new screen takes the charter as it is.`,
    brief?.notes?.trim() ?? ''
  ].filter(Boolean).join('\n\n');
  texts.set(AGENTS_FILE, agentsFile(courseNotes(notes)));
  texts.set(CLAUDE_FILE, CLAUDE_TEXT);
  texts.set('.gitignore', COURSE_TEMPLATE.gitignore!);
  return texts;
}

// The note a module made from another course's charter starts with (D69), before the author's.
export function charterNote(title: string, courseId: string | null): string {
  return `This course's charter is copied from the module « ${title} »${courseId ? ` (${courseId})` : ''}: its theme (tokens, fonts, stylesheet, named styles, backdrop and its variants), its components and the player's bars. Keep it: build the screens with its components, styles and backdrop variants (elabora look shows them), and change the charter only when the author asks.`;
}

// A new course's course.json with a charter's theme, presentation (the mode the author chose kept) and
// player bars (D69).
export function withCharter(courseText: string, charter: CharterCourse, presentation?: 'slides' | 'scroll'): string {
  const made = JSON.parse(courseText) as Record<string, unknown>;
  if (isObject(charter.theme)) made.theme = charter.theme;
  if (isObject(charter.presentation)) made.presentation = { ...charter.presentation, ...(presentation ? { mode: presentation } : {}) };
  if (isObject(charter.player)) made.player = charter.player;
  return stringifyJSON(made);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// What a module starts from, as a host or a room's editor sent it: refused before anything is written when it is not
// one (D124).
function checkStart(from: unknown): asserts from is CourseStart {
  const start = from as Partial<Record<string, unknown>> | null;
  if (!isObject(start) || (start.kind !== 'template' && start.kind !== 'charter')) throw new CommandError('from: a template or a charter ({ kind: "template" | "charter", … })');
  if (start.kind === 'template' && (typeof start.template !== 'string' || !start.template)) throw new CommandError('from.template: the template\'s id');
  if (start.kind === 'charter' && (typeof start.title !== 'string' || !start.title || (start.courseId !== null && typeof start.courseId !== 'string') || !isObject(start.course))) throw new CommandError('from: a charter has the title and course id of its course, and its course\'s fields (course)');
  if (!isObject(start.files)) throw new CommandError('from.files: the files by their path');
  for (const [rel, file] of Object.entries(start.files)) {
    const ok = isObject(file) && (file.kind === 'text' ? typeof file.text === 'string' : file.kind === 'binary' && typeof file.hash === 'string' && /^sha256:[0-9a-f]{64}$/.test(file.hash) && Number.isSafeInteger(file.size) && (file.size as number) >= 0);
    if (!ok) throw new CommandError(`from.files: "${rel}" is neither a text ({ kind: "text", text }) nor a medium ({ kind: "binary", hash, size })`);
  }
}

// create_course (D112): a new module's files as the first change of an empty project. A project that
// has a course.json already is left as it is (created: false): two copies that open the same empty
// project and both make it write it once. Its files are those a project reads as text: .gitignore,
// which a folder reads as bytes (isTextPath), is a folder's own file for git, not the project's. From a
// template or a charter (D124), the files it starts from are written with them, media by their hash.
export function createCourse(context: CommandContext, options: NewCourseOptions): CommandOutput<{ created: boolean }> {
  if (context.files.has('course.json')) return { files: context.files, result: { created: false } };
  const { from } = options;
  if (from !== undefined) checkStart(from);
  const files = new Map(context.files);
  const given = new Map<string, StartFile>();
  for (const [rel, file] of Object.entries(from?.files ?? {})) {
    if (projectPath(rel) !== rel || rel === '.elabora' || rel.startsWith('.elabora/')) throw new CommandError(`from.files: "${rel}" is not a path of the project`);
    // A folder's .gitignore, which a template carries, is not the project's (D112).
    if (rel === '.gitignore') continue;
    if ((file.kind === 'text') !== isTextPath(rel)) throw new CommandError(`from.files: "${rel}" is ${isTextPath(rel) ? 'a text' : 'a medium'}`);
    given.set(rel, file);
  }
  const put = (rel: string, file: StartFile) => files.set(rel, file.kind === 'text' ? textFile(file.text) : binaryFile(file.size, { hash: file.hash }));
  if (from?.kind === 'template') {
    for (const [rel, file] of given) put(rel, file);
    const read = (rel: string) => { const file = given.get(rel); return file?.kind === 'text' ? file.text : null; };
    for (const [rel, text] of templateTexts(read, options, from.template)) if (isTextPath(rel)) files.set(rel, textFile(text));
    return { files, result: { created: true } };
  }
  const brief = from?.kind === 'charter' ? { ...options.brief, notes: [charterNote(from.title, from.courseId), options.brief?.notes?.trim() ?? ''].filter(Boolean).join('\n\n') } : options.brief;
  const made = newCourseFiles({ ...options, ...(brief ? { brief } : {}) });
  for (const [rel, text] of made) if (isTextPath(rel)) files.set(rel, textFile(text));
  if (from?.kind === 'charter') {
    for (const [rel, file] of given) put(rel, file);
    files.set('course.json', textFile(withCharter(made.get('course.json')!, from.course, options.brief?.presentation)));
  }
  return { files, result: { created: true } };
}
