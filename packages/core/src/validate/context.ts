import type { Project, Course, Block, Variable, ScreenEntry } from '../project/model.ts';
import type { Reporter } from '../diagnostics/index.ts';
import { createReporter } from '../diagnostics/index.ts';
import { getRegistry } from '../components/registry.ts';
import type { Registry } from '../components/registry.ts';
import { planIndex, iterateBlocks, screenOrder } from '../project/load.ts';
import type { PlanIndex, BlockLocation } from '../project/load.ts';
import { list } from './guards.ts';
import { targetProfileIds } from '../lms/profiles.ts';

export interface ValidationOptions {
  profiles?: readonly string[]; // LMS profile ids the course targets (default: course.json delivery.lms, else ["unknown"], the strictest values)
  release?: boolean; // client delivery: the plan must be approved
  // What the build makes (default scorm12). web (D41): no LMS, so no LMS profile, suspend data
  // budget or package rule of an LMS applies.
  target?: BuildTarget;
}

export type BuildTarget = 'scorm12' | 'web';

// A screen file with its id (the file name).
export interface ScreenFile extends ScreenEntry {
  id: string;
}

// A screen that course.json lists and whose file loaded, with its place in learner order.
export interface ListedScreen extends ScreenFile {
  index: number;
  section: string;
}

// What the checks read: the project, indexes built once from it, and the options. The engine keeps
// one for a version of the project and re-validates an edited screen against it (validateScreen).
export interface ValidationContext {
  project: Project;
  course: Course | null;
  options: { profiles: readonly string[]; release: boolean; target: BuildTarget };
  registry: Registry;
  planIndex: PlanIndex;
  order: { id: string; section: string }[]; // learner order, as course.json lists the screens
  screens: Map<string, ListedScreen>;
  // Blocks of the listed screens by id (layers and slots included); with duplicate ids, the first.
  blocks: Map<string, BlockLocation>;
  // The same, but with duplicate ids the last block: the one a visited condition reads.
  lastBlocks: Map<string, Block>;
  variables: Map<string, Variable>;
}

// Worst-case suspend data against the strictest LMS profile (the tracking check measures it).
export interface SuspendDataBudget {
  worstCase: number;
  limit: number;
  profiles: string[];
}

// One run of the checks: the context, the reporter collecting the findings, and what the run
// measures or has already reported.
export interface CheckContext extends ValidationContext {
  reporter: Reporter;
  reportedMath: Set<string>; // E_MATH_PARSE already reported: a locked text used on two screens is reported once
  budget?: SuspendDataBudget;
}

// Checks of the course run only when course.json loaded.
export interface CourseCheckContext extends CheckContext {
  course: Course;
}

// A check depends on one screen (scope "screen": the screen, plus what screens share and rarely
// changes: course.json, plan, components, objects, theme, variables) or compares screens with each
// other or with the plan (scope "project"). validateProject runs the checks in their order, a screen
// check on each screen in learner order; validateScreen runs the screen checks of one screen. After
// a screen edit, an engine re-runs that screen's checks, the project checks that read screens, and
// the screen checks that read other screens on every screen when block ids or types changed.
export interface ProjectCheck<C extends CheckContext> {
  name: string;
  scope: 'project';
  // It reads the screens (or files that may be screens): an edited screen changes its findings.
  readsScreens?: true;
  run: (ctx: C) => void;
}

export interface ScreenCheck<C extends CheckContext> {
  name: string;
  scope: 'screen';
  // The screens it runs on: the screens course.json lists (default), or every screen file.
  screens?: 'all';
  // It also reads the blocks of other screens (context.blocks or context.lastBlocks): when the blocks
  // of a screen change, its findings on other screens may change too.
  readsOtherScreens?: true;
  run: (ctx: C, screen: ScreenFile) => void;
}

export type Check<C extends CheckContext> = ProjectCheck<C> | ScreenCheck<C>;

export function createValidationContext(project: Project, options: ValidationOptions = {}): ValidationContext {
  const order = screenOrder(project);
  const screens = new Map<string, ListedScreen>();
  order.forEach(({ id, section }, index) => {
    const entry = project.screens.get(id);
    if (entry && !screens.has(id)) screens.set(id, { ...entry, id, index, section });
  });
  const blocks = new Map<string, BlockLocation>();
  const lastBlocks = new Map<string, Block>();
  for (const location of iterateBlocks(project)) {
    const { block } = location;
    if (block === null || block === undefined) continue;
    if (!blocks.has(block.id)) blocks.set(block.id, location);
    lastBlocks.set(block.id, block);
  }
  const variables = new Map<string, Variable>();
  for (const variable of list(project.course?.variables)) if (variable !== null && variable !== undefined) variables.set(variable.id, variable);
  return {
    project,
    course: project.course,
    options: { profiles: options.target === 'web' ? [] : targetProfileIds(project.course, options.profiles), release: !!options.release, target: options.target ?? 'scorm12' },
    registry: getRegistry(project),
    planIndex: planIndex(project.plan),
    order,
    screens,
    blocks,
    lastBlocks,
    variables
  };
}

// A run of checks over the context, with a fresh reporter.
export function startRun(context: ValidationContext): CheckContext {
  return { ...context, reporter: createReporter(), reportedMath: new Set() };
}

export const hasCourse = (ctx: CheckContext): ctx is CourseCheckContext => !!ctx.course;
