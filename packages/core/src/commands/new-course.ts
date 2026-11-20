import { getProfile } from '../lms/profiles.ts';
import { stringifyJSON } from '../util/json.ts';
import { isTextPath, textFile } from '../project/files.ts';
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
}

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

// create_course (D112): a new module's files as the first change of an empty project. A project that
// has a course.json already is left as it is (created: false): two copies that open the same empty
// project and both make it write it once. Its files are those a project reads as text: .gitignore,
// which a folder reads as bytes (isTextPath), is a folder's own file for git, not the project's.
export function createCourse(context: CommandContext, options: NewCourseOptions): CommandOutput<{ created: boolean }> {
  if (context.files.has('course.json')) return { files: context.files, result: { created: false } };
  const made = newCourseFiles(options);
  const files = new Map(context.files);
  for (const [rel, text] of made) if (isTextPath(rel)) files.set(rel, textFile(text));
  return { files, result: { created: true } };
}
