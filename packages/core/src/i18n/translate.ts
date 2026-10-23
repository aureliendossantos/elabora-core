import { schemaId } from '@elabora/format';
import { planContentHash, planRefs, screenBlocks } from '../project/load.ts';
import { getRegistry } from '../components/registry.ts';
import { hasFile, readText } from '../project/files.ts';
import { stringifyJSON } from '../util/json.ts';
import { localDay } from '../util/local-day.ts';
import { validateSchema } from '@elabora/format/schemas';
import type { Project, Course, Plan, PlanVersion, Screen, TranslationApproval } from '../project/model.ts';
import { planVersionFile, versionedPlan } from '../project/plan-versions.ts';
import { extractUnits, setAt, valueAt, invariants, writeUnit } from './units.ts';
import type { TranslationUnit } from './units.ts';
import { toXliff, readXliff } from './xliff.ts';
import type { XliffDocument, XliffMark, XliffNote, XliffUnit } from './xliff.ts';
import { anchorMarkId, markersOf, placedAnchors, screenAnchors, translateAnchor } from './anchors.ts';
import type { WordAnchor } from './anchors.ts';
import { voiceLinesOf } from '../narration/voice-lines.ts';

// Translations of a course (one SCORM package per language). The source course keeps them:
//   translations/<lang>.xlf            the units, with the source text they were translated from
//   translations/<lang>.approval.json  the approval of the translated plan (its own hash)
// The translated course is generated from the source and the XLIFF (`translate build`): its design,
// objects and assets stay those of the source, and a change of the source shows up as stale units.
// Everything here works on the loaded project and returns the files to write; @elabora/node
// (translate.ts) reads and writes them.

const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const translationPath = (language: string): string => `translations/${language}.xlf`;
export const approvalPath = (language: string): string => `translations/${language}.approval.json`;

// A translated file: course.json, plan.json or a screen, with the translations applied.
export type TranslatedDocument = Course | Plan | PlanVersion | Screen;

export interface TranslationCounts {
  translated: number;
  toTranslate: number;
  stale: number;
  removed: number;
  details: { toTranslate: string[]; stale: string[]; removed: string[] };
}

export interface TranslationProblem {
  id: string; // unit id
  message: string;
}

export type TranslatedPlanState = 'missing' | 'approved' | 'approval outdated' | 'not approved';

export type TranslationStatus =
  | { language: string; exists: false }
  | { language: string; exists: true; units: number; problems: TranslationProblem[]; anchors: { toPlace: AnchorToPlace[] }; plan: TranslatedPlanState | 'not built' } & TranslationCounts;

const xliffOf = (project: Project, language: string): XliffDocument | null => {
  const text = readText(project.files, translationPath(language));
  return text === null ? null : readXliff(text);
};

function approvalOf(project: Project, language: string): TranslationApproval | null {
  const translation = project.translations.get(language);
  if (translation?.approvalError) throw new Error(`${translation.approvalFile}: ${translation.approvalError}`);
  return translation?.approval ?? null;
}

function checkLanguage(project: Project, language: string): void {
  if (!LANGUAGE_TAG.test(language || '')) throw new Error(`Language "${language}": a BCP 47 tag such as fr, de or pt-BR.`);
  if (language === project.course?.language) throw new Error(`The course is already in ${language}.`);
}

function sourceCourse(project: Project): Course {
  if (!project.course) throw new Error('The project has no course.json to translate.');
  return project.course;
}

// Compare the units of the source with an XLIFF: translated, new (never translated), stale (the
// source changed since), removed (no longer in the course).
interface UnitStatus {
  translated: string[];
  fresh: string[];
  stale: string[];
  removed: string[];
}

function compare(units: readonly TranslationUnit[], previous: XliffDocument | null): UnitStatus {
  const status: UnitStatus = { translated: [], fresh: [], stale: [], removed: [] };
  const ids = new Set(units.map((unit) => unit.id));
  for (const unit of units) {
    const translated = previous?.units.get(unit.id);
    if (!translated || translated.target == null || translated.target === '') status.fresh.push(unit.id);
    else if (translated.source !== unit.text) status.stale.push(unit.id);
    else if (translated.state === 'initial') status.fresh.push(unit.id);
    else status.translated.push(unit.id);
  }
  for (const id of previous?.units.keys() || []) if (!ids.has(id)) status.removed.push(id);
  return status;
}

