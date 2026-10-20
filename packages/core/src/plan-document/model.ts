import type { Plan, Project } from '../project/model.ts';
import { planDiff } from '../project/plan-diff.ts';
import { planCourse } from '../project/plan-order.ts';
import type { PlanChange, PlanElementKind } from '../project/plan-diff.ts';
import { notesFor, planContentHash, usableVersions, versionLabel, versionNumber } from '../project/plan-versions.ts';
import type { PlanVersionEntry } from '../project/plan-versions.ts';
import { getProfile, lmsName } from '../lms/profiles.ts';
import { localDay } from '../util/local-day.ts';
import { isRecord } from '../util/values.ts';
import { diffPlain, diffRich, parseRich, richText } from './rich.ts';
import type { RichBlock, RichInline, RichText } from './rich.ts';
import { DOCUMENT_WORDS, documentLanguage, formatNumber, longDate } from './words.ts';
import type { DocumentLanguage, DocumentWords } from './words.ts';

// The plan's document (docs/decisions.md D48, D52): what the client reads, comments and signs, as
// data without layout. Three renderers read it: the exports (Word, and HTML printed to PDF), the
// app's Document view, and later a review link that shows the plan alone. It shows one version of
// the plan (V1, V2…) or the working copy, with course.json for the module's properties. Its head
// says the version shown and the versions before it (made, sent, validated); what changed since the
// latest validated version reads in place, words deleted and inserted, elements added, removed or
// moved marked, with the author's notes for the client. Its words are in the module's language.
//
// The document never says who or what wrote the plan or a change: a reviewer validates the
// substance, whoever wrote it. It names only those who validated (a version, a waiver).

export const PLAN_DOCUMENT_FORMAT = 'elabora/plan-document/2';

// approved: the version shown is validated; modified: it changed since a validated version; draft:
// no version before it is validated.
export type PlanDocumentState = 'approved' | 'modified' | 'draft';

export interface PlanDocument {
  format: typeof PLAN_DOCUMENT_FORMAT;
  // The module's language (course.json language), and the language of the words below.
  language: string;
  words: DocumentLanguage;
  // The day the document is made (YYYY-MM-DD), said in its colophon.
  date: string;
  kicker: string; // « Plan validé », « Plan du module »
  title: string; // the module's title
  status: { state: PlanDocumentState; label: string };
  // What it shows: a version (its number) or the working copy (version null; is: the version it
  // equals, when it does: then it is that version).
  shows: { version: number | null; label: string; current: boolean };
  // The properties at the head, in order: status, version, approved by, module, history.
  properties: PlanProperty[];
  // The versions up to the one shown, each with its last step (« V2 validée par … le … »).
  history: { version: string; line: string }[];
  // What the properties say, as values, for a renderer that writes its own sentences.
  facts: PlanFacts;
  // The changes marked in it: since which validated version, and how many (null: none marked).
  marks: { since: string; changes: number } | null;
  sections: PlanSection[];
  // Notes for the client on changes that have no place of their own in the sections (the plan's
  // title, its duration…).
  notes: { label: string; text: string }[];
  colophon: string;
  plan: { id: string; contentHash: string; version: string | null };
  // The labels a renderer needs beside the content (« Objectifs », « Voix off »…).
  labels: PlanDocumentLabels;
}

export interface PlanProperty {
  key: 'status' | 'version' | 'approvedBy' | 'module' | 'history';
  label: string;
  value: string; // history: one line a version
}

export interface PlanFacts {
  // The validated version the marks start from (or the one shown, when it is validated).
  approval: { version: string; by: string; date: string; reference: string | null } | null;
  module: { durationMinutes: number | null; delivery: 'SCORM 1.2'; lms: string[] };
}

export interface PlanDocumentLabels {
  objectives: string;
  noObjective: string;
  criterion: string;
  sources: string;
  voiceover: string;
  verbatim: string;
  correct: string;
  answer: string;
  feedbackCorrect: string;
  feedbackIncorrect: string;
  misconceptions: string;
  sourceType: string;
  sourceVersion: string;
  colon: string;
  page: string;
  // The author of the tracked changes in Word (« Depuis la V2 validée »: never a person nor an AI),
  // and of its comments (the notes for the client).
  changeAuthor: string;
  noteAuthor: string;
  notesHeading: string;
}

