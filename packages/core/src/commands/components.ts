import { isBuiltinType, schemaId } from '@elabora/format';
import type { ComponentManifest, ComponentSlot, ComponentSource, Project, Screen } from '../project/model.ts';
import type { ProjectFiles, SourceFile } from '../project/files.ts';
import { getFile, pathsUnder } from '../project/files.ts';
import { getRegistry, componentHash, type ComponentDescriptor } from '../components/registry.ts';
import { pendingMigrations, type MigrationSteps, type PendingMigrations } from '../components/migrate.ts';
import { readLock, isStateLock, LOCK_FILE, type StateLock } from '../compile/state-model.ts';
import { planIndex, resolveBlockProps, screenBlocks } from '../project/load.ts';
import { propsValidator } from '../validate/components.ts';
import { parseJSON, stringifyJSON } from '../util/json.ts';
import { isRecord } from '../util/values.ts';
import { CommandError, Draft, type CommandContext, type CommandDiagnostic, type CommandOutput } from './context.ts';

export const COMPONENT_FILES = ['component.json', 'template.html', 'component.css', 'migrations.mjs'] as const;
const SLUG = /^[a-z][a-z0-9-]{0,47}$/;
const SCHEMA = schemaId('component');

// A component id: a slug that is not a built-in type.
export function checkComponentId(id: string | undefined): void {
  if (!SLUG.test(id || '')) throw new CommandError('id: lowercase letters, digits and hyphens, starting with a letter');
  if (isBuiltinType(id)) throw new CommandError(`"${id}" is a built-in type`);
}

type Created = CommandOutput<{ component: string; files: string[] }>;
const createdFiles = (id: string) => ['component.json', 'template.html', 'component.css'].map((f) => `components/${id}/${f}`);

export interface CreateComponentArgs {
  id: string;
  title?: string;
  level?: 'block' | 'screen';
  description?: string;
  props?: ComponentManifest['props'];
  slots?: ComponentSlot[];
  template?: string;
  css?: string;
}

// A new component: block type (level block) or screen layout (level screen).
export function createComponent(context: CommandContext, args: CreateComponentArgs): Created {
  const { id, title, level = 'block', description, props, slots, template, css } = args;
  checkComponentId(id);
  const draft = new Draft(context.files);
  if (draft.exists(`components/${id}/component.json`)) throw new CommandError(`components/${id} already exists`);
  const manifest = {
    $schema: SCHEMA, id, title: title || id, ...(description ? { description } : {}), version: '1.0.0', level,
    props: props || { type: 'object', properties: {} }, ...(slots ? { slots } : level === 'screen' ? { slots: [{ id: 'body', label: 'Content', default: true }] } : {})
  };
  draft.writeText(`components/${id}/component.json`, stringifyJSON(manifest));
  draft.writeText(`components/${id}/template.html`, template ?? (level === 'screen' ? '<div class="__ID__">\n  <div data-title></div>\n  <div data-slot="body"></div>\n</div>\n' : '<div class="__ID__"></div>\n').replaceAll('__ID__', id));
  draft.writeText(`components/${id}/component.css`, css ?? `/* Component "${id}" — cascade layer elabora.components. Scope rules with [data-component~="${id}"] or .t-block--${id}${level === 'screen' ? ` (screens: .t-layout--${id})` : ''}. */\n`);
  return { files: draft.files(), result: { component: id, files: createdFiles(id) } };
}

export interface ForkComponentArgs {
  component: string;
  id: string;
  title?: string;
  copyCss?: boolean;
}

// A fork: a new component that remembers its parent. The template is copied so it can change;
// props, slots, styles and fallback are inherited until the fork declares its own; the parent's
// stylesheet still applies (instances carry the parent's classes).
export function forkComponent(context: CommandContext, { component, id, title, copyCss = false }: ForkComponentArgs): Created {
  checkComponentId(id);
  const parent = getRegistry(context.project()).get(component);
  if (!parent) throw new CommandError(`No component "${component}"`);
  if (parent.render === 'code') throw new CommandError(`"${component}" is rendered by code and cannot be forked: place it in a slot of a component instead.`);
  const draft = new Draft(context.files);
  if (draft.exists(`components/${id}/component.json`)) throw new CommandError(`components/${id} already exists`);
  const manifest = {
    // The parent's description, said to be a fork's: the fork's author rewrites it with what changes.
    $schema: SCHEMA, id, title: title || `${parent.title} (fork)`, ...(parent.description ? { description: `A fork of ${component}. ${parent.description}` } : {}), version: '1.0.0',
    ...(parent.level === 'screen' ? { level: 'screen' } : {}), extends: { component, version: parent.version }
  };
  draft.writeText(`components/${id}/component.json`, stringifyJSON(manifest));
  draft.writeText(`components/${id}/template.html`, parent.template || '');
  // A screen layout's instances are screens (.t-layout--<id>), a block's are blocks (.t-block--<id>).
  const scope = parent.level === 'screen' ? 't-layout' : 't-block';
  draft.writeText(`components/${id}/component.css`, copyCss && parent.css ? parent.css : `/* Fork of "${component}": its stylesheet still applies (instances carry .${scope}--${component}). Add or override rules here, scoped with .${scope}--${id}. */\n`);
  return { files: draft.files(), result: { component: id, files: createdFiles(id) } };
}

