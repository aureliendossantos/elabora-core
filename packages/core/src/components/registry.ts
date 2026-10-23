import { getSchema, derefSchema, BLOCK_TYPES, isBuiltinBlockType, SCHEMA_VERSION } from '@elabora/format';
import type { BuiltinBlockType } from '@elabora/format';
import { parseTemplate, analyzeTemplate } from './template.ts';
import type { ParsedTemplate, TemplateAnalysis } from './template.ts';
import { BUILTIN_TEMPLATES } from './builtin-templates.generated.ts';
import { canonicalJSON, sha256 } from '../util/json.ts';
import { objectsIn } from '../util/values.ts';
import type { Project, ComponentSource, ComponentManifest, ComponentSlot, ComponentExample, ComponentOrigin, FallbackEntry, JsonSchema } from '../project/model.ts';
import { isPredict } from '../charts/predict.ts';
import corePackage from '../../package.json' with { type: 'json' };

// One model for every block type: the native catalogue is a set of built-in components, and a
// course adds its own in components/<id>/ (component.json, template.html, component.css,
// migrations.mjs). A component may extend another (a fork remembers its parent), and screen-level
// components are the layouts of screens.
//
// Built-in components rendered by a template can be forked: the fork keeps the behaviour of its
// root (quiz, numeric, decision, dialogue, results: scoring, saved state, SCORM records and keyboard handling
// stay in the player) and replaces the markup. Video, audio and free objects are rendered by code.

const VERSION = corePackage.version;

export type Behavior = 'quiz' | 'numeric' | 'decision' | 'dialogue' | 'results' | 'object' | 'chart';

export const BUILTINS: Readonly<Record<string, { title: string; render: 'template' | 'code'; behavior?: Behavior }>> = {
  heading: { title: 'Heading', render: 'template' },
  text: { title: 'Text', render: 'template' },
  image: { title: 'Image', render: 'template' },
  video: { title: 'Video', render: 'code' },
  audio: { title: 'Audio', render: 'code' },
  callout: { title: 'Callout', render: 'template' },
  button: { title: 'Button', render: 'template' },
  accordion: { title: 'Accordion', render: 'template' },
  math: { title: 'Equation', render: 'template' },
  quiz: { title: 'Choice question', render: 'template', behavior: 'quiz' },
  numeric: { title: 'Numeric question', render: 'template', behavior: 'numeric' },
  decision: { title: 'Decision', render: 'template', behavior: 'decision' },
  // A branching conversation (D61): its walk is pure (@elabora/player dialogue/), the player renders it.
  dialogue: { title: 'Dialogue', render: 'template', behavior: 'dialogue' },
  'free-object': { title: 'Free object', render: 'code', behavior: 'object' },
  results: { title: 'Results', render: 'template', behavior: 'results' },
  stack: { title: 'Stack', render: 'template' },
  // Charts and diagrams (D60): drawn by the core when the course is built (charts/), moved by the player.
  'key-figures': { title: 'Key figures', render: 'code', behavior: 'chart' },
  bars: { title: 'Bars', render: 'code', behavior: 'chart' },
  donut: { title: 'Part of a whole', render: 'code', behavior: 'chart' },
  trend: { title: 'Trend', render: 'code', behavior: 'chart' },
  proportion: { title: 'Proportion', render: 'code', behavior: 'chart' },
  'before-after': { title: 'Before and after', render: 'code', behavior: 'chart' },
  levels: { title: 'Funnel or pyramid', render: 'code', behavior: 'chart' },
  process: { title: 'Process', render: 'code', behavior: 'chart' },
  cycle: { title: 'Cycle', render: 'code', behavior: 'chart' },
  matrix: { title: '2 × 2 matrix', render: 'code', behavior: 'chart' },
  milestones: { title: 'Milestones', render: 'code', behavior: 'chart' },
  diagram: { title: 'Diagram', render: 'code', behavior: 'chart' }
};

export interface BehaviorHooks {
  required: string[];
  optional?: string[];
  anyOf?: string[];
  each?: Record<string, string>; // hook → list prop it repeats over
  tags?: Record<string, string[]>; // hook → elements it may sit on
}

