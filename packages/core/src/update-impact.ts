import { resolveProfiles } from './lms/profiles.ts';
import type { LmsProfile } from './lms/profiles.ts';
import type { PlanCoverage } from './compile/report.ts';
import type { StructureFingerprint } from './compile/scorm12-manifest.ts';
import type { StateKeys } from './compile/state-model.ts';

// Compares two build reports (previous delivery → new build, as parsed from their
// .report.json files) and tells, LMS by LMS, what an update does to learners in progress
// (checklist item 7).

// What the comparison reads of a build report (compile/report.ts). The report may come from an
// older Elabora: the parts added over time may be missing.
export interface UpdateReport {
  course: { version: string };
  buildId: string;
  structure: StructureFingerprint;
  stateKeys?: StateKeys;
  plan?: { coverage?: Pick<PlanCoverage, 'questions'>[] } | null;
  profiles?: { id: string }[];
}

export type LearnerResume = 'kept' | 'partial' | 'broken';
export type UpdateVerdict = 'safe' | 'progress-lost' | 'new-version' | 'unknown';

export interface UpdateImpact {
  from: { version: string; buildId: string };
  to: { version: string; buildId: string };
  manifest: { sameStructure: boolean; masteryChanged: boolean };
  // renamed: elements that kept their key under another id (elabora rename): their progress is kept.
  learnerState: { resume: LearnerResume; removed: string[]; added: string[]; renamed: { from: string; to: string }[]; changedKeys: string[]; note: string };
  content: { quizChanges: string[] };
  perProfile: { profile: string; name: string; family: LmsProfile['update']['family'] | undefined; verdict: UpdateVerdict; why: string | undefined }[];
}

export function diffReports(previous: UpdateReport, next: UpdateReport, { profiles }: { profiles?: readonly string[] } = {}): UpdateImpact {
  const sameStructure = JSON.stringify({ ...previous.structure, masteryScore: null }) === JSON.stringify({ ...next.structure, masteryScore: null });
  const masteryChanged = previous.structure.masteryScore !== next.structure.masteryScore;
  const previousKeys = previous.stateKeys || {};
  const nextKeys = next.stateKeys || {};
  const removed: string[] = [];
  const changedKeys: string[] = [];
  for (const [entity, key] of Object.entries(previousKeys)) {
    if (!(entity in nextKeys)) removed.push(entity);
    else if (nextKeys[entity] !== key) changedKeys.push(entity);
  }
  const added = Object.keys(nextKeys).filter((entity) => !(entity in previousKeys));
  // A removed entity whose key an added one of the same kind holds was renamed (elabora rename).
  const renamed: { from: string; to: string }[] = [];
  const kind = (entity: string) => entity.slice(0, entity.indexOf(':'));
  for (const entity of [...removed]) {
    const to = added.find((candidate) => nextKeys[candidate] === previousKeys[entity] && kind(candidate) === kind(entity));
    if (!to) continue;
    renamed.push({ from: entity, to });
    removed.splice(removed.indexOf(entity), 1);
    added.splice(added.indexOf(to), 1);
  }
  const quizChanges: string[] = [];
  const previousQuestions = new Set((previous.plan?.coverage || []).flatMap((item) => item.questions.map((question) => question.id)));
  for (const item of next.plan?.coverage || []) for (const question of item.questions) if (!previousQuestions.has(question.id)) quizChanges.push(`new question ${question.id}`);
  const resume: LearnerResume = changedKeys.length ? 'broken' : removed.length ? 'partial' : 'kept';
  const perProfile = resolveProfiles(profiles?.length ? profiles : (next.profiles || []).map((profile) => profile.id)).map((profile) => {
    const family = profile.update?.family;
    let verdict: UpdateVerdict;
    let why: string | undefined;
    if (family === 'replace-loses-progress') { verdict = 'progress-lost'; why = profile.update.notes; }
    else if (family === 'in-place-if-same-structure') { verdict = sameStructure ? (resume === 'broken' ? 'progress-lost' : 'safe') : 'new-version'; why = sameStructure ? 'Same manifest structure: the package can be replaced in place.' : 'Manifest structure changed: create a new version.'; }
    else if (family === 'lms-versioning') { verdict = 'new-version'; why = profile.update.notes; }
    else if (family === 'auto-update') { verdict = resume === 'broken' ? 'progress-lost' : 'safe'; why = profile.update.notes; }
    else { verdict = 'unknown'; why = 'Update behaviour not documented: test in a real instance.'; }
    return { profile: profile.id, name: profile.name, family, verdict, why };
  });
  return {
    from: { version: previous.course.version, buildId: previous.buildId }, to: { version: next.course.version, buildId: next.buildId },
    manifest: { sameStructure, masteryChanged },
    learnerState: {
      resume, removed, added, renamed, changedKeys,
      note: resume === 'kept' ? 'Every stateful element keeps its key: learners resume where they were.' : resume === 'partial' ? 'Removed elements lose their saved answers; everything else resumes.' : 'Keys changed (elabora.lock.json lost or edited): saved progress no longer matches.'
    },
    content: { quizChanges },
    perProfile
  };
}