// Where an element of the plan stands in the document: its id in the plan (permanent, D4), which
// renderers turn into an anchor (HTML) or a bookmark (Word, wordBookmarkName).
export interface Anchored {
  id: string;
}

// An element that changed since the validated version: how (« Ajouté », « Modifié · déplacé, c'était
// le point 4 »), and the author's note for the client on it. Its texts read with their words deleted
// and inserted; a removed element is shown as it was, all deleted.
export interface EntryMark {
  status: 'added' | 'removed' | 'changed';
  summary: string;
  note: string | null;
  verbatim: boolean; // a text kept « à l'identique » that changed
}

export interface Marked {
  mark: EntryMark | null;
}

export type PlanSection =
  | { kind: 'framing'; title: string; empty: string | null; entries: FramingEntry[]; waivers: WaiverEntry[]; waiversLabel: string }
  | { kind: 'objectives'; title: string; empty: string | null; objectives: ObjectiveEntry[] }
  | { kind: 'sequence'; title: string; empty: string | null; items: ItemEntry[] }
  | { kind: 'texts'; title: string; empty: string | null; groups: TextGroup[] }
  | { kind: 'assessments'; title: string; empty: string | null; groups: QuestionGroup[] }
  | { kind: 'sources'; title: string; empty: string | null; sources: SourceEntry[] };

export type PlanSectionKind = PlanSection['kind'];

export interface FramingEntry extends Marked {
  key: 'businessGoal' | 'audience' | 'priorKnowledge' | 'notes' | 'spacing';
  label: string;
  text: RichText;
}

export interface WaiverEntry {
  code: string;
  target: string | null;
  approvedBy: string;
  summary: string; // « W_X sur ITEM-3, approuvée par … »
  reason: RichText;
}

export interface Reference {
  id: string;
  number: string; // « 2 »: what the document calls it
  label: string; // « Objectif 2 », « Point 3 »
}

export interface ObjectiveEntry extends Anchored, Marked {
  number: string;
  heading: string; // « Objectif 1 »
  statement: RichText;
  bloom: string | null; // « appliquer »
  criterion: string | null;
  sources: { id: string; title: string }[];
}

export interface ItemEntry extends Anchored, Marked {
  number: string;
  heading: string; // « Point 2 »
  title: string;
  titleChange: RichInline[] | null; // the title's words deleted and inserted, when it changed
  kind: string; // « Explication »
  objectives: Reference[];
  description: RichText | null;
  voiceover: { speaker: string | null; text: RichText }[];
  sources: { id: string; title: string }[];
}

export interface ItemRef {
  id: string;
  number: string;
  title: string;
}

export interface TextGroup {
  item: ItemRef;
  texts: TextEntry[];
}

export interface TextEntry extends Anchored, Marked {
  number: string; // « 2.1 »: the item's number, then the text's
  text: RichText; // the plan's wording, its changes marked
  verbatim: boolean;
}

export interface QuestionGroup {
  item: ItemRef;
  questions: QuestionEntry[];
}

export interface QuestionEntry extends Anchored, Marked {
  number: string; // « 5.1 »
  heading: string; // « Question 5.1 »
  mode: 'single' | 'multiple' | 'numeric';
  modeLabel: string;
  stem: RichText;
  objectives: Reference[];
  bloom: string | null;
  options: OptionEntry[];
  numeric: NumericEntry | null;
}

export interface OptionEntry {
  id: string;
  letter: string; // « A »
  text: RichText;
  correct: boolean;
  feedback: RichText | null;
  change: 'added' | 'removed' | null; // an answer added or removed since the validated version
}

export interface NumericEntry {
  answer: string; // « 500 rpm »
  tolerance: string | null; // « à 2 rpm près »
  correct: RichText;
  incorrect: RichText;
  misconceptions: { id: string; value: string; label: string; feedback: RichText }[];
}

export interface SourceEntry extends Anchored, Marked {
  title: string;
  titleChange: RichInline[] | null;
  type: string | null;
  version: string | null;
}

