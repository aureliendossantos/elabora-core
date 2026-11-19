import { getRegistry, analysisOf, stylesOf, BEHAVIORS, PRIMITIVE_HOOKS } from '@elabora/core/components/registry';
import { pendingMigrations } from '@elabora/core/components/migrate';
import { readLock } from '@elabora/core/compile/state-model';
import { screenBlocks } from '@elabora/core/project/load';
import type { Project } from '@elabora/core/project/model';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { fromCommand, defineTool, editResult, errorResult, imageResult, objectSchema, textResult, SLUG } from './tool.ts';

// Block types: listing and reading them, designing course components, libraries and migrations.

export const listComponents = defineTool({
  name: 'elabora_list_components',
  readOnly: true,
  description: 'Every block type usable in this course: built-in blocks and the course components (components/<id>/), with purpose, category, level (block or screen layout), behaviour, parent of forks, slots, styles and uses. Blocks come before free objects.',
  inputSchema: objectSchema({}),
  handler(_args, { root }) {
    const project = loadProjectFromDir(root);
    const uses = componentUses(project);
    return textResult([...getRegistry(project).values()].map((d) => ({
      type: d.id, title: d.title, builtin: d.builtin, level: d.level, category: d.category, ...(d.behavior ? { behavior: d.behavior } : {}), ...(d.parent ? { extends: d.parent } : {}),
      description: d.description, ...(d.instructions ? { instructions: d.instructions } : {}), required: d.schema?.required || [],
      ...(d.slots.length ? { slots: d.slots.map((s) => s.id) } : {}), ...(Object.keys(stylesOf(project, d.id)).length ? { styles: stylesOf(project, d.id) } : {}),
      ...(d.builtin ? { forkable: d.forkable } : { version: d.version, uses: uses.get(d.id) || 0 })
    })));
  }
});

// How many times each component is used: as a screen layout, as a block, or through its forks.
function componentUses(project: Project): Map<string, number> {
  const registry = getRegistry(project);
  const uses = new Map<string, number>();
  for (const { data } of project.screens.values()) {
    if (data.layout) uses.set(data.layout, (uses.get(data.layout) || 0) + 1);
    for (const { block } of screenBlocks(data)) for (const type of registry.get(block.type)?.lineage || []) uses.set(type, (uses.get(type) || 0) + 1);
  }
  return uses;
}

export const getComponent = defineTool({
  name: 'elabora_get_component',
  readOnly: true,
  description: 'A component (built-in or course): manifest, template, stylesheet, effective props schema, slots, styles, fallback, behaviour hooks it must provide, lineage, instances and pending migrations. Read it before forking or editing one. To change its CSS, template or props: elabora_write_component_file (a built-in: elabora_fork_component first).',
  inputSchema: objectSchema({ id: SLUG }, ['id']),
  handler({ id }, { root }) {
    const project = loadProjectFromDir(root);
    const d = getRegistry(project).get(id);
    if (!d) return errorResult(`No component "${id}"`);
    const instances: string[] = [];
    for (const [screenId, { data, file }] of project.screens) {
      if (data.layout === d.id) instances.push(`${screenId} (layout)`);
      for (const location of screenBlocks(data, file)) if (location.block.type === d.id) instances.push(`${screenId}/${location.block.id}`);
    }
    const behavior = d.behavior ? BEHAVIORS[d.behavior] : null;
    return textResult({
      id: d.id, title: d.title, builtin: d.builtin,
      edit: d.builtin ? `Built-in: fork it (elabora_fork_component), then change the fork with elabora_write_component_file.` : `Change its files with elabora_write_component_file: component.css, template.html, component.json.`, level: d.level, version: d.version, lineage: d.lineage, behavior: d.behavior,
      ...(behavior ? { hooks: { required: behavior.required.map((h) => `data-t-${h}`), optional: (behavior.optional || []).map((h) => `data-t-${h}`) } } : {}),
      primitives: PRIMITIVE_HOOKS.map((h) => `data-t-${h}`),
      manifest: d.source?.manifest || null, template: d.template, templateFile: d.templateFile, css: d.css, schema: d.schema,
      slots: d.slots, styles: stylesOf(project, d.id), fallback: d.fallback, examples: d.examples, origin: d.origin,
      usedProps: [...(analysisOf(d)?.usedProps || [])], instances,
      pendingMigrations: d.builtin ? [] : pendingMigrations(project, d, readLock(project)).map((step) => step.version)
    });
  }
});

export const createComponent = defineTool({
  name: 'elabora_create_component',
  ...fromCommand('create_component'),
  handler: (args, { root, author }) => editResult(edit.run(root, 'create_component', args, { author }))
});

export const forkComponent = defineTool({
  name: 'elabora_fork_component',
  ...fromCommand('fork_component'),
  handler: (args, { root, author }) => editResult(edit.run(root, 'fork_component', args, { author }))
});

export const writeComponentFile = defineTool({
  name: 'elabora_write_component_file',
  ...fromCommand('write_component_file'),
  handler: (args, { root, author }) => editResult(edit.run(root, 'write_component_file', args, { author }))
});

export const migrateComponents = defineTool({
  name: 'elabora_migrate_components',
  ...fromCommand('migrate_components'),
  async handler(args, { root, author }) {
    const result = await edit.run(root, 'migrate_components', args, { author });
    // No component has steps pending: nothing was run.
    return result.components.length ? editResult(result) : textResult({ ok: true, migrated: [], message: 'Nothing to migrate.' });
  }
});

export const addLibraryComponent = defineTool({
  name: 'elabora_add_library_component',
  ...fromCommand('add_component'),
  handler: (args, { root, author }) => editResult(edit.run(root, 'add_component', args, { author }))
});

export const publishComponent = defineTool({
  name: 'elabora_publish_component',
  ...fromCommand('publish_component'),
  handler: (args, { root, author }) => editResult(edit.run(root, 'publish_component', args, { author }))
});

export const previewComponent = defineTool({
  name: 'elabora_preview_component',
  readOnly: true,
  description: 'Render the examples of a component (or given props) on a specimen screen and return a PNG: the light review of a component at 1280 and 375 px.',
  inputSchema: objectSchema({ id: SLUG, width: { type: 'integer', minimum: 320, maximum: 1920, default: 1280 }, props: { type: 'object', description: 'Props to preview instead of the examples.' } }, ['id']),
  async handler(args, { root }) {
    const { previewComponent } = await import('@elabora/node/capture');
    const result = await previewComponent(root, { id: args.id, width: args.width || 1280, props: args.props });
    if (!result.ok) return errorResult({ error: result.error, diagnostics: result.diagnostics?.filter((d) => d.severity === 'error') });
    return imageResult(result.png, `${args.id}: ${result.count} instance(s).${result.consoleErrors.length ? ` Console errors: ${result.consoleErrors.join(' | ')}` : ' No console errors.'}`);
  }
});