// Behaviours owned by the player, with the hooks a template must provide (docs/components.md).
export const BEHAVIORS: Readonly<Record<Behavior, BehaviorHooks>> = {
  quiz: { required: ['stem', 'option', 'submit', 'feedback'], optional: ['group', 'input', 'option-feedback', 'flag'], each: { option: 'options' }, tags: { option: ['label'], submit: ['button'], input: ['input'] } },
  numeric: { required: ['stem', 'input', 'submit', 'feedback'], optional: ['group', 'input-label', 'unit', 'expected'], tags: { input: ['input'], submit: ['button'], 'input-label': ['label'] } },
  decision: { required: ['prompt', 'choice', 'feedback'], optional: ['group', 'choice-feedback'], each: { choice: 'options' }, tags: { choice: ['button'] } },
  // The player fills the thread (log) and the options' room; the rest is optional.
  dialogue: { required: ['log', 'options'], optional: ['group', 'stage', 'debrief', 'start'], tags: { start: ['button'] } },
  results: { required: [], anyOf: ['score', 'status', 'message'], optional: ['score', 'status', 'message', 'retry'], tags: { retry: ['button'] } },
  object: { required: [] },
  chart: { required: [] }
};
// Hooks any template may use: click (a button firing the screen event "click"), toggle/part
// (disclosure), tabs/tab/panel (tabs), label (a player label, translated by the course language).
export const PRIMITIVE_HOOKS = ['click', 'toggle', 'part', 'open', 'tabs', 'tab', 'panel', 'selected', 'label'];
export const BUTTON_HOOKS = ['click', 'toggle', 'tab', 'submit', 'choice', 'retry', 'start'];

// A finding made while resolving a component, reported by the validator.
export interface RegistryError {
  code: string;
  file: string;
  path: string;
  message: string;
}

// Effective description of a block type or screen layout: built-in, or a course component with
// what it inherits from its parents.
export interface ComponentDescriptor {
  id: string;
  title: string;
  description: string;
  instructions: string | null;
  category: string;
  version: string;
  level: 'block' | 'screen';
  builtin: boolean;
  render: 'template' | 'code';
  behavior: Behavior | null;
  root: string | null; // the built-in a fork descends from
  parent: string | null;
  extendsVersion?: string | null;
  lineage: string[]; // itself, then its parents
  schema: JsonSchema;
  template: string | null;
  templateFrom: string | null; // the component whose template is used
  tpl: ParsedTemplate | null;
  slots: ComponentSlot[];
  defaultSlot: string | null;
  fallback: FallbackEntry[] | 'self' | 'root' | null;
  styles: Record<string, string>;
  examples: ComponentExample[];
  fullBleed: boolean;
  css: string | null;
  cssChain: string[]; // components whose stylesheet applies, parents first
  origin: ComponentOrigin | null;
  migrations: string | null;
  file: string;
  templateFile: string | null;
  forkable: boolean;
  errors: RegistryError[];
  source?: ComponentSource; // course components: the files
}

export type Registry = Map<string, ComponentDescriptor>;