// A text with its word anchors' markers, as agents read and write them (not escaped: markersOf reads it).
function marked(text: string, marks: readonly XliffMark[]): string {
  let out = '';
  let at = 0;
  for (const mark of [...marks].sort((a, b) => a.start - b.start)) {
    if (mark.start < at || mark.end > text.length) continue;
    out += `${text.slice(at, mark.start)}<mrk id="${mark.id}">${text.slice(mark.start, mark.end)}</mrk>`;
    at = mark.end;
  }
  return out + text.slice(at);
}

const counts = (status: UnitStatus): TranslationCounts => ({
  translated: status.translated.length, toTranslate: status.fresh.length, stale: status.stale.length, removed: status.removed.length,
  details: { toTranslate: status.fresh, stale: status.stale, removed: status.removed }
});

// Create or update translations/<lang>.xlf: unchanged units keep their translation; changed units keep
// the previous one as a starting point, marked initial with the previous source in a note.
// Returns the file to write (file, text) and the counts.
export function translationExport(project: Project, { to }: { to: string }): { file: string; text: string; units: number } & TranslationCounts {
  return xliffWith(project, to, new Map());
}

// The XLIFF of a language with some units translated anew (target and state), the others as the
// file has them; units the source no longer has go.
function xliffWith(project: Project, to: string, overrides: ReadonlyMap<string, { target: string | null; state: string; marks?: XliffMark[] }>): { file: string; text: string; units: number } & TranslationCounts {
  checkLanguage(project, to);
  const course = sourceCourse(project);
  const file = translationPath(to);
  const read = xliffOf(project, to);
  const previous: XliffDocument | null = overrides.size ? { srcLang: course.language, trgLang: to, ...read, units: new Map(read?.units) } : read;
  const units = extractUnits(project);
  for (const [id, { target, state, marks }] of overrides) {
    const unit = units.find((candidate) => candidate.id === id);
    if (unit && previous) previous.units.set(id, { id, source: unit.text, target, state, notes: [], ...(marks?.length ? { targetMarks: marks } : {}) });
  }
  const status = compare(units, previous);
  const xliffUnits = units.map((unit): XliffUnit => {
    const translated = previous?.units.get(unit.id);
    const notes: XliffNote[] = [{ category: 'location', text: `${unit.file} ${unit.pointer}` }, { category: 'format', text: unit.format }];
    if (unit.note) notes.push({ category: 'context', text: unit.note });
    if (unit.maxLength) notes.push({ category: 'max-length', text: String(unit.maxLength) });
    if (translated && translated.source !== unit.text && translated.target) notes.push({ category: 'previous-source', text: translated.source });
    const unchanged = translated && translated.source === unit.text && translated.target;
    return {
      id: unit.id, source: unit.text, ...(unit.marks?.length ? { sourceMarks: unit.marks } : {}),
      target: translated?.target || undefined, ...(translated?.target && translated.targetMarks?.length ? { targetMarks: translated.targetMarks } : {}),
      state: unchanged ? translated.state : 'initial', notes, ...(unit.voice ? { voice: true } : {})
    };
  });
  const text = toXliff({ srcLang: course.language, trgLang: to, original: `${course.id}@${course.version}`, units: xliffUnits });
  return { file, text, units: units.length, ...counts(status) };
}

// A language as a bilingual table (the app's « Traduction »): every unit of the source with its
// translation and what it asks for: to translate (no target yet, or one to review), stale (the
// source changed since), translated; and what breaks the text.
export type TranslationRowStatus = 'to-translate' | 'to-review' | 'stale' | 'translated';

export interface TranslationRow {
  id: string;
  file: string;
  screen: string | null;
  block: string | null;
  source: string;
  target: string | null;
  state: string;
  status: TranslationRowStatus;
  previousSource: string | null; // stale: the source it was translated from
  format: TranslationUnit['format'];
  note: string | null;
  maxLength: number | null;
  problem: string | null;
  // A narration line's word anchors (D28): each source word, and the words of the translation its
  // marker is placed on (null: to place). With the texts as XLIFF writes them, markers included.
  anchors?: { id: string; word: string; placed: WordAnchor | null }[];
  sourceMarked?: string;
  targetMarked?: string | null;
}

