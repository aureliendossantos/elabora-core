import { applyIgnored, applyWaivers, summarize, sortDiagnostics } from '../diagnostics/index.ts';
import type { Diagnostic, Summary } from '../diagnostics/index.ts';
import type { Project } from '../project/model.ts';
import type { CourseIgnored } from '@elabora/format';
import { createValidationContext, startRun, hasCourse } from './context.ts';
import type { Check, CheckContext, CourseCheckContext, ScreenFile, ValidationContext, ValidationOptions } from './context.ts';
import { reportLoadErrors, checkDocumentSchemas, checkPlanVersions, checkScreenSchema, checkStructure, checkScreenFile } from './structure.ts';
import { checkPlan, checkScreenPlan } from './plan.ts';
import { checkBlocks } from './blocks.ts';
import { checkScreenNarration, checkNarrationAudio } from './narration.ts';
import { checkScreenTiming, checkTimelineTimes } from './timeline.ts';
import { checkEvents } from './events.ts';
import { checkDialogues, checkSpeakerLooks } from './dialogue.ts';
import { checkObjects, checkObjectUsage, checkScreenObjects, checkScreenBackdrop } from './objects.ts';
import { checkTheme } from './theme.ts';
import { checkPlayer } from './player.ts';
import { checkScreenPedagogy, checkExpositionStreak } from './pedagogy.ts';
import { checkTracking } from './tracking.ts';
import { checkThemeFiles, checkFontLicenses, checkFigures, checkGenerators } from './design.ts';
import { checkComponents, checkComponentUsage, checkScreenComponents, checkThemeStyles } from './components.ts';
import { checkMedia } from './media.ts';
import { checkContinuity } from './continuity.ts';
import { list } from './guards.ts';

export { createValidationContext };
export type { Check, CheckContext, CourseCheckContext, ScreenFile, ValidationContext, ValidationOptions };
export type { ListedScreen, ProjectCheck, ScreenCheck, SuspendDataBudget } from './context.ts';

// Checks of the files: they run on any project, with or without course.json.
export const FILE_CHECKS: readonly Check<CheckContext>[] = [
  { name: 'load-errors', scope: 'project', readsScreens: true, run: reportLoadErrors },
  { name: 'document-schemas', scope: 'project', run: checkDocumentSchemas },
  { name: 'plan-versions', scope: 'project', run: checkPlanVersions },
  { name: 'screen-schema', scope: 'screen', screens: 'all', run: checkScreenSchema },
  { name: 'media', scope: 'project', run: checkMedia }
];

// Checks of the course, when course.json loaded. Reports sort findings by severity, file and code
// and keep the order of the checks within each group: this order is part of the output.
export const COURSE_CHECKS: readonly Check<CourseCheckContext>[] = [
  { name: 'structure', scope: 'project', readsScreens: true, run: checkStructure },
  { name: 'screen-file', scope: 'screen', screens: 'all', run: checkScreenFile },
  { name: 'plan', scope: 'project', readsScreens: true, run: checkPlan },
  { name: 'screen-plan', scope: 'screen', run: checkScreenPlan },
  { name: 'blocks', scope: 'screen', run: checkBlocks },
  { name: 'events', scope: 'screen', readsOtherScreens: true, run: checkEvents },
  { name: 'dialogues', scope: 'screen', run: checkDialogues },
  { name: 'speaker-looks', scope: 'project', run: checkSpeakerLooks },
  { name: 'narration', scope: 'screen', run: checkScreenNarration },
  { name: 'narration-audio', scope: 'project', readsScreens: true, run: checkNarrationAudio },
  { name: 'timeline', scope: 'screen', run: checkScreenTiming },
  { name: 'timeline-times', scope: 'project', readsScreens: true, run: checkTimelineTimes },
  { name: 'screen-objects', scope: 'screen', readsOtherScreens: true, run: checkScreenObjects },
  { name: 'screen-backdrop', scope: 'screen', screens: 'all', run: checkScreenBackdrop },
  { name: 'objects', scope: 'project', run: checkObjects },
  { name: 'object-usage', scope: 'project', readsScreens: true, run: checkObjectUsage },
  { name: 'continuity', scope: 'project', readsScreens: true, run: checkContinuity },
  { name: 'theme', scope: 'project', run: checkTheme },
  { name: 'player', scope: 'project', readsScreens: true, run: checkPlayer },
  { name: 'components', scope: 'project', run: checkComponents },
  { name: 'component-usage', scope: 'project', readsScreens: true, run: checkComponentUsage },
  { name: 'screen-components', scope: 'screen', run: checkScreenComponents },
  { name: 'theme-styles', scope: 'project', run: checkThemeStyles },
  { name: 'theme-files', scope: 'project', run: checkThemeFiles },
  { name: 'font-licenses', scope: 'project', run: checkFontLicenses },
  { name: 'figures', scope: 'screen', readsOtherScreens: true, run: checkFigures },
  { name: 'generators', scope: 'project', readsScreens: true, run: checkGenerators },
  { name: 'screen-pedagogy', scope: 'screen', run: checkScreenPedagogy },
  { name: 'exposition-streak', scope: 'project', readsScreens: true, run: checkExpositionStreak },
  { name: 'tracking', scope: 'project', readsScreens: true, run: checkTracking }
];