const builtinCache = new Map<string, ComponentDescriptor>();
function builtinDescriptor(id: BuiltinBlockType): ComponentDescriptor {
  const cached = builtinCache.get(id);
  if (cached) return cached;
  const b = BUILTINS[id];
  const raw = getSchema(`blocks/${id}`);
  const template = b.render === 'template' ? BUILTIN_TEMPLATES[id] : null;
  if (b.render === 'template' && template === undefined) throw new Error(`Built-in template ${id}.html missing: run npm run gen.`);
  // A built-in with slots declares them in its props schema (x-slots), as a component.json does.
  const slots = objectsIn(raw['x-slots'] as ComponentSlot[] | undefined);
  const d: ComponentDescriptor = {
    id, title: b.title, description: String(raw.description ?? ''), instructions: (raw['x-ai-instructions'] as string | undefined) || null, category: (raw['x-category'] as string | undefined) || 'content',
    version: VERSION, level: 'block', builtin: true, render: b.render, behavior: b.behavior || null, root: id, parent: null, lineage: [id],
    schema: derefSchema(raw), template, templateFrom: template ? id : null, tpl: template ? parseTemplate(template) : null,
    slots, defaultSlot: defaultSlotOf(slots), fallback: 'self', styles: {}, examples: [], fullBleed: false, css: null, cssChain: [], origin: null, migrations: null,
    file: `schemas/${SCHEMA_VERSION}/blocks/${id}.schema.json`, templateFile: template ? `src/components/builtin/${id}.html` : null, forkable: b.render === 'template', errors: []
  };
  builtinCache.set(id, d);
  return d;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Deep merge for propsExtend: objects merge, `required` lists unite, other arrays are replaced.
export function mergeSchema(base: unknown, ext: unknown): unknown {
  if (!isObject(ext)) return ext === undefined ? base : ext;
  if (!isObject(base)) return structuredClone(ext);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(ext)) {
    if (k === 'required' && Array.isArray(v)) out.required = [...new Set([...(Array.isArray(base.required) ? base.required : []), ...v])];
    else out[k] = mergeSchema(base[k], v);
  }
  return out;
}

export function defaultSlotOf(slots: readonly ComponentSlot[] | null | undefined): string | null {
  const declared = objectsIn(slots);
  return (declared.find((s) => s.default) || declared[0])?.id || null;
}

// Hash of a component's files, to know whether a copy from a library was edited.
export function componentHash(c: Pick<ComponentSource, 'manifest' | 'template' | 'css' | 'migrations' | 'migrationsSource'>): string {
  const { origin, $schema, ...manifest } = c.manifest || ({} as Partial<ComponentManifest>);
  return `sha256:${sha256(canonicalJSON({ manifest, template: c.template || '', css: c.css || '', migrations: c.migrations ? c.migrationsSource || '' : '' }))}`;
}

// Effective descriptors of every type usable in the course, built-ins first.
export function buildRegistry(project: Pick<Project, 'components'>): Registry {
  const reg: Registry = new Map();
  for (const id of BLOCK_TYPES) reg.set(id, builtinDescriptor(id));
  const comps = project.components || new Map<string, ComponentSource>();
  const resolving = new Set<string>();
  const resolve = (id: string): ComponentDescriptor | null => {
    const known = reg.get(id);
    if (known) return known;
    const c = comps.get(id);
    if (!c?.manifest) return null;
    const m = c.manifest;
    const errors: RegistryError[] = [];
    const file = `components/${id}/component.json`;
    if (resolving.has(id)) { errors.push({ code: 'E_COMPONENT_EXTENDS', file, path: '/extends', message: `Component "${id}" extends itself through its parents.` }); return null; }
    resolving.add(id);
    const parentId = m.extends?.component || null;
    let parent: ComponentDescriptor | null = null;
    if (parentId) {
      parent = isBuiltinBlockType(parentId) ? builtinDescriptor(parentId) : resolve(parentId);
      if (!parent) errors.push({ code: 'E_COMPONENT_EXTENDS', file, path: '/extends/component', message: `Component "${id}" extends "${parentId}", which does not exist.` });
      else if (parent.render === 'code') { errors.push({ code: 'E_COMPONENT_EXTENDS', file, path: '/extends/component', message: `"${parentId}" is rendered by code and cannot be forked: place it in a slot of your component instead.` }); parent = null; }
    }
    resolving.delete(id);
    let schema = (m.props ? derefSchema(m.props) : parent ? parent.schema : { type: 'object', properties: {} }) as JsonSchema;
    if (m.propsExtend) schema = mergeSchema(schema, derefSchema(m.propsExtend)) as JsonSchema;
    if (schema && !schema.type) schema = { type: 'object', ...schema };
    const template = c.template ?? parent?.template ?? null;
    const level = m.level || parent?.level || 'block';
    // Own slots, styles and examples that are not lists or records fail the schema: read as none.
    const slots = m.slots ? objectsIn(m.slots) : parent?.slots || [];
    const d: ComponentDescriptor = {
      id, title: m.title || id, description: m.description || '', instructions: m.instructions || null, category: m.category || parent?.category || 'content',
      version: m.version || '0.0.0', level, builtin: false, render: 'template',
      behavior: parent?.behavior || null, root: parent?.root || null, parent: parent?.id || null, extendsVersion: m.extends?.version || null,
      lineage: [id, ...(parent?.lineage || [])],
      schema, template, templateFrom: c.template != null ? id : parent?.templateFrom || null, tpl: template != null ? parseTemplate(template) : null,
      slots, defaultSlot: defaultSlotOf(slots),
      fallback: m.fallback !== undefined ? m.fallback : parent && !parent.builtin ? parent.fallback : parent ? 'root' : null,
      styles: { ...(parent?.styles || {}), ...(isObject(m.styles) ? m.styles : {}) },
      examples: objectsIn(m.examples), fullBleed: !!(m.fullBleed ?? parent?.fullBleed), css: c.css, cssChain: [...(parent?.cssChain || []), ...(c.css ? [id] : [])],
      origin: m.origin || null, migrations: c.migrations, file, templateFile: c.template != null ? `components/${id}/template.html` : parent?.templateFile || null,
      forkable: true, errors, source: c
    };
    reg.set(id, d);
    return d;
  };
  for (const id of comps.keys()) {
    if (isBuiltinBlockType(id)) continue; // reported by the validator (reserved name)
    resolve(id);
  }
  return reg;
}