export interface TranslationTable {
  language: string;
  source: string; // the course's language
  exists: boolean;
  rows: TranslationRow[];
}

export function translationTable(project: Project, language: string): TranslationTable {
  checkLanguage(project, language);
  const course = sourceCourse(project);
  const xliff = xliffOf(project, language);
  const units = extractUnits(project);
  const broken = new Map(xliff ? problems(units, xliff).map((problem) => [problem.id, problem.message]) : []);
  const rows = units.map((unit): TranslationRow => {
    const translated = xliff?.units.get(unit.id);
    const target = translated?.target ?? null;
    const status: TranslationRowStatus = !target ? 'to-translate' : translated!.source !== unit.text ? 'stale' : translated!.state === 'initial' ? 'to-review' : 'translated';
    const placed = target && status !== 'stale' ? placedAnchors(target, translated?.targetMarks, language) : new Map<string, WordAnchor>();
    return {
      id: unit.id, file: unit.file, screen: /^screens\/(.+)\.json$/.exec(unit.file)?.[1] ?? null, block: unit.id.startsWith('block.') ? unit.id.split('.')[1] ?? null : null,
      source: unit.text, target, state: translated?.state ?? 'initial', status, previousSource: status === 'stale' ? translated!.source : null,
      format: unit.format, note: unit.note ?? null, maxLength: unit.maxLength ?? null, problem: broken.get(unit.id) ?? null,
      ...(unit.marks?.length ? {
        anchors: unit.marks.map((mark) => ({ id: mark.id, word: mark.word, placed: placed.get(mark.id) ?? null })),
        sourceMarked: marked(unit.text, unit.marks), targetMarked: target === null ? null : marked(target, translated?.targetMarks ?? [])
      } : {})
    };
  });
  return { language, source: course.language, exists: xliff !== null, rows };
}

// One screen in a language (the app's « En contexte »): the units it shows, as translationTable gives
// them, with where the canvas shows each: the block, and the prop path below its props that the
// canvas marks (data-t-field: options.1.label). The plan's validated texts and questions that its
// blocks show are among them, at the block that shows them. field null: the canvas marks no element
// for it (the screen title, a layer's, a step's button, a free object's words): the block's box, or
// none, shows where it is. In reading order: the screen's own units, then block after block.
export interface ScreenTranslationRow extends TranslationRow {
  field: string | null;
}

export interface ScreenTranslation {
  language: string;
  source: string;
  screen: string;
  exists: boolean;
  rows: ScreenTranslationRow[];
}

export function screenTranslation(project: Project, { screen, language }: { screen: string; language: string }): ScreenTranslation {
  const table = translationTable(project, language);
  const entry = project.screens.get(screen);
  if (!entry) throw Object.assign(new Error(`No screen "${screen}".`), { notFound: true });
  const units = new Map(extractUnits(project).map((unit) => [unit.id, unit]));
  const registry = getRegistry(project);
  const placed = [...screenBlocks(entry.data, entry.file)];
  const order = new Map(placed.map(({ block }, index) => [block.id, index]));
  // Where each unit shows: blocks' own words below their props, the plan's words where a block takes them.
  const where = new Map<string, { block: string; field: string | null }>();
  for (const { block, path } of placed) {
    const below = `${path}/props/`;
    for (const unit of units.values()) {
      if (unit.file === entry.file && unit.id.startsWith(`block.${block.id}.`) && unit.pointer.startsWith(below)) where.set(unit.id, { block: block.id, field: unit.pointer.slice(below.length).split('/').join('.') });
    }
    const descriptor = registry.get(block.type);
    const root = descriptor?.root ?? block.type;
    const props = block.props ?? {};
    if (typeof props.textRef === 'string' && !where.has(`plan.text.${props.textRef}`)) {
      where.set(`plan.text.${props.textRef}`, { block: block.id, field: root === 'heading' ? 'text' : root === 'text' || root === 'callout' ? 'markdown' : null });
    }
    if (typeof props.questionRef === 'string' && (root === 'quiz' || root === 'numeric')) {
      // The question's words become the block's props, in the same places (stem, options.1.text…).
      const prefix = `plan.question.${props.questionRef}.`;
      for (const unit of units.values()) {
        const inQuestion = /^\/items\/\d+\/questions\/\d+\/(.+)$/.exec(unit.pointer)?.[1];
        if (unit.id.startsWith(prefix) && inQuestion && !where.has(unit.id)) where.set(unit.id, { block: block.id, field: inQuestion.split('/').join('.') });
      }
    }
    // Components take a validated text anywhere in their props ({ "textRef": "TXT-n" } as a value).
    if (descriptor && !descriptor.builtin) {
      for (const ref of planRefs(props)) {
        if (ref.kind === 'textRef' && ref.path !== '/textRef' && !where.has(`plan.text.${ref.id}`)) where.set(`plan.text.${ref.id}`, { block: block.id, field: ref.path.slice(1, -'/textRef'.length).split('/').join('.') });
      }
    }
  }
  const rows = table.rows
    .filter((row) => row.file === entry.file || where.has(row.id))
    .map((row): ScreenTranslationRow => {
      const shown = where.get(row.id);
      return { ...row, block: shown?.block ?? row.block, field: shown?.field ?? null };
    });
  const rank = (row: ScreenTranslationRow): number => (row.block === null ? -1 : order.get(row.block) ?? placed.length);
  rows.sort((a, b) => rank(a) - rank(b));
  return { language, source: table.source, screen, exists: table.exists, rows };
}

