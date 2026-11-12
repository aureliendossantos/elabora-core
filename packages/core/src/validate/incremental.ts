import { loadProject } from '../project/load.ts';
import { readText, type ProjectFiles } from '../project/files.ts';
import type { LoadError, Project, Screen, ScreenEntry } from '../project/model.ts';
import { sameContent } from '../ops/json.ts';
import { parseJSON } from '../util/json.ts';
import { applyIgnored, applyWaivers, sortDiagnostics, type Diagnostic } from '../diagnostics/index.ts';
import { hasCourse, startRun } from './context.ts';
import { COURSE_CHECKS, FILE_CHECKS, createValidationContext, ignoredOf, validateScreen, type Check, type CheckContext, type ValidationContext, type ValidationOptions } from './index.ts';

// A project's validation kept change by change (docs/decisions.md D86): what the checks found, per
// screen and per project check, and the project they found it in. The next files are validated
// from it by running again only what their changes can affect, with the same findings as
// validateProject on them (test/unit/validation-incremental.test.ts compares the two):
//   - screen files changed: their screen checks run again, then those of the screens that mention
//     an id whose element was added, removed or changed in them (checks that read other screens:
//     visited conditions, duplicate block ids, go-to targets), and the project checks that read
//     screens; the other project checks keep their findings;
//   - an asset changed: the screens that mention it, and every project check;
//   - a file no check reads (AGENTS.md, translations): every project check (a file that does not
//     load is a load error), no screen check;
//   - any other file (course.json, the plan, components, objects, the theme…), or a project in
//     another format than this Elabora's: everything, as validateProject.
// A value, never changed once made: a server keeps the one of its head and computes the next one
// for a change it may still refuse. The desktop engine's ProjectState does the same in place.

export interface ValidationState {
  readonly files: ProjectFiles;
  readonly project: Project;
  readonly options: IncrementalOptions;
  // The findings of the screen checks, by screen; of the project checks, by check.
  readonly screens: ReadonlyMap<string, readonly Diagnostic[]>;
  readonly checks: ReadonlyMap<string, readonly Diagnostic[]>;
  // All of them, sorted as reports sort them: those of validateProject on these files.
  readonly diagnostics: readonly Diagnostic[];
  // What the last step ran again (for measures and tests).
  readonly ran: { readonly screens: number; readonly projectChecks: 'all' | 'screens' | 'none'; readonly full: boolean };
}

export interface IncrementalOptions {
  readonly root?: string;
  readonly validation?: ValidationOptions;
}

// Files no check reads.
const NOT_VALIDATED = /^(AGENTS\.md|CLAUDE\.md|README\.md|translations\/.*)$/;
const SCREEN_FILE = /^screens\/([^/]+)\.json$/;

// The whole validation of these files.
export function validationState(files: ProjectFiles, options: IncrementalOptions = {}): ValidationState {
  const project = loadProject(files, options.root ? { root: options.root } : {});
  const context = createValidationContext(project, options.validation);
  const screens = new Map<string, readonly Diagnostic[]>();
  for (const id of project.screens.keys()) screens.set(id, validateScreen(context, id));
  return assemble(files, project, options, screens, projectChecks(context, new Map(), false), { screens: screens.size, projectChecks: 'all', full: true });
}

// The validation of the next files, from the previous one: only what changed between them runs again.
export function revalidate(previous: ValidationState, files: ProjectFiles): ValidationState {
  const changed = changedPaths(previous.files, files);
  if (!changed.length) return previous.files === files ? previous : { ...previous, files, ran: { screens: 0, projectChecks: 'none', full: false } };
  const current = !previous.project.migration && !previous.project.loadErrors.some((error) => error.code === 'E_FORMAT_NEWER');
  const screenFiles = changed.filter((path) => SCREEN_FILE.test(path));
  const assets = changed.filter((path) => path.startsWith('assets/'));
  const unread = changed.filter((path) => NOT_VALIDATED.test(path));
  if (!current || screenFiles.length + assets.length + unread.length < changed.length) return validationState(files, previous.options);

  const project = screenFiles.length === changed.length
    ? withScreens(previous.project, files, screenFiles)
    : loadProject(files, previous.options.root ? { root: previous.options.root } : {});
  if (project.migration || project.loadErrors.some((error) => error.code === 'E_FORMAT_NEWER')) return validationState(files, previous.options);
  const context = createValidationContext(project, previous.options.validation);

  // The screens to check again: those changed, and those that mention what changed in them.
  const rerun = new Set<string>();
  const changedIds = new Set<string>();
  for (const file of screenFiles) {
    const id = (SCREEN_FILE.exec(file) as RegExpExecArray)[1];
    changedSignatures(previous.project.screens.get(id)?.data, project.screens.get(id)?.data, changedIds);
    if (project.screens.has(id)) rerun.add(id);
  }
  const needles = [...[...changedIds].map((id) => JSON.stringify(id)), ...assets.map((path) => path.slice('assets/'.length))];
  if (needles.length) {
    for (const [id, entry] of project.screens) {
      if (rerun.has(id)) continue;
      const text = readText(files, entry.file) ?? '';
      if (needles.some((needle) => text.includes(needle))) rerun.add(id);
    }
  }
  const screens = new Map<string, readonly Diagnostic[]>();
  for (const id of project.screens.keys()) screens.set(id, rerun.has(id) ? validateScreen(context, id) : previous.screens.get(id) ?? validateScreen(context, id));

  const onlyScreens = !assets.length && !unread.length;
  return assemble(files, project, previous.options, screens, projectChecks(context, previous.checks, onlyScreens), { screens: rerun.size, projectChecks: onlyScreens ? 'screens' : 'all', full: false });
}

