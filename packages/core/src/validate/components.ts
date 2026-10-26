import { validateSchema, compileInline, BLOCK_TYPES, isBuiltinBlockType, isBuiltinLayoutType } from '@elabora/format';
import type { ValidateFunction, ErrorObject } from '@elabora/format';
import { getRegistry, analysisOf, stylesOf, componentHash, BEHAVIORS, PRIMITIVE_HOOKS, LAYOUT_HOOKS, BUTTON_HOOKS, PRIMITIVE_TAGS } from '../components/registry.ts';
import type { ComponentDescriptor } from '../components/registry.ts';
import type { TemplateHook } from '../components/template.ts';
import { CONTROL_NAME, NAMED_CONTROL_HOOKS } from '../components/controls.ts';
import { kindOf, renderTemplate } from '../components/template.ts';
import { walkHeadings } from '../components/headings.ts';
import type { SchemaNode } from '../components/template.ts';
import { applyDefaults, valuesOfKind } from '../components/props.ts';
import { fallbackBlocks, fallbackLosses } from '../components/fallback.ts';
import { resolveBlockProps, resolveTextRefs, readingOrder, screenBlocks } from '../project/load.ts';
import type { Block, ComponentSlot, ComponentSource, JsonSchema } from '../project/model.ts';
import { tokenNames } from './theme.ts';
import { checkMarkdown, checkAsset } from './blocks.ts';
import { checkCss } from './design.ts';
import { mathErrors } from '../compile/markdown.ts';
import { readLock } from '../compile/state-model.ts';
import { pendingMigrations } from '../components/migrate.ts';
import { labelKeys } from '@elabora/player/labels';
import type { CheckContext, CourseCheckContext, ScreenFile } from './context.ts';
import { isRecord, list, hasId, entriesOf } from './guards.ts';

// Components: definitions (manifest, props schema, template, CSS, fallback, examples, lineage,
// library origin, migrations), screen layouts, and every instance (props, slots, fallback).

const FORBIDDEN_TAGS = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'form', 'select', 'textarea', 'option', 'canvas', 'dialog', 'template', 'slot', 'video', 'audio', 'source', 'track', 'a', 'area', 'map', 'noscript', 'portal', 'math']);
const KINDS = new Set(['text', 'markdown', 'tex', 'asset', 'token']);
const TEXT_ATTRS = ['aria-label', 'title', 'alt', 'placeholder', 'aria-description', 'aria-roledescription'];
const STYLE_DECL = /^\s*(--[a-z0-9-]+\s*:\s*\{\{[^{}]+\}\}\s*;?\s*)*$/i;
const XHTML = 'http://www.w3.org/1999/xhtml';
const LABEL_KEYS = new Set(labelKeys());

// The compiled props schema of a component, or why it does not compile.
export type PropsValidator = (ValidateFunction & { error?: undefined }) | { error: string };

const validators = new WeakMap<ComponentDescriptor, PropsValidator>();
export function propsValidator(component: ComponentDescriptor): PropsValidator {
  let validator = validators.get(component);
  if (!validator) {
    try { validator = compileInline(withoutAnnotations(component.schema)); } catch (error) { validator = { error: error instanceof Error ? error.message : String(error) }; }
    validators.set(component, validator);
  }
  return validator;
}

// A schema without its x-* annotations, for ajv.
function withoutAnnotations(schema: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) if (!key.startsWith('x-')) out[key] = annotationsRemoved(value);
  return out;
}
const annotationsRemoved = (value: unknown): unknown => (Array.isArray(value) ? value.map(annotationsRemoved) : isRecord(value) ? withoutAnnotations(value) : value);

const ajvErrors = (validate: ValidateFunction) => (validate.errors || []).filter((e: ErrorObject) => e.keyword !== 'if').map((e: ErrorObject) => ({ path: e.instancePath, message: e.keyword === 'additionalProperties' ? `unknown property "${e.params.additionalProperty}"` : e.keyword === 'enum' ? `must be one of ${JSON.stringify(e.params.allowedValues)}` : e.message }));

// Props of an instance against its component's schema (none when the schema does not compile:
// the definition reports it).
function propsErrors(component: ComponentDescriptor, props: unknown): { path: string; message: string | undefined }[] {
  const validate = propsValidator(component);
  if (validate.error !== undefined || validate(props)) return [];
  return ajvErrors(validate);
}

// Definitions of the course components (components/<id>/).
export function checkComponents(ctx: CourseCheckContext): void {
  const { project, reporter, registry } = ctx;
  for (const source of project.components.values()) {
    const file = `components/${source.id}/component.json`;
    if (isBuiltinBlockType(source.id) || isBuiltinLayoutType(source.id)) { reporter.emit('E_COMPONENT_ID', { file, target: source.id, message: `"${source.id}" is a built-in ${isBuiltinLayoutType(source.id) ? 'screen layout' : 'type'}: fork it under another id (extends: { component: "${source.id}" }).` }); continue; }
    if (!source.manifest) continue;
    for (const error of validateSchema('component', source.manifest)) reporter.emit('E_SCHEMA', { file, path: error.path, target: source.id, message: `${error.path || '/'}: ${error.message} (schema component)` });
    if (source.manifest.id && source.manifest.id !== source.id) reporter.emit('E_COMPONENT_ID', { file, path: '/id', target: source.id, message: `Component id "${source.manifest.id}" differs from its folder "${source.id}".` });
    const component = registry.get(source.id);
    if (!component) continue;
    for (const error of component.errors) reporter.emit(error.code, { file: error.file, path: error.path, message: error.message, target: source.id });
    checkDefinition(ctx, component, source);
  }
}

