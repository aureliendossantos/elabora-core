import type { JournalEntry, ChangeLike, Op } from '@elabora/core/ops/types';
import { undoneChanges, summarizeBatches } from '@elabora/core/ops/batch';
import { projectPath } from '@elabora/core/project/files';
import { planDiffBetween, planVersionsView } from '@elabora/core/project/plan-versions';
import type { PlanDiffView, PlanRef, PlanVersionsView } from '@elabora/core/project/plan-versions';
import { screenParts } from '@elabora/core/project/parts';
import type { ScreenParts } from '@elabora/core/project/parts';
import { screenEstimates } from '@elabora/core/project/duration';
import { findText } from '@elabora/core/commands/text';
import type { TextMatch } from '@elabora/core/commands/text';
import { conversionTargets } from '@elabora/core/commands/convert';
import { CommandError } from '@elabora/core/commands/context';
import { planVoiceover } from '@elabora/core/commands/index';
import { screenTranslation, translationStatus, translationTable } from '@elabora/core/i18n/translate';
import type { ScreenTranslation, TranslationStatus, TranslationTable } from '@elabora/core/i18n/translate';
import { planDocument } from '@elabora/core/plan-document/model';
import type { PlanDocument } from '@elabora/core/plan-document/model';
import { dialogueView } from '@elabora/core/dialogue/view';
import type { DialogueView } from '@elabora/core/dialogue/view';
import { findDialogue } from '@elabora/core/dialogue/project';
import { playDialogue } from '@elabora/core/dialogue/play';
import type { PlayReport } from '@elabora/core/dialogue/play';
import { narrationView, timelineView, screenAt, timelineMarks } from '@elabora/core/narration/view';
import type { NarrationView } from '@elabora/core/narration/view';
import { courseSounds } from '@elabora/core/sounds/sounds';
import type { CourseSound } from '@elabora/core/sounds/sounds';
import type { TimelineView, ScreenAt, TimelineMark } from '@elabora/core/narration/view';
import { effectsOf } from '@elabora/core/narration/timeline';
import type { EffectInfo } from '@elabora/core/narration/timeline';
import { FORMAT } from '@elabora/format';
import { projectFormat, compareFormats, formatNumbers } from '@elabora/core/format/version';
import { summarizeNotes } from '@elabora/core/format/migrations/index';
import { EngineError } from './errors.ts';
import { momentTime } from './render.ts';
import type { Renderer } from './render.ts';
import type { ProjectState } from './project-state.ts';
import type { RenderedScreen } from '@elabora/core/render/screen';
import type {
  CanvasMoment, RenderScreenParams, Service, ConversionsParams, ConversionsView, DiagnosticsView, FileEntry, FileView, FormatStatus, HistoryView, ProjectSummary, ScreenView
} from '../protocol.ts';

// The requests that only read the project in memory (docs/architecture/engine.md, The base without
// Node): its files, screens, findings, narration's timeline, plan, dialogues, texts and languages,
// format, a screen rendered, and the journal's history. The same in every session; what differs is its host's: where the
// project's files and the journal come from, what is being made (media jobs), whether it is open.

export interface ReadsHost {
  readonly root: string;
  readonly state: ProjectState;
  // The renders' memory, shared with what shows them (a canvas).
  readonly renderer: Renderer;
  // The journal's entries, oldest first: the folder's, or the room's (journalOf).
  entries(): readonly JournalEntry[];
  journalSeq(): number;
  openBatch(): string | null;
  // The media jobs queued and running.
  mediaJobs(): readonly { status: string }[];
  readonly migrate: 'ask' | 'auto' | 'never' | undefined;
  // The exchange a generated line's take was cut from (said as one dialogue, D29), when the host keeps takes.
  takeDialogue?(take: { screen: string; line: string; language: string; take: number }): string | null;
  // The services the session has (D102).
  readonly services: readonly Service[];
  assertOpen(): void;
}

const ENCODER = new TextEncoder();

export class SessionReads {
  readonly #host: ReadsHost;
  readonly #state: ProjectState;

  constructor(host: ReadsHost) {
    this.#host = host;
    this.#state = host.state;
  }

