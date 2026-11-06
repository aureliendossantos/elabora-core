import fs from 'node:fs';
import path from 'node:path';
import { deliveryLanguages, packageLanguages } from '@elabora/core/player/config';
import { createReporter, summarize } from '@elabora/core/diagnostics/index';
import { translationPath } from '@elabora/core/i18n/translate';
import { build } from './build.ts';
import type { BuildOptions, BuildResult } from './build.ts';
import { loadProjectFromDir } from './project-reader.ts';
import { withCourseLanguage } from './translate.ts';
import type { TranslationBuild } from './translate.ts';

// One package per language (course.json delivery.languagePackages "each", D71), for LMSs that keep
// the language versions of a course themselves and give each learner the one of their profile
// (Docebo, SuccessFactors, Cornerstone): the course's own package, then one package for each other
// language of delivery.languages (or those asked), as elabora translate build makes it. Each is put
// in as it is, as in one package of every language: a translation not approved or with texts to
// translate is said on its own package.
export interface LanguagePackage {
  language: string;
  result: BuildResult;
  // How the translated course was made (texts left in the course's language, its plan's state);
  // null for the course's own package.
  translation: TranslationBuild | null;
}

// course.json delivery.languagePackages of a course folder: each, else one (unreadable: one, the
// build says why).
export function languagePackagesOf(dir: string): 'one' | 'each' {
  try {
    const course = JSON.parse(fs.readFileSync(path.join(dir, 'course.json'), 'utf8')) as { delivery?: { languagePackages?: unknown } } | null;
    return course?.delivery?.languagePackages === 'each' ? 'each' : 'one';
  } catch { return 'one'; }
}

export async function buildLanguagePackages(dir: string, options: BuildOptions = {}): Promise<LanguagePackage[]> {
  const project = loadProjectFromDir(dir);
  const own = project.course?.language ?? '';
  const { languages, notes } = packageLanguages(project, options.languages ?? deliveryLanguages(project.course) ?? []);
  const out = options.out ?? path.join(project.root, 'dist');
  const { languages: _asked, tryLanguages: _try, ...each } = options;
  const ownPackage = await build(dir, { ...each, out, languages: [] });
  // A language asked that the course has no translation in: said on the course's own package.
  const unknown = createReporter();
  for (const note of notes.filter((candidate) => candidate.kind === 'unknown')) unknown.emit('W_PACKAGE_LANGUAGE_UNKNOWN', { file: 'course.json', target: note.language, message: `The packages ask for ${note.language}, which the course has no translation in: add it (elabora translate export . --to ${note.language}) or leave it out of the package's languages.` });
  const ownDiagnostics = [...unknown.items, ...ownPackage.diagnostics];
  const packages: LanguagePackage[] = [{ language: own, result: { ...ownPackage, diagnostics: ownDiagnostics, summary: summarize(ownDiagnostics) }, translation: null }];
  for (const language of languages.slice(1)) {
    const reporter = createReporter();
    for (const note of notes.filter((candidate) => candidate.language === language)) {
      if (note.kind === 'not approved') reporter.emit('W_PACKAGE_LANGUAGE_NOT_APPROVED', { file: translationPath(language), target: language, ...(options.release ? { severity: 'error' as const } : {}), message: `The ${language} package is made, ${note.lacks.join('; ')}: tell the author, who approves it (Traduction › Versions, or through you with their yes).` });
      else if (note.kind === 'incomplete') reporter.emit('W_PACKAGE_LANGUAGE_INCOMPLETE', { file: translationPath(language), target: language, message: `The ${language} package is made with ${note.lacks.join('; ')}: learners read those texts in ${own}.` });
    }
    // A translation the core refuses (a text that loses its maths, a link…) stops its own package
    // only: the others are made, and it says why.
    // A release that needs this translation approved stops before anything is made.
    if (reporter.items.some((d) => d.severity === 'error')) { packages.push({ language, translation: null, result: { ok: false, diagnostics: reporter.items, summary: summarize(reporter.items) } }); continue; }
    try {
      await withCourseLanguage(dir, { language, allowMissing: true }, async (root, translation) => {
        const result = await build(root, { ...each, out, languages: [] });
        const diagnostics = [...reporter.items, ...result.diagnostics];
        packages.push({ language, translation, result: { ...result, diagnostics, summary: summarize(diagnostics) } });
      });
    } catch (error) {
      reporter.emit('E_PACKAGE_LANGUAGE_REFUSED', { file: translationPath(language), target: language, message: `The ${language} package could not be made: ${error instanceof Error ? error.message : String(error)}` });
      packages.push({ language, translation: null, result: { ok: false, diagnostics: reporter.items, summary: summarize(reporter.items) } });
    }
  }
  return packages;
}
