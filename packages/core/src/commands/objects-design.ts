import type { ObjectManifest, Project } from '../project/model.ts';
import { screenOrder } from '../project/load.ts';
import { parseJSON, stringifyJSON } from '../util/json.ts';
import { isRecord } from '../util/values.ts';
import { fieldOf } from '@elabora/player/json';
import { CommandError, Draft, type CommandContext, type CommandOutput } from './context.ts';

export const OBJECT_FILES = ['object.manifest.json', 'object.js', 'object.tests.json', 'object.notes.md'] as const;
export type ObjectFile = (typeof OBJECT_FILES)[number];

// The object template (templates/object/ in @elabora/node), with __ID__ and __TITLE__ to replace.
export type ObjectTemplates = Readonly<Record<ObjectFile, string>>;

export interface CreateObjectArgs {
  id: string;
  title?: string;
  objectives?: string[];
  items?: string[];
  // A decoration of the course backdrop (theme.backdrop.object): no plan references, no events.
  decoration?: boolean;
}

export function createObject(context: CommandContext, { id, title, objectives, items, decoration = false }: CreateObjectArgs, templates: ObjectTemplates): CommandOutput<{ object: string; files: string[] }> {
  const draft = new Draft(context.files);
  if (draft.exists(`objects/${id}/object.manifest.json`)) throw new CommandError(`objects/${id} already exists`);
  if (decoration && (objectives?.length || items?.length)) throw new CommandError('A decoration serves no plan objective: give --decoration or --objectives, not both.');
  if (!decoration && !objectives?.length) throw new CommandError('A free object serves plan objectives: give them (--objectives OBJ-1,OBJ-2, the ids in plan.json), or --decoration for a decoration of the course backdrop (theme.backdrop.object).');
  for (const file of OBJECT_FILES) {
    let content = templates[file].replaceAll('__ID__', id).replaceAll('__TITLE__', title || id);
    if (file === 'object.tests.json' && decoration) content = decorationTests(content, context.project());
    if (file === 'object.manifest.json' && !decoration) {
      const manifest = JSON.parse(content) as ObjectManifest;
      manifest.planRefs = { objectives: objectives || [], ...(items?.length ? { items } : {}) };
      content = stringifyJSON(manifest);
    }
    draft.writeText(`objects/${id}/${file}`, content);
  }
  return { files: draft.files(), result: { object: id, files: OBJECT_FILES.map((f) => `objects/${id}/${f}`) } };
}

// A decoration's tests walk the course's own screens: its first, then one in a later part (the
// template's names its own example screens).
function decorationTests(content: string, project: Project): string {
  const order = screenOrder(project).filter((entry) => project.screens.has(entry.id));
  const parsed = parseJSON(content).value;
  const test = isRecord(parsed) && Array.isArray(parsed.tests) && isRecord(parsed.tests[0]) ? parsed.tests[0] : null;
  if (order.length < 2 || !test || !Array.isArray(test.steps)) return content;
  const sections = [...new Set(order.map((entry) => entry.section).filter((id) => !!id))];
  const first = order[0];
  const later = order.find((entry) => entry.section && entry.section !== first.section) ?? order[order.length - 1];
  const at = (entry: (typeof order)[number], direction: 'forward' | null) => ({
    screen: entry.id, section: entry.section || null, step: 1, variant: null, screenIndex: order.indexOf(entry), screenCount: order.length,
    sectionIndex: entry.section ? sections.indexOf(entry.section) : null, sectionCount: sections.length, direction
  });
  test.context = at(first, null);
  let now = at(first, null);
  for (const step of test.steps) {
    if (!isRecord(step)) continue;
    if (step.action === 'set-context') step.context = now = at(later, 'forward');
    else if (step.action === 'expect-state') step.state = { screenIndex: now.screenIndex, sectionIndex: now.sectionIndex };
  }
  return stringifyJSON(parsed);
}

export interface WriteObjectFileArgs {
  object: string;
  file: string;
  content: string;
}

export function writeObjectFile(context: CommandContext, { object, file, content }: WriteObjectFileArgs): CommandOutput<Record<string, never>> {
  if (!(OBJECT_FILES as readonly string[]).includes(file)) throw new CommandError(`file must be one of ${OBJECT_FILES.join(', ')}`);
  const draft = new Draft(context.files);
  const manifestPath = `objects/${object}/object.manifest.json`;
  if (!draft.exists(manifestPath) && file !== 'object.manifest.json') throw new CommandError(`objects/${object} does not exist: create_object first`);
  if (file === 'object.manifest.json') {
    const next = parseJSON(content);
    if (next.error !== undefined) throw new CommandError(`object.manifest.json is not valid JSON: ${next.error}`);
    const current = draft.text(manifestPath);
    // The plan references of a free object belong to the contract (guardrail A5). A manifest that does
    // not parse as an object has none to keep.
    const before = current === null ? null : parseJSON(current).value;
    if (isRecord(before) && JSON.stringify(before.planRefs) !== JSON.stringify(fieldOf(next.value, 'planRefs'))) {
      throw new CommandError('planRefs of a free object belong to the contract: propose the change with propose_plan_change instead (guardrail A5).');
    }
  }
  draft.writeText(`objects/${object}/${file}`, content);
  return { files: draft.files(), result: {} };
}

// Design files written by agents: theme stylesheets and asset generators (fonts and other binary
// files are copied as files, not through this tool). Components have their own tools.
const DESIGN_FILE = /^(theme\/[A-Za-z0-9._/-]+\.css|generators\/[A-Za-z0-9._-]+\.(mjs|js))$/;

export function writeDesignFile(context: CommandContext, { file, content }: { file: string; content: string }): CommandOutput<Record<string, never>> {
  if (!DESIGN_FILE.test(file || '') || file.includes('..')) throw new CommandError('file must be theme/<name>.css or generators/<name>.mjs (component files: write_component_file)');
  const draft = new Draft(context.files);
  draft.writeText(file, content);
  return { files: draft.files(), result: {} };
}