export interface PlanDocumentOptions {
  // The day the document is made (YYYY-MM-DD); the author's day by default (the computer's time
  // zone, not UTC's). The exports are the same bytes for the same project and the same date (D8).
  date?: string;
  // The moment « today » is read at; now by default (tests fix it).
  now?: Date;
  // What to show: a version (2, « V2 ») or the working copy (« current »). By default the latest
  // version, else the working copy (D52: the same as exporting).
  version?: number | string;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value.filter((entry) => isRecord(entry)) as T[] : []);
const capitalize = (value: string): string => value.charAt(0).toLocaleUpperCase() + value.slice(1);

export interface PlanDocumentTarget {
  // The version shown, or null for the working copy.
  version: PlanVersionEntry | null;
  plan: Plan;
}

// What a document (and so an export) shows: the version asked for; the working copy when asked
// (« current »), or by default when the plan has no version. Throws when the version does not exist.
export function planDocumentTarget(project: Project, version?: number | string): PlanDocumentTarget | null {
  const versions = usableVersions(project);
  if (version === 'current' || (version === undefined && !versions.length)) return isRecord(project.plan) ? { version: null, plan: project.plan } : null;
  const number = version === undefined || version === 'latest' ? versions.at(-1)!.number : versionNumber(version);
  if (number === null) throw new Error(`"${version}" is not a version of the plan: V1, V2… or current.`);
  const entry = versions.find((candidate) => candidate.number === number);
  if (!entry) throw new Error(`The plan has no version ${versionLabel(number)}${versions.length ? ` (it has ${versions.map((candidate) => versionLabel(candidate.number)).join(', ')})` : ''}.`);
  return { version: entry, plan: entry.data.plan };
}