function checkDefinition(ctx: CourseCheckContext, component: ComponentDescriptor, source: ComponentSource): void {
  const { project, reporter } = ctx;
  const manifest = source.manifest;
  if (!manifest) return;
  const file = component.file;
  const id = component.id;
  // Props schema.
  if (component.schema?.type !== 'object') reporter.emit('E_COMPONENT_SCHEMA', { file, path: '/props', target: id, message: 'props must be a JSON Schema of type object.' });
  const validator = propsValidator(component);
  if (validator.error) reporter.emit('E_COMPONENT_SCHEMA', { file, path: manifest.propsExtend ? '/propsExtend' : '/props', target: id, message: `The props schema does not compile: ${validator.error}` });
  const walkKinds = (schema: unknown, path: string): void => {
    if (!isRecord(schema)) return;
    if (schema['x-kind'] && !hasId(KINDS, schema['x-kind'])) reporter.emit('E_COMPONENT_SCHEMA', { file, path, target: id, message: `x-kind "${schema['x-kind']}" is not one of ${[...KINDS].join(', ')}.` });
    for (const [key, property] of entriesOf(schema.properties || {})) walkKinds(property, `${path}/properties/${key}`);
    if (schema.items) walkKinds(schema.items, `${path}/items`);
  };
  walkKinds(component.schema, '/props');
  if (manifest.extends && manifest.props && component.behavior) reporter.emit('E_COMPONENT_SCHEMA', { file, path: '/props', target: id, message: `A fork of ${component.root} keeps the props of ${component.root}: use propsExtend to add props instead of replacing them.` });
  if (manifest.propsExtend && !manifest.extends) reporter.emit('E_COMPONENT_SCHEMA', { file, path: '/propsExtend', target: id, message: 'propsExtend is for forks: without extends, declare props.' });
  if (component.level === 'screen' && component.behavior) reporter.emit('E_COMPONENT_LEVEL', { file, path: '/level', target: id, message: 'A screen layout cannot fork an activity.' });

  // Template.
  if (!component.tpl) reporter.emit('E_FILE_MISSING', { file: `components/${id}/template.html`, target: id, message: `components/${id}/template.html not found${component.parent ? ` (and ${component.parent} has none)` : ''}.` });
  else checkTemplate(ctx, component, { own: source.template != null });

  // Stylesheet.
  if (source.css != null) checkCss(ctx, source.css, `components/${id}/component.css`);

  // Fallback templates: native types, known slots.
  if (Array.isArray(manifest.fallback)) {
    const slotIds = new Set(component.slots.map((slot) => slot?.id));
    manifest.fallback.forEach((entry, i) => {
      if (entry?.$slot !== undefined) { if (!hasId(slotIds, entry.$slot)) reporter.emit('E_COMPONENT_FALLBACK', { file, path: `/fallback/${i}/$slot`, target: id, message: `Fallback refers to slot "${entry.$slot}", which is not declared.` }); return; }
      if (!isBuiltinBlockType(entry?.type)) reporter.emit('E_COMPONENT_FALLBACK', { file, path: `/fallback/${i}/type`, target: id, message: `Fallback item ${i} must use a built-in type (${BLOCK_TYPES.join(', ')}), not ${JSON.stringify(entry?.type)}.` });
    });
  }

  // Examples are checked like instances.
  list(manifest.examples).forEach((example, i) => {
    if (example === null || example === undefined) return;
    const block: Block = { id: `${id}-example-${i + 1}`, type: id, props: example.props || {}, ...(example.blocks ? { blocks: example.blocks } : {}) };
    const errors = propsErrors(component, resolveBlockProps(block, ctx.planIndex, ctx.registry));
    for (const error of errors.slice(0, 5)) reporter.emit('E_COMPONENT_EXAMPLE', { file, path: `/examples/${i}/props${error.path}`, target: id, message: `Example ${i + 1}${example.title ? ` (${example.title})` : ''}: ${error.message}.` });
  });

  // Lineage and library origin.
  if (component.parent && manifest.extends?.version) {
    const parent = ctx.registry.get(component.parent);
    if (parent && parent.version !== manifest.extends.version) reporter.emit('I_COMPONENT_PARENT_CHANGED', { file, path: '/extends/version', target: id, message: `${id} was forked from ${component.parent} ${manifest.extends.version}; ${component.parent} is now ${parent.version}.` });
  }
  if (manifest.origin && componentHash(source) !== manifest.origin.hash) reporter.emit('W_COMPONENT_DIVERGED', { file, path: '/origin', target: id, message: `${id} was copied from library "${manifest.origin.library}" (${manifest.origin.component} ${manifest.origin.version}) and has been edited since.` });

  // Migrations the instances have not been through.
  const pending = pendingMigrations(project, component, readLock(project));
  if (pending.length) reporter.emit('E_COMPONENT_MIGRATION_PENDING', { file, target: id, message: `${id} ${component.version}: instances are still at ${pending.from}; migration step(s) ${pending.map((step) => step.version).join(', ')} to run.` });
}

