import type { Diagnostic, Summary } from '../diagnostics/index.ts';
import type { PlanApprovalState } from '../project/plan-versions.ts';
import type { PlanChange } from '../project/plan-diff.ts';
import type { Plan, PlanItem, PlanObjective, PlanWaiver, ObjectManifest, LmsProfile } from '@elabora/format';
import type { StructureFingerprint } from './scorm12-manifest.ts';
import type { StateKeys } from './state-model.ts';
import type { BuildTarget } from '../validate/context.ts';

// <package>.report.json: what a build delivered and what is left to check. @elabora/node writes it
// (build.ts), `elabora test` adds the trials (tests); the proof dossier (proof.ts) and `elabora diff`
// (update-impact.ts) read it. Types only.

export interface BuildReport {
  format: 'elabora-build-report/1';
  elabora: string; // version of Elabora that built the package
  target: BuildTarget;
  // The web target's settings (D41); absent in a SCORM package's report.
  web?: ReportWeb;
  release: boolean;
  course: { id: string; title: string; version: string; language: string };
  // A package of every language (D59): the languages learners switch between, the course's own
  // first; absent when the package holds one.
  languages?: string[];
  buildId: string;
  package: { sha256: string; bytes: number; files: number; uncompressedBytes: number };
  // The media shipped, when there are any: the quality of the package and, for each master, the
  // file in the package (a rendition below the high quality) and its size.
  media?: { quality: 'high' | 'medium' | 'low'; files: { asset: string; path: string; bytes: number; rendition: boolean }[] };
  // The narration shipped, when the course has some: a track and its captions per narrated screen
  // (their bytes and seconds), and the narrated screens without a track (a line without audio yet).
  // credits: what the voices of the tracks ask the module's credits to say (their sidecars' credit).
  narration?: { bytes: number; seconds: number; tracks: { screen: string; path: string; captions: string; bytes: number; seconds: number }[]; silent: string[]; credits?: string[] };
  structure: StructureFingerprint;
  stateKeys: StateKeys;
  // suspendDataLimit null: no LMS limits it (the web target).
  budget: { suspendDataWorstCase: number; suspendDataLimit: number | null; source: string };
  profiles: ReportProfile[]; // none for the web target
  plan: ReportPlan;
  screens: ReportScreen[];
  components: ReportComponent[];
  objects: ReportObject[];
  generatedMedia: { screen: string; block: string; type: string }[];
  generatedAssets: { asset: string; generator: string }[];
  // fontLicenses: the licence files carried next to the packaged fonts.
  design: { stylesheet: string | null; fonts: string[]; fontLicenses: string[]; layouts: string[]; presentation: 'scroll' | 'slides' };
  tests: ReportTests | null; // null until `elabora test` runs
  diagnostics: Diagnostic[];
  summary: Summary;
  // Human gates, as ids (accessibility-manual, sme-review, lms-smoke, object-review:<id>): the
  // dossier words them in the course language.
  pending: string[];
}

// A module for the web: where its progress stays, how it is navigated, whether search engines may
// index it, the address it was built for and its sharing image (its path in the package).
export interface ReportWeb {
  progress: 'local' | 'none';
  navigation: 'authored' | 'free';
  noindex: boolean;
  url: string | null;
  image: string | null;
  // A review build (D42): the origins of the review pages it speaks with.
  review?: { origins: string[] };
}

export interface ReportProfile {
  id: string;
  name: string;
  documentedAt: string;
  updateFamily: LmsProfile['update']['family'];
  toMeasure: string[];
}

export interface ReportPlan {
  id: string;
  title: string;
  // The working copy's state from the plan's versions (D52), the validated version it is built
  // against, and what changed since: a release may deliver changes the client has not validated
  // yet, and says so here and in the proof dossier.
  approvalState: PlanApprovalState;
  validated: { version: string; by: string; date: string; reference: string | null; contentHash: string } | null;
  changesSince: { version: string; changes: Pick<PlanChange, 'key' | 'kind' | 'id' | 'status' | 'label'>[]; verbatim: string[] } | null;
  contentHash: string;
  businessGoal: string | null;
  spacing: string[];
  objectives: { id: string; statement: string; bloom: PlanObjective['bloom'] | null }[];
  coverage: PlanCoverage[];
  waivers: PlanWaiver[];
}

// One plan item and what implements it: screens, blocks using its locked texts and questions
// (screen/block), activities (type:block).
export interface PlanCoverage {
  id: string;
  kind: PlanItem['kind'];
  title: string;
  objectives: string[];
  screens: string[];
  lockedTexts: { id: string; usedBy: string[] }[];
  questions: { id: string; usedBy: string[] }[];
  activities: string[];
}

export interface ReportScreen {
  id: string;
  title: string;
  covers: string[];
  completeWhen: string;
  layout?: string;
  blocks: string[]; // block types, in reading order
}

export interface ReportComponent {
  id: string;
  title: string;
  version: string;
  level: 'block' | 'screen';
  extends?: string;
  behavior?: string;
  origin?: string; // library/component@version
  instances: number;
}

export interface ReportObject {
  id: string;
  version: string;
  planRefs?: ObjectManifest['planRefs'];
  pedagogicalRole: ObjectManifest['pedagogicalRole'];
  gates: { automated: GatesStatus; human: 'pending' };
}

// The record of the last full run of an object's automated gates (2–6).
export interface GatesStatus {
  status: 'passed' | 'failed' | 'stale' | 'not-run';
  at?: string | null;
  elabora?: string | null;
  gates?: Record<string, string>;
  bootMs?: number | null;
}

export interface ReportTests {
  at: string;
  runs: ReportTestRun[];
  accessibility: ReportAccessibility | null;
  fit?: ReportFit[]; // slides only
}

export interface ReportTestRun {
  profile: string;
  launch: string;
  browser: string;
  ok: boolean;
  checks: { name: string; ok: boolean }[];
  failures: Diagnostic[];
}

export interface ReportAccessibility {
  screens: number; // screen states checked by axe-core
  violations: number;
  details: { id: string; screen: string; state: string; help: string; targets?: string[] }[];
  overflow?: { screen: string; scrollWidth: number; viewport: number; culprit: string | null }[];
}

// Slides measured at one fit size of the course.
export interface ReportFit {
  role: 'reference' | 'minimum';
  size: string; // 1600x900
  screens: number;
  fit: number; // screens that fit without scrolling
  overflow: { screen: string; px: number }[];
}