// The plan's document of a project, or null when it has no readable plan.
export function planDocument(project: Project, options: PlanDocumentOptions = {}): PlanDocument | null {
  const target = planDocumentTarget(project, options.version);
  if (!target) return null;
  const { plan } = target;
  const course = project.course;
  const language = text(course?.language) ?? 'en';
  const words = documentLanguage(language);
  const w = DOCUMENT_WORDS[words];
  const day = (date: string) => longDate(date, language);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(options.date ?? '') ? options.date! : localDay(options.now);

  // ── what it shows, and from which validated version its changes are marked ──
  const versions = usableVersions(project);
  const contentHash = planContentHash(plan);
  // The working copy that is a version as it is reads as that version.
  const shown = target.version ?? versions.filter((entry) => entry.data.contentHash === contentHash).at(-1) ?? null;
  const upTo = shown ? versions.filter((entry) => entry.number <= shown.number) : versions;
  const base = upTo.filter((entry) => isRecord(entry.data.validation)).at(-1) ?? null;
  const validation = base?.data.validation ?? null;
  const planParts = planCourse(project);
  const diff = base && base.data.contentHash !== contentHash ? planDiff(base.data.plan, plan, planParts) : null;
  const changes = new Map((diff?.changes ?? []).map((change) => [change.key, change]));
  const notes = diff ? notesFor(project, shown ? shown.number : null, base!.number) : new Map<string, string>();
  const state: PlanDocumentState = !base ? 'draft' : diff ? 'modified' : 'approved';
  const statusLabel = state === 'approved' ? w.status.approved : state === 'modified' ? w.status.modified(versionLabel(base!.number)) : shown ? w.status.toApprove : w.status.draft;
  const latest = versions.at(-1) ?? null;
  const showsLabel = shown ? versionLabel(shown.number) : latest ? w.workingCopy(versionLabel(latest.number), planDiff(latest.data.plan, plan, planParts).changes.length) : w.noVersion;
  const history = upTo.map((entry) => {
    const label = versionLabel(entry.number);
    const validated = entry.data.validation;
    const sent = list<{ date: string }>(entry.data.sends).map((send) => String(send.date)).sort().at(-1);
    const line = validated ? w.logValidated(label, validated.by, day(validated.date), text(validated.reference)) : sent ? w.logSent(label, day(sent)) : w.logCreated(label, day(String(entry.data.date)));
    return { version: label, line };
  });

  const lms = (Array.isArray(course?.delivery?.lms) ? course.delivery.lms : []).flatMap((id) => {
    try { return id === 'unknown' ? [] : [lmsName(getProfile(id))]; } catch { return []; }
  });
  const duration = typeof course?.durationMinutes === 'number' && course.durationMinutes > 0 ? course.durationMinutes : null;
  const moduleLine = [duration ? w.minutes(duration) : null, 'SCORM 1.2', ...(lms.length ? [lms.join(', ')] : [])].filter(Boolean).join(' · ');

  const properties: PlanProperty[] = [
    { key: 'status', label: w.property.status, value: statusLabel },
    { key: 'version', label: w.property.version, value: showsLabel },
    { key: 'approvedBy', label: w.property.approvedBy, value: validation ? `${w.approvedOn(validation.by, day(validation.date))} (${versionLabel(base!.number)})` : w.notApproved },
    { key: 'module', label: w.property.module, value: moduleLine },
    ...(history.length ? [{ key: 'history' as const, label: w.property.versions, value: history.map((entry) => entry.line).join('\n') }] : [])
  ];

  // ── the plan as the validated version had it, for what was removed ──
  const was = (base?.data.plan ?? null) as Plan | null;
  const changeOf = (kind: PlanElementKind, id: string) => changes.get(`${kind}:${id}`);
  const touched = (change: PlanChange | undefined, field: string) => !!change && (change.status !== 'changed' || change.fields.some((entry) => entry.field === field || entry.field.startsWith(`${field}/`)));
  // A text as it is, its words marked when it changed (all inserted when the element is new, all
  // deleted when it is gone).
  const marked = (before: unknown, after: unknown, change: PlanChange | undefined, field: string): RichText => {
    const now = typeof after === 'string' ? after : '';
    if (!touched(change, field)) return richText(now);
    const old = typeof before === 'string' ? before : '';
    if (old === now) return richText(now);
    return { markdown: now, blocks: diffRich(parseRich(old), parseRich(now)) };
  };
  const plainMarked = (before: unknown, after: unknown, change: PlanChange | undefined, field: string): RichInline[] | null => {
    if (!touched(change, field)) return null;
    const old = typeof before === 'string' ? before : '';
    const now = typeof after === 'string' ? after : '';
    return old === now ? null : diffPlain(old, now);
  };
  const fieldLabel = (field: string) => w.field[field.split('/')[0]!] ?? field.split('/')[0]!;
  // The mark of an element: its status, where it was, its part, the fields not read in place.
  const markOf = (change: PlanChange | undefined, inline: readonly string[], was: (number: string) => string): EntryMark | null => {
    if (!change) return null;
    const parts: string[] = [w.mark[change.status]];
    if (change.status === 'changed') {
      if (change.moved) parts.push(w.mark.moved(was(String(change.moved.from))));
      if (change.part) parts.push(w.mark.part(change.part.from, change.part.to));
      const other = [...new Set(change.fields.map((entry) => entry.field.split('/')[0]!).filter((field) => !inline.includes(field)))];
      if (other.length) parts.push(w.mark.fields(other.map(fieldLabel)));
    }
    return { status: change.status, summary: parts.join(' · '), note: notes.get(change.key) ?? null, verbatim: change.verbatim === true };
  };

  // ── numbering ──
  type Objective = Plan['objectives'][number];
  type Item = Plan['items'][number];
  type Source = NonNullable<Plan['sources']>[number];
  const objectives = list<Objective>(plan.objectives);
  const items = list<Item>(plan.items);
  const sources = list<Source>(plan.sources);
  const objectiveNumber = new Map(objectives.map((objective, index) => [objective.id, String(index + 1)]));
  const itemNumber = new Map(items.map((item, index) => [item.id, String(index + 1)]));
  const sourceTitle = new Map([...list<Source>(was?.sources), ...sources].map((source) => [source.id, source.title]));
  const objectiveRefs = (ids: unknown): Reference[] => (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === 'string').map((id) => {
    const number = objectiveNumber.get(id) ?? id;
    return { id, number, label: w.objective(number) };
  });
  const sourceRefs = (ids: unknown) => (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === 'string').map((id) => ({ id, title: sourceTitle.get(id) ?? id }));
  const bloom = (value: unknown): string | null => (typeof value === 'string' && value in w.bloom ? w.bloom[value as keyof DocumentWords['bloom']] : null);
  const speakers = new Map((Array.isArray(course?.speakers) ? course.speakers : []).filter(isRecord).map((speaker) => [speaker.id, String(speaker.name ?? speaker.id)]));
  // The elements of a list as the document shows them: those of the plan, each one removed since the
  // validated version after the one that was before it there.
  const withRemoved = <T extends { id: string }>(kind: PlanElementKind, now: T[], before: T[]): { entry: T; removed: boolean }[] => {
    const present = new Set(now.map((entry) => entry.id));
    const out = now.map((entry) => ({ entry, removed: false }));
    for (const [index, entry] of before.entries()) {
      if (present.has(entry.id) || changeOf(kind, entry.id)?.status !== 'removed') continue;
      const previous = before.slice(0, index).reverse().find((candidate) => present.has(candidate.id) || out.some((placed) => placed.entry.id === candidate.id));
      const at = previous ? out.findIndex((placed) => placed.entry.id === previous.id) + 1 : 0;
      out.splice(at, 0, { entry, removed: true });
    }
    return out;
  };
  const oldNumber = (kind: 'objective' | 'item' | 'source', id: string) => String(list<{ id: string }>(was?.[kind === 'objective' ? 'objectives' : kind === 'item' ? 'items' : 'sources']).findIndex((entry) => entry.id === id) + 1);

  // ── framing ──
  const audience = isRecord(plan.audience) ? plan.audience : {};
  const oldAudience = isRecord(was?.audience) ? was.audience : {};
  const framing: FramingEntry[] = [];
  const framed = (key: FramingEntry['key'], label: string, before: unknown, after: unknown, change: PlanChange | undefined, field: string) => {
    const entryText = marked(before, after, change, field);
    if (!text(after) && !(touched(change, field) && text(before))) return;
    const fieldChanged = touched(change, field) && (before ?? '') !== (after ?? '');
    const mark = fieldChanged && change ? { status: !text(before) ? 'added' as const : !text(after) ? 'removed' as const : 'changed' as const, summary: w.mark[!text(before) ? 'added' : !text(after) ? 'removed' : 'changed'], note: notes.get(change.key) ?? null, verbatim: false } : null;
    framing.push({ key, label, text: entryText, mark });
  };
  framed('businessGoal', w.framing.businessGoal, was?.businessGoal, plan.businessGoal, changeOf('plan', 'businessGoal'), 'businessGoal');
  framed('audience', w.framing.audience, oldAudience.role, audience.role, changeOf('plan', 'audience'), 'audience/role');
  const knowledge = (value: unknown) => (typeof value === 'string' && value in w.priorKnowledge ? w.priorKnowledge[value as 'low' | 'medium' | 'high'] : undefined);
  framed('priorKnowledge', w.framing.priorKnowledge, knowledge(oldAudience.priorKnowledge), knowledge(audience.priorKnowledge), changeOf('plan', 'audience'), 'audience/priorKnowledge');
  framed('notes', w.framing.notes, oldAudience.notes, audience.notes, changeOf('plan', 'audience'), 'audience/notes');
  const spacingOf = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()).join(', ') : '');
  framed('spacing', w.framing.spacing, spacingOf(was?.spacing), spacingOf(plan.spacing), changeOf('plan', 'spacing'), 'spacing');
  const waivers: WaiverEntry[] = list<NonNullable<Plan['waivers']>[number]>(plan.waivers).map((waiver) => ({
    code: String(waiver.code), target: text(waiver.target), approvedBy: String(waiver.approvedBy ?? ''),
    summary: w.waiver(String(waiver.code), text(waiver.target), String(waiver.approvedBy ?? '')), reason: richText(String(waiver.reason ?? ''))
  }));
  const placed = new Set(['plan:businessGoal', 'plan:audience', 'plan:spacing']);

  const oldObjective = new Map(list<Objective>(was?.objectives).map((objective) => [objective.id, objective]));
  const oldItem = new Map(list<Item>(was?.items).map((item) => [item.id, item]));
  const oldSource = new Map(list<Source>(was?.sources).map((source) => [source.id, source]));
  const sections: PlanSection[] = [
    { kind: 'framing', title: w.section.framing, empty: framing.length || waivers.length ? null : w.empty.framing, entries: framing, waivers, waiversLabel: w.framing.waivers },
    {
      kind: 'objectives', title: w.section.objectives, empty: objectives.length ? null : w.empty.objectives,
      objectives: withRemoved('objective', objectives, list<Objective>(was?.objectives)).map(({ entry: objective, removed }) => {
        const change = changeOf('objective', objective.id);
        const before = removed ? objective : oldObjective.get(objective.id);
        const after = removed ? undefined : objective;
        const number = removed ? '' : objectiveNumber.get(objective.id)!;
        return {
          id: objective.id, number, heading: removed ? capitalize(w.was.objective(oldNumber('objective', objective.id))) : w.objective(number),
          statement: marked(before?.statement, after?.statement, change, 'statement'), bloom: bloom(objective.bloom), criterion: text(objective.criterion), sources: sourceRefs(objective.sources),
          mark: markOf(change, ['statement'], w.was.objective)
        };
      })
    },
    {
      kind: 'sequence', title: w.section.sequence, empty: items.length ? null : w.empty.sequence,
      items: withRemoved('item', items, list<Item>(was?.items)).map(({ entry: item, removed }) => {
        const change = changeOf('item', item.id);
        const before = removed ? item : oldItem.get(item.id);
        const after = removed ? undefined : item;
        const number = removed ? '' : itemNumber.get(item.id)!;
        const lines = (value: unknown) => list<{ speaker?: string; text: string }>(value).filter((line) => typeof line.text === 'string');
        const voiced = lines(item.voiceover);
        const oldLines = lines(before?.voiceover);
        const voiceChanged = touched(change, 'voiceover');
        return {
          id: item.id, number, heading: removed ? capitalize(w.was.item(oldNumber('item', item.id))) : w.item(number), title: String(item.title ?? ''),
          titleChange: plainMarked(before?.title, after?.title, change, 'title'),
          kind: typeof item.kind === 'string' && item.kind in w.kind ? w.kind[item.kind as keyof DocumentWords['kind']] : String(item.kind ?? ''),
          objectives: objectiveRefs(item.objectives),
          description: text(item.description) || (touched(change, 'description') && text(before?.description)) ? marked(before?.description, after?.description, change, 'description') : null,
          voiceover: (voiceChanged && (removed || oldLines.length === voiced.length) ? (removed ? oldLines : voiced) : voiced).map((line, index) => ({
            speaker: line.speaker ? speakers.get(line.speaker) ?? line.speaker : null,
            text: voiceChanged && (removed || oldLines.length === voiced.length) ? marked(oldLines[index]?.text, removed ? undefined : line.text, change, 'voiceover') : richText(line.text)
          })),
          sources: sourceRefs(item.sources),
          mark: markOf(change, ['title', 'description', ...(voiceChanged && oldLines.length === voiced.length ? ['voiceover'] : [])], w.was.item)
        };
      })
    }
  ];

  // Texts and questions by item, with the items removed since the validated version in place.
  const itemsShown = withRemoved('item', items, list<Item>(was?.items));
  const itemRef = (item: Item, removed: boolean): ItemRef => ({ id: item.id, number: removed ? '' : itemNumber.get(item.id) ?? '', title: String(item.title ?? '') });
  const nestedOf = <T extends { id: string }>(kind: 'text' | 'question', field: 'lockedTexts' | 'questions', item: Item, removed: boolean) => {
    // A text or a question removed from the plan reads where it was (one moved to another item
    // reads there, marked).
    return withRemoved(kind, removed ? [] : list<T>(item[field]), list<T>(oldItem.get(item.id)?.[field]));
  };
  const oldText = new Map(list<Item>(was?.items).flatMap((item) => list<{ id: string; text: string; verbatim?: boolean }>(item.lockedTexts)).map((entry) => [entry.id, entry]));
  const textGroups: TextGroup[] = itemsShown.map(({ entry: item, removed }) => ({
    item: itemRef(item, removed),
    texts: nestedOf<{ id: string; text: string; verbatim?: boolean }>('text', 'lockedTexts', item, removed).map(({ entry: locked, removed: gone }, index) => {
      const change = changeOf('text', locked.id);
      const before = gone ? locked : oldText.get(locked.id);
      return {
        id: locked.id, number: gone ? '' : `${itemNumber.get(item.id)}.${index + 1}`,
        text: marked(before?.text, gone ? undefined : locked.text, change, 'text'), verbatim: locked.verbatim === true || (gone && before?.verbatim === true),
        mark: markOf(change, ['text'], (number) => w.was.text(`${oldNumber('item', change?.fromItem ?? item.id)}.${number}`))
      };
    })
  })).filter((group) => group.texts.length);
  sections.push({ kind: 'texts', title: w.section.texts, empty: textGroups.length ? null : w.empty.texts, groups: textGroups });

  const oldQuestion = new Map(list<Item>(was?.items).flatMap((item) => list<Record<string, unknown> & { id: string }>(item.questions)).map((entry) => [entry.id, entry]));
  const questionGroups: QuestionGroup[] = itemsShown.map(({ entry: item, removed }) => ({
    item: itemRef(item, removed),
    questions: nestedOf<Record<string, unknown> & { id: string }>('question', 'questions', item, removed).map(({ entry: question, removed: gone }, index) => {
      const change = changeOf('question', question.id);
      const before = gone ? question : oldQuestion.get(question.id);
      const after = gone ? undefined : question;
      const number = gone ? '' : `${itemNumber.get(item.id)}.${index + 1}`;
      const mode: QuestionEntry['mode'] = question.mode === 'multiple' || question.mode === 'numeric' ? question.mode : 'single';
      const own = Array.isArray(question.objectives) && question.objectives.length ? question.objectives : item.objectives;
      const oldOptions = new Map(list<{ id: string; text: string; feedback?: string }>(before?.options).map((option) => [String(option.id), option]));
      const nowOptions = list<{ id: string; text: string; correct: boolean; feedback?: string }>(after?.options);
      const options: OptionEntry[] = (gone ? list<{ id: string; text: string; correct: boolean; feedback?: string }>(question.options) : nowOptions).map((option, at) => {
        const field = `options/${option.id}`;
        const old = oldOptions.get(String(option.id));
        const added = !gone && !!change && change.status === 'changed' && !old;
        const optionText = marked(gone ? option.text : old?.text, gone ? undefined : option.text, change, added ? field : `${field}/text`);
        const feedback = text(option.feedback) || (old && text(old.feedback)) ? marked(gone ? option.feedback : old?.feedback, gone ? undefined : option.feedback, change, added ? field : `${field}/feedback`) : null;
        return { id: String(option.id), letter: String.fromCharCode(65 + at), text: added ? { markdown: option.text, blocks: diffRich([], parseRich(option.text)) } : optionText, correct: option.correct === true, feedback, change: added ? 'added' : null };
      });
      // Answers removed from a question still there read last, deleted.
      if (!gone && change?.status === 'changed') {
        for (const [id, old] of oldOptions) {
          if (nowOptions.some((option) => String(option.id) === id)) continue;
          const all = old as { id: string; text: string; correct?: boolean; feedback?: string };
          options.push({ id, letter: '', text: { markdown: '', blocks: diffRich(parseRich(all.text ?? ''), []) }, correct: all.correct === true, feedback: null, change: 'removed' });
        }
      }
      return {
        id: String(question.id), number, heading: gone ? capitalize(w.was.question(`${oldNumber('item', item.id)}.${index + 1}`)) : w.question(number), mode, modeLabel: w.mode[mode],
        stem: marked(before?.stem, after?.stem, change, 'stem'), objectives: objectiveRefs(own), bloom: bloom(question.bloom), options,
        numeric: mode === 'numeric' ? numericOf(question, before ?? null, gone, change, language, w, marked) : null,
        mark: markOf(change, ['stem', 'options', 'feedback'], (at) => w.was.question(`${oldNumber('item', change?.fromItem ?? item.id)}.${at}`))
      };
    })
  })).filter((group) => group.questions.length);
  sections.push({ kind: 'assessments', title: w.section.assessments, empty: questionGroups.length ? null : w.empty.assessments, groups: questionGroups });
  sections.push({
    kind: 'sources', title: w.section.sources, empty: sources.length ? null : w.empty.sources,
    sources: withRemoved('source', sources, list<Source>(was?.sources)).map(({ entry: source, removed }) => {
      const change = changeOf('source', source.id);
      const before = removed ? source : oldSource.get(source.id);
      return { id: source.id, title: String(source.title ?? ''), titleChange: plainMarked(before?.title, removed ? undefined : source.title, change, 'title'), type: text(source.type), version: text(source.version), mark: markOf(change, ['title'], w.was.source) };
    })
  });

  // Notes on changes that have no place of their own (the plan's title, its duration, its waivers).
  const elsewhere = [...notes].filter(([key]) => key.startsWith('plan:') && !placed.has(key)).map(([key, note]) => ({ label: capitalize(fieldLabel(key.slice('plan:'.length))), text: note }));

  const versionShown = shown ? versionLabel(shown.number) : null;
  return {
    format: PLAN_DOCUMENT_FORMAT,
    language,
    words,
    date,
    kicker: state === 'approved' ? w.kicker.approved : w.kicker.draft,
    title: text(course?.title) ?? String(plan.title ?? ''),
    status: { state, label: statusLabel },
    shows: { version: shown?.number ?? null, label: showsLabel, current: !target.version },
    properties,
    history,
    facts: {
      approval: validation ? { version: versionLabel(base!.number), by: validation.by, date: validation.date, reference: text(validation.reference) } : null,
      module: { durationMinutes: duration, delivery: 'SCORM 1.2', lms }
    },
    marks: diff ? { since: versionLabel(base!.number), changes: diff.changes.length } : null,
    sections,
    notes: elsewhere,
    colophon: w.colophon(String(plan.id ?? ''), versionShown, contentHash, day(date)),
    plan: { id: String(plan.id ?? ''), contentHash, version: versionShown },
    labels: {
      objectives: w.objectives, noObjective: w.noObjective, criterion: w.criterion, sources: w.sources, voiceover: w.voiceover, verbatim: w.verbatim,
      correct: w.correct, answer: w.answer, feedbackCorrect: w.feedbackCorrect, feedbackIncorrect: w.feedbackIncorrect, misconceptions: w.misconceptions,
      sourceType: w.sourceType, sourceVersion: w.sourceVersion, colon: w.colon, page: w.footerPage,
      changeAuthor: base ? w.changeAuthor(versionLabel(base.number)) : w.changeAuthor(''), noteAuthor: w.noteAuthor, notesHeading: w.notesHeading
    }
  };
}

