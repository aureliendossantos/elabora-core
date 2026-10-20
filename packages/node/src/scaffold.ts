import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProfile } from '@elabora/core/lms/profiles';
import { stringifyJSON } from '@elabora/core/util/json';
import { agentsFile, courseNotes } from './agent-rules.ts';

export const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates');

export interface InitOptions {
  id: string;
  title: string;
  language?: string;
  brief?: CourseBrief;
}

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

// The texts a new course starts with, to be replaced by the storyboard's, in the course language
// (another language gets the English ones).
const STARTER_TEXTS: Record<'fr' | 'en', Record<string, string>> = {
  fr: {
    __TEXT_INTRODUCTION__: 'Introduction',
    __TEXT_OBJECTIVE__: 'À remplacer par un comportement observable : verbe d\'action, condition, critère.',
    __TEXT_PRACTICE__: 'À remplacer par la première activité du storyboard',
    __TEXT_INTRO__: 'À remplacer par l\'introduction validée dans le storyboard.'
  },
  en: {
    __TEXT_INTRODUCTION__: 'Introduction',
    __TEXT_OBJECTIVE__: 'Replace with an observable behaviour: action verb, condition, criterion.',
    __TEXT_PRACTICE__: 'Replace with the first activity of the storyboard',
    __TEXT_INTRO__: 'Replace with the introduction validated in the storyboard.'
  }
};

const starterTexts = (language: string): Record<string, string> => {
  const short = language.slice(0, 2).toLowerCase();
  return short === 'fr' || short === 'en' ? STARTER_TEXTS[short] : STARTER_TEXTS.en;
};

// Scaffolds a course project: course.json, plan.json (draft), an intro screen, AGENTS.md, .gitignore.
export function initProject(dir: string, { id, title, language = 'fr', brief }: InitOptions): { dir: string; files: string[] } {
  const root = path.resolve(dir);
  if (fs.existsSync(path.join(root, 'course.json'))) throw new Error(`${root} already contains a course.json`);
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw new Error('id: lowercase letters, digits and hyphens, starting with a letter');
  if (brief) checkBrief(brief);
  const planId = id.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24);
  const texts = Object.entries(starterTexts(language));
  // Inside JSON strings: a title's quotes, backslashes and control characters escaped.
  const json = (value: string) => JSON.stringify(value).slice(1, -1);
  const fill = (text: string) => texts.reduce((filled, [token, value]) => filled.replaceAll(token, json(value)), text)
    .replaceAll('__ID__', id).replaceAll('__TITLE__', json(title)).replaceAll('__LANG__', json(language)).replaceAll('__PLANID__', planId);
  const copy = (from: string, to: string, change?: (value: Record<string, unknown>) => void) => {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    const text = fill(fs.readFileSync(path.join(TEMPLATES_DIR, 'course', from), 'utf8'));
    if (!change) { fs.writeFileSync(path.join(root, to), text); return; }
    const value = JSON.parse(text) as Record<string, unknown>;
    change(value);
    fs.writeFileSync(path.join(root, to), stringifyJSON(value));
  };
  copy('course.json', 'course.json', brief && (brief.presentation || brief.lms?.length) ? (course) => {
    if (brief.presentation) course.presentation = { mode: brief.presentation };
    if (brief.lms?.length) course.delivery = { lms: [...new Set(brief.lms)] };
  } : undefined);
  copy('plan.json', 'plan.json', brief && (brief.audience?.trim() || brief.businessGoal?.trim() || brief.duration) ? (plan) => {
    if (brief.businessGoal?.trim()) plan.businessGoal = brief.businessGoal.trim();
    if (brief.audience?.trim()) plan.audience = { ...(plan.audience as object), role: brief.audience.trim() };
    if (brief.duration) plan.duration = { ...(brief.duration.min ? { min: brief.duration.min } : {}), ...(brief.duration.max ? { max: brief.duration.max } : {}) };
  } : undefined);
  copy('screens/intro.json', 'screens/intro.json');
  // The rules for agents between their markers, kept up to date by Elabora (agent-rules.ts, D34);
  // the author's notes after them, which Elabora never changes.
  fs.writeFileSync(path.join(root, 'AGENTS.md'), agentsFile(courseNotes(brief?.notes)));
  copy('gitignore', '.gitignore');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  return { dir: root, files: ['course.json', 'plan.json', 'screens/intro.json', 'AGENTS.md', '.gitignore'] };
}

// Refused before anything is written, with the plan's limits (plan.schema.json).
export function checkBrief(brief: CourseBrief): void {
  if (brief.audience && brief.audience.trim().length > 200) throw new Error('brief.audience: at most 200 characters (plan.json audience.role)');
  if (brief.businessGoal && brief.businessGoal.trim().length > 1000) throw new Error('brief.businessGoal: at most 1000 characters (plan.json businessGoal)');
  if (brief.duration) {
    const { min, max } = brief.duration;
    const minutes = (value: number | undefined) => value === undefined || (Number.isInteger(value) && value >= 1 && value <= 600);
    if ((min === undefined && max === undefined) || !minutes(min) || !minutes(max) || (min !== undefined && max !== undefined && min > max)) {
      throw new Error('brief.duration: whole minutes from 1 to 600, min not above max (plan.json duration)');
    }
  }
  if (brief.presentation && brief.presentation !== 'scroll' && brief.presentation !== 'slides') throw new Error('brief.presentation: scroll or slides');
  for (const lms of brief.lms ?? []) getProfile(lms);
}
