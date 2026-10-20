import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentDescriptor } from '@elabora/core/components/registry';
import type { MigrationStep, MigrationSteps } from '@elabora/core/components/migrate';
import { fieldOf } from './util/values.ts';

// The steps of components/<id>/migrations.mjs, imported from the course folder (the core finds
// which steps are pending from the source text; running them needs the module).
export async function loadMigrations(projectRoot: string, descriptor: ComponentDescriptor): Promise<MigrationSteps> {
  const file = path.join(projectRoot, descriptor.source?.folder ?? `components/${descriptor.id}`, 'migrations.mjs');
  // The modification time busts the module cache: a long-running MCP server sees edited steps.
  const module: unknown = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
  const steps = fieldOf(module, 'default') || {};
  if (typeof steps !== 'object' || steps === null) throw new Error(`${descriptor.id}/migrations.mjs must export default an object { "<version>": (props) => props }`);
  const migrations: MigrationSteps = {};
  // A step that is not a function is left out: running the migration reports it missing. The
  // signature of the author's function cannot be checked at run time.
  for (const [version, step] of Object.entries(steps)) if (typeof step === 'function') migrations[version] = step as MigrationStep;
  return migrations;
}