type Marker = (before: unknown, after: unknown, change: PlanChange | undefined, field: string) => RichText;

function numericOf(question: Record<string, unknown>, before: Record<string, unknown> | null, gone: boolean, change: PlanChange | undefined, language: string, w: DocumentWords, marked: Marker): NumericEntry {
  const unit = text(question.unit);
  const amount = (value: number) => `${formatNumber(value, language)}${unit ? ` ${unit}` : ''}`;
  const tolerance = isRecord(question.tolerance) ? question.tolerance : null;
  const within = tolerance && typeof tolerance.absolute === 'number' ? amount(tolerance.absolute)
    : tolerance && typeof tolerance.percent === 'number' ? `${formatNumber(tolerance.percent, language)} %` : null;
  const feedback = isRecord(question.feedback) ? question.feedback : {};
  const oldFeedback = isRecord(before?.feedback) ? before.feedback : {};
  return {
    answer: typeof question.answer === 'number' ? amount(question.answer) : '',
    tolerance: within ? w.tolerance(within) : null,
    correct: marked(oldFeedback.correct, gone ? undefined : feedback.correct, change, 'feedback/correct'),
    incorrect: marked(oldFeedback.incorrect, gone ? undefined : feedback.incorrect, change, 'feedback/incorrect'),
    misconceptions: list<{ id: string; value: number; feedback: string }>(question.misconceptions).map((entry) => {
      const value = typeof entry.value === 'number' ? amount(entry.value) : '';
      return { id: String(entry.id), value, label: w.misconception(value), feedback: richText(String(entry.feedback ?? '')) };
    })
  };
}

export type { RichBlock };
