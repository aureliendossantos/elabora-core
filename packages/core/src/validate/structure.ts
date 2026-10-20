import { parseJSON, pointer } from '../util/json.ts';
import { screenBlocks } from '../project/load.ts';
import { validateSchema } from '@elabora/format/schemas';
import type { SchemaName } from '@elabora/format';
import { labelKeys, labelLanguages } from '@elabora/player/labels';
import type { Variable } from '../project/model.ts';
import type { CheckContext, CourseCheckContext, ScreenFile } from './context.ts';
import { list } from './guards.ts';
import { PLAN_NOTES_FILE, planContentHash, versionLabel } from '../project/plan-versions.ts';
import { readText } from '../project/files.ts';
import { isRecord } from '../util/values.ts';

// Files, ordering and identifier uniqueness.

// Problems found while loading the files: JSON syntax, missing files, copies left by sync services.
export function reportLoadErrors(ctx: CheckContext): void {
  for (const error of ctx.project.loadErrors) ctx.reporter.emit(error.code, { file: error.file, message: error.message });
}

function reportSchemaErrors(ctx: CheckContext, name: SchemaName, data: unknown, file: string, skip: (path: string) => boolean = () => false): void {
  for (const error of validateSchema(name, data)) {
    if (skip(error.path)) continue;
    ctx.reporter.emit('E_SCHEMA', { file, path: error.path, message: `${error.path || '/'}: ${error.message} (schema ${name})` });
  }
}

// Settings of the player that moved into course.json player on 19 October 2026 (D58): said where they
// went, rather than as properties the schema does not know.
const MOVED: Readonly<Record<string, string>> = {
  showMenu: 'the outline is the player item "outline": showMenu false is { "id": "outline", "enabled": false }',
  showProgress: 'the progress bar is the player item "progress": showProgress false is { "id": "progress", "enabled": false }',
  footer: 'where Previous and Next are is the bottom bar\'s position: footer "end" is player.bottom.position "page"'
};
function reportMovedSettings(ctx: CheckContext, course: Record<string, unknown>): Set<string> {
  const paths = new Set<string>();
  const navigation = isRecord(course.navigation) ? course.navigation : {};
  for (const [key, where] of Object.entries(MOVED)) {
    if (!(key in navigation)) continue;
    paths.add('/navigation');
    ctx.reporter.emit('E_PLAYER_SETTING_MOVED', { file: 'course.json', path: `/navigation/${key}`, message: `navigation.${key} moved into course.json player: ${where} (elabora player . sets it).` });
  }
  if (isRecord(course.narration) && course.narration.seek === 'none') {
    paths.add('/narration/seek');
    ctx.reporter.emit('E_PLAYER_SETTING_MOVED', { file: 'course.json', path: '/narration/seek', message: 'narration.seek "none" moved into course.json player: the controls item\'s option seekBar false hides the seek bar for every screen (elabora player . --set controls.seekBar=false); a screen may still say narration.seek "none".' });
  }
  return paths;
}

// Documents against their schemas; screens have their own check (checkScreenSchema).
export function checkDocumentSchemas(ctx: CheckContext): void {
  const { project } = ctx;
  if (project.course) {
    const moved = reportMovedSettings(ctx, project.course as unknown as Record<string, unknown>);
    reportSchemaErrors(ctx, 'course', project.course, 'course.json', (path) => moved.has(path));
  }
  if (project.plan) reportSchemaErrors(ctx, 'plan', project.plan, 'plan.json');
  for (const object of project.objects.values()) {
    if (object.manifest) reportSchemaErrors(ctx, 'object-manifest', object.manifest, `objects/${object.id}/object.manifest.json`);
    if (object.tests) reportSchemaErrors(ctx, 'object-tests', object.tests, `objects/${object.id}/object.tests.json`);
  }
  for (const version of project.planVersions) reportSchemaErrors(ctx, 'plan-version', version.data, version.file);
  // The notes waiting for the next version (a file that does not parse is a load error).
  const notes = readText(project.files, PLAN_NOTES_FILE);
  const parsed = notes === null ? null : parseJSON(notes);
  if (parsed && parsed.error === undefined && isRecord(parsed.value)) reportSchemaErrors(ctx, 'plan-notes', parsed.value, PLAN_NOTES_FILE);
}

export function checkScreenSchema(ctx: CheckContext, screen: ScreenFile): void {
  reportSchemaErrors(ctx, 'screen', screen.data, screen.file);
}

