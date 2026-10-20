import type { Plan, PlanNote, PlanVersion, Project } from './model.ts';
import { planDiff } from './plan-diff.ts';
import type { PlanDiff } from './plan-diff.ts';
import { planCourse } from './plan-order.ts';
import { canonicalJSON, sha256 } from '../util/json.ts';
import { isRecord, objectsIn } from '../util/values.ts';

// The plan's versions (docs/decisions.md D52). plan.json is always the working copy, written at any
// time by the author and their agent. A version is a frozen copy of it, numbered V1, V2…, made by
// hand (never by an agent, never by an export) and kept in plan-versions/V<n>.json: its day, its
// content hash and the plan as it was never change; the days it was sent and its validation by the
// client are added to it. The plan's state follows from them: validated when the working copy is
// the latest validated version, changed since when it differs, a draft without a validated version.
// The author's notes for the client on the changes not in a version yet wait in
// plan-versions/notes.json; the next version freezes them.

export const PLAN_VERSIONS_DIR = 'plan-versions';
export const PLAN_NOTES_FILE = 'plan-versions/notes.json';
export const PLAN_VERSION_FILE = /^plan-versions\/V([1-9]\d{0,3})\.json$/;
export const planVersionFile = (number: number): string => `${PLAN_VERSIONS_DIR}/V${number}.json`;
export const versionLabel = (number: number): string => `V${number}`;

// « V2 », « v2 » or « 2 »: the number; null otherwise.
export function versionNumber(label: string | number | null | undefined): number | null {
  if (typeof label === 'number') return Number.isInteger(label) && label >= 1 ? label : null;
  const match = /^[Vv]?([1-9]\d{0,3})$/.exec(String(label ?? '').trim());
  return match ? Number(match[1]) : null;
}

export interface PlanVersionEntry {
  file: string; // plan-versions/V<n>.json
  number: number; // from the file name
  data: PlanVersion;
}

// The contract: the plan without its state, nor what the agent decided and asks while it is a draft
// (D51), which validating removes and which never change the content's hash.
export function planContentHash(plan: Partial<Plan> | null | undefined): string {
  const { $schema, decided, question, ...content } = plan || {};
  return `sha256:${sha256(canonicalJSON(content))}`;
}

// The plan a version freezes: the working copy without its $schema and the draft's decisions and
// question (D51).
export function versionedPlan(plan: Plan): Plan {
  const { $schema, decided, question, ...content } = structuredClone(plan);
  return content as Plan;
}

const validationOf = (version: PlanVersion | undefined) => (isRecord(version?.validation) && typeof version.validation.by === 'string' && typeof version.validation.date === 'string' ? version.validation : null);

// The versions in order, those whose content holds together (a plan, its hash) only.
export function usableVersions(project: Pick<Project, 'planVersions'>): PlanVersionEntry[] {
  return project.planVersions.filter((entry) => isRecord(entry.data.plan) && entry.data.contentHash === planContentHash(entry.data.plan));
}

export interface PlanSendView {
  date: string;
  format: string;
}

export interface PlanVersionView {
  number: number;
  label: string; // V2
  date: string;
  note: string | null;
  contentHash: string;
  sends: PlanSendView[];
  validation: { by: string; date: string; reference: string | null } | null;
  notes: number; // notes for the client it holds
  // What changed in it since the version before (nothing for V1).
  changes: number;
}

export type PlanApprovalState = 'missing' | 'draft' | 'modified' | 'approved';

export interface PlanVersionsView {
  versions: PlanVersionView[]; // oldest first
  latest: number | null; // the latest version
  validated: number | null; // the latest validated version
  next: number; // the number « Créer la V3 » makes
  state: PlanApprovalState;
  current: {
    contentHash: string | null; // null: no readable plan
    // The version the working copy is, when it is one (the latest such).
    is: number | null;
    // The marks: what changed since the latest validated version (null without one).
    sinceValidated: number | null;
    // The pill's count: what is in no version yet, since the latest version (null without one: then
    // the whole plan is in none).
    unversioned: number | null;
  };
  // What an export shows by default (D52): the latest version, else the working copy; and how many
  // changes the working copy has that it does not show (the warning before exporting).
  export: { shows: number | null; changesSince: number };
  // Texts the latest validated version keeps « à l'identique » that changed since (W_PLAN_VERBATIM_CHANGED).
  verbatimChanged: string[];
  notes: number; // notes waiting for the next version
}

// The working copy's state: approved when it is the latest validated version, modified when it
// changed since, draft without a validated version.
export function planState(project: Pick<Project, 'plan' | 'planVersions'>): PlanApprovalState {
  if (!project.plan) return 'missing';
  const validated = usableVersions(project).filter((entry) => validationOf(entry.data)).at(-1);
  if (!validated) return 'draft';
  return validated.data.contentHash === planContentHash(project.plan) ? 'approved' : 'modified';
}

export function latestValidated(project: Pick<Project, 'planVersions'>): PlanVersionEntry | null {
  return usableVersions(project).filter((entry) => validationOf(entry.data)).at(-1) ?? null;
}

export function latestVersion(project: Pick<Project, 'planVersions'>): PlanVersionEntry | null {
  return usableVersions(project).at(-1) ?? null;
}

export function findVersion(project: Pick<Project, 'planVersions'>, number: number): PlanVersionEntry | null {
  return usableVersions(project).find((entry) => entry.number === number) ?? null;
}

export function nextVersionNumber(project: Pick<Project, 'planVersions'>): number {
  return Math.max(0, ...project.planVersions.map((entry) => entry.number)) + 1;
}