// Units translated (or their translation reviewed, or cleared), the file written again: their
// source is the current one, so they are no longer stale. A language without its file yet starts with
// them. A translation that loses the source's maths, links, code or placeholders, or exceeds its
// length, is refused (and the whole batch with it).
export interface TranslatedText {
  unit: string; // a translation unit id (translationTable, elabora translate status)
  // null or empty: not translated. A narration line's word anchors as markers around the words of
  // the translation (<mrk id="w-imprimante">printer</mrk>), or placed by anchors.
  target: string | null;
  state?: 'translated' | 'reviewed' | 'final';
  // Word anchors placed on words of the translation (an editor's « Accrocher »): the marker's id
  // (TranslationRow.anchors) and the words; markers the target already has stay.
  anchors?: { id: string; word: string; occurrence?: number }[];
}

export function translateUnits(project: Project, { language, texts }: { language: string; texts: readonly TranslatedText[] }): { file: string; text: string; units: string[] } {
  checkLanguage(project, language);
  sourceCourse(project);
  if (!texts.length) throw new Error('No text to translate.');
  const units = new Map(extractUnits(project).map((unit) => [unit.id, unit]));
  const overrides = new Map<string, { target: string | null; state: string; marks?: XliffMark[] }>();
  const current = xliffOf(project, language);
  for (const { unit: id, target: written, state = 'translated', anchors } of texts) {
    const unit = units.get(id);
    if (!unit) throw new Error(`No unit "${id}" in the course.`);
    // Markers written in the text, those of the current translation when its words stay, then those placed.
    const before = current?.units.get(id);
    const read = written?.trim() ? markersOf(written, language) : null;
    const kept = read && !read.marks.length && before?.target === read.text ? before.targetMarks ?? [] : read?.marks ?? [];
    const placing = read ? markersOf(read.text, language, anchors ?? []) : null;
    const marks = placing ? [...kept.filter((mark) => !placing.marks.some((other) => other.id === mark.id || (mark.start < other.end && other.start < mark.end))), ...placing.marks].sort((a, b) => a.start - b.start) : [];
    if (anchors?.length && !read) throw new Error(`Anchors need the translation of ${id}: give its target.`);
    const unknown = (anchors ?? []).filter((anchor) => !unit.marks?.some((mark) => mark.id === anchor.id)).map((anchor) => anchor.id);
    const unknownMarks = (read?.marks ?? []).filter((mark) => !unit.marks?.some((known) => known.id === mark.id)).map((mark) => mark.id);
    unknown.push(...unknownMarks.filter((mark) => !unknown.includes(mark)));
    if (unknown.length) throw new Error(`${id} has no anchor ${unknown.join(', ')}${unit.marks?.length ? ` (its anchors: ${unit.marks.map((mark) => mark.id).join(', ')})` : ' (it has no word anchor)'}.`);
    const words = read?.text ?? null;
    if (words) {
      const source = invariants(unit.text, unit.format);
      const translated = invariants(words, unit.format);
      const lost = Object.keys(source).filter((key) => source[key] !== translated[key]);
      if (lost.length) throw new Error(`The translation of ${id} changes ${lost.join(', ')}: ${lost.map((key) => `${source[key]} in the source, ${translated[key]} here`).join('; ')}.`);
      if (unit.maxLength && words.length > unit.maxLength) throw new Error(`The translation of ${id} has ${words.length} characters, ${unit.maxLength} at most.`);
    }
    overrides.set(id, { target: words, state: words ? state : 'initial', ...(marks.length ? { marks } : {}) });
  }
  const { file, text } = xliffWith(project, language, overrides);
  return { file, text, units: [...overrides.keys()] };
}

