import type { Project } from '../project/model.ts';
import type { ComponentDescriptor } from './registry.ts';
import type { StateLock } from '../compile/state-model.ts';

// Migrations of component instances. When the shape of a component's props changes, the agent
// raises its version and adds a step to components/<id>/migrations.mjs:
//
//   export default {
//     '2.0.0': (props, { id, screen }) => ({ ...props, label: props.title, title: undefined })
//   };
//
// elabora.lock.json records, per component, the version its instances were written for. The steps
// above that version run on every instance (`elabora component migrate`), the results are checked
// against the new schema, and nothing is written unless every instance passes. Running the steps
// means importing the module: @elabora/node does it (component-migrations.ts).

export type MigrationStep = (props: Record<string, unknown>, context: { id: string; screen: string }) => unknown;
export type MigrationSteps = Record<string, MigrationStep>;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
export function compareVersions(a: unknown, b: unknown): number {
  const x = SEMVER.exec(String(a));
  const y = SEMVER.exec(String(b));
  if (!x || !y) return String(a).localeCompare(String(b));
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (x[4] === y[4]) return 0;
  return x[4] ? (y[4] ? x[4].localeCompare(y[4]) : -1) : 1;
}

// Versions declared in migrations.mjs, read without running it.
export function migrationVersions(d: ComponentDescriptor | null | undefined): string[] {
  const src = d?.migrations ? d.source?.migrationsSource : null;
  if (!src) return [];
  return [...new Set([...src.matchAll(/['"](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)['"]\s*:/g)].map((m) => m[1]))].sort(compareVersions);
}

export type PendingMigrations = { version: string }[] & { from: string | null };

// Steps to run for a component, given the lock (or an explicit starting version).
export function pendingMigrations(project: Project, d: ComponentDescriptor, lock: StateLock | null | undefined, from?: string): PendingMigrations {
  const start = from || lock?.components?.[d.id];
  const out = Object.assign([] as { version: string }[], { from: start || null });
  if (!start || d.builtin || compareVersions(start, d.version) >= 0) return out;
  for (const v of migrationVersions(d)) if (compareVersions(v, start) > 0 && compareVersions(v, d.version) <= 0) out.push({ version: v });
  return out;
}