// Where a diff starts or ends: a version by number, the latest validated version, the latest
// version, or the working copy.
export type PlanRef = number | 'validated' | 'latest' | 'current';

export function planAt(project: Pick<Project, 'plan' | 'planVersions'>, ref: PlanRef): { plan: Plan | null; version: number | null } {
  if (ref === 'current') return { plan: project.plan, version: null };
  const entry = ref === 'validated' ? latestValidated(project) : ref === 'latest' ? latestVersion(project) : findVersion(project, ref);
  if (!entry && typeof ref === 'number') throw new Error(`The plan has no version ${versionLabel(ref)}${project.planVersions.length ? ` (it has ${project.planVersions.map((candidate) => versionLabel(candidate.number)).join(', ')})` : ''}.`);
  return { plan: entry?.data.plan ?? null, version: entry?.number ?? null };
}

export interface PlanDiffView extends PlanDiff {
  from: number | null; // null: from nothing (no version)
  to: number | null; // null: the working copy
}

// What changed from one reference to another (from: the latest validated version by default, to:
// the working copy). Without a version to start from, everything is added.
export function planDiffBetween(project: Pick<Project, 'plan' | 'planVersions'> & Partial<Pick<Project, 'course' | 'screens'>>, { from = 'validated', to = 'current' }: { from?: PlanRef; to?: PlanRef } = {}): PlanDiffView {
  const start = planAt(project, from);
  const end = planAt(project, to);
  return { ...planDiff(start.plan, end.plan, planCourse(project)), from: start.version, to: end.version };
}

// Everything the app shows of the plan's versions: the pill, the panel, the export's warning.
export function planVersionsView(project: Pick<Project, 'plan' | 'planVersions' | 'planNotes'> & Partial<Pick<Project, 'course' | 'screens'>>): PlanVersionsView {
  const usable = usableVersions(project);
  const course = planCourse(project);
  const versions = usable.map((entry, index): PlanVersionView => {
    const data = entry.data;
    const validation = validationOf(data);
    return {
      number: entry.number, label: versionLabel(entry.number), date: String(data.date ?? ''), note: typeof data.note === 'string' ? data.note : null,
      contentHash: data.contentHash,
      sends: objectsIn(data.sends).map((send) => ({ date: String(send.date), format: String(send.format) })),
      validation: validation ? { by: validation.by, date: validation.date, reference: typeof validation.reference === 'string' ? validation.reference : null } : null,
      notes: objectsIn(data.notes).length,
      changes: index ? planDiff(usable[index - 1]!.data.plan, data.plan, course).changes.length : 0
    };
  });
  const validated = latestValidated(project);
  const latest = usable.at(-1) ?? null;
  const hash = project.plan ? planContentHash(project.plan) : null;
  const is = hash ? usable.filter((entry) => entry.data.contentHash === hash).at(-1)?.number ?? null : null;
  const count = (entry: PlanVersionEntry | null) => (entry && project.plan ? (entry.data.contentHash === hash ? 0 : planDiff(entry.data.plan, project.plan, course).changes.length) : null);
  const sinceValidated = count(validated);
  const unversioned = count(latest);
  return {
    versions,
    latest: latest?.number ?? null,
    validated: validated?.number ?? null,
    next: nextVersionNumber(project),
    state: planState(project),
    current: { contentHash: hash, is, sinceValidated, unversioned },
    export: { shows: latest?.number ?? null, changesSince: unversioned ?? 0 },
    verbatimChanged: validated && project.plan ? planDiff(validated.data.plan, project.plan, course).changes.filter((change) => change.verbatim).map((change) => change.id) : [],
    notes: project.planNotes.length
  };
}

// The notes for the client that explain the changes of a version (or of the working copy, with the
// notes waiting): for a version, those of the versions since the validated one before it, and its
// own; a later note on the same change wins.
export function notesFor(project: Pick<Project, 'planVersions' | 'planNotes'>, version: number | null, since: number | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of usableVersions(project)) {
    if ((since !== null && entry.number <= since) || (version !== null && entry.number > version)) continue;
    for (const note of objectsIn<PlanNote>(entry.data.notes)) out.set(note.target, note.text);
  }
  if (version === null) for (const note of project.planNotes) out.set(note.target, note.text);
  return out;
}

// The plan's versions in a line, for agents and the command line: « V2 validated by Claire Martin on
// 2026-10-05 · 4 change(s) since · V3 made on 2026-10-16, sent on 2026-10-16 (docx) · 1 change(s) in no version ».
export function describePlanVersions(view: PlanVersionsView): string {
  if (!view.versions.length) return 'no version yet: the working copy is a draft (a person makes V1: elabora plan version)';
  const parts: string[] = [];
  const validated = view.versions.find((version) => version.number === view.validated);
  if (validated?.validation) parts.push(`${validated.label} validated by ${validated.validation.by} on ${validated.validation.date}`);
  else parts.push('no version validated');
  if (view.current.sinceValidated) parts.push(`${view.current.sinceValidated} change(s) since`);
  const latest = view.versions.at(-1)!;
  if (latest.number !== view.validated) {
    const sent = latest.sends.at(-1);
    parts.push(`${latest.label} made on ${latest.date}${sent ? `, sent on ${sent.date} (${sent.format})` : ', not sent'}`);
  }
  if (view.current.unversioned && latest.number !== view.validated) parts.push(`${view.current.unversioned} change(s) in no version`);
  return parts.join(' · ');
}