export function checkStructure(ctx: CourseCheckContext): void {
  const { project, course, reporter } = ctx;
  // Player labels: built in for a few languages; elsewhere course.ui must give them all.
  const language = String(course.language || 'en').toLowerCase().split('-')[0];
  if (!labelLanguages().includes(language)) {
    const missing = labelKeys().filter((key) => !(course.ui || {})[key]);
    if (missing.length) reporter.emit('W_UI_LABELS_LANGUAGE', { file: 'course.json', path: '/ui', message: `The player has no labels in ${course.language}: ${missing.length} would show in English (${missing.slice(0, 5).join(', ')}…).` });
  }
  const listed = new Set<string>();
  list(course.sections).forEach((section, sectionIndex) => {
    list(section?.screens).forEach((id, i) => {
      const path = pointer('sections', sectionIndex, 'screens', i);
      if (listed.has(id)) reporter.emit('E_SCREEN_LISTED_TWICE', { file: 'course.json', path, target: id, message: `Screen "${id}" is listed more than once in sections.` });
      else listed.add(id);
      if (!project.screens.has(id)) reporter.emit('E_SCREEN_NOT_FOUND', { file: 'course.json', path, target: id, message: `Screen "${id}" is listed in course.json but screens/${id}.json does not exist.` });
    });
  });

  // Ids are unique across sections, screens, layers, blocks and events, because events,
  // tracking and learner state all address elements by id.
  const seen = new Map<string, { file: string; path: string; kind: string }>();
  const claim = (id: string | undefined, file: string, path: string, kind: string) => {
    if (!id) return;
    const previous = seen.get(id);
    if (previous) reporter.emit('E_DUPLICATE_ID', { file, path, target: id, message: `Id "${id}" (${kind}) is already used by a ${previous.kind} in ${previous.file}${previous.path}.` });
    else seen.set(id, { file, path, kind });
  };
  list(course.sections).forEach((section, i) => claim(section?.id, 'course.json', pointer('sections', i, 'id'), 'section'));
  for (const [id, { file, data }] of ctx.screens) {
    claim(id, file, '/id', 'screen');
    list(data.layers).forEach((layer, i) => claim(layer?.id, file, pointer('layers', i, 'id'), 'layer'));
    for (const { block, path } of screenBlocks(data, file)) claim(block?.id, file, `${path}/id`, 'block');
    list(data.events).forEach((event, i) => claim(event?.id, file, pointer('events', i, 'id'), 'event'));
  }
  const variableIds = new Set<string>();
  list(course.variables).forEach((variable, i) => {
    if (variable === null || variable === undefined) return;
    if (variableIds.has(variable.id)) reporter.emit('E_DUPLICATE_ID', { file: 'course.json', path: pointer('variables', i, 'id'), target: variable.id, message: `Variable "${variable.id}" is declared twice.` });
    variableIds.add(variable.id);
  });

  // Variables: defaults must match their type; strings need maxLength for the budget.
  list(course.variables).forEach((variable, i) => {
    if (variable === null || variable === undefined) return;
    const path = pointer('variables', i);
    if (variable.type === 'string' && !variable.maxLength) reporter.emit('E_VARIABLE_STRING_LENGTH', { file: 'course.json', path, target: variable.id });
    const error = variableValueError(variable, variable.default);
    if (error) reporter.emit('E_VARIABLE_TYPE', { file: 'course.json', path: `${path}/default`, target: variable.id, message: `Default of "${variable.id}": ${error}.` });
    if (variable.type === 'choice' && !((variable.options?.length ?? 0) >= 2)) reporter.emit('E_VARIABLE_TYPE', { file: 'course.json', path, target: variable.id, message: `Choice variable "${variable.id}" needs at least two options.` });
  });
}

// The file of a screen: the id it declares, and whether course.json lists it.
export function checkScreenFile(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { id, file, data } = screen;
  if (data.id && data.id !== id) ctx.reporter.emit('E_SCREEN_ID_MISMATCH', { file, path: '/id', target: data.id, message: `File ${file} declares id "${data.id}".` });
  if (!ctx.screens.has(id)) ctx.reporter.emit('W_SCREEN_FILE_UNUSED', { file, target: id, message: `${file} is not listed in any section of course.json.` });
}

export function variableValueError(variable: Variable, value: unknown): string | null {
  switch (variable.type) {
    case 'boolean': return typeof value === 'boolean' ? null : `expected a boolean, got ${JSON.stringify(value)}`;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `expected a number, got ${JSON.stringify(value)}`;
      if (variable.minimum !== undefined && value < variable.minimum) return `${value} is below minimum ${variable.minimum}`;
      if (variable.maximum !== undefined && value > variable.maximum) return `${value} is above maximum ${variable.maximum}`;
      return null;
    case 'string':
      if (typeof value !== 'string') return `expected a string, got ${JSON.stringify(value)}`;
      if (variable.maxLength && value.length > variable.maxLength) return `longer than maxLength ${variable.maxLength}`;
      return null;
    case 'choice': {
      const options: readonly unknown[] = variable.options || [];
      return options.includes(value) ? null : `expected one of ${JSON.stringify(variable.options || [])}, got ${JSON.stringify(value)}`;
    }
    default: return null;
  }
}

// The plan's versions never change once made (D52): each one's plan gives its content hash, and its
// number is its file name. One that does not hold together is left out of the plan's state (it is
// neither a version sent nor a validated one) until it is brought back.
export function checkPlanVersions(ctx: CheckContext): void {
  for (const { file, number, data } of ctx.project.planVersions) {
    if (typeof data.version === 'number' && data.version !== number) {
      ctx.reporter.emit('E_PLAN_VERSION_INVALID', { file, path: '/version', target: versionLabel(number), message: `${file} says it is ${versionLabel(data.version)}: a version's number is its file name.` });
    }
    if (isRecord(data.plan) && typeof data.contentHash === 'string' && data.contentHash !== planContentHash(data.plan)) {
      ctx.reporter.emit('E_PLAN_VERSION_INVALID', { file, path: '/contentHash', target: versionLabel(number), measured: planContentHash(data.plan), limit: data.contentHash, message: `${versionLabel(number)} was edited after it was made: its plan no longer gives its content hash. It is not counted as a version until it is brought back.` });
    }
  }
}