export function translateUnit(project: Project, { language, unit, target, state = 'translated', anchors }: { language: string } & TranslatedText): { file: string; text: string } {
  const { file, text } = translateUnits(project, { language, texts: [{ unit, target, state, ...(anchors ? { anchors } : {}) }] });
  return { file, text };
}

export function translationStatus(project: Project, { to }: { to?: string } = {}): TranslationStatus[] {
  if (to) checkLanguage(project, to);
  const languages = to ? [to] : [...project.translations.keys()];
  const units = extractUnits(project);
  return languages.map((language): TranslationStatus => {
    const xliff = xliffOf(project, language);
    if (!xliff) return { language, exists: false };
    const status = compare(units, xliff);
    let plan: TranslatedPlanState | 'not built' = 'not built';
    try { plan = translatedPlanState(project, xliff, language); } catch { /* the plan may be missing */ }
    return { language, exists: true, units: units.length, ...counts(status), problems: [...problems(units, xliff), ...schemaProblems(project, xliff, units)], anchors: { toPlace: anchorsToPlace(units, xliff, language) }, plan };
  });
}

// Text readiness is separate from the human approval of the translated plan and the course's
// validation. Both CLI exit codes and agent status use this same definition.
export function translationReady(status: TranslationStatus): boolean {
  return status.exists && !status.toTranslate && !status.stale && !status.problems.length && !status.anchors.toPlace.length;
}

// Word anchors of translated narration lines whose marker the translation has not placed (D28).
export interface AnchorToPlace {
  unit: string;
  id: string;
  word: string;
}

function anchorsToPlace(units: readonly TranslationUnit[], xliff: XliffDocument, language: string): AnchorToPlace[] {
  const out: AnchorToPlace[] = [];
  for (const unit of units) {
    const translated = xliff.units.get(unit.id);
    if (!unit.marks?.length || !translated?.target || translated.source !== unit.text) continue;
    const placed = placedAnchors(translated.target, translated.targetMarks, language);
    for (const mark of unit.marks) if (!placed.has(mark.id)) out.push({ unit: unit.id, id: mark.id, word: mark.word });
  }
  return out;
}

// Translations that broke the text: maths, links, code or placeholders lost, or too long.
function problems(units: readonly TranslationUnit[], xliff: XliffDocument): TranslationProblem[] {
  const found: TranslationProblem[] = [];
  for (const unit of units) {
    const target = xliff.units.get(unit.id)?.target;
    if (!target) continue;
    const source = invariants(unit.text, unit.format);
    const translated = invariants(target, unit.format);
    for (const key of Object.keys(source)) if (source[key] !== translated[key]) found.push({ id: unit.id, message: `${key}: ${source[key]} in the source, ${translated[key]} in the translation` });
    if (unit.maxLength && target.length > unit.maxLength) found.push({ id: unit.id, message: `${target.length} characters, ${unit.maxLength} at most` });
  }
  return found;
}

// Translations the format refuses (too long for a field, empty…): the translated files checked
// against their schemas, findings traced back to their unit.
function schemaProblems(project: Project, xliff: XliffDocument, units: readonly TranslationUnit[]): TranslationProblem[] {
  const { files } = applyTargets(project, project.course, xliff, units);
  const found: TranslationProblem[] = [];
  for (const [file, data] of files) {
    const name = file === 'course.json' ? 'course' : file === 'plan.json' ? 'plan' : 'screen';
    for (const error of validateSchema(name, data)) {
      const unit = units.find((candidate) => candidate.file === file && candidate.pointer === error.path);
      if (unit) found.push({ id: unit.id, message: error.message });
    }
  }
  return found;
}