export interface ValidationResult {
  diagnostics: Diagnostic[];
  summary: Summary;
  ok: boolean;
  project: Project;
  context: CheckContext; // budget: the worst-case suspend data the tracking check measured
}

// validateProject(project, { profiles, release }): the project as loadProject made it from its
// files (@elabora/node: validateDir for a folder).
//   profiles: LMS profile ids the course targets (default: course.json delivery.lms, else ["unknown"], the strictest values)
//   release:  true for client deliveries: the plan must be approved
//   target:   scorm12 (default) or web: a module for the web is checked against no LMS (D41)
export function validateProject(project: Project, options: ValidationOptions = {}): ValidationResult {
  // JavaScript callers may still pass a folder.
  if (typeof project === 'string') throw new TypeError('validateProject takes a loaded project: use validateDir or loadProjectFromDir from @elabora/node for a folder.');
  const ctx = startRun(createValidationContext(project, options));
  runChecks(FILE_CHECKS, ctx);
  if (hasCourse(ctx)) runChecks(COURSE_CHECKS, ctx);
  const diagnostics = finish(ctx);
  const summary = summarize(diagnostics);
  return { diagnostics, summary, ok: summary.errors === 0, project, context: ctx };
}

// The findings of the screen checks on one screen, against a context built for the project as it
// is (createValidationContext): what an editor re-validates when the screen changes. The findings
// of the project checks are those of validateProject.
export function validateScreen(context: ValidationContext, screenId: string): Diagnostic[] {
  const entry = context.project.screens.get(screenId);
  if (!entry) return [];
  const listed = context.screens.get(screenId);
  const screen: ScreenFile = listed ?? { ...entry, id: screenId };
  const ctx = startRun(context);
  const runOnScreen = <C extends CheckContext>(checks: readonly Check<C>[], checkContext: C) => {
    for (const check of checks) if (check.scope === 'screen' && (listed || check.screens === 'all')) check.run(checkContext, screen);
  };
  runOnScreen(FILE_CHECKS, ctx);
  if (hasCourse(ctx)) runOnScreen(COURSE_CHECKS, ctx);
  return finish(ctx);
}

// The findings of the project checks: with validateScreen on every screen, the findings of
// validateProject (the same set; a locked text whose maths fail is reported once per run, so once
// per screen that uses it here).
export function validateProjectChecks(context: ValidationContext): Diagnostic[] {
  const ctx = startRun(context);
  const runProjectChecks = <C extends CheckContext>(checks: readonly Check<C>[], checkContext: C) => {
    for (const check of checks) if (check.scope === 'project') check.run(checkContext);
  };
  runProjectChecks(FILE_CHECKS, ctx);
  if (hasCourse(ctx)) runProjectChecks(COURSE_CHECKS, ctx);
  return finish(ctx);
}

// Each check in order: a project check once, a screen check on each of its screens (screen files in
// name order, listed screens in learner order).
function runChecks<C extends CheckContext>(checks: readonly Check<C>[], ctx: C): void {
  for (const check of checks) {
    if (check.scope === 'project') check.run(ctx);
    else if (check.screens === 'all') for (const [id, entry] of ctx.project.screens) check.run(ctx, ctx.screens.get(id) ?? { ...entry, id });
    else for (const screen of ctx.screens.values()) check.run(ctx, screen);
  }
}

// Plan waivers and the warnings the author ignored (D31) apply to the findings of the run, sorted
// like every report.
const finish = (ctx: CheckContext): Diagnostic[] => sortDiagnostics(applyIgnored(applyWaivers(ctx.reporter.items, list(ctx.project.plan?.waivers).filter((waiver) => waiver !== null && waiver !== undefined)), ignoredOf(ctx.project.course)));

// The author's ignored findings in course.json, those well formed.
export const ignoredOf = (course: { ignored?: unknown } | null | undefined): CourseIgnored[] => (Array.isArray(course?.ignored) ? course.ignored : [])
  .filter((entry): entry is CourseIgnored => !!entry && typeof entry === 'object' && typeof (entry as CourseIgnored).code === 'string' && typeof (entry as CourseIgnored).key === 'string');
