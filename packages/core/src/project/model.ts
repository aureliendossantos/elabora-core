import type { Course, Plan, PlanVersion, PlanNote, Screen, ScreenLayer, Block, ComponentManifest, ObjectManifest, ObjectTests, JsonSchema } from '@elabora/format';
import type { PlanVersionEntry } from './plan-versions.ts';
import type { ProjectFiles, MediaStatus } from './files.ts';
import type { MigrationNote } from '../format/migrations/types.ts';

// The project model: what loadProject makes of a files snapshot. The documents use the types
// generated from the format's JSON Schemas (@elabora/format). Loaded data is only as good as its
// files: a document that fails its schema is still loaded (the validator reports it), so code
// reading the model stays defensive about values the schema requires.

export type { Course, Plan, PlanVersion, PlanNote, PlanVersionEntry, Screen, ScreenLayer, Block, ComponentManifest, ObjectManifest, ObjectTests, JsonSchema };
export type {
  CourseSection, Variable, Theme, ThemeFont, PlanObjective, PlanItem, PlanSource, PlanWaiver, LockedText, PlanQuestion, PlanQuestionOption,
  Event, Trigger, Condition, Action, ComponentSlot, ComponentExample, ObjectEvent, PropSchema, DataField, PatchOperation, BuiltinBlockType
} from '@elabora/format';

export type ComponentOrigin = NonNullable<ComponentManifest['origin']>;

// An item of a component's fallback: a native block template, or $if, $each, $slot
// (docs/components.md).
export interface FallbackEntry {
  $if?: string;
  $each?: string;
  $slot?: string;
  as?: unknown;
  type?: string;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ScreenEntry {
  file: string; // screens/<id>.json
  data: Screen;
}

export interface ProjectObject {
  id: string;
  folder: string; // objects/<id>
  manifest: ObjectManifest | null;
  code: string | null; // object.js
  tests: ObjectTests | null;
  notes: string | null; // object.notes.md
}

// A course component as its files hold it; the registry resolves it into a descriptor.
export interface ComponentSource {
  id: string;
  folder: string; // components/<id>
  manifest: ComponentManifest | null;
  template: string | null;
  css: string | null;
  migrations: string | null; // path of migrations.mjs, when there is one
  migrationsSource: string | null;
}

// translations/<lang>.xlf and the approval of the translated plan (translations/<lang>.approval.json).
export interface TranslationEntry {
  language: string;
  file: string;
  xliff: string;
  approvalFile: string;
  approval: TranslationApproval | null;
  approvalError: string | null; // the approval file does not parse
}

export interface TranslationApproval {
  language: string;
  by: string;
  date: string;
  contentHash: string;
  sourceContentHash: string;
  reference?: string;
}

// A project whose files are in an older format: loadProject read it migrated in memory
// (docs/architecture/operations.md, Identifiers and format version); `elabora migrate` writes these changes.
export interface LoadedMigration {
  from: string;
  to: string;
  changed: string[]; // files the migration changes
  notes: MigrationNote[];
}

// Problems found while loading: reported by the validator with their code.
export interface LoadError {
  code: string;
  file: string;
  message: string;
}

export interface Project {
  root: string; // where the files come from (a folder, a URI): for messages and Node services
  files: ProjectFiles;
  course: Course | null;
  plan: Plan | null;
  screens: Map<string, ScreenEntry>;
  objects: Map<string, ProjectObject>;
  components: Map<string, ComponentSource>;
  // The plan's versions (plan-versions/V<n>.json, D52) in order of their number, and the notes for
  // the client waiting for the next one (plan-versions/notes.json).
  planVersions: PlanVersionEntry[];
  planNotes: PlanNote[];
  translations: Map<string, TranslationEntry>;
  loadErrors: LoadError[];
  media?: MediaStatus; // given by the store that read the files (LoadOptions.media)
  // Set when the files are in an older format: files then holds them migrated.
  migration?: LoadedMigration;
}