// The source documents with the translations applied, by file, in the order the units reach them;
// course and plan are the same objects as in files.
interface TranslatedFiles<C extends Course | null> {
  files: Map<string, TranslatedDocument>;
  course: C;
  plan: Plan | null;
  // Word anchors of translated lines whose marker is not placed: anchored to their line's start.
  unplaced: { screen: string; line: string; word: string; where: string }[];
}

function applyTargets<C extends Course | null>(project: Project, source: C, xliff: XliffDocument, units: readonly TranslationUnit[]): TranslatedFiles<C> {
  const course = structuredClone(source);
  const plan = project.plan ? structuredClone(project.plan) : null;
  const files = new Map<string, TranslatedDocument>();
  const documentOf = (file: string): TranslatedDocument | undefined => {
    if (!files.has(file)) {
      const document = file === 'course.json' ? course : file === 'plan.json' ? plan : screenCopy(project, file);
      if (document) files.set(file, document);
    }
    return files.get(file);
  };
  for (const unit of units) {
    const translated = xliff.units.get(unit.id);
    if (!translated?.target || translated.source !== unit.text) continue;
    const document = documentOf(unit.file);
    if (!document) continue;
    writeUnit(document, unit, translated.target);
  }
  // Word anchors follow the words their markers are placed on (D28).
  const unplaced: TranslatedFiles<C>['unplaced'] = [];
  const language = xliff.trgLang ?? '';
  for (const [screenId, entry] of project.screens) {
    const lines = new Map<string, Map<string, WordAnchor>>();
    for (const { line, unit } of voiceLinesOf(entry.data, screenId, project)) {
      const translated = xliff.units.get(unit);
      if (translated?.target && translated.source === line.text) lines.set(line.id, placedAnchors(translated.target, translated.targetMarks, language));
    }
    if (!lines.size) continue;
    const document = documentOf(entry.file) as Screen | undefined;
    if (!document) continue;
    for (const reference of screenAnchors(document)) {
      const next = translateAnchor(reference.anchor, lines);
      if (next === reference.anchor) continue;
      if (next) { reference.set(next); continue; }
      const { word, occurrence: _occurrence, ...line } = reference.anchor;
      unplaced.push({ screen: screenId, line: String(reference.anchor.line), word: String(word), where: reference.where });
      reference.set(line);
    }
  }
  documentOf('course.json');
  if (plan) documentOf('plan.json');
  return { files, course, plan, unplaced };
}

const screenCopy = (project: Project, file: string): Screen | undefined => {
  const screen = [...project.screens.values()].find((entry) => entry.file === file)?.data;
  return screen && structuredClone(screen);
};

// The translated files, in memory: course.json, plan.json and the screens with the targets applied.
// skipBroken: translations that break the text are left out (their source text stays), rather than
// stopping everything: a translation shown while it is being written (the app's « En contexte »).
function translatedFiles(project: Project, xliff: XliffDocument, language: string, { allowMissing = false, skipBroken = false }: { allowMissing?: boolean; skipBroken?: boolean } = {}): TranslatedFiles<Course> & { units: TranslationUnit[]; missing: string[]; broken: string[]; approved: boolean } {
  xliff = { ...xliff, trgLang: language };
  const source = sourceCourse(project);
  const units = extractUnits(project);
  const status = compare(units, xliff);
  const missing = [...status.fresh, ...status.stale];
  if (missing.length && !allowMissing) {
    throw Object.assign(new Error(`${missing.length} unit(s) not translated or stale (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}): run elabora translate export, translate, then build again (or --allow-missing for a draft).`), { missing });
  }
  const bad = [...problems(units, xliff), ...schemaProblems(project, xliff, units)];
  if (bad.length && !skipBroken) {
    throw Object.assign(new Error(`${bad.length} translation(s) break the text: ${bad.slice(0, 3).map((problem) => `${problem.id} (${problem.message})`).join('; ')}.`), { problems: bad });
  }
  const broken = [...new Set(bad.map((problem) => problem.id))];
  const usable = broken.length ? { ...xliff, units: new Map([...xliff.units].filter(([id]) => !broken.includes(id))) } : xliff;
  const translated = applyTargets(project, source, usable, units);
  const { course, plan } = translated;
  if (translated.unplaced.length && !allowMissing) {
    const which = translated.unplaced.slice(0, 5).map((anchor) => `« ${anchor.word} » of ${anchor.screen}/${anchor.line}`).join(', ');
    throw Object.assign(new Error(`${translated.unplaced.length} word anchor(s) not placed in the ${language} translation (${which}${translated.unplaced.length > 5 ? '…' : ''}): put each marker on the words that say the same thing (elabora translate status lists them; elabora_translate_text with <mrk id="…">…</mrk>), or --allow-missing for a draft, where they come at the start of their line.`), { unplaced: translated.unplaced });
  }
  course.language = language;
  course.id = `${source.id}-${language.toLowerCase()}`.slice(0, 48);
  course.translationOf = { id: source.id, version: source.version, language: source.language };
  let approved = false;
  if (plan && project.plan) {
    plan.translationOf = { id: project.plan.id, contentHash: planContentHash(project.plan), language: source.language };
    // The translated plan keeps its approval while its content (and so its source) is unchanged: the
    // translated course holds it as its validated version, V1 (D52); the source's versions are the
    // source language's and stay with it.
    const approval = approvalOf(project, language);
    if (approval && approval.contentHash === planContentHash(plan)) {
      approved = true;
      const frozen = versionedPlan(plan);
      translated.files.set(planVersionFile(1), {
        $schema: schemaId('plan-version'), version: 1, date: approval.date, contentHash: planContentHash(frozen), plan: frozen,
        validation: { by: approval.by, date: approval.date, ...(approval.reference ? { reference: approval.reference } : {}) }
      } satisfies PlanVersion);
    }
  }
  return { ...translated, units, missing, broken, approved };
}