export interface WriteComponentFileArgs {
  component: string;
  file: string;
  content: string;
}

export function writeComponentFile(context: CommandContext, { component, file, content }: WriteComponentFileArgs): CommandOutput<Record<string, never>> {
  if (!(COMPONENT_FILES as readonly string[]).includes(file)) throw new CommandError(`file must be one of ${COMPONENT_FILES.join(', ')}`);
  checkComponentId(component);
  const draft = new Draft(context.files);
  if (file !== 'component.json' && !draft.exists(`components/${component}/component.json`)) throw new CommandError(`components/${component} does not exist: create_component or fork_component first`);
  draft.writeText(`components/${component}/${file}`, content);
  return { files: draft.files(), result: {} };
}

// ── migrations ───────────────────────────────────────────────────────

export interface MigrateComponentsArgs {
  component?: string;
  from?: string; // the version the instances are at, when elabora.lock.json does not know it
}

export interface MigrationPlan {
  descriptor: ComponentDescriptor;
  steps: PendingMigrations;
}

// The components whose instances have migration steps to run.
export function migrationPlans(project: Project, { component, from }: MigrateComponentsArgs = {}): MigrationPlan[] {
  const lock = readLock(project);
  const plans: MigrationPlan[] = [];
  for (const descriptor of getRegistry(project).values()) {
    if (descriptor.builtin || (component && descriptor.id !== component)) continue;
    const steps = pendingMigrations(project, descriptor, lock, component ? from : undefined);
    if (steps.length) plans.push({ descriptor, steps });
  }
  return plans;
}

export interface MigrationSummary {
  migrated: string[];
  components: { id: string; from: string | null; to: string; steps: string[] }[];
}