// The paths whose content differs between two snapshots.
function changedPaths(before: ProjectFiles, after: ProjectFiles): string[] {
  if (before === after) return [];
  const changed: string[] = [];
  for (const [path, file] of after) {
    const was = before.get(path);
    if (was !== file && !sameContent(was, file)) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed;
}

// The project checks in their order, as validateProject runs them; only: those that read screens
// run again, the others keep their findings.
function projectChecks(context: ValidationContext, previous: ReadonlyMap<string, readonly Diagnostic[]>, onlyScreens: boolean): Map<string, readonly Diagnostic[]> {
  const checks = new Map(previous);
  const run = startRun(context);
  const runChecks = <C extends CheckContext>(list: readonly Check<C>[], ctx: C) => {
    for (const check of list) {
      if (check.scope !== 'project' || (onlyScreens && !check.readsScreens)) continue;
      const start = ctx.reporter.items.length;
      check.run(ctx);
      checks.set(check.name, ctx.reporter.items.slice(start));
    }
  };
  runChecks(FILE_CHECKS, run);
  if (hasCourse(run)) runChecks(COURSE_CHECKS, run);
  else for (const check of COURSE_CHECKS) checks.delete(check.name);
  const waivers = Array.isArray(context.project.plan?.waivers) ? context.project.plan.waivers.filter((waiver) => waiver !== null && waiver !== undefined) : [];
  applyIgnored(applyWaivers(run.reporter.items, waivers), ignoredOf(context.project.course));
  return checks;
}

function assemble(files: ProjectFiles, project: Project, options: IncrementalOptions, screens: Map<string, readonly Diagnostic[]>, checks: Map<string, readonly Diagnostic[]>, ran: ValidationState['ran']): ValidationState {
  const all: Diagnostic[] = [];
  for (const check of [...FILE_CHECKS, ...COURSE_CHECKS]) all.push(...(checks.get(check.name) ?? []));
  for (const list of screens.values()) all.push(...list);
  return { files, project, options, screens, checks, diagnostics: sortDiagnostics(oncePerProject(all)), ran };
}

// A validated text of the plan whose maths fail is reported once in a run of the checks, however
// many screens show it (its file is plan.json): screens checked apart report it once each.
function oncePerProject(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((d) => {
    if (d.code !== 'E_MATH_PARSE') return true;
    const key = JSON.stringify([d.file, d.path, d.target, d.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The project with some screen files read again, as loadProject reads them (screens in file name
// order, a file that does not parse reported as a load error).
export function withScreens(project: Project, files: ProjectFiles, paths: readonly string[]): Project {
  const changed = new Set(paths);
  const screens = new Map<string, ScreenEntry>();
  for (const [id, entry] of project.screens) if (!changed.has(entry.file)) screens.set(id, entry);
  const loadErrors: LoadError[] = project.loadErrors.filter((error) => !changed.has(error.file));
  for (const file of paths) {
    const text = readText(files, file);
    if (text === null) continue; // deleted
    const parsed = parseJSON(text);
    if (parsed.error !== undefined) loadErrors.push({ code: 'E_JSON_PARSE', file, message: parsed.error });
    else if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) loadErrors.push({ code: 'E_SCHEMA', file, message: '/: must be object (schema screen)' });
    else screens.set((SCREEN_FILE.exec(file) as RegExpExecArray)[1], { file, data: parsed.value as Screen });
  }
  const ordered = new Map([...screens].sort(([, a], [, b]) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)));
  return { ...project, files, screens: ordered, loadErrors };
}

// The content of each element with an id (screen, layers, blocks, events…), by id: what other
// screens may read of this one.
function signatures(value: unknown, out: Map<string, string>): Map<string, string> {
  if (Array.isArray(value)) {
    for (const item of value) signatures(item, out);
  } else if (value !== null && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') out.set(id, (out.get(id) ?? '') + JSON.stringify(value));
    for (const item of Object.values(value)) signatures(item, out);
  }
  return out;
}

// Adds the ids whose element was added, removed or changed between two versions of a screen.
export function changedSignatures(before: unknown, after: unknown, out: Set<string>): Set<string> {
  const was = signatures(before, new Map());
  const now = signatures(after, new Map());
  for (const [id, signature] of was) if (now.get(id) !== signature) out.add(id);
  for (const id of now.keys()) if (!was.has(id)) out.add(id);
  return out;
}

// The errors a project has, counted by code, file and path: a second error of the same kind at the
// same place counts too. A room refuses a change after which a count grows (D73).
export function errorCounts(state: Pick<ValidationState, 'diagnostics'>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of state.diagnostics) {
    if (d.severity !== 'error') continue;
    const key = `${d.code}|${d.file ?? ''}|${d.path ?? ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// The errors the next state has that the previous one did not: the keys whose count grew.
export function newErrors(before: Pick<ValidationState, 'diagnostics'>, after: Pick<ValidationState, 'diagnostics'>): string[] {
  const was = errorCounts(before);
  return [...errorCounts(after)].filter(([key, n]) => n > (was.get(key) ?? 0)).map(([key]) => key);
}