// The template of a component: bindings, allowed markup, behaviour hooks, slots, literal text.
export function checkTemplate(ctx: Pick<CheckContext, 'project' | 'reporter'>, component: ComponentDescriptor, { own = true }: { own?: boolean } = {}): void {
  const { reporter } = ctx;
  const analysis = analysisOf(component);
  if (!analysis) return;
  const id = component.id;
  const templateFile = component.templateFile || `components/${id}/template.html`;
  const at = (line: number | null | undefined) => (line ? `line ${line}` : undefined);
  const report = (code: string, line: number | null | undefined, message: string) => reporter.emit(code, { file: templateFile, path: at(line), target: id, message });
  const behavior = component.behavior ? BEHAVIORS[component.behavior] : null;
  const allowedHooks = new Set([...PRIMITIVE_HOOKS, ...(component.level === 'screen' ? LAYOUT_HOOKS : []), ...(behavior ? [...behavior.required, ...behavior.optional || []] : [])]);

  for (const unknown of analysis.unknown) report('E_COMPONENT_TEMPLATE', unknown.line, 'error' in unknown && unknown.error ? `${unknown.where}: ${unknown.error}.` : `{{${unknown.path}}}${unknown.where === 'data-if' ? ' in data-if' : ''} is not a prop of ${id} (props: ${Object.keys(component.schema?.properties || {}).join(', ') || 'none'}).`);
  for (const each of analysis.badEach) report('E_COMPONENT_TEMPLATE', each.line, `data-each="${each.path}" needs a list prop.`);
  for (const binding of analysis.refs) {
    if (binding.where === 'attr' && binding.attr === 'class' && binding.kind !== null && ['markdown', 'asset', 'tex'].includes(binding.kind)) report('E_COMPONENT_TEMPLATE', binding.line, `class binds {{${binding.path}}} (${binding.kind}): bind enums, numbers or booleans in class.`);
    if (binding.kind === 'token' && !(binding.where === 'attr' && binding.attr === 'style')) report('E_COMPONENT_TEMPLATE', binding.line, `Token prop {{${binding.path}}} is a CSS value: use it in style="--name: {{${binding.path}}}".`);
  }
  for (const element of analysis.elements) {
    const { tag, attrs, line } = element;
    if (element.ns !== XHTML) {
      if (tag === 'svg' && !element.inSvg && attrs['aria-hidden'] !== 'true' && !(attrs.role === 'img' && /\{\{/.test(attrs['aria-label'] || ''))) report('W_COMPONENT_DECORATION', line, 'An <svg> without aria-hidden="true" (decoration) or role="img" with a bound aria-label.');
      if (tag === 'foreignObject') report('E_COMPONENT_TEMPLATE', line, '<foreignObject> is not allowed in templates.');
    }
    if (FORBIDDEN_TAGS.has(tag) && element.ns === XHTML) report('E_COMPONENT_TEMPLATE', line, `<${tag}> is not allowed in a component template${tag === 'a' ? ': links belong in Markdown props' : tag === 'video' || tag === 'audio' ? ': place a video or audio block in a slot' : ''}.`);
    if (tag === 'h1') report('E_COMPONENT_TEMPLATE', line, '<h1> is the screen title: use h2–h4 in components.');
    const hooks = Object.keys(attrs).filter((name) => name.startsWith('data-t-')).map((name) => name.slice(7));
    if (tag === 'button' && !hooks.some((hook) => BUTTON_HOOKS.includes(hook))) report('E_COMPONENT_TEMPLATE', line, `<button> needs a behaviour hook (${BUTTON_HOOKS.map((hook) => `data-t-${hook}`).join(', ')}).`);
    if (tag === 'input' && !(hooks.includes('input') && (component.behavior === 'quiz' || component.behavior === 'numeric'))) report('E_COMPONENT_TEMPLATE', line, '<input> only with data-t-input, in forks of quiz or numeric.');
    if (tag === 'label' && !hooks.some((hook) => hook === 'option' || hook === 'input-label')) report('E_COMPONENT_TEMPLATE', line, '<label> only with data-t-option (quiz) or data-t-input-label (numeric).');
    if (tag === 'img') {
      const src = attrs.src || '';
      const match = /^\s*\{\{\s*([^{}|]+?)\s*\}\}\s*$/.exec(src);
      const binding = match && analysis.refs.find((ref) => ref.where === 'attr' && ref.attr === 'src' && ref.line === line && ref.path === match[1].trim());
      if (!match || (binding && binding.kind !== 'asset')) report('E_COMPONENT_TEMPLATE', line, '<img src> must be a single binding to an asset prop (x-kind "asset").');
      if (attrs.alt === undefined) report('E_COMPONENT_TEMPLATE', line, '<img> needs alt: bound to a text prop, or alt="" when the image is decorative.');
    }
    for (const [name, value] of Object.entries(attrs)) {
      if (/^on/i.test(name)) report('E_COMPONENT_TEMPLATE', line, `Event handler attribute ${name} is not allowed.`);
      if (/^(href|xlink:href|src|srcset|action|formaction|poster|data|background|ping)$/i.test(name) && !(tag === 'img' && name === 'src') && !String(value).startsWith('#')) report('E_COMPONENT_TEMPLATE', line, `${name}="${String(value).slice(0, 40)}": templates only point to fragments (#id) of their own SVG.`);
      if (/javascript:|url\(\s*['"]?(https?:)?\/\//i.test(value)) report('E_COMPONENT_TEMPLATE', line, 'External or script URL in the template.');
      if (name === 'style' && !STYLE_DECL.test(value)) report('E_COMPONENT_TEMPLATE', line, `style="${value.slice(0, 50)}": only custom properties bound to props (style="--accent: {{accent}}") are allowed; write the rest in component.css.`);
      if (name === 'id' && !/\{\{\s*@id\s*\}\}/.test(value)) report('W_COMPONENT_ID_ATTR', line, `id="${value}" repeats when ${id} is used twice: write id="${value}-{{@id}}".`);
      if (TEXT_ATTRS.includes(name) && /\p{L}{2,}/u.test(String(value).replace(/\{\{[^}]+\}\}/g, ''))) report('W_COMPONENT_TEXT', line, `${name}="${value.slice(0, 40)}": bind it to a prop.`);
    }
    for (const hook of hooks) {
      // data-t-heading: a heading that follows the page (components/headings.ts), on h2 to h6.
      if (hook === 'heading') { if (!/^h[2-6]$/.test(tag)) report('E_COMPONENT_HOOK', line, `data-t-heading goes on a heading (<h2> to <h6>), not <${tag}>.`); continue; }
      if (!allowedHooks.has(hook)) report('E_COMPONENT_HOOK', line, `data-t-${hook} is ${LAYOUT_HOOKS.includes(hook) ? 'a hook of screen layouts (level "screen")' : Object.values(BEHAVIORS).some((other) => other.required.includes(hook) || other.optional?.includes(hook)) ? `a hook of another behaviour than ${component.behavior || 'none'} (${id}${component.behavior ? ` forks ${component.root}` : ' has no behaviour'})` : 'not a known hook'}.`);
      const tags = behavior?.tags?.[hook] ?? PRIMITIVE_TAGS[hook];
      if (tags && !tags.includes(tag)) report('E_COMPONENT_HOOK', line, `data-t-${hook} goes on <${tags.join('> or <')}>, not <${tag}>.`);
      const value = attrs[`data-t-${hook}`];
      const named = (NAMED_CONTROL_HOOKS as readonly string[]).includes(hook) || hook === 'card';
      if (named && !value.trim()) report('E_COMPONENT_HOOK', line, `data-t-${hook} needs a name (data-t-${hook}="{{id}}" in data-each, or a literal name): its visited state is saved under it.`);
      else if ((hook === 'click' || named) && value && !value.includes('{{') && !CONTROL_NAME.test(value)) report('E_COMPONENT_HOOK', line, `data-t-${hook}="${value}": a name is lowercase letters, digits, "-", "_" or "." (48 at most), starting with a letter or digit.`);
    }
  }
  for (const literal of analysis.texts) report('W_COMPONENT_TEXT', literal.line, `${component.level === 'screen' ? 'Layout' : 'Component'} "${id}" contains text: "${literal.text.slice(0, 60)}".`);

  // Behaviour contract.
  if (behavior) {
    const present = new Map<string, typeof analysis.hooks>();
    for (const hook of analysis.hooks) { if (!present.has(hook.hook)) present.set(hook.hook, []); present.get(hook.hook)?.push(hook); }
    for (const hook of behavior.required) if (!present.has(hook)) report('E_COMPONENT_HOOK', null, `${id} keeps the ${component.behavior} behaviour of ${component.root}: its template needs data-t-${hook}.`);
    if (behavior.anyOf && !behavior.anyOf.some((hook) => present.has(hook))) report('E_COMPONENT_HOOK', null, `${id} needs at least one of ${behavior.anyOf.map((hook) => `data-t-${hook}`).join(', ')}.`);
    for (const [hook, listProp] of Object.entries(behavior.each || {})) {
      for (const found of present.get(hook) || []) {
        if (found.each !== listProp) report('E_COMPONENT_HOOK', found.line, `data-t-${hook} must be repeated with data-each="${listProp}" (one per option).`);
        if (!/^\s*\{\{\s*id\s*\}\}\s*$/.test(found.value)) report('E_COMPONENT_HOOK', found.line, `data-t-${hook}="{{id}}": the hook carries the option id.`);
      }
    }
    for (const hook of ['submit', 'feedback', 'stem', 'prompt', 'group', 'text', 'response', 'bank', 'pool']) {
      const found = present.get(hook) || [];
      if (found.length > 1 || found.some((x) => x.inEach)) report('E_COMPONENT_HOOK', found[1]?.line || found[0]?.line, `data-t-${hook} appears once, outside data-each.`);
    }
    for (const found of present.get('input') || []) {
      if (component.behavior === 'quiz' && !found.within.includes('option')) report('E_COMPONENT_HOOK', found.line, 'data-t-input goes inside the data-t-option element.');
    }
    // A sort's target holds the button that places there and, optionally, where its items go.
    for (const found of [...(present.get('place') || []), ...(present.get('zone') || [])]) {
      if (component.behavior === 'sort' && !found.within.includes('sort-target')) report('E_COMPONENT_HOOK', found.line, `data-t-${found.hook} goes inside the data-t-sort-target element.`);
    }
    if (component.behavior === 'sort' && present.has('sort-target') && !present.has('place')) report('E_COMPONENT_HOOK', null, `${id} keeps the sort behaviour: each data-t-sort-target needs a <button data-t-place> inside.`);
    for (const found of [...(present.get('option-feedback') || []), ...(present.get('flag') || [])]) {
      const beside = found.each === 'options' && /^\s*\{\{\s*id\s*\}\}\s*$/.test(found.value || '');
      if (component.behavior === 'quiz' && !found.within.includes('option') && !beside) report('E_COMPONENT_HOOK', found.line, `data-t-${found.hook} goes inside the data-t-option element, or next to it as data-t-${found.hook}="{{id}}" in the same data-each="options".`);
    }
  }
  // Primitives.
  // data-t-bleed asks for the whole width from the block's root: on an element at the top of the template.
  const roots = new Set((component.tpl?.root.childNodes || []).map((node) => node.sourceCodeLocation?.startLine));
  for (const hook of analysis.hooks.filter((x) => x.hook === 'bleed')) if (hook.within.length || !roots.has(hook.line)) report('E_COMPONENT_HOOK', hook.line, 'data-t-bleed goes on a root element of the template (the block goes edge to edge).');
  for (const hook of analysis.hooks.filter((x) => x.hook === 'compare-label')) if (!hook.within.includes('compare')) report('E_COMPONENT_HOOK', hook.line, 'data-t-compare-label goes inside a data-t-compare element.');
  const parts = new Set(analysis.hooks.filter((hook) => hook.hook === 'part').map((hook) => hook.value));
  for (const hook of analysis.hooks.filter((x) => x.hook === 'toggle')) if (!parts.has(hook.value)) report('E_COMPONENT_HOOK', hook.line, `data-t-toggle="${hook.value}" has no data-t-part="${hook.value}".`);
  const panels = new Set(analysis.hooks.filter((hook) => hook.hook === 'panel').map((hook) => hook.value));
  for (const hook of analysis.hooks.filter((x) => x.hook === 'tab')) {
    if (!hook.within.includes('tabs')) report('E_COMPONENT_HOOK', hook.line, 'data-t-tab goes inside a data-t-tabs element.');
    if (!panels.has(hook.value)) report('E_COMPONENT_HOOK', hook.line, `data-t-tab="${hook.value}" has no data-t-panel="${hook.value}".`);
  }
  checkPrimitives(analysis.hooks, report);
  for (const hook of analysis.hooks.filter((x) => x.hook === 'label')) {
    if (!LABEL_KEYS.has(hook.value)) report('E_COMPONENT_HOOK', hook.line, `data-t-label="${hook.value}" is not a player label (${[...LABEL_KEYS].slice(0, 12).join(', ')}…).`);
  }

  // Slots and title.
  const declared = component.slots.map((slot) => slot?.id);
  const inTemplate = analysis.slots.map((slot) => slot.id);
  for (const slotId of declared) if (!inTemplate.some((placed) => placed === slotId)) report('E_COMPONENT_SLOT', null, `Slot "${slotId}" is declared but has no data-slot="${slotId}" element.`);
  for (const slot of analysis.slots) {
    if (!declared.includes(slot.id)) report('E_COMPONENT_SLOT', slot.line, `data-slot="${slot.id}" is not declared in component.json slots.`);
    if (!slot.empty) report('E_COMPONENT_SLOT', slot.line, `data-slot="${slot.id}" must be empty: blocks are placed inside it.`);
    if (slot.conditional || slot.inEach) report('E_COMPONENT_SLOT', slot.line, `data-slot="${slot.id}" cannot be inside data-if or data-each.`);
  }
  for (const slotId of new Set(inTemplate.filter((x, i) => inTemplate.indexOf(x) !== i))) report('E_COMPONENT_SLOT', null, `data-slot="${slotId}" appears more than once.`);
  if ((component.slots || []).filter((slot) => slot?.default).length > 1) reporter.emit('E_COMPONENT_SLOT', { file: component.file, path: '/slots', target: id, message: `${id} marks several default slots.` });
  if (component.level === 'screen' && analysis.titles > 1) report('E_COMPONENT_SLOT', null, 'More than one data-title element.');
  if (component.level === 'block' && analysis.titles) report('E_COMPONENT_SLOT', null, 'data-title is for screen layouts (level "screen").');

  // Props neither bound nor used by the fallback.
  if (own && !component.builtin) {
    const fallback = JSON.stringify(component.source?.manifest?.fallback || '');
    const rootProps = new Set(Object.keys(getRegistry(ctx.project).get(component.root ?? '')?.schema?.properties || {}));
    for (const prop of Object.keys(component.schema?.properties || {})) {
      if (analysis.usedProps.has(prop) || fallback.includes(prop) || (component.behavior && component.root && rootProps.has(prop))) continue;
      reporter.emit('W_COMPONENT_PROP_UNUSED', { file: component.file, path: `/props/properties/${prop}`, target: id, message: `Prop "${prop}" of ${id} is not used by the template${component.source?.manifest?.fallback ? ' or the fallback' : ''}.` });
    }
  }
}

// A block whose type is a course component (or a fork of a built-in): props, kinds, slots, fallback.
export function checkInstance(ctx: CheckContext, block: Block, component: ComponentDescriptor, path: string, file: string): void {
  const { reporter, planIndex, registry } = ctx;
  if (component.level === 'screen') { reporter.emit('E_COMPONENT_LEVEL', { file, path: `${path}/type`, target: block.id, message: `${component.id} is a screen layout: use it as screen layout, not as a block.` }); return; }
  const resolved = resolveBlockProps(block, planIndex, registry);
  for (const error of propsErrors(component, resolved).slice(0, 8)) reporter.emit('E_COMPONENT_PROPS', { file, path: `${path}/props${error.path}`, target: block.id, message: `${component.id} "${block.id}": ${error.path || 'props'} ${error.message}.` });
  checkKinds(ctx, component.schema, resolved, file, `${path}/props`, block.id);
  if (!component.builtin && component.root == null) {
    // Fallback: valid native blocks, carrying the text of the instance.
    const own: Block = { ...block, blocks: undefined };
    let fallback: Block[] = [];
    try { fallback = fallbackBlocks(registry, own, { resolve: (b) => resolveBlockProps(b, planIndex, registry) }); } catch (error) { reporter.emit('E_COMPONENT_FALLBACK', { file, path, target: block.id, message: `Fallback of ${component.id} failed: ${error instanceof Error ? error.message : String(error)}` }); }
    for (const native of fallback) {
      for (const error of validateSchema('block', native).slice(0, 3)) reporter.emit('E_COMPONENT_FALLBACK', { file: component.file, path: '/fallback', target: block.id, message: `Fallback of "${block.id}" gives an invalid ${native.type} block: ${error.path || '/'} ${error.message}.` });
    }
    const lost = fallbackLosses(registry, block, resolved, fallback.map((native) => resolveBlockProps(native, planIndex, registry)));
    if (lost.length) reporter.emit('W_COMPONENT_FALLBACK_LOSS', { file, path: `${path}/props`, target: block.id, message: `The fallback of ${component.id} drops: "${lost.slice(0, 3).map((t) => t.slice(0, 40)).join('", "')}".` });
  }
}

// Values of a component's props by kind: assets exist, tokens are known, Markdown and TeX parse.
export function checkKinds(ctx: CheckContext, schema: SchemaNode, value: unknown, file: string, base: string, target: string): void {
  const { reporter } = ctx;
  const tokens: readonly unknown[] = tokenNames(ctx.course);
  for (const found of valuesOfKind(schema, value, ['asset', 'token', 'markdown', 'tex'])) {
    const path = `${base}${found.path}`;
    if (found.kind === 'asset') checkAsset(ctx, found.value, file, path, target);
    else if (found.kind === 'token') {
      const prefix = isRecord(found.schema) ? found.schema['x-token-prefix'] : undefined;
      if (!tokens.includes(found.value)) reporter.emit('E_UNKNOWN_REFERENCE', { file, path, target, message: `Token "${found.value}" does not exist (known: ${tokens.join(', ')}).` });
      else if (prefix && !String(found.value).startsWith(String(prefix))) reporter.emit('E_COMPONENT_PROPS', { file, path, target, message: `Token "${found.value}" must start with ${prefix}.` });
    } else if (found.kind === 'markdown') checkMarkdown(ctx, found.value, file, path, target);
    else if (found.kind === 'tex') for (const error of mathErrors(found.value, { tex: true })) reporter.emit('E_MATH_PARSE', { file, path, target, message: `${target}: ${error.message.trim()}` });
  }
}

interface SlotHolder {
  holder: string; // id of the screen, layer or component instance
  component: ComponentDescriptor | null;
  blocks: Block[] | undefined;
  file: string;
  base: string;
  kind: 'screen' | 'layer' | 'block';
}

// Slots of a holder (screen layout or component instance) and the blocks placed in them.
export function checkSlots(ctx: CheckContext, { holder, component, blocks, file, base, kind }: SlotHolder): void {
  const { reporter, registry } = ctx;
  // Keyed by what the manifest holds (an id that is not a string fails the schema).
  const slots = new Map<unknown, ComponentSlot>((component?.slots || []).map((slot) => [slot?.id, slot]));
  const count = new Map<unknown, number>();
  list(blocks).forEach((block, i) => {
    if (block === null || block === undefined) return;
    const path = `${base}/${i}`;
    if (!component || !slots.size) {
      if (block.slot) reporter.emit('E_COMPONENT_SLOT', { file, path: `${path}/slot`, target: block.id, message: kind === 'screen' ? `Block "${block.id}" has slot "${block.slot}" but screen "${holder}" has no layout.` : kind === 'layer' ? `Blocks of layers stack in the dialog: remove slot from "${block.id}".` : `Block "${block.id}" has slot "${block.slot}" but ${component?.id || 'its parent'} has no slots.` });
      return;
    }
    const slotId = block.slot || component.defaultSlot;
    const slot = slots.get(slotId);
    if (!slot) { reporter.emit('E_COMPONENT_SLOT', { file, path: `${path}/slot`, target: block.id, message: `${component.level === 'screen' ? 'Layout' : 'Component'} "${component.id}" has no slot "${block.slot}" (slots: ${[...slots.keys()].join(', ')}).` }); return; }
    const lineage = registry.get(block.type)?.lineage || [block.type];
    // A list of types; anything else (a schema error) restricts nothing.
    const accepts = Array.isArray(slot.accepts) ? slot.accepts : null;
    if (accepts && !lineage.some((type) => accepts.includes(type))) reporter.emit('E_COMPONENT_SLOT', { file, path: `${path}/slot`, target: block.id, message: `Slot "${slotId}" of ${component.id} accepts ${accepts.join(', ')}, not ${block.type}.` });
    count.set(slotId, (count.get(slotId) || 0) + 1);
  });
  for (const [slotId, n] of count) {
    const max = slots.get(slotId)?.maxBlocks;
    if (max && n > max) reporter.emit('E_COMPONENT_SLOT', { file, path: base, target: holder, message: `Slot "${slotId}" of ${component?.id} holds ${n} blocks; it allows ${max}.` });
  }
}

// A screen and its components: style, layout and layout props, slots (also inside component
// instances), block styles.
export function checkScreenComponents(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { project, reporter, planIndex, registry } = ctx;
  const { id: screenId, file, data } = screen;
  const screenStyles = ctx.course.theme?.styles?.screen || {};
  if (data.style && !screenStyles[data.style]) reporter.emit('E_UNKNOWN_REFERENCE', { file, path: '/style', target: screenId, message: `Screen style "${data.style}" is not declared in course.json theme.styles.screen.` });
  let layout: ComponentDescriptor | null = null;
  if (data.layout) {
    layout = registry.get(data.layout) ?? null;
    if (!layout) reporter.emit('E_UNKNOWN_REFERENCE', { file, path: '/layout', target: screenId, message: `Layout "${data.layout}" not found: it must be a built-in layout or a screen-level component in components/ (${[...registry.values()].filter((x) => x.level === 'screen').map((x) => x.id).join(', ')}).` });
    else if (layout.level !== 'screen') { reporter.emit('E_COMPONENT_LEVEL', { file, path: '/layout', target: screenId, message: `${layout.id} is a block component, not a screen layout (level "screen").` }); layout = null; }
  }
  if (data.layoutProps && !layout) reporter.emit('E_COMPONENT_PROPS', { file, path: '/layoutProps', target: screenId, message: 'layoutProps without a layout.' });
  if (layout) {
    const props = resolveTextRefs(data.layoutProps || {}, planIndex);
    for (const error of propsErrors(layout, props).slice(0, 8)) reporter.emit('E_COMPONENT_PROPS', { file, path: `/layoutProps${error.path}`, target: screenId, message: `Layout ${layout.id}: ${error.path || 'props'} ${error.message}.` });
    checkKinds(ctx, layout.schema, props, file, '/layoutProps', screenId);
    // A built-in layout's picture is named like an image block's (opening, D63).
    const shown = isRecord(props) ? props : {};
    if (layout.root === 'opening' && shown.image && shown.decorative !== true && !(typeof shown.alt === 'string' && shown.alt.trim())) reporter.emit('E_IMAGE_ALT_MISSING', { file, path: '/layoutProps/alt', target: screenId, message: `The picture of the opening of screen "${screenId}" has no alt text and is not marked decorative.` });
    if (layout.root === 'opening' && shown.generated === true) reporter.emit('I_GENERATED_MEDIA', { file, path: '/layoutProps', target: screenId, message: `The opening of screen "${screenId}" shows an AI-generated picture.` });
  }
  checkSlots(ctx, { holder: screenId, component: layout, blocks: data.blocks, file, base: '/blocks', kind: 'screen' });
  list(data.layers).forEach((layer, i) => { if (layer !== null && layer !== undefined) checkSlots(ctx, { holder: layer.id, component: null, blocks: layer.blocks, file, base: `/layers/${i}/blocks`, kind: 'layer' }); });
  for (const { block, path } of screenBlocks(data, file)) {
    if (block === null || block === undefined) continue;
    const component = registry.get(block.type);
    if (!component) continue;
    if (block.style && !stylesOf(project, block.type)[block.style]) reporter.emit('E_UNKNOWN_REFERENCE', { file, path: `${path}/style`, target: block.id, message: `Style "${block.style}" is not declared for ${block.type} (theme.styles.${block.type}${component.builtin ? '' : ` or the styles of ${component.id}`}).` });
    if (block.blocks) {
      if (!component.slots.length) reporter.emit('E_COMPONENT_SLOT', { file, path: `${path}/blocks`, target: block.id, message: `${block.type} has no slots: it cannot hold blocks.` });
      else checkSlots(ctx, { holder: block.id, component, blocks: block.blocks, file, base: `${path}/blocks`, kind: 'block' });
    }
  }
}

// Named styles of course.json are declared for a type that exists.
export function checkThemeStyles(ctx: CourseCheckContext): void {
  for (const kind of Object.keys(ctx.course.theme?.styles || {})) {
    if (kind !== 'screen' && !ctx.registry.has(kind)) ctx.reporter.emit('E_SCHEMA', { file: 'course.json', path: `/theme/styles/${kind}`, message: `theme.styles.${kind}: no built-in type or component "${kind}".` });
  }
}

// Course components that no screen uses, or only one block.
export function checkComponentUsage(ctx: CourseCheckContext): void {
  const { reporter, registry } = ctx;
  const uses = new Map<string, number>();
  const count = (type: string) => uses.set(type, (uses.get(type) || 0) + 1);
  for (const { data } of ctx.screens.values()) {
    if (data.layout) count(data.layout);
    for (const { block } of screenBlocks(data)) if (block !== null && block !== undefined) for (const type of registry.get(block.type)?.lineage || []) count(type);
  }
  for (const component of registry.values()) {
    if (component.builtin) continue;
    const n = uses.get(component.id) || 0;
    if (!n) reporter.emit('W_COMPONENT_UNUSED', { file: component.file, target: component.id, message: `Component "${component.id}" is not used by any screen${[...registry.values()].some((x) => x.parent === component.id) ? ' (only through its forks)' : ''}.` });
    else if (n === 1 && component.level === 'block') reporter.emit('I_COMPONENT_SINGLE_USE', { file: component.file, target: component.id, message: `Component "${component.id}" is used once.` });
  }
}

// Heading levels of a list of blocks in reading order, through templates and slots (relative
// headings of templates follow the page: components/headings.ts).
export function headingSequence(ctx: Pick<CheckContext, 'registry' | 'planIndex'>, blocks: Block[] | undefined, holder: ComponentDescriptor | null): { level: number; block: Block }[] {
  return walkHeadings(ctx.registry, ctx.planIndex, blocks, holder).headings;
}

export { kindOf };

// The primitives of D63: what each hook needs around it and inside it (docs/components.md §3).
function checkPrimitives(hooks: readonly TemplateHook[], report: (code: string, line: number | null | undefined, message: string) => void): void {
  const of = (name: string) => hooks.filter((hook) => hook.hook === name);
  const holds = (hook: TemplateHook, name: string, value?: string) => hook.inner.hooks.some((inner) => inner.hook === name && (value === undefined || inner.value === value));
  const bound = (value: string) => value.includes('{{');
  // One item at a time: items, Previous and Next inside the sequence.
  for (const sequence of of('sequence')) {
    const missing = ['item', 'prev', 'next'].filter((name) => !holds(sequence, name));
    if (missing.length) report('E_COMPONENT_HOOK', sequence.line, `data-t-sequence needs ${missing.map((name) => (name === 'item' ? 'data-t-item elements' : `a data-t-${name} button`)).join(', ')} inside it.`);
    if (holds(sequence, 'sequence')) report('E_COMPONENT_HOOK', sequence.line, 'data-t-sequence holds another data-t-sequence: one item at a time cannot nest (place the inner one in its own component, in a slot).');
  }
  for (const name of ['item', 'prev', 'next', 'goto', 'position']) {
    for (const hook of of(name)) if (!hook.within.includes('sequence')) report('E_COMPONENT_HOOK', hook.line, `data-t-${name} goes inside a data-t-sequence element.`);
  }
  const items = of('item');
  if (!items.some((item) => bound(item.value))) {
    const names = new Set(items.map((item) => item.value));
    for (const goto of of('goto')) if (!bound(goto.value) && !names.has(goto.value)) report('E_COMPONENT_HOOK', goto.line, `data-t-goto="${goto.value}" names no data-t-item (items: ${[...names].join(', ') || 'none'}).`);
  }
  // A flip card: its two faces inside it, a button that flips it.
  const flips = of('flip');
  for (const card of of('card')) {
    const faces = ['front', 'back'].filter((face) => !holds(card, 'face', face));
    if (faces.length) report('E_COMPONENT_HOOK', card.line, `data-t-card needs ${faces.map((face) => `a data-t-face="${face}"`).join(' and ')} inside it.`);
    if (!flips.some((flip) => flip.value === card.value)) report('E_COMPONENT_HOOK', card.line, `data-t-card="${card.value}" has no data-t-flip="${card.value}" button.`);
  }
  for (const face of of('face')) {
    if (face.value !== 'front' && face.value !== 'back') report('E_COMPONENT_HOOK', face.line, `data-t-face is "front" or "back", not "${face.value}".`);
    if (!face.within.includes('card')) report('E_COMPONENT_HOOK', face.line, 'data-t-face goes inside a data-t-card element.');
  }
  const cards = new Set(of('card').map((card) => card.value));
  for (const flip of flips) if (!cards.has(flip.value)) report('E_COMPONENT_HOOK', flip.line, `data-t-flip="${flip.value}" names no data-t-card.`);
  // The lightbox: a button holding the image it enlarges, a caption with it.
  for (const zoom of of('zoom')) if (!zoom.inner.tags.includes('img')) report('E_COMPONENT_HOOK', zoom.line, 'data-t-zoom goes on a button that holds the <img> it enlarges.');
  if (of('caption').length && !of('zoom').length) report('E_COMPONENT_HOOK', of('caption')[0].line, 'data-t-caption is the caption of a data-t-zoom image: inside the zoom button or next to it.');
  // One part open at a time: disclosures inside.
  for (const exclusive of of('exclusive')) {
    if (exclusive.value !== '' && exclusive.value !== 'popover') report('E_COMPONENT_HOOK', exclusive.line, `data-t-exclusive is empty or "popover", not "${exclusive.value}".`);
    if (!holds(exclusive, 'toggle')) report('E_COMPONENT_HOOK', exclusive.line, 'data-t-exclusive holds the data-t-toggle buttons of the parts it keeps one at a time.');
  }
  // Reveals followed as the page scrolls (a steps block's scroll): the reveals inside, not nested.
  for (const follow of of('follow')) {
    if (!holds(follow, 'reveal')) report('E_COMPONENT_HOOK', follow.line, 'data-t-follow holds the data-t-reveal elements it follows (the steps).');
    if (holds(follow, 'follow')) report('E_COMPONENT_HOOK', follow.line, 'data-t-follow holds another data-t-follow: one figure follows one list of steps.');
  }
}