// Runs the pending steps on every instance (and layout props), checks the results against the new
// schema and writes them with elabora.lock.json in one change; nothing is written if one fails.
// functions: the steps of each component's migrations.mjs (imported by @elabora/node).
export function migrateComponents(context: CommandContext, args: MigrateComponentsArgs, functions: ReadonlyMap<string, MigrationSteps>): CommandOutput<MigrationSummary> {
  const project = context.project();
  const plans = migrationPlans(project, args);
  const registry = getRegistry(project);
  const index = planIndex(project.plan);
  const draft = new Draft(context.files);
  const problems: CommandDiagnostic[] = [];
  const migrated: string[] = [];
  for (const [screenId, { file, data }] of project.screens) {
    const screen = structuredClone(data);
    let touched = false;
    for (const { descriptor, steps } of plans) {
      const stepFunctions = functions.get(descriptor.id) ?? {};
      const run = (props: Record<string, unknown> | undefined, scope: { id: string; screen: string }) => steps.reduce<Record<string, unknown>>((current, step) => {
        const fn = stepFunctions[step.version];
        if (typeof fn !== 'function') throw new Error(`migrations.mjs has no function for ${step.version}`);
        const out = fn(structuredClone(current), scope);
        if (!out || typeof out !== 'object') throw new Error(`step ${step.version} returned no props object`);
        return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
      }, props || {});
      const validator = propsValidator(descriptor);
      const check = (props: Record<string, unknown>, where: string) => {
        const resolved = descriptor.level === 'screen' ? props : resolveBlockProps({ type: descriptor.id, props }, index, registry);
        if (validator.error === undefined && !validator(resolved)) {
          const details = (validator.errors || []).map((e) => `${e.instancePath || 'props'} ${e.message}`).join('; ');
          problems.push({ code: 'E_COMPONENT_PROPS', severity: 'error', file, path: where, message: `${descriptor.id} after migration: ${details}` });
        }
      };
      try {
        if (screen.layout === descriptor.id) {
          screen.layoutProps = run(screen.layoutProps, { id: screenId, screen: screenId });
          check(screen.layoutProps, '/layoutProps');
          touched = true;
          migrated.push(`${screenId} (layout)`);
        }
        for (const location of screenBlocks(screen, file)) {
          if (location.block.type !== descriptor.id) continue;
          location.block.props = run(location.block.props, { id: location.block.id, screen: screenId });
          check(location.block.props, `${location.path}/props`);
          touched = true;
          migrated.push(location.block.id);
        }
      } catch (error) {
        problems.push({ code: 'E_COMPONENT_MIGRATION_PENDING', severity: 'error', file: `components/${descriptor.id}/migrations.mjs`, message: `${descriptor.id}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (touched) draft.writeJson(file, screen as Screen);
  }
  if (problems.length) throw new CommandError('Migration refused: some instances do not match the new schema (nothing was written)', problems);
  if (plans.length) {
    const lockText = draft.text(LOCK_FILE);
    let lock: StateLock = { format: 'elabora-lock/1', next: 0, keys: {} };
    if (lockText) {
      // The lock holds learner state keys: a lock that does not read is not overwritten.
      const parsed = parseJSON(lockText).value;
      if (!isStateLock(parsed)) throw new CommandError(`${LOCK_FILE} is not a state lock (it does not parse, or has no keys): restore it from a backup or version control first.`);
      lock = parsed;
    }
    lock.components = isRecord(lock.components) ? lock.components : {};
    for (const { descriptor } of plans) lock.components[descriptor.id] = descriptor.version;
    draft.writeJson(LOCK_FILE, lock);
  }
  return {
    files: draft.files(),
    result: { migrated, components: plans.map(({ descriptor, steps }) => ({ id: descriptor.id, from: steps.from, to: descriptor.version, steps: steps.map((s) => s.version) })) }
  };
}

// ── libraries ────────────────────────────────────────────────────────
// A library is a folder shared by several courses (a client's design system): library.json
// ({ id, title }) and components/<id>/. A course never links to it at run time: it copies a
// component (pinned, with origin and hash), upgrades it explicitly, and can publish its own.

// A component of a library: its files, by path inside its folder (component.json, template.html…).
export interface LibraryComponent {
  library: string; // the library's id
  component: string;
  files: ProjectFiles;
}

export interface AddLibraryComponentArgs {
  component: string;
  as?: string;
  upgrade?: boolean;
  force?: boolean; // upgrade over local edits
}

// Copies a library component into the course (or over an older copy: upgrade).
export function addLibraryComponent(context: CommandContext, args: AddLibraryComponentArgs, source: LibraryComponent): CommandOutput<{ component: string; from: string | null; to: string; library: string }> {
  const { component, as, upgrade = false, force = false } = args;
  const manifestText = getFile(source.files, 'component.json');
  if (manifestText?.kind !== 'text') throw new CommandError(`Library ${source.library} has no component "${component}"`);
  const id = as || component;
  checkComponentId(id);
  const existing = context.project().components.get(id);
  if (existing && !upgrade) throw new CommandError(`components/${id} already exists: upgrade it, or add the library version under another id (as).`);
  if (upgrade && !existing) throw new CommandError(`components/${id} does not exist: add it first.`);
  if (upgrade && existing?.manifest?.origin && componentHash(existing) !== existing.manifest.origin.hash && !force) {
    throw new CommandError(`components/${id} was edited since it was copied from ${existing.manifest.origin.library}: publish or fork your changes first, or upgrade with force to discard them.`);
  }
  const names = [...source.files.keys()].sort();
  const parsed = parseJSON(manifestText.text);
  if (!isRecord(parsed.value)) throw new CommandError(`components/${component}/component.json of library ${source.library} is not a JSON object.`);
  const manifest = parsed.value as ComponentManifest;
  delete manifest.origin;
  manifest.id = id;
  const folder = `components/${id}`;
  const draft = new Draft(context.files);
  if (existing?.manifest) for (const path of pathsUnder(context.files, folder)) if (!names.includes(path.slice(folder.length + 1))) draft.remove(path);
  for (const name of names) if (name !== 'component.json') draft.writeFile(`${folder}/${name}`, source.files.get(name) as SourceFile);
  const copy: Pick<ComponentSource, 'manifest' | 'template' | 'css' | 'migrations' | 'migrationsSource'> = {
    manifest, template: draft.text(`${folder}/template.html`), css: draft.text(`${folder}/component.css`),
    migrations: names.includes('migrations.mjs') ? 'migrations.mjs' : null, migrationsSource: draft.text(`${folder}/migrations.mjs`)
  };
  const withOrigin = { ...manifest, origin: { library: source.library, component, version: manifest.version, hash: componentHash(copy) } };
  draft.writeText(`${folder}/component.json`, stringifyJSON(withOrigin));
  return { files: draft.files(), result: { component: id, from: existing?.manifest?.version || null, to: manifest.version, library: source.library } };
}

// After a course component was copied into a library (by @elabora/node): the course records the
// library as its origin, with the hash of what was published.
export function publishComponent(context: CommandContext, { component, library }: { component: string; library: string }): CommandOutput<{ component: string; library: string; version: string }> {
  const source = context.project().components.get(component);
  if (!source?.manifest) throw new CommandError(`No component "${component}" in components/`);
  const draft = new Draft(context.files);
  const manifest = source.manifest;
  draft.writeText(`components/${component}/component.json`, stringifyJSON({ ...manifest, origin: { library, component, version: manifest.version, hash: componentHash(source) } }));
  return { files: draft.files(), result: { component, library, version: manifest.version } };
}
