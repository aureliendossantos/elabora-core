import fs from 'node:fs';
import path from 'node:path';
import { SOURCES_DIR } from '@elabora/core/project/files';
import { translationStatus as statusOf, translatedCourse } from '@elabora/core/i18n/translate';
import * as commands from '@elabora/core/commands/translation';
import { stringifyJSON } from '@elabora/core/util/json';
import { listGenerators } from '@elabora/core/project/generators';
import { loadProjectFromDir } from './project-reader.ts';
import { runGenerators } from './generators.ts';
import { writeFileAtomic } from './util/fs.ts';
import { fieldOf } from './util/values.ts';
import { projectDataDir } from './data-dir.ts';
import { runCommand } from './edit/executor.ts';
import type { EditOptions } from './edit/executor.ts';

// `elabora translate` on a course folder: the core computes the files, this module reads and writes
// them (translations live in the source course, translations/<lang>.xlf).

export const translationFile = (dir: string, language: string): string => path.join(path.resolve(dir), 'translations', `${language}.xlf`);

// Create or update translations/<lang>.xlf.
export function exportTranslation(dir: string, { to }: { to: string }, options?: EditOptions) {
  const result = runCommand(dir, { name: 'export_translation', args: { to }, run: (context) => commands.exportTranslation(context, { to }) }, options);
  return { file: translationFile(dir, to), units: result.units, translated: result.translated, toTranslate: result.toTranslate, stale: result.stale, removed: result.removed, details: result.details, change: result.change, undo: result.undo };
}

export function translationStatus(dir: string, options: { to?: string } = {}) {
  return statusOf(loadProjectFromDir(dir), options);
}

export interface TranslationBuild {
  dir: string;
  language: string;
  units: number;
  untranslated: number;
  // Word anchors whose marker the translation has not placed (--allow-missing): at their line's start.
  unplaced: number;
  plan: string | null; // status of the translated plan
}

// Generate the translated course in `out`: a copy of the source (design, objects, assets) with the
// translated strings. `out` must be empty or a previous build of the same translation, outside the
// source course, or in a folder of it that is never copied (.elabora, dist: the app's engine builds
// there).
export async function buildTranslation(dir: string, { to, out, allowMissing = false }: { to: string; out: string; allowMissing?: boolean }): Promise<TranslationBuild> {
  const project = loadProjectFromDir(dir);
  const { files, plan, approved, units, missing, unplaced, agentsNote } = translatedCourse(project, { to, allowMissing });
  const target = path.resolve(out);
  const inside = target === project.root || target.startsWith(`${project.root}${path.sep}`);
  if (inside && !['.elabora', 'dist'].includes(path.relative(project.root, target).split(path.sep)[0] ?? '')) throw new Error('Build the translation outside the source course folder.');
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    const courseFile = path.join(target, 'course.json');
    const previous: unknown = fs.existsSync(courseFile) ? JSON.parse(fs.readFileSync(courseFile, 'utf8')) : null;
    if (fieldOf(fieldOf(previous, 'translationOf'), 'id') !== project.course?.id) throw new Error(`${target} is not empty and is not a translation of ${project.course?.id}.`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  // The source's plan versions are of the source language's plan: the translated course has its own.
  const skip = /[\\/](dist|\.elabora|\.git|translations|plan-versions|node_modules)([\\/]|$)/;
  // Entry by entry: a target in .elabora is never inside what is copied.
  const keep = (source: string) => !skip.test(source.slice(project.root.length)) && !/[\\/]\.DS_Store$/.test(source);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(project.root)) {
    const source = path.join(project.root, entry);
    // The author's sources stay with the source course (D49).
    if (entry !== SOURCES_DIR && keep(source)) fs.cpSync(source, path.join(target, entry), { recursive: true, filter: keep, mode: fs.constants.COPYFILE_FICLONE });
  }
  for (const [rel, data] of files) writeFileAtomic(path.join(target, rel), stringifyJSON(data));
  const agents = path.join(target, 'AGENTS.md');
  if (fs.existsSync(agents)) fs.writeFileSync(agents, agentsNote + fs.readFileSync(agents, 'utf8'));
  // Figures are generated for the course language (numbers, decimal separators).
  const translated = loadProjectFromDir(target);
  if (listGenerators(translated).length) {
    const generated = await runGenerators(target, { course: translated.course, plan: translated.plan });
    const failed = generated.results.filter((result) => result.error);
    if (failed.length) throw new Error(`Generators failed in the translation: ${failed.map((result) => `${result.generator}: ${result.error}`).join('; ')}`);
  }
  return { dir: target, language: to, units: units.length, untranslated: missing.length, unplaced: unplaced.length, plan: plan ? (approved ? 'approved' : 'draft') : null };
}

// Run a check/build on a language while the caller stays scoped to the source course. A unique
// derived folder per call prevents concurrent clients from deleting each other's working copy.
// Durable outputs must be written to the source's dist/, never into this temporary copy.
export async function withCourseLanguage<T>(dir: string, options: { language?: string; allowMissing?: boolean }, run: (root: string, translation: TranslationBuild | null) => Promise<T> | T): Promise<T> {
  if (!options.language) {
    if (options.allowMissing) throw new Error('allowMissing requires a translation language.');
    return run(dir, null);
  }
  const base = path.join(projectDataDir(dir), 'translations');
  fs.mkdirSync(base, { recursive: true });
  const work = fs.mkdtempSync(path.join(base, 'check-'));
  try {
    const translation = await buildTranslation(dir, { to: options.language, out: work, allowMissing: options.allowMissing });
    return await run(work, translation);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// Approve the translated plan (a person who read it): stored with the source course.
export function approveTranslation(dir: string, args: { to: string; by: string; reference?: string; date?: string }, options?: EditOptions) {
  return runCommand(dir, { name: 'approve_translation', args, run: (context) => commands.approveTranslation(context, args) }, options).approval;
}