function translatedPlanState(project: Project, xliff: XliffDocument, language: string): TranslatedPlanState {
  if (!project.plan) return 'missing';
  const { approved } = translatedFiles(project, xliff, language, { allowMissing: true });
  return approved ? 'approved' : hasFile(project.files, approvalPath(language)) ? 'approval outdated' : 'not approved';
}

// The translated course: course.json, plan.json and the screens with the translations applied, and
// the note that tells agents not to edit the generated copy (put at the top of its AGENTS.md).
// @elabora/node copies the rest of the source next to them.
// skipBroken (with allowMissing): translations that break the text keep their source text, listed in
// broken; the canvas and looks show a language as far as it goes.
export function translatedCourse(project: Project, { to, allowMissing = false, skipBroken = false }: { to: string; allowMissing?: boolean; skipBroken?: boolean }): { files: Map<string, TranslatedDocument>; plan: Plan | null; approved: boolean; units: TranslationUnit[]; missing: string[]; broken: string[]; unplaced: TranslatedFiles<Course>['unplaced']; agentsNote: string } {
  checkLanguage(project, to);
  const course = sourceCourse(project);
  const xliff = xliffOf(project, to);
  if (!xliff) throw new Error(`No translations/${to}.xlf: run elabora translate export --to ${to} first.`);
  const { files, plan, approved, units, missing, broken, unplaced } = translatedFiles(project, xliff, to, { allowMissing, skipBroken });
  const agentsNote = `> **Generated translation (${to}) of \`${course.id}\`.** Do not edit this folder: change the source course or its \`translations/${to}.xlf\`, then run \`elabora translate build\` again.\n\n`;
  return { files, plan, approved, units, missing, broken, unplaced, agentsNote };
}

// Approve the translated plan (a person who read it): stored with the source course, valid while the
// translated plan, and so its source, keeps the same content. Returns the file to write.
export function translationApproval(project: Project, { to, by, reference, date }: { to: string; by: string; reference?: string; date?: string }): { file: string; text: string; approval: TranslationApproval } {
  checkLanguage(project, to);
  if (!by) throw new Error('--by "<name, organisation>" is required: a person approves the translated plan.');
  const xliff = xliffOf(project, to);
  if (!xliff) throw new Error(`No translations/${to}.xlf.`);
  const { plan } = translatedFiles(project, xliff, to);
  if (!plan || !project.plan) throw new Error('The course has no plan.');
  const approval: TranslationApproval = { language: to, by, date: date || localDay(), contentHash: planContentHash(plan), sourceContentHash: planContentHash(project.plan), ...(reference ? { reference } : {}) };
  return { file: approvalPath(to), text: stringifyJSON(approval), approval };
}