// Keyed by the components a project loaded, which is all a registry reads: a project derived from
// another without touching its components (an engine replacing one edited screen) keeps the
// registry, and with it the analyses of its templates.
const registries = new WeakMap<object, Registry>();
export function getRegistry(project: Pick<Project, 'components'>): Registry {
  const key: object = project.components ?? project;
  let reg = registries.get(key);
  if (!reg) { reg = buildRegistry(project); registries.set(key, reg); }
  return reg;
}

// Effective named styles of a type: the component's own (and its parents'), then the theme's for
// the type and for its parents (styles of callout apply to a fork of callout).
export function stylesOf(project: Pick<Project, 'components' | 'course'>, type: string): Record<string, string> {
  const d = getRegistry(project).get(type);
  const theme = project.course?.theme?.styles || {};
  const out: Record<string, string> = { ...(d?.styles || {}) };
  for (const id of [...(d?.lineage || [type])].reverse()) Object.assign(out, theme[id] || {});
  return out;
}

// Static analysis of a component's template (cached): bindings, hooks, slots, literal text.
const analyses = new WeakMap<ComponentDescriptor, TemplateAnalysis>();
export function analysisOf(d: ComponentDescriptor | null | undefined): TemplateAnalysis | null {
  if (!d?.tpl) return null;
  let a = analyses.get(d);
  if (!a) { a = analyzeTemplate(d.tpl, d.schema); analyses.set(d, a); }
  return a;
}
// Hooks of a component's template (click, toggle, submit…).
export function hooksOf(d: ComponentDescriptor | null | undefined): Set<string> {
  return new Set((analysisOf(d)?.hooks || []).map((h) => h.hook));
}

export const rootOf = (reg: Registry | null | undefined, type: string): string | null => reg?.get(type)?.root ?? (isBuiltinBlockType(type) ? type : null);
export const behaviorOf = (reg: Registry | null | undefined, type: string): Behavior | null => reg?.get(type)?.behavior ?? BUILTINS[type]?.behavior ?? null;
// A block's behaviour as its instance has it: a trend in predict mode is an activity (D60).
export function instanceBehavior(reg: Registry | null | undefined, block: { type: string; props?: unknown }): Behavior | 'predict' | null {
  const behavior = behaviorOf(reg, block.type);
  const props = block.props && typeof block.props === 'object' && !Array.isArray(block.props) ? block.props as Record<string, unknown> : null;
  return behavior === 'chart' && isPredict(rootOf(reg, block.type), props) ? 'predict' : behavior;
}