  summary(): ProjectSummary {
    this.#host.assertOpen();
    const project = this.#state.project;
    const course = project.course;
    const listed = new Set<string>();
    const estimates = screenEstimates(project);
    const outline = (Array.isArray(course?.sections) ? course.sections : []).map((section) => ({
      id: String(section?.id ?? ''),
      title: String(section?.title ?? ''),
      screens: (Array.isArray(section?.screens) ? section.screens : []).map((id) => {
        listed.add(id);
        const entry = project.screens.get(id);
        const findings = this.#state.screenDiagnostics(id).filter((d) => !d.waived && !d.ignored);
        return {
          id, title: typeof entry?.data?.title === 'string' ? entry.data.title : null, file: entry?.file ?? `screens/${id}.json`,
          errors: findings.filter((d) => d.severity === 'error').length, warnings: findings.filter((d) => d.severity === 'warning').length,
          seconds: estimates.get(id)?.seconds ?? 0,
          ...placedOn(entry?.data)
        };
      })
    }));
    const jobs = this.#host.mediaJobs();
    return {
      root: this.#host.root,
      course: course ? { id: course.id, title: course.title, language: course.language, version: course.version, format: course.format } : null,
      format: this.formatStatus(),
      outline,
      unlisted: [...project.screens.keys()].filter((id) => !listed.has(id)).sort(),
      plan: (() => {
        const versions = planVersionsView(project);
        return { state: versions.state, objectives: project.plan?.objectives?.length ?? 0, items: project.plan?.items?.length ?? 0, latest: versions.latest, validated: versions.validated, sinceValidated: versions.current.sinceValidated, unversioned: versions.current.unversioned };
      })(),
      diagnostics: this.#state.summary,
      journal: { seq: this.#host.journalSeq(), openBatch: this.#host.openBatch() },
      media: { queued: jobs.filter((job) => job.status === 'queued').length, running: jobs.filter((job) => job.status === 'running').length },
      services: [...this.#host.services]
    };
  }

  listFiles(dir?: string): FileEntry[] {
    this.#host.assertOpen();
    const prefix = dir ? `${projectPath(String(dir)) ?? ''}/`.replace(/\/+$/, '/') : '';
    if (dir && prefix === '/') throw new EngineError('bad-request', `Not a folder of the project: ${dir}`);
    return [...this.#state.files]
      .filter(([rel]) => rel.startsWith(prefix))
      .map(([rel, file]): FileEntry => ({ path: rel, kind: file.kind, size: file.kind === 'text' ? ENCODER.encode(file.text).length : file.size }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  readFile(rel: string): FileView {
    this.#host.assertOpen();
    const key = projectPath(String(rel));
    const file = key === null ? undefined : this.#state.files.get(key);
    if (!file || key === null) throw new EngineError('not-found', `No file ${rel} in the project`);
    if (file.kind === 'binary') return { path: key, kind: 'binary', size: file.size, hash: file.hash ?? null };
    const error = this.#state.brokenError(key);
    return error === undefined ? { path: key, kind: 'text', text: file.text } : { path: key, kind: 'text', text: file.text, error };
  }

  readScreen(id: string): ScreenView {
    this.#host.assertOpen();
    const entry = this.#state.project.screens.get(id);
    if (!entry) throw new EngineError('not-found', `No screen "${id}"`);
    const error = this.#state.brokenError(entry.file);
    const view: ScreenView = { id, file: entry.file, data: entry.data, diagnostics: this.#state.screenDiagnostics(id) };
    if (error !== undefined) view.error = error;
    return view;
  }

  screenParts(id: string): ScreenParts {
    this.#host.assertOpen();
    const parts = screenParts(this.#state.project, id);
    if (!parts) throw new EngineError('not-found', `No screen "${id}"`);
    return parts;
  }

  // A timed screen's timeline: lines and their words, timed blocks, events (docs/decisions.md D28).
  // A narrated screen's lines in a language (default: the course's), their audio and their times,
  // and the exchange each generated line's take was cut from (said as one dialogue, D29); with
  // layer, that layer's narration (D62).
  narration(id: string, language?: string, layer?: string): NarrationView | null {
    this.#host.assertOpen();
    if (!this.#state.project.screens.has(id)) throw new EngineError('not-found', `No screen "${id}"`);
    const view = narrationView(this.#state.project, id, language || undefined, { layer: layer ?? null });
    if (!view) return null;
    for (const line of view.lines) {
      if (line.take === null || !line.generated || line.status === 'missing') continue;
      const dialogue = this.#host.takeDialogue?.({ screen: id, line: line.id, language: view.language, take: line.take });
      if (dialogue) line.dialogue = dialogue;
    }
    return view;
  }

  // The module's sounds (assets/sounds/), each with its sidecar's licence, credit and uses (D67).
  courseSounds(): CourseSound[] {
    this.#host.assertOpen();
    return courseSounds(this.#state.project);
  }

  timeline(id: string, language?: string, layer?: string): TimelineView | null {
    this.#host.assertOpen();
    if (!this.#state.project.screens.has(id)) throw new EngineError('not-found', `No screen "${id}"`);
    return timelineView(this.#state.project, id, language || undefined, { layer: layer ?? null });
  }

  // What is seen of a timed screen (or of a layer's timeline, D62) at a time, or at an anchor resolved in that language.
  timelineAt({ screen, time, at, language, layer }: { screen: string; time?: number; at?: CanvasMoment; language?: string; layer?: string }): ScreenAt | null {
    this.#host.assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    const moment = at ? momentTime(this.#state.project, screen, at, language, layer) : typeof time === 'number' ? { time } : null;
    if (!moment) throw new EngineError('bad-request', 'timelineAt takes a time (seconds) or a moment (at)');
    return screenAt(this.#state.project, screen, moment.time, language || undefined, { layer: layer ?? null });
  }

  // The marks of a timed screen (or of a layer's timeline): a storyboard, one capture per mark (null: not timed).
  timelineMarks(screen: string, language?: string, layer?: string): TimelineMark[] | null {
    this.#host.assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    return timelineMarks(this.#state.project, screen, language || undefined, { layer: layer ?? null });
  }

  effects(): EffectInfo[] {
    this.#host.assertOpen();
    return effectsOf(this.#state.project);
  }

  planVoiceover(screen: string): { item: string; speaker?: string; text: string }[] {
    this.#host.assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    return planVoiceover(this.#state.project, screen);
  }

  // The plan's versions and what changed (D52), from the project as the session holds it.
  planVersions(): PlanVersionsView {
    this.#host.assertOpen();
    return planVersionsView(this.#state.project);
  }

  planDiff({ from, to }: { from?: unknown; to?: unknown }): PlanDiffView {
    this.#host.assertOpen();
    const ref = (value: unknown, fallback: PlanRef): PlanRef => {
      if (value === undefined) return fallback;
      if (value === 'validated' || value === 'latest' || value === 'current' || (typeof value === 'number' && Number.isInteger(value) && value >= 1)) return value;
      throw new EngineError('bad-request', 'planDiff takes from and to: a version number, "validated", "latest" or "current"');
    };
    try { return planDiffBetween(this.#state.project, { from: ref(from, 'validated'), to: ref(to, 'current') }); } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('not-found', error instanceof Error ? error.message : String(error));
    }
  }

  // The plan's document (D48), from the project as the session holds it.
  planDocument(date?: string, version?: number | 'current'): PlanDocument | null {
    this.#host.assertOpen();
    try { return planDocument(this.#state.project, documentOptions(date, version)); } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('not-found', error instanceof Error ? error.message : String(error));
    }
  }

  // A dialogue for its editor (D61), from the project as the session holds it.
  dialogue(block: string): DialogueView | null {
    this.#host.assertOpen();
    if (typeof block !== 'string') throw new EngineError('bad-request', 'dialogue takes block: a dialogue block id');
    return dialogueView(this.#state.project, block);
  }

  dialoguePlay(params: { block: string; choices: string[] }): PlayReport {
    this.#host.assertOpen();
    const ref = typeof params?.block === 'string' ? findDialogue(this.#state.project, params.block) : null;
    if (!ref) throw new EngineError('not-found', `No dialogue block "${String(params?.block)}"`);
    if (!Array.isArray(params.choices) || params.choices.some((choice) => typeof choice !== 'string')) throw new EngineError('bad-request', 'dialoguePlay takes choices: option ids');
    return playDialogue(this.#state.project, ref, params.choices);
  }

  // « Transformer en… » (D63): the targets of a block, in the app's language.
  conversions(params: ConversionsParams): ConversionsView {
    this.#host.assertOpen();
    if (params?.probe === true) return { supported: true, targets: [], refused: [] };
    if (typeof params?.block !== 'string') throw new EngineError('bad-request', 'conversions takes block: a block id (or probe: true)');
    try {
      return { supported: true, ...conversionTargets(this.#state.project, params.block, params.language) };
    } catch (error) {
      if (error instanceof CommandError) throw new EngineError('not-found', error.message);
      throw error;
    }
  }

  findText(query: string, caseSensitive = false): TextMatch[] {
    this.#host.assertOpen();
    if (typeof query !== 'string') throw new EngineError('bad-request', 'findText takes a query (the words to find)');
    return findText(this.#state.project, query, { caseSensitive });
  }

  translationStatus(to?: string): TranslationStatus[] {
    this.#host.assertOpen();
    return translationStatus(this.#state.project, to ? { to } : {});
  }

  translationTable(language: string): TranslationTable {
    this.#host.assertOpen();
    try { return translationTable(this.#state.project, language); } catch (error) { throw new EngineError('bad-request', error instanceof Error ? error.message : String(error)); }
  }

  screenTranslation(screen: string, language: string): ScreenTranslation {
    this.#host.assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    try { return screenTranslation(this.#state.project, { screen, language }); } catch (error) { throw new EngineError('bad-request', error instanceof Error ? error.message : String(error)); }
  }

  diagnostics(screen?: string): DiagnosticsView {
    this.#host.assertOpen();
    const { screens, project, summary } = this.#state.diagnostics();
    if (screen !== undefined) return { screens: { [screen]: this.#state.screenDiagnostics(screen) }, project, summary };
    return { screens: Object.fromEntries(screens), project, summary };
  }

  // The journal's last changes and batches. With ops, each change says what it did, for a window
  // that did not see the changes arrive.
  history(limit = 50, options: { ops?: boolean } = {}): HistoryView {
    this.#host.assertOpen();
    const entries = this.#host.entries();
    const undone = undoneChanges(entries);
    const changes = entries.filter((entry): entry is ChangeLike => entry.type !== 'mark').slice(-limit).map((entry) => ({
      seq: entry.seq, id: entry.id, op: entry.command?.name ?? (entry.type === 'undo' ? 'undo' : entry.author.kind), at: entry.at, author: entry.author,
      batch: entry.batch, files: entry.files.map((file) => file.path), undone: undone.has(entry.id),
      ...(options.ops ? { ops: entry.ops as Op[] } : {})
    }));
    return { changes, batches: summarizeBatches(entries).slice(-limit), openBatch: this.#host.openBatch() };
  }

  // One screen as the player shows it (memoised; the canvas shows the same).
  renderScreen(params: RenderScreenParams): RenderedScreen {
    this.#host.assertOpen();
    return this.#host.renderer.render(this.#state.project, params);
  }

  // The format of the files, and what the migrate option says to do about an older one.
  formatStatus(): FormatStatus {
    const project = this.#state.project;
    const format = projectFormat(this.#state.files);
    const base = { format, latest: FORMAT, migrate: this.#host.migrate ?? 'ask' } as const;
    if (project.migration) return { ...base, state: 'outdated', changes: summarizeNotes(project.migration.notes), files: project.migration.changed };
    if (format === FORMAT) return { ...base, state: 'current' };
    if (format !== null && formatNumbers(format) !== null && compareFormats(format, FORMAT) > 0) return { ...base, state: 'newer' };
    return { ...base, state: 'unknown' };
  }
}

// What a document shows: a version (2) or « current »; the latest version by default.
export function documentOptions(date: unknown, version: unknown): { date?: string; version?: number | 'current' } {
  if (version !== undefined && version !== 'current' && !(typeof version === 'number' && Number.isInteger(version) && version >= 1)) throw new EngineError('bad-request', 'version is a version number (2) or "current"');
  return { ...(typeof date === 'string' && date ? { date } : {}), ...(version !== undefined ? { version: version as number | 'current' } : {}) };
}

// Its blocks placed by hand (D72), when it has some: « Mettre au propre » names the other screens.
function placedOn(screen: { blocks?: unknown } | undefined): { placed?: number } {
  const count = Array.isArray(screen?.blocks) ? screen.blocks.filter((block) => !!block && typeof block === 'object' && 'place' in block && !!(block as { place?: unknown }).place).length : 0;
  return count ? { placed: count } : {};
}
