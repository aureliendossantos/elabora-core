import fs from 'node:fs';
import path from 'node:path';
import type { Author, ChangeLike, JournalEntry, Op } from '@elabora/core/ops/types';
import { diffFiles } from '@elabora/core/ops/diff';
import { invertOps } from '@elabora/core/ops/apply';
import { isJsonPath, sameContent } from '@elabora/core/ops/json';
import { isAiAuthor, summarizeBatches, undoneChanges } from '@elabora/core/ops/batch';
import { projectPath } from '@elabora/core/project/files';
import type { ProjectFiles, SourceFile } from '@elabora/core/project/files';
import type { FileInfo } from '@elabora/core/project/store';
import type { Project } from '@elabora/core/project/model';
import { planDiffBetween, planVersionsView } from '@elabora/core/project/plan-versions';
import type { PlanDiffView, PlanRef, PlanVersionsView } from '@elabora/core/project/plan-versions';
import { screenParts } from '@elabora/core/project/parts';
import { screenEstimates } from '@elabora/core/project/duration';
import { findText } from '@elabora/core/commands/text';
import type { TextMatch } from '@elabora/core/commands/text';
import { conversionTargets } from '@elabora/core/commands/convert';
import { CommandError } from '@elabora/core/commands/context';
import { screenTranslation, translationStatus, translationTable } from '@elabora/core/i18n/translate';
import type { ScreenTranslation, TranslationStatus, TranslationTable } from '@elabora/core/i18n/translate';
import { buildTranslation } from '@elabora/node/translate';
import { planDocument } from '@elabora/core/plan-document/model';
import type { PlanDocument } from '@elabora/core/plan-document/model';
import { PLAN_DOCUMENT_FORMATS, planDocumentPage, readPlanDocument, writePlanDocument } from '@elabora/node/plan-document';
import { dialoguePage, writeDialogueExport, DIALOGUE_EXPORT_FORMATS } from '@elabora/node/dialogue-export';
import type { DialogueExportFormat, ExportedDialogue } from '@elabora/node/dialogue-export';
import { dialogueView } from '@elabora/core/dialogue/view';
import type { DialogueView } from '@elabora/core/dialogue/view';
import { findDialogue } from '@elabora/core/dialogue/project';
import { playDialogue } from '@elabora/core/dialogue/play';
import type { PlayReport } from '@elabora/core/dialogue/play';
import { localDay } from '@elabora/core/util/local-day';
import type { ExportedPlanDocument, PlanDocumentFormat } from '@elabora/node/plan-document';
import type { ScreenParts } from '@elabora/core/project/parts';
import { narrationView, timelineView, screenAt, timelineMarks } from '@elabora/core/narration/view';
import type { TimelineView, ScreenAt, TimelineMark } from '@elabora/core/narration/view';
import { effectsOf } from '@elabora/core/narration/timeline';
import type { EffectInfo } from '@elabora/core/narration/timeline';
import type { NarrationView } from '@elabora/core/narration/view';
import { parseJSON } from '@elabora/core/util/json';
import { sortDiagnostics } from '@elabora/core/diagnostics/index';
import type { Diagnostic } from '@elabora/core/diagnostics/index';
import type { ValidationOptions } from '@elabora/core/validate/index';
import * as edit from '@elabora/node/edit';
import type { EditOptions, EditResult, Written } from '@elabora/node/edit';
import { keepOriginalTexts } from '@elabora/node/edit/disk';
import { withProjectLock } from '@elabora/node/journal/lock';
import { JOURNAL_DIR, JournalError, appendChange, changeFileHashes, storeChangeBlobs, storeChangeBlobsSync } from '@elabora/node/journal/journal';
import { projectDataDir } from '@elabora/node/data-dir';
import { syncArtefact } from '@elabora/node/project-files';
import { agentRulesState, updateAgentRules, AGENTS_FILE } from '@elabora/node/agent-rules';
import { hasBlob } from '@elabora/node/blobs';
import type { BlobHash } from '@elabora/node/blobs';
import { createVersion, listVersions, restore } from '@elabora/node/backups/index';
import { findVersion, newestVersionTime, summarize as summarizeVersion } from '@elabora/node/backups/store';
import type { Version, VersionReason, VersionSummary } from '@elabora/node/backups/types';
import { pruneProjectData } from '@elabora/node/project-data';
import { FsStore } from '@elabora/node/store/fs-store';
import { readSnapshot } from '@elabora/node/store/snapshot';
import type { MediaJob } from '@elabora/node/media/jobs';
import { ProjectState } from './project-state.ts';
import type { DiagnosticsDelta } from './project-state.ts';
import { JournalTail } from './journal-tail.ts';
import { WriteQueue } from './queue.ts';
import { MediaSupervisor, jobInfo } from './media.ts';
import type { MediaOptions } from './media.ts';
import { replaceMediaReferences } from '@elabora/core/commands/media';
import { commandContext, planVoiceover } from '@elabora/core/commands/index';
import { binaryFile } from '@elabora/core/project/files';
import type { FileMedia } from '@elabora/core/media/conformance';
import { isMediaAsset, mediaStatus, probeAssets } from '@elabora/node/store/media';
import { readDisk, readDiskSync, hashOf, toSourceFile, withUpdates, tryApply, pathsInside } from './disk.ts';
import type { DiskRead, SessionStore } from './disk.ts';
import { COMMANDS, commandResult, isCommandName, runNamedCommand } from './commands.ts';
import { SessionCanvas } from './session-canvas.ts';
import { SessionVoice } from './session-voice.ts';
import { SessionMonitor } from './session-monitor.ts';
import { momentTime } from './render.ts';
import type { RenderedScreen } from '@elabora/core/render/screen';
import { FORMAT } from '@elabora/format';
import { projectFormat, compareFormats, formatNumbers } from '@elabora/core/format/version';
import { summarizeNotes } from '@elabora/core/format/migrations/index';
import { build } from '@elabora/node/build';
import { WEB_NAVIGATION, WEB_PROGRESS } from '@elabora/node/build';
import type { BuildOptions, BuildResult } from '@elabora/node/build';
import { LOCK_FILE } from '@elabora/core/compile/state-model';
import { isPresetName } from '@elabora/core/media/presets';
import { EngineError, protocolError } from './errors.ts';
import type {
  BackupSummary, BuildParams, BuildView, CanvasInfo, CanvasMoment, CanvasView, ChangeSource, ChangeView, CommandArgs, CommandName, DiagnosticsView, EngineEvent, EventMessage, FileEntry, FileView,
  FormatMigrationView, FormatStatus, HistoryView, MarkResult, MediaImportResult, MediaJobInfo, ProjectSummary, RenderScreenParams, RequestMessage,
  RequestResult, RequestType, ResponseMessage, RestoreView, RunResult, ScreenView, TranslationBuildParams, TranslationBuildView, UndoView, VoiceView, GenerateVoiceParams, AlignNarrationParams, ConversionsParams, ConversionsView
} from './protocol.ts';
import { takeDialogue } from '@elabora/node/voice/index';
import type { VoiceQuery, VoiceSearchResult, VoiceAccount, VoiceEstimate, GenerateResult, TakeInfo } from '@elabora/node/voice/index';
import type { Transcript, TranscriberView, TranscriptionEstimate, TranscriptionService } from '@elabora/node/transcribe/index';
import type { AlignResult, AlignerView } from '@elabora/node/align/index';
import { narrationPeaks } from '@elabora/node/narration/peaks';
import { importNarrationFiles } from '@elabora/node/narration/audio';
import type { NarrationPeaks, ImportedFile } from '@elabora/node/narration/types';

// An editing session (docs/architecture/engine.md): one project in memory for the desktop app.
//   - Commands run one at a time through a write queue, as journaled changes under the project
//     lock (the edits of @elabora/node, given the snapshot in memory); the snapshot is updated from
//     what they wrote, the touched screens are validated again, and events tell the app.
//   - Reads answer from memory and never wait for writes.
//   - Other writers: the CLI and the MCP server (other processes) journal their changes; the
//     session reads them from the journal and applies them, never journaling them again. Programs
//     that are not Elabora tools (an agent's own file tools) leave files the journal does not
//     explain: the session journals them as one `external` change, under the project lock.
//   - AI batches close after 5 minutes without AI changes, at a human change or a mark, with an
//     after-ai version; an auto version every 5 minutes of activity; a close version on close.
//   - Media jobs run in the session's queue; their results are journaled; media dropped into
//     assets/ that are not conformant masters are converted, references rewritten.

export interface BackupOptions {
  enabled?: boolean;     // versions on the schedule below (default true)
  intervalMs?: number;   // an auto version every 5 minutes of activity
  onOpen?: boolean;      // an auto version on open when the newest is older than intervalMs (default true)
  prune?: boolean;       // prune the project's data (journal, backups) once per session (default true)
  pruneDelayMs?: number; // after opening (default 60 s), or at close when the session ends sooner
}

export interface OpenOptions {
  store?: SessionStore;          // where the files are: FsStore(dir) by default
  author?: Author;               // who the app's requests come from (default human)
  validation?: ValidationOptions; // LMS profiles, release checks
  watch?: boolean;               // watch the folder and the journal (default true)
  debounceMs?: number;           // quiet time before reconciling what changed on disk (default 60 ms)
  maxDelayMs?: number;           // longest wait during a burst of writes (default 600 ms)
  rescanIntervalMs?: number;     // list the folder now and then for changes a watcher missed (default 15 s; 0: never)
  lockTimeoutMs?: number;        // waiting for the project lock (another writer) before E_LOCKED
  batchIdleMs?: number;          // an AI batch closes after this long without AI changes (default 5 minutes)
  backups?: BackupOptions;
  media?: MediaOptions;
  // A course in an older format (read migrated in memory, I_FORMAT_OUTDATED): ask (default: the
  // summary says so, the migrate request writes the migration; an edit through the session
  // migrates first, as the CLI does), auto (migrated on open, after the open version), never
  // (writes are refused).
  migrate?: 'ask' | 'auto' | 'never';
}

// Running media jobs at close: cancel them (default: an interrupted conversion of a dropped file is
// queued again at the next open, since the file is still not conformant; an import is lost, so the
// app asks first when summary().media says imports run), wait for them, or leave them running in
// this process without journaling their result.
export interface CloseOptions {
  media?: 'leave' | 'wait' | 'cancel';
}

const FIVE_MINUTES = 5 * 60_000;
// A binary file written this recently is still being written (copied, downloaded).
const SETTLE_MS = 400;
const MAX_SETTLE_MS = 2000;
const SYSTEM: Author = { kind: 'system' };
const EXTERNAL: Author = { kind: 'external' };

interface SessionInit {
  root: string;
  store: SessionStore;
  state: ProjectState;
  tail: JournalTail;
  entries: JournalEntry[];
  stats: Map<string, FileInfo>;
  options: OpenOptions;
}

// Opens a project folder: reads its files and journal, validates it, starts watching, starts the
// project's media queue and the backup schedule.
export async function openProject(dir: string, options: OpenOptions = {}): Promise<Session> {
  const root = path.resolve(dir);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new EngineError('not-found', `No project folder at ${root}`);
  const store = options.store ?? new FsStore(root);
  const journalDir = path.join(projectDataDir(root), JOURNAL_DIR);
  fs.mkdirSync(journalDir, { recursive: true });
  const tail = new JournalTail(journalDir);
  // The journal first: a change written while the files are read is then applied again, harmlessly.
  const entries = await tail.read();
  const snapshot = await readSnapshot(store);
  const state = new ProjectState(root, snapshot.files, snapshot.artefacts, options.validation, snapshot.media);
  const session = new Session({ root, store, state, tail, entries, stats: snapshot.stats, options });
  await session.start();
  return session;
}

export class Session {
  readonly root: string;
  readonly store: SessionStore;
  readonly author: Author;
  readonly #options: OpenOptions;
  readonly #state: ProjectState;
  readonly #tail: JournalTail;
  #entries: JournalEntry[];
  readonly #queue = new WriteQueue();
  readonly #listeners = new Set<(message: EventMessage) => void>();
  readonly #monitor: SessionMonitor;
  readonly #sources = new Map<number, ChangeSource>(); // journal entries the session appended, by sequence number
  readonly #media: MediaSupervisor | null;
  #openBatch: { id: string; at: number } | null = null;
  #batchTimer: NodeJS.Timeout | null = null;
  #closures: { id: string; reason: 'idle' | 'human' | 'mark' | 'close' }[] = [];
  #versionTimer: NodeJS.Timeout | null = null;
  #versionInFlight: Promise<string | null> | null = null;
  #pruned = false;
  #timers: NodeJS.Timeout[] = [];
  #closing: Promise<{ version: string | null }> | null = null;
  #closed = false;
  #gone = false;
  #settlingSince: number | null = null;
  readonly #canvas: SessionCanvas;
  readonly #voice: SessionVoice;
  // Media: the hash each media file was probed at, what could not be read, whether ffprobe is there,
  // and whether media jobs started or finished since the media status was last given.
  readonly #mediaChecked = new Map<string, string>();
  readonly #unreadable = new Map<string, string>();
  #toolsMissing = false;
  #jobsChanged = false;

  constructor(init: SessionInit) {
    this.root = init.root;
    this.#canvas = new SessionCanvas(this.root, () => this.#state.project, (error, context) => this.#emitError(error, context));
    this.store = init.store;
    this.#state = init.state;
    this.#tail = init.tail;
    this.#entries = init.entries;
    this.#options = init.options;
    this.#monitor = new SessionMonitor(this.store, this.#tail.dir, init.stats, this.#options, () => this.#closing !== null, () => this.#queue.run(() => this.#refresh()), (error, context) => this.#emitError(error, context));
    this.author = init.options.author ?? { kind: 'human' };
    this.#voice = new SessionVoice(this.root, this.author, () => this.#state.project, this.run.bind(this), () => this.#assertOpen(), (event) => this.#emit(event));
    for (const [rel, file] of init.state.files) if (file.kind === 'binary' && file.media) this.#mediaChecked.set(rel, file.hash ?? '');
    for (const { path: rel, message } of init.state.media?.unreadable ?? []) {
      this.#unreadable.set(rel, message);
      this.#mediaChecked.set(rel, (init.state.files.get(rel) as { hash?: string } | undefined)?.hash ?? '');
    }
    this.#toolsMissing = init.state.media?.toolsMissing ?? false;
    this.#media = init.options.media?.enabled === false ? null : new MediaSupervisor(this.root, init.options.media ?? {}, {
      job: (job) => {
        this.#emit({ type: 'mediaJob', job: jobInfo(job) });
        // Its output is awaited (I_MEDIA_PROCESSING), or not any more.
        if (job.status !== 'running' || job.progress === 0) {
          this.#jobsChanged = true;
          this.#monitor.schedule();
        }
      },
      complete: (job) => this.#onMediaComplete(job),
      error: (message, context) => this.#emit({ type: 'error', message, context })
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  // Called by openProject: watchers, media queue, schedules. Resolves once the folder's watcher
  // reports what is written from then on (Store.watch, onReady; 3 s at most).
  async start(): Promise<void> {
    this.#resumeBatch();
    await this.#monitor.start();
    if (this.#media) {
      this.#media.start();
      // Media that are not conformant masters yet (dropped while the app was closed).
      if (this.#media.autoOptimize) void this.#media.optimize(this.#nonConformant([...this.#state.files.keys()]));
    }
    const backups = this.#options.backups ?? {};
    if (backups.enabled !== false && backups.onOpen !== false && this.#versionDue()) void this.#takeVersion('auto', { author: SYSTEM });
    // After the open version (versions are taken one after the other).
    if (this.#options.migrate === 'auto' && this.#state.project.migration) void this.migrate().catch((error) => this.#emitError(error, 'migrating the course format'));
    // The course's rules for agents, written by an earlier Elabora and edited by nobody: brought up to
    // date, as a system change (agent-rules.ts, D34). A course in an older format waits for its
    // migration.
    if (!this.#state.project.migration && this.#agentRulesOutdated()) void this.#change(SYSTEM, async () => this.#committed(updateAgentRules(this.root, this.#editOptions(SYSTEM)))).catch((error) => this.#emitError(error, 'updating the rules for agents'));
    if (backups.prune !== false) {
      const timer = setTimeout(() => void this.#prune().catch((error) => this.#emitError(error, 'pruning the project data')), backups.pruneDelayMs ?? 60_000);
      timer.unref();
      this.#timers.push(timer);
    }
  }

  // Ends the session: reconciles what changed last, closes the open AI batch, takes the close
  // version, prunes the project's data if the session has not yet. Requests fail afterwards.
  close(options: CloseOptions = {}): Promise<{ version: string | null }> {
    this.#closing ??= (async () => {
      this.#monitor.stop();
      for (const timer of [...this.#timers, this.#batchTimer, this.#versionTimer]) if (timer) clearTimeout(timer);
      // Results of the jobs that finish meanwhile are journaled by the queue, before what follows.
      const mode = options.media ?? 'cancel';
      if (mode !== 'leave') await this.#media?.close(mode);
      await this.#queue.run(() => this.#refresh(true)).catch((error) => this.#emitError(error, 'reconciling changes'));
      let version: string | null = null;
      await this.#queue.run(async () => {
        this.#closeOpenBatch('close');
        await this.#flushClosures();
        if (this.#options.backups?.enabled !== false) version = await this.#takeVersion('close', { author: SYSTEM });
      });
      if (this.#options.backups?.prune !== false && !this.#pruned) await this.#prune().catch((error) => this.#emitError(error, 'pruning the project data'));
      if (mode === 'leave') await this.#media?.close('leave');
      await this.#canvas.closeForSession();
      if (this.store instanceof FsStore) this.store.flush();
      this.#closed = true;
      this.#emit({ type: 'closed' });
      this.#listeners.clear();
      return { version };
    })();
    return this.#closing;
  }

  get closed(): boolean {
    return this.#closing !== null;
  }

  // ── state ──────────────────────────────────────────────────────────

  get files(): ProjectFiles { return this.#state.files; }
  get project(): Project { return this.#state.project; }
  get journalSeq(): number { return this.#tail.lastSeq; }
  get openBatch(): string | null { return this.#openBatch?.id ?? null; }

  // Receives every event as a message ready for a transport.
  subscribe(listener: (message: EventMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Waits until what the watchers reported so far is reconciled; rescan: also list the folder and
  // read the journal now, for changes a watcher has not reported yet.
  async flush(options: { rescan?: boolean } = {}): Promise<void> {
    this.#assertOpen();
    if (options.rescan) {
      this.#monitor.requestRescan();
      this.#monitor.requestJournal();
    }
    this.#monitor.clearScheduled();
    await this.#queue.run(() => this.#refresh());
  }

  // ── protocol ───────────────────────────────────────────────────────

  async handle(message: unknown): Promise<ResponseMessage> {
    const request = (message ?? {}) as Partial<RequestMessage>;
    const id = typeof request.id === 'string' ? request.id : '';
    const type = typeof request.type === 'string' ? request.type : '';
    try {
      if (!id || request.kind !== 'request' || !isRequestType(type)) throw new EngineError('bad-request', `Not a request of the engine protocol: ${JSON.stringify(message)?.slice(0, 200)}`);
      const result = await this.#dispatch(request as RequestMessage);
      return { kind: 'response', id, type, ok: true, result } as ResponseMessage;
    } catch (error) {
      return { kind: 'response', id, type, ok: false, error: protocolError(error) };
    }
  }

  async #dispatch(request: RequestMessage): Promise<RequestResult<RequestType>> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.type) {
      case 'summary': return this.summary();
      case 'readFile': return this.readFile(request.params.path);
      case 'listFiles': return this.listFiles(request.params.dir);
      case 'readScreen': return this.readScreen(request.params.screen);
      case 'screenParts': return this.screenParts(request.params.screen);
      case 'narration': return this.narration(request.params.screen, request.params.language, request.params.layer);
      case 'timeline': return this.timeline(request.params.screen, request.params.language, request.params.layer);
      case 'timelineAt': return this.timelineAt(request.params);
      case 'timelineMarks': return this.timelineMarks(request.params.screen, request.params.language, request.params.layer);
      case 'narrationPeaks': return this.narrationPeaks(request.params);
      case 'planVoiceover': return this.planVoiceover(request.params.screen);
      case 'planVersions': return this.planVersions();
      case 'planDiff': return this.planDiff(request.params ?? {});
      case 'planDocument': return this.planDocument(request.params?.date, request.params?.version);
      case 'planDocumentPage': return this.planDocumentPage(request.params?.date, request.params?.version);
      case 'exportPlanDocument': return this.exportPlanDocument(request.params);
      case 'dialogue': return this.dialogue(request.params.block);
      case 'dialoguePlay': return this.dialoguePlay(request.params);
      case 'dialoguePage': return this.dialoguePage(request.params);
      case 'exportDialogue': return this.exportDialogue(request.params);
      case 'effects': return this.effects();
      case 'transcribers': return this.transcribers(request.params.language);
      case 'transcribeRecording': return this.transcribeRecording(request.params);
      case 'transcriptionEstimate': return this.transcriptionEstimate(request.params);
      case 'transcribeLine': return this.transcribeLine(request.params);
      case 'importNarrationFiles': return this.importNarrationFiles(request.params);
      case 'findText': return this.findText(request.params.query, request.params.caseSensitive);
      case 'conversions': return this.conversions(request.params);
      case 'translationStatus': return this.translationStatus(request.params.to);
      case 'translationTable': return this.translationTable(request.params.language);
      case 'screenTranslation': return this.screenTranslation(request.params.screen, request.params.language);
      case 'buildTranslation': return this.buildTranslation(request.params);
      case 'run': {
        if (typeof request.params.command !== 'string' || !isCommandName(request.params.command)) throw new EngineError('bad-request', `Unknown command "${String(params.command)}" (commands: ${Object.keys(COMMANDS).join(', ')})`);
        return this.run(request.params.command, request.params.args, request.params.author);
      }
      case 'undo': return this.undo(request.params.seq);
      case 'undoBatch': return this.undoBatch(request.params.batch);
      case 'history': return this.history(request.params.limit, { ops: request.params.ops });
      case 'mark': return this.mark(request.params.request);
      case 'diagnostics': return this.diagnostics(request.params.screen);
      case 'importMedia': return this.importMedia(request.params.path, { to: request.params.to, name: request.params.name });
      case 'mediaJobs': return this.mediaJobs();
      case 'cancelMediaJob': return this.cancelMediaJob(request.params.id);
      case 'backups': return this.backups();
      case 'createBackup': return this.createBackup(request.params.name);
      case 'restoreBackup': return this.restoreBackup(request.params.version, request.params.paths);
      case 'renderScreen': return this.renderScreen(request.params);
      case 'openCanvas': return this.openCanvas(request.params);
      case 'canvasView': return this.canvasView(request.params);
      case 'closeCanvas': return this.closeCanvas();
      case 'migrate': return this.migrate();
      case 'voices': return this.voices(request.params.language);
      case 'installVoices': return this.installVoices(request.params.language);
      case 'setSpeakerVoice': return this.setSpeakerVoice(request.params);
      case 'generateVoice': return this.generateVoice(request.params);
      case 'voiceTakes': return this.voiceTakes(request.params);
      case 'cancelVoice': return this.cancelVoice(request.params.screen);
      case 'voiceSample': return this.voiceSample(request.params);
      case 'setVoiceKey': return this.setVoiceKey(request.params.key);
      case 'voiceAccount': return this.voiceAccount(request.params);
      case 'voiceSearch': return this.voiceSearch(request.params);
      case 'voiceEstimate': return this.voiceEstimate(request.params);
      case 'aligners': return this.aligners(request.params.language);
      case 'alignNarration': return this.alignNarration(request.params);
      case 'build': return this.build(request.params);
      case 'close': return this.close();
    }
  }

  // ── reads ──────────────────────────────────────────────────────────

  summary(): ProjectSummary {
    this.#assertOpen();
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
          seconds: estimates.get(id)?.seconds ?? 0
        };
      })
    }));
    const jobs = this.#media?.jobs() ?? [];
    return {
      root: this.root,
      course: course ? { id: course.id, title: course.title, language: course.language, version: course.version, format: course.format } : null,
      format: this.formatStatus(),
      outline,
      unlisted: [...project.screens.keys()].filter((id) => !listed.has(id)).sort(),
      plan: (() => {
        const versions = planVersionsView(project);
        return { state: versions.state, objectives: project.plan?.objectives?.length ?? 0, items: project.plan?.items?.length ?? 0, latest: versions.latest, validated: versions.validated, sinceValidated: versions.current.sinceValidated, unversioned: versions.current.unversioned };
      })(),
      diagnostics: this.#state.summary,
      journal: { seq: this.#tail.lastSeq, openBatch: this.openBatch },
      media: { queued: jobs.filter((job) => job.status === 'queued').length, running: jobs.filter((job) => job.status === 'running').length }
    };
  }

  listFiles(dir?: string): FileEntry[] {
    this.#assertOpen();
    const prefix = dir ? `${projectPath(String(dir)) ?? ''}/`.replace(/\/+$/, '/') : '';
    if (dir && prefix === '/') throw new EngineError('bad-request', `Not a folder of the project: ${dir}`);
    return [...this.#state.files]
      .filter(([rel]) => rel.startsWith(prefix))
      .map(([rel, file]): FileEntry => ({ path: rel, kind: file.kind, size: file.kind === 'text' ? Buffer.byteLength(file.text) : file.size }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  readFile(rel: string): FileView {
    this.#assertOpen();
    const key = projectPath(String(rel));
    const file = key === null ? undefined : this.#state.files.get(key);
    if (!file || key === null) throw new EngineError('not-found', `No file ${rel} in the project`);
    if (file.kind === 'binary') return { path: key, kind: 'binary', size: file.size, hash: file.hash ?? null };
    const error = this.#state.brokenError(key);
    return error === undefined ? { path: key, kind: 'text', text: file.text } : { path: key, kind: 'text', text: file.text, error };
  }

  readScreen(id: string): ScreenView {
    this.#assertOpen();
    const entry = this.#state.project.screens.get(id);
    if (!entry) throw new EngineError('not-found', `No screen "${id}"`);
    const error = this.#state.brokenError(entry.file);
    const view: ScreenView = { id, file: entry.file, data: entry.data, diagnostics: this.#state.screenDiagnostics(id) };
    if (error !== undefined) view.error = error;
    return view;
  }

  screenParts(id: string): ScreenParts {
    this.#assertOpen();
    const parts = screenParts(this.#state.project, id);
    if (!parts) throw new EngineError('not-found', `No screen "${id}"`);
    return parts;
  }

  // A narrated screen's lines in a language (default: the course's), their audio and their times,
  // and the exchange each generated line's take was cut from (said as one dialogue, D29); with
  // layer, that layer's narration (D62).
  narration(id: string, language?: string, layer?: string): NarrationView | null {
    this.#assertOpen();
    if (!this.#state.project.screens.has(id)) throw new EngineError('not-found', `No screen "${id}"`);
    const view = narrationView(this.#state.project, id, language || undefined, { layer: layer ?? null });
    if (!view) return null;
    for (const line of view.lines) {
      if (line.take === null || !line.generated || line.status === 'missing') continue;
      const dialogue = takeDialogue(this.root, { screen: id, line: line.id, language: view.language, take: line.take });
      if (dialogue) line.dialogue = dialogue;
    }
    return view;
  }

  // A timed screen's timeline: lines and their words, timed blocks, events (docs/decisions.md D28).
  timeline(id: string, language?: string, layer?: string): TimelineView | null {
    this.#assertOpen();
    if (!this.#state.project.screens.has(id)) throw new EngineError('not-found', `No screen "${id}"`);
    return timelineView(this.#state.project, id, language || undefined, { layer: layer ?? null });
  }

  // What is seen of a timed screen (or of a layer's timeline, D62) at a time, or at an anchor resolved in that language.
  timelineAt({ screen, time, at, language, layer }: { screen: string; time?: number; at?: CanvasMoment; language?: string; layer?: string }): ScreenAt | null {
    this.#assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    const moment = at ? momentTime(this.#state.project, screen, at, language, layer) : typeof time === 'number' ? { time } : null;
    if (!moment) throw new EngineError('bad-request', 'timelineAt takes a time (seconds) or a moment (at)');
    return screenAt(this.#state.project, screen, moment.time, language || undefined, { layer: layer ?? null });
  }

  // The marks of a timed screen (or of a layer's timeline): a storyboard, one capture per mark (null: not timed).
  timelineMarks(screen: string, language?: string, layer?: string): TimelineMark[] | null {
    this.#assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    return timelineMarks(this.#state.project, screen, language || undefined, { layer: layer ?? null });
  }

  // The waveform of a narrated screen's lines, decoded once per audio file (cached in the data folder).
  async narrationPeaks({ screen, language, perSecond }: { screen: string; language?: string; perSecond?: number }): Promise<NarrationPeaks | null> {
    this.#assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    return narrationPeaks(this.root, this.#state.project, screen, { ...(language ? { language } : {}), ...(typeof perSecond === 'number' ? { perSecond } : {}) });
  }

  transcribers(language?: string): TranscriberView { return this.#voice.transcribers(language); }
  async transcribeRecording({ file, language, install, service, approvedPercent }: { file: string; language?: string; install?: boolean; service?: TranscriptionService; approvedPercent?: number }): Promise<Transcript> { return this.#voice.transcribeRecording({ file, language, install, service, approvedPercent }); }
  async transcriptionEstimate({ file, screen, line, language }: { file?: string; screen?: string; line?: string; language?: string }): Promise<TranscriptionEstimate> { return this.#voice.transcriptionEstimate({ file, screen, line, language }); }
  async transcribeLine({ screen, line, language, install, service, approvedPercent }: { screen: string; line: string; language?: string; install?: boolean; service?: TranscriptionService; approvedPercent?: number }): Promise<{ before: string; transcript: Transcript; audioHash: `sha256:${string}` | null }> { return this.#voice.transcribeLine({ screen, line, language, install, service, approvedPercent }); }

  effects(): EffectInfo[] {
    this.#assertOpen();
    return effectsOf(this.#state.project);
  }

  planVoiceover(screen: string): { item: string; speaker?: string; text: string }[] {
    this.#assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    return planVoiceover(this.#state.project, screen);
  }

  // The plan's versions and what changed (D52), from the project as the session holds it.
  planVersions(): PlanVersionsView {
    this.#assertOpen();
    return planVersionsView(this.#state.project);
  }

  planDiff({ from, to }: { from?: unknown; to?: unknown }): PlanDiffView {
    this.#assertOpen();
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

  // What a document shows: a version (2) or « current »; the latest version by default.
  #documentOptions(date: unknown, version: unknown): { date?: string; version?: number | 'current' } {
    if (version !== undefined && version !== 'current' && !(typeof version === 'number' && Number.isInteger(version) && version >= 1)) throw new EngineError('bad-request', 'version is a version number (2) or "current"');
    return { ...(typeof date === 'string' && date ? { date } : {}), ...(version !== undefined ? { version: version as number | 'current' } : {}) };
  }

  // The plan's document (D48), from the project as the session holds it.
  planDocument(date?: string, version?: number | 'current'): PlanDocument | null {
    this.#assertOpen();
    try { return planDocument(this.#state.project, this.#documentOptions(date, version)); } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('not-found', error instanceof Error ? error.message : String(error));
    }
  }

  planDocumentPage(date?: string, version?: number | 'current'): { html: string; date: string; title: string; version: string | null } {
    this.#assertOpen();
    const options = this.#documentOptions(date, version);
    let doc: PlanDocument;
    try { doc = readPlanDocument(this.#state.project, options); } catch (error) { throw new EngineError('not-found', error instanceof Error ? error.message : String(error)); }
    return { html: planDocumentPage(doc), date: doc.date, title: doc.title, version: doc.plan.version };
  }

  // The document written to file, then the send recorded on the version it shows (a change of the
  // app's author), never a version made.
  async exportPlanDocument(params: { format: PlanDocumentFormat; file: string; date?: string; version?: number | 'current' }): Promise<ExportedPlanDocument> {
    this.#assertOpen();
    if (!PLAN_DOCUMENT_FORMATS.includes(params?.format)) throw new EngineError('bad-request', 'exportPlanDocument takes a format: docx, pdf or html');
    if (typeof params.file !== 'string' || !path.isAbsolute(params.file)) throw new EngineError('bad-request', 'exportPlanDocument takes file: an absolute path');
    const options = this.#documentOptions(params.date, params.version);
    let exported: ExportedPlanDocument;
    let day: string;
    try {
      day = readPlanDocument(this.#state.project, options).date;
      exported = await writePlanDocument(this.#state.project, { format: params.format, out: params.file, ...options });
    } catch (error) {
      throw new EngineError('refused', error instanceof Error ? error.message : String(error));
    }
    if (!exported.version) return exported;
    await this.run('record_plan_send', { version: exported.version, format: params.format, date: day });
    return { ...exported, sent: true };
  }

  // A dialogue for its editor (D61), from the project as the session holds it.
  dialogue(block: string): DialogueView | null {
    this.#assertOpen();
    if (typeof block !== 'string') throw new EngineError('bad-request', 'dialogue takes block: a dialogue block id');
    return dialogueView(this.#state.project, block);
  }

  dialoguePlay(params: { block: string; choices: string[] }): PlayReport {
    this.#assertOpen();
    const ref = typeof params?.block === 'string' ? findDialogue(this.#state.project, params.block) : null;
    if (!ref) throw new EngineError('not-found', `No dialogue block "${String(params?.block)}"`);
    if (!Array.isArray(params.choices) || params.choices.some((choice) => typeof choice !== 'string')) throw new EngineError('bad-request', 'dialoguePlay takes choices: option ids');
    return playDialogue(this.#state.project, ref, params.choices);
  }

  dialoguePage(params: { block: string; date?: string }): { html: string; date: string; title: string } {
    this.#assertOpen();
    const ref = typeof params?.block === 'string' ? findDialogue(this.#state.project, params.block) : null;
    if (!ref) throw new EngineError('not-found', `No dialogue block "${String(params?.block)}"`);
    return { html: dialoguePage(this.#state.project, ref.id), date: typeof params.date === 'string' && params.date ? params.date : localDay(), title: typeof ref.props.title === 'string' ? ref.props.title : ref.id };
  }

  async exportDialogue(params: { block: string; format: DialogueExportFormat; file: string; date?: string }): Promise<ExportedDialogue> {
    this.#assertOpen();
    if (!DIALOGUE_EXPORT_FORMATS.includes(params?.format)) throw new EngineError('bad-request', 'exportDialogue takes a format: html or pdf');
    if (typeof params.file !== 'string' || !path.isAbsolute(params.file)) throw new EngineError('bad-request', 'exportDialogue takes file: an absolute path');
    try {
      return await writeDialogueExport(this.#state.project, { block: params.block, to: params.format, out: params.file, ...(params.date ? { date: params.date } : {}) });
    } catch (error) {
      throw new EngineError('refused', error instanceof Error ? error.message : String(error));
    }
  }

  // Recordings of several lines, each written through the queue as set_narration_audio.
  async importNarrationFiles({ files, screen, language, keepSilence }: { files: string[]; screen?: string; language?: string; keepSilence?: boolean }, author: Author = this.author): Promise<{ language: string; files: ImportedFile[] }> {
    this.#assertOpen();
    if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) throw new EngineError('bad-request', 'importNarrationFiles takes files: absolute paths of recordings');
    if (screen !== undefined && !this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    try {
      return await importNarrationFiles(this.root, { files, ...(screen ? { screen } : {}), ...(language ? { language } : {}), trim: !keepSilence }, undefined,
        async (args) => ({ change: (await this.run('set_narration_audio', args, author)).change }));
    } catch (error) {
      throw new EngineError('refused', error instanceof Error ? error.message : String(error));
    }
  }

  // « Transformer en… » (D63): the targets of a block, in the app's language.
  conversions(params: ConversionsParams): ConversionsView {
    this.#assertOpen();
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
    this.#assertOpen();
    if (typeof query !== 'string') throw new EngineError('bad-request', 'findText takes a query (the words to find)');
    return findText(this.#state.project, query, { caseSensitive });
  }

  translationStatus(to?: string): TranslationStatus[] {
    this.#assertOpen();
    return translationStatus(this.#state.project, to ? { to } : {});
  }

  translationTable(language: string): TranslationTable {
    this.#assertOpen();
    try { return translationTable(this.#state.project, language); } catch (error) { throw new EngineError('bad-request', error instanceof Error ? error.message : String(error)); }
  }

  screenTranslation(screen: string, language: string): ScreenTranslation {
    this.#assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    try { return screenTranslation(this.#state.project, { screen, language }); } catch (error) { throw new EngineError('bad-request', error instanceof Error ? error.message : String(error)); }
  }

  diagnostics(screen?: string): DiagnosticsView {
    this.#assertOpen();
    const { screens, project, summary } = this.#state.diagnostics();
    if (screen !== undefined) return { screens: { [screen]: this.#state.screenDiagnostics(screen) }, project, summary };
    return { screens: Object.fromEntries(screens), project, summary };
  }

  // The journal's last changes and batches. With ops, each change says what it did, for a window
  // that did not see the changes arrive.
  history(limit = 50, options: { ops?: boolean } = {}): HistoryView {
    this.#assertOpen();
    const entries = this.#entries;
    const undone = undoneChanges(entries);
    const changes = entries.filter((entry): entry is ChangeLike => entry.type !== 'mark').slice(-limit).map((entry) => ({
      seq: entry.seq, id: entry.id, op: entry.command?.name ?? (entry.type === 'undo' ? 'undo' : entry.author.kind), at: entry.at, author: entry.author,
      batch: entry.batch, files: entry.files.map((file) => file.path), undone: undone.has(entry.id),
      ...(options.ops ? { ops: entry.ops as Op[] } : {})
    }));
    return { changes, batches: summarizeBatches(entries).slice(-limit), openBatch: this.openBatch };
  }

  mediaJobs(): MediaJobInfo[] {
    this.#assertOpen();
    return (this.#media?.jobs() ?? []).map(jobInfo);
  }

  backups(): BackupSummary[] {
    this.#assertOpen();
    return listVersions(this.root).map(backupSummary);
  }

  // One screen as the player shows it (memoised; the canvas shows the same).
  renderScreen(params: RenderScreenParams): RenderedScreen {
    this.#assertOpen();
    return this.#canvas.render(params);
  }

  // The format of the files, and what the migrate option says to do about an older one.
  formatStatus(): FormatStatus {
    const project = this.#state.project;
    const format = projectFormat(this.#state.files);
    const base = { format, latest: FORMAT, migrate: this.#options.migrate ?? 'ask' } as const;
    if (project.migration) return { ...base, state: 'outdated', changes: summarizeNotes(project.migration.notes), files: project.migration.changed };
    if (format === FORMAT) return { ...base, state: 'current' };
    if (format !== null && formatNumbers(format) !== null && compareFormats(format, FORMAT) > 0) return { ...base, state: 'newer' };
    return { ...base, state: 'unknown' };
  }

  async openCanvas(options: { port?: number; debug?: boolean } = {}): Promise<CanvasInfo> {
    this.#assertOpen();
    return this.#canvas.open(options);
  }

  async canvasView(change: Partial<CanvasView>): Promise<{ id: string; pages: number; view: CanvasView }> {
    this.#assertOpen();
    return this.#canvas.view(change);
  }

  async closeCanvas(): Promise<{ closed: boolean }> { return this.#canvas.close(); }

  // ── format ─────────────────────────────────────────────────────────

  // Writes the migration of a course in an older format, as one system change after a migration
  // version. Null when the course needed none.
  async migrate(): Promise<FormatMigrationView | null> {
    this.#assertOpen();
    return this.#change(SYSTEM, () => this.#migrateFormat(), { migrating: true }).then((ref) => ref && { from: ref.from, to: ref.to, change: this.#changeView(ref.seq) });
  }

  #agentRulesOutdated(): boolean {
    const file = this.#state.files.get(AGENTS_FILE);
    return file?.kind === 'text' && agentRulesState(file.text).status === 'outdated';
  }

  // Under the lock, in a write: the migration through the node edits, given the snapshot.
  async #migrateFormat(): Promise<{ from: string; to: string; seq: number | null } | null> {
    if (!this.#state.project.migration) return null;
    if (this.#options.backups?.enabled !== false) await this.#takeVersion('migration', { author: SYSTEM });
    const ref = edit.migrateIfOutdated(this.root, this.#editOptions(SYSTEM));
    if (!ref) return null;
    this.#adopt(ref.written);
    if (ref.change) this.#sources.set(ref.change.seq, 'engine');
    return { from: ref.from, to: ref.to, seq: ref.change?.seq ?? null };
  }

  // ── publishing ─────────────────────────────────────────────────────

  // Builds the SCORM package as `elabora build` does, in the write queue: the AI batch closes first,
  // what other writers left is journaled as theirs, then the build runs outside the project lock
  // (encoding renditions can take minutes; the CLI would wait). The state keys it adds to
  // elabora.lock.json are then journaled as a system change, so they never pass for an agent's edit,
  // and a successful build takes a publish version.
  async build(request: BuildParams = {}): Promise<BuildView> {
    this.#assertOpen();
    const params = request ?? {};
    const options = buildOptions(params, this.#options.validation);
    return this.#queue.run(async () => {
      this.#assertPresent();
      this.#closeOpenBatch('human');
      await this.#flushClosures();
      await this.#locked(() => this.#syncWithDisk());
      let result: BuildResult;
      let seq: number | null = null;
      try {
        result = await build(this.root, { ...options, emit: options.target === 'web' ? 'both' : 'zip', onMedia: ({ job }) => this.#emit({ type: 'mediaJob', job: jobInfo(job) }) });
      } finally {
        // Written even when the build stops after assigning keys, or fails.
        seq = await this.#locked(async () => {
          try {
            return await this.#journalLock(params);
          } finally {
            await this.#recordOwn();
          }
        });
        await this.#afterChange();
      }
      const zip = result.ok ? result.zipPath ?? null : null;
      let version: string | null = null;
      if (zip && this.#options.backups?.enabled !== false) {
        version = await this.#takeVersion('publish', { name: params.name?.trim() || publishName(this.#state.project.course?.language), author: this.author });
      }
      return {
        ok: result.ok, zip, dir: result.ok && options.target === 'web' ? result.dirPath ?? null : null, size: zip ? result.report?.package.bytes ?? 0 : 0, report: result.ok ? result.reportPath : null, summary: result.summary,
        errors: result.diagnostics.filter((d) => d.severity === 'error' && !d.waived), warnings: result.diagnostics.filter((d) => d.severity === 'warning' && !d.waived && !d.ignored),
        change: this.#changeView(seq), version
      };
    });
  }

  // Under the lock, after a build: elabora.lock.json as it wrote it, journaled as a system change
  // (the journal's new entries first, so the change starts from what other writers left).
  async #journalLock(params: BuildParams): Promise<number | null> {
    const entries = await this.#tail.read();
    if (entries.length) await this.#absorb(entries);
    this.#monitor.forget(LOCK_FILE);
    const disk = await this.#readDisk(LOCK_FILE);
    const file = fileOf(disk);
    if (disk.kind === 'unstable' || !file || sameContent(this.#state.files.get(LOCK_FILE), file)) return null;
    if (file.kind !== 'text' || parseJSON(file.text).error !== undefined) {
      this.#monitor.observe(LOCK_FILE); // not the build's: left to the watcher
      return null;
    }
    return this.#journalChange({ updates: new Map([[LOCK_FILE, file]]), author: SYSTEM, command: { name: 'build', args: params }, source: 'engine' });
  }

  // A language as its own package (the app's « Versions »): the translated course generated in the
  // project's data folder from the files as they are on disk, then built into <project>/dist. Runs in
  // the write queue (after what other writers left), outside the project lock; the source is not
  // written, and its build is not journaled: the translated copy is regenerated every time.
  async buildTranslation(request: TranslationBuildParams): Promise<TranslationBuildView> {
    this.#assertOpen();
    const params = request ?? ({} as TranslationBuildParams);
    if (typeof params.language !== 'string') throw new EngineError('bad-request', 'buildTranslation takes a language (a BCP 47 tag: en, de, pt-BR)');
    if (params.allowMissing !== undefined && typeof params.allowMissing !== 'boolean') throw new EngineError('bad-request', 'allowMissing is true or false');
    const options = buildOptions(params, this.#options.validation);
    return this.#queue.run(async () => {
      this.#assertPresent();
      await this.#locked(() => this.#syncWithDisk());
      const out = path.join(projectDataDir(this.root), 'translations', params.language);
      let made;
      try {
        made = await buildTranslation(this.root, { to: params.language, out, allowMissing: params.allowMissing === true });
      } catch (error) {
        throw new EngineError('refused', error instanceof Error ? error.message : String(error));
      }
      const result = await build(out, { ...options, emit: 'zip', out: path.join(this.root, 'dist'), onMedia: ({ job }) => this.#emit({ type: 'mediaJob', job: jobInfo(job) }) });
      const zip = result.ok ? result.zipPath ?? null : null;
      return {
        language: params.language, ok: result.ok, zip, size: zip ? result.report?.package.bytes ?? 0 : 0, report: result.ok ? result.reportPath : null,
        units: made.units, untranslated: made.untranslated, unplaced: made.unplaced, plan: made.plan, summary: result.summary,
        errors: result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error' && !diagnostic.waived),
        warnings: result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning' && !diagnostic.waived && !diagnostic.ignored)
      };
    });
  }

  // ── changes ────────────────────────────────────────────────────────

  // Runs a command as a change. author: the app's by default; an agent's command run through the
  // engine (a future in-app assistant) says so.
  async run<Name extends CommandName>(name: Name, args: CommandArgs[Name], author: Author = this.author): Promise<RunResult> {
    this.#assertOpen();
    if (!isCommandName(name)) throw new EngineError('bad-request', `Unknown command "${String(name)}"`);
    return this.#change(author, async () => {
      // An outdated course is migrated first, by its own change after a migration version.
      await this.#migrateFormat();
      const result = await runNamedCommand(name, this.root, args, this.#editOptions(author));
      return this.#committed(result);
    }).then(({ result, change }) => this.#runResult(result.op ?? name, result, change));
  }

  async undo(seq?: number, author: Author = this.author): Promise<UndoView> {
    this.#assertOpen();
    return this.#change(author, async () => this.#committed(edit.undo(this.root, seq, this.#editOptions(author))))
      .then(({ result, change }) => ({ ...this.#runResult('undo', result, change), undone: [result.undone].flat(), skipped: result.skipped }));
  }

  // « Annuler le travail de l'IA »: the last AI batch by default. A human edit made after the AI's is kept.
  async undoBatch(batch?: string, author: Author = this.author): Promise<UndoView> {
    this.#assertOpen();
    return this.#change(author, async () => this.#committed(edit.undoBatch(this.root, batch, this.#editOptions(author))))
      .then(({ result, change }) => ({ ...this.#runResult('undo_batch', result, change), undone: [result.undone].flat(), skipped: result.skipped, batch: result.batch }));
  }

  // « Demander à l'IA »: closes the AI batch, writes the mark that labels the next one, and keeps a
  // before-ai version (the newest version when nothing changed since it).
  async mark(request: string, author: Author = this.author): Promise<MarkResult> {
    this.#assertOpen();
    return this.#queue.run(async () => {
      this.#assertPresent();
      this.#closeOpenBatch('mark');
      await this.#flushClosures();
      const mark = await this.#locked(async () => {
        await this.#syncWithDisk();
        try {
          const { mark } = edit.appendMark(this.root, request, { author });
          this.#sources.set(mark.seq, 'engine');
          return mark;
        } finally {
          await this.#recordOwn();
        }
      });
      await this.#afterChange();
      const version = await this.#takeVersion('before-ai', { author });
      return { mark, version };
    });
  }

  voices(language?: string): VoiceView[] { return this.#voice.voices(language); }
  async installVoices(language: string): Promise<{ language: string; installed: boolean }> { return this.#voice.installVoices(language); }
  cancelVoice(screen?: string): { cancelled: number } { return this.#voice.cancelVoice(screen); }
  async voiceSample(params: { voice: string; provider?: string; language?: string; text: string; spend?: boolean; name?: string }): Promise<{ audio: Uint8Array; duration: number }> { return this.#voice.voiceSample(params); }
  setVoiceKey(key: string | null): { key: string | null } { return this.#voice.setVoiceKey(key); }
  async voiceAccount({ check }: { check?: boolean }): Promise<VoiceAccount> { return this.#voice.voiceAccount({ check }); }
  async voiceSearch(query: VoiceQuery): Promise<VoiceSearchResult> { return this.#voice.voiceSearch(query); }
  async voiceEstimate(params: GenerateVoiceParams): Promise<VoiceEstimate> { return this.#voice.voiceEstimate(params); }
  aligners(language?: string): AlignerView[] { return this.#voice.aligners(language); }
  async alignNarration(params: AlignNarrationParams = {}, author: Author = this.author): Promise<AlignResult> { return this.#voice.alignNarration(params, author); }
  async setSpeakerVoice({ speaker, voice, language, provider, name, settings }: { speaker: string; voice: string; language?: string; provider?: string; name?: string; settings?: Record<string, unknown> }, author: Author = this.author): Promise<{ change: number | null }> { return this.#voice.setSpeakerVoice({ speaker, voice, language, provider, name, settings }, author); }
  async generateVoice(params: GenerateVoiceParams, author: Author = this.author): Promise<GenerateResult> { return this.#voice.generateVoice(params, author); }
  voiceTakes({ screen, line, language }: { screen: string; line: string; language?: string }): { language: string; takes: TakeInfo[] } { return this.#voice.voiceTakes({ screen, line, language }); }

  async importMedia(input: string, options: { to?: string; name?: string } = {}, author: Author = this.author): Promise<MediaImportResult> {
    this.#assertOpen();
    if (!this.#media) throw new EngineError('not-available', 'Media jobs are off in this session');
    this.#assertPresent();
    const result = await this.#media.import(input, options, author);
    return { path: result.path, job: jobInfo(result.job) };
  }

  cancelMediaJob(id: string): MediaJobInfo | null {
    this.#assertOpen();
    const job = this.#media?.cancel(id) ?? null;
    if (!job) throw new EngineError('not-found', `No media job ${id}`);
    return jobInfo(job);
  }

  // A named version (« Enregistrer une version »), taken even when nothing changed.
  async createBackup(name?: string): Promise<BackupSummary | null> {
    this.#assertOpen();
    return this.#queue.run(async () => {
      const id = await this.#takeVersion('manual', { name: name ?? null, author: this.author });
      const version = id ? findVersion(this.root, id) : null;
      return version ? backupSummary(summarizeVersion(version)) : null;
    });
  }

  // Restores a version (whole, or the files matching paths): a version of the current state is taken
  // first, and the restore is journaled as one system change, so it can be undone too.
  async restoreBackup(version: string, paths?: string[]): Promise<RestoreView> {
    this.#assertOpen();
    if (!findVersion(this.root, version)) throw new EngineError('not-found', `No backup version ${version}`);
    return this.#change(SYSTEM, async () => {
      const result = await restore(this.root, version, { paths, author: this.author, skip: (rel) => this.#skipInVersions(rel) });
      const updates = new Map<string, SourceFile | null>();
      for (const change of result.changes) updates.set(change.path, fileOf(await this.#readDisk(change.path)));
      const seq = await this.#journalChange({ updates, author: SYSTEM, command: { name: 'restore_backup', args: { version, paths: paths ?? null } }, source: 'engine' });
      const before = result.before ? findVersion(this.root, result.before) : null;
      if (before?.reason === 'restore') this.#emit({ type: 'backupTaken', version: backupSummary(summarizeVersion(before)) });
      return { result, seq };
    }).then(({ result, seq }) => ({
      version: result.version, before: result.before, change: this.#changeView(seq), unavailable: result.unavailable, kept: result.kept, failed: result.failed, unmatched: result.unmatched
    }));
  }

  // ── writing ────────────────────────────────────────────────────────

  // One write: in the queue, after closing the AI batch (a human or system change ends it) and an
  // automatic version when one is due; under the project lock, after taking in what other writers
  // did; then the touched screens are validated.
  #change<T>(author: Author, work: () => Promise<T>, options: { migrating?: boolean } = {}): Promise<T> {
    return this.#queue.run(async () => {
      this.#assertPresent();
      const migration = this.#state.project.migration;
      if (migration && this.#options.migrate === 'never' && !options.migrating) {
        throw new EngineError('refused', `This course is in format ${migration.from}, older than the one this Elabora writes (${migration.to}), and the session does not migrate it: nothing is written until it is migrated (the migrate request, or elabora migrate).`, { code: 'I_FORMAT_OUTDATED' });
      }
      if (!isAiAuthor(author)) {
        this.#closeOpenBatch('human');
        await this.#flushClosures();
      }
      // A course about to be migrated gets its migration version instead.
      if (this.#options.backups?.enabled !== false && !migration && !this.#versionInFlight && this.#versionDue()) await this.#takeVersion('auto', { author: SYSTEM });
      try {
        return await this.#locked(async () => {
          await this.#syncWithDisk();
          try {
            return await work();
          } finally {
            await this.#recordOwn();
          }
        });
      } finally {
        await this.#afterChange();
      }
    });
  }

  #editOptions(author: Author): EditOptions {
    return {
      author,
      validate: false,
      autoVersion: false,
      lockTimeoutMs: this.#options.lockTimeoutMs,
      files: (stale) => {
        if (stale.length) this.#reconcileSync(stale);
        return this.#state.files;
      }
    };
  }

  // Takes in what an edit wrote, without reading the folder.
  #committed<Result extends EditResult>(result: Result): { result: Result; change: number | null } {
    // The executor migrated the course first (another writer made it outdated meanwhile).
    if (result.formatMigration) {
      this.#adopt(result.formatMigration.written);
      if (result.formatMigration.change) this.#sources.set(result.formatMigration.change.seq, 'engine');
    }
    this.#adopt(result.written);
    if (result.change) this.#sources.set(result.change.seq, 'engine');
    return { result, change: result.change?.seq ?? null };
  }

  #adopt(written: Written | undefined): void {
    if (!written) return;
    const updates = new Map<string, SourceFile | null>();
    for (const [rel, file] of written.after) if (written.before.get(rel) !== file) updates.set(rel, toSourceFile(this.root, rel, file));
    for (const rel of written.before.keys()) if (!written.after.has(rel)) updates.set(rel, null);
    for (const rel of updates.keys()) this.#recordStatSync(rel);
    this.#state.update(updates);
  }

  #runResult(command: string, result: EditResult, seq: number | null): RunResult {
    const touched = new Set(result.files);
    const { screens, project, summary } = this.#state.diagnostics();
    const all: Diagnostic[] = [...project];
    for (const list of screens.values()) all.push(...list);
    return {
      command, change: seq === null ? null : this.#changeView(seq), files: result.files, result: commandResult(result),
      diagnostics: sortDiagnostics(all.filter((d) => touched.has(d.file ?? '') || (d.severity === 'error' && !d.waived))), summary
    };
  }

  #changeView(seq: number | null): ChangeView | null {
    if (seq === null) return null;
    const entry = this.#entries.find((candidate): candidate is ChangeLike => candidate.seq === seq && candidate.type !== 'mark');
    return entry ? changeView(entry) : null;
  }

  #locked<T>(work: () => Promise<T>): Promise<T> {
    return withProjectLock(this.root, work, { timeoutMs: this.#options.lockTimeoutMs });
  }

  // Under the lock: the journal's new entries first (other processes' changes), then the files
  // that changed on disk without a journal entry.
  async #syncWithDisk(): Promise<void> {
    const entries = await this.#tail.read();
    if (entries.length) await this.#absorb(entries);
    if (this.#monitor.needsRescan) await this.#rescan();
    await this.#reconcileDirty();
  }

  // Entries the session appended are recorded; the others are applied to the snapshot.
  async #absorb(entries: JournalEntry[]): Promise<void> {
    const foreign = entries.filter((entry) => !this.#sources.has(entry.seq));
    if (foreign.length) await this.#applyForeign(foreign);
    this.#record(entries);
    for (const entry of entries) {
      if (entry.type !== 'mark') this.#emit({ type: 'changed', source: this.#sources.get(entry.seq) ?? 'journal', change: changeView(entry) });
      this.#sources.delete(entry.seq);
    }
  }

  // Reads what the session itself just appended.
  async #recordOwn(): Promise<void> {
    const entries = await this.#tail.read();
    if (entries.length) await this.#absorb(entries);
  }

  // Changes of other processes: each touched file is read back when it holds what the journal says
  // it holds after them (its exact text). A file written again since (by a program that is not a
  // Elabora tool) gets the journal's version, and the difference is reconciled as an external change.
  async #applyForeign(entries: JournalEntry[]): Promise<void> {
    const changes = entries.filter((entry): entry is ChangeLike => entry.type !== 'mark');
    const expected = new Map<string, string | null>();
    for (const change of changes) for (const file of change.files) expected.set(file.path, file.after);
    const updates = new Map<string, SourceFile | null>();
    let applied: ReturnType<typeof tryApply> | undefined;
    for (const [rel, hash] of expected) {
      const disk = await this.#readDisk(rel);
      if (disk.kind !== 'unstable' && hashOf(fileOf(disk)) === hash) {
        updates.set(rel, fileOf(disk));
        continue;
      }
      applied ??= tryApply(this.#state.files, changes.flatMap((change) => change.ops));
      // When the operations do not apply, the snapshot was behind the journal: the disk is taken as it is.
      updates.set(rel, applied ? toSourceFile(this.root, rel, applied.get(rel)) : fileOf(disk));
      this.#monitor.observe(rel);
    }
    this.#state.update(updates);
    for (const [rel, file] of updates) if (file) this.#state.setBroken(rel, null);
  }

  // Under the lock: files that changed on disk and that no journal entry explains, journaled as one
  // external change. A JSON file that does not parse is left as the snapshot has it (reported).
  async #reconcileDirty(): Promise<void> {
    const paths = this.#monitor.takePending((rel) => this.#media?.owns(rel) ?? false);
    if (!paths.length) return;
    // Read everything first: a folder removed brings its files, and while a binary file is still
    // being written the whole burst waits for it (an agent copying a video and editing the screen
    // that shows it makes one change), up to MAX_SETTLE_MS.
    const reads = new Map<string, DiskRead>();
    for (let index = 0; index < paths.length; index++) {
      const rel = paths[index];
      const disk = await this.#readDisk(rel, true);
      reads.set(rel, disk);
      // A folder reported (removed, or on Windows any folder whose files change) brings its files,
      // except those a media job will write or replace: they are the job's to journal.
      if (disk.kind === 'missing' && !this.#state.files.has(rel)) {
        for (const child of pathsInside(this.#state.files, rel)) if (!paths.includes(child) && !this.#media?.owns(child)) paths.push(child);
      }
    }
    const settling = [...reads.values()].some((disk) => disk.kind === 'unstable');
    if (settling && Date.now() - (this.#settlingSince ??= Date.now()) < MAX_SETTLE_MS) {
      for (const rel of paths) this.#monitor.observe(rel);
      this.#monitor.scheduleRetry();
      return;
    }
    this.#settlingSince = null;
    const updates = new Map<string, SourceFile | null>();
    let artefacts = [...this.#state.artefacts];
    const known = new Set(this.#state.files.keys());
    for (const [rel, disk] of reads) {
      if (disk.kind === 'unstable') {
        this.#monitor.observe(rel);
        continue;
      }
      const current = this.#state.files.get(rel);
      if (disk.kind === 'missing') {
        artefacts = artefacts.filter((artefact) => artefact.path !== rel);
        this.#state.setBroken(rel, null);
        if (current) updates.set(rel, null);
        // A new folder: its files are listed.
        else if (!pathsInside(this.#state.files, rel).length) this.#monitor.requestRescan();
        continue;
      }
      if (!current) {
        const artefact = syncArtefact(rel, new Set([...known, rel]));
        if (artefact) {
          if (!artefacts.some((existing) => existing.path === rel)) artefacts.push(artefact);
          continue;
        }
      }
      if (sameContent(current, disk.file)) {
        this.#state.setBroken(rel, null);
        continue;
      }
      if (isJsonPath(rel) && disk.file.kind === 'text') {
        const parsed = parseJSON(disk.file.text);
        if (parsed.error !== undefined) {
          // Being written (or broken): the last valid content stays; a new file waits outside the
          // snapshot until it parses (its creation is then one change). A file broken since the
          // session opened has no valid content to keep: its new text is taken without a journal entry.
          if (current && !(current.kind === 'text' && parseJSON(current.text).error === undefined)) this.#state.update([[rel, disk.file]]);
          else this.#state.setBroken(rel, parsed.error);
          continue;
        }
      }
      this.#state.setBroken(rel, null);
      updates.set(rel, disk.file);
    }
    this.#state.setArtefacts(artefacts);
    if (this.#monitor.pending().some((rel) => !this.#media?.owns(rel))) this.#monitor.scheduleRetry();
    if (!updates.size) return;
    try {
      await this.#journalChange({ updates, author: EXTERNAL, source: 'watcher' });
    } catch (error) {
      // A file changed again while its content was stored: everything is read again shortly.
      if (!(error instanceof JournalError)) throw error;
      for (const rel of updates.keys()) this.#monitor.observe(rel);
      this.#monitor.scheduleRetry();
      return;
    }
    await this.#recordOwn();
  }

  // The same for the files an edit finds changed on disk while it runs (synchronously, from inside
  // the edit): journaled as an external change before the edit is computed again.
  #reconcileSync(paths: readonly string[]): void {
    const updates = new Map<string, SourceFile | null>();
    for (const rel of paths) {
      const disk = readDiskSync(this.root, rel);
      if (disk.kind === 'unstable') continue;
      const file = fileOf(disk);
      const current = this.#state.files.get(rel);
      if (file === null ? current === undefined : sameContent(current, file)) continue;
      // Mid-write: the edit tries again, and fails with E_CONFLICT if the file stays broken.
      if (file?.kind === 'text' && isJsonPath(rel) && parseJSON(file.text).error !== undefined) continue;
      updates.set(rel, file);
      if (disk.kind === 'file') this.#monitor.recordStat(rel, disk.info);
    }
    if (!updates.size) return;
    const { before, after, ops, inverse, unavailable } = this.#prepareChange(updates);
    if (ops.length) {
      storeChangeBlobsSync(this.root, { ops, inverse, unavailable });
      keepOriginalTexts(this.root, before, ops);
      const entry = appendChange(this.root, { author: EXTERNAL, ops, inverse, files: changeFileHashes(before, after, ops), unavailable });
      this.#sources.set(entry.seq, 'watcher');
    }
    this.#state.update(updates);
    for (const rel of updates.keys()) this.#state.setBroken(rel, null);
  }

  // The change a set of new contents makes. A binary file another program overwrote or deleted
  // before any version or change kept its content cannot come back: the change says so
  // (unavailable), and undo will skip that part.
  #prepareChange(updates: ReadonlyMap<string, SourceFile | null>) {
    const before = this.#state.files;
    const after = withUpdates(before, updates);
    const ops = diffFiles(before, after);
    const inverse = invertOps(before, ops);
    const written = new Set(ops.flatMap((op) => (op.op === 'write' && 'blob' in op ? [op.blob] : [])));
    const unavailable = [...new Set(inverse.flatMap((op) => (op.op === 'write' && 'blob' in op && !written.has(op.blob) && !hasBlob(this.root, op.blob as BlobHash) ? [op.blob] : [])))];
    return { before, after, ops, inverse, unavailable };
  }

  // Journals new contents as one change: files already on disk (what another program or a job
  // wrote), and files the session writes now (write: references rewritten).
  async #journalChange(spec: { updates: Map<string, SourceFile | null>; author: Author; command?: { name: string; args: unknown }; source: ChangeSource; write?: ReadonlyMap<string, SourceFile> }): Promise<number | null> {
    const { before, after, ops, inverse, unavailable } = this.#prepareChange(spec.updates);
    let seq: number | null = null;
    if (ops.length) {
      await storeChangeBlobs(this.root, { ops, inverse, unavailable });
      keepOriginalTexts(this.root, before, ops);
      for (const [rel, file] of spec.write ?? []) {
        if (file.kind === 'text') await this.store.write(rel, file.text);
        await this.#readDisk(rel);
      }
      const entry = appendChange(this.root, { author: spec.author, ...(spec.command ? { command: spec.command } : {}), ops, inverse, files: changeFileHashes(before, after, ops), unavailable });
      this.#sources.set(entry.seq, spec.source);
      seq = entry.seq;
    }
    this.#state.update(spec.updates);
    for (const rel of spec.updates.keys()) this.#state.setBroken(rel, null);
    return seq;
  }

  // Validates what changed and tells the app (the canvas first); then the AI batches that ended.
  async #afterChange(): Promise<void> {
    await this.#refreshMedia();
    this.#canvas.changed(this.#state.takeChanged(), this.#tail.lastSeq);
    const delta = this.#state.validate();
    if (delta) this.#emit(diagnosticsEvent(delta));
    await this.#flushClosures();
  }

  // ── media status ───────────────────────────────────────────────────

  // Media files of assets/ new or changed since they were probed get their verdict (the probe
  // cache answers for files the CLI already probed); the media status follows (jobs under way,
  // unreadable files, ffprobe), and media that are not conformant masters are converted.
  async #refreshMedia(): Promise<void> {
    const files = this.#state.files;
    const toProbe = [...files].filter(([rel, file]) => file.kind === 'binary' && !file.media && isMediaAsset(rel) && this.#mediaChecked.get(rel) !== (file.hash ?? '')).map(([rel]) => rel);
    let statusChanged = this.#jobsChanged;
    for (const rel of [...this.#unreadable.keys()]) {
      if (files.has(rel)) continue;
      this.#unreadable.delete(rel);
      statusChanged = true;
    }
    const verdicts: [string, FileMedia][] = [];
    if (toProbe.length) {
      const probed = await probeAssets(this.root, toProbe, { tools: this.#options.media?.tools });
      const updates: [string, SourceFile][] = [];
      for (const rel of toProbe) {
        const file = files.get(rel);
        const now = this.#state.files.get(rel);
        // Changed again while it was probed: the next refresh probes it.
        if (file?.kind !== 'binary' || now?.kind !== 'binary' || now.hash !== file.hash) continue;
        this.#mediaChecked.set(rel, file.hash ?? '');
        const media = probed.media.get(rel);
        if (this.#unreadable.delete(rel)) statusChanged = true;
        if (!media) continue;
        updates.push([rel, binaryFile(file.size, { ...(file.hash ? { hash: file.hash } : {}), media })]);
        verdicts.push([rel, media]);
      }
      for (const { path: rel, message } of probed.unreadable) {
        this.#unreadable.set(rel, message);
        statusChanged = true;
      }
      if (probed.toolsMissing !== this.#toolsMissing && (probed.toolsMissing || probed.media.size)) {
        this.#toolsMissing = probed.toolsMissing;
        statusChanged = true;
      }
      this.#state.update(updates);
    }
    if (statusChanged) {
      this.#jobsChanged = false;
      this.#state.setMedia(mediaStatus(this.root, { unreadable: [...this.#unreadable].map(([rel, message]) => ({ path: rel, message })), toolsMissing: this.#toolsMissing }));
    }
    if (this.#media?.autoOptimize) {
      const waiting = this.#nonConformant(verdicts.map(([rel]) => rel));
      if (waiting.length) void this.#media.optimize(waiting);
    }
  }

  // Media files of assets/ the snapshot says are not conformant masters.
  #nonConformant(paths: readonly string[]): string[] {
    return paths.filter((rel) => {
      const file = this.#state.files.get(rel);
      return file?.kind === 'binary' && file.media !== undefined && !file.media.conformant;
    });
  }

  // Raw media waiting for conversion are inputs, not sources: versions leave them out.
  #skipInVersions(rel: string): boolean {
    return this.#nonConformant([rel]).length > 0 || (this.#media?.replaced(rel) ?? false);
  }

  // ── watching ───────────────────────────────────────────────────────

  // What the watchers reported. The lock is taken only when something is new: the session's own
  // writes come back from the watchers as files that hold what the snapshot holds.
  async #refresh(final = false): Promise<void> {
    // A project folder moved or deleted while open is not a deletion of every file: nothing is
    // journaled, and the app is told (it closes the session).
    if (!fs.existsSync(this.root)) {
      this.#monitor.forgetAll();
      if (!this.#gone) this.#emit({ type: 'error', context: 'watching the project', message: `The project folder ${this.root} is gone (moved or deleted).` });
      this.#gone = true;
      return;
    }
    this.#gone = false;
    let needLock = false;
    if (this.#monitor.consumeJournal() || final) {
      needLock = await this.#tail.hasNew();
    }
    if (this.#monitor.needsRescan || final) await this.#rescan();
    if (!needLock) needLock = await this.#dirtyChanged();
    if (needLock) await this.#locked(() => this.#syncWithDisk());
    await this.#afterChange();
  }

  // Whether a reported file differs from the snapshot; the ones that do not are settled here.
  async #dirtyChanged(): Promise<boolean> {
    for (const rel of this.#monitor.pending()) {
      if (this.#media?.owns(rel)) continue;
      const disk = await this.#readDisk(rel, true);
      if (disk.kind === 'unstable') return true;
      const current = this.#state.files.get(rel);
      if (disk.kind === 'missing') {
        if (current || pathsInside(this.#state.files, rel).length || this.#state.artefacts.some((artefact) => artefact.path === rel)) return true;
        this.#monitor.forget(rel);
        continue;
      }
      if (!sameContent(current, disk.file)) return true;
      this.#monitor.forget(rel);
      this.#state.setBroken(rel, null);
    }
    return false;
  }

  // Lists the folder: files whose size or time changed since they were read, new and gone files.
  async #rescan(): Promise<void> {
    this.#monitor.finishRescan();
    this.#jobsChanged = true; // jobs of other processes are seen through their job files
    const listed = await this.store.list();
    const seen = new Set<string>();
    for (const info of listed) {
      seen.add(info.path);
      const known = this.#monitor.stat(info.path);
      if (!known || known.size !== info.size || known.mtimeMs !== info.mtimeMs) this.#monitor.observe(info.path);
    }
    for (const rel of this.#state.files.keys()) if (!seen.has(rel)) this.#monitor.observe(rel);
    for (const artefact of this.#state.artefacts) if (!seen.has(artefact.path)) this.#monitor.observe(artefact.path);
  }

  async #readDisk(rel: string, settle = false): Promise<DiskRead> {
    const disk = await readDisk(this.store, rel, { settleMs: settle ? SETTLE_MS : 0 });
    if (disk.kind === 'file') this.#monitor.recordStat(rel, disk.info);
    else if (disk.kind === 'missing') this.#monitor.forgetStat(rel);
    return disk;
  }

  #recordStatSync(rel: string): void {
    try {
      const stat = fs.statSync(path.join(this.root, ...rel.split('/')));
      this.#monitor.recordStat(rel, { path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      this.#monitor.forgetStat(rel);
    }
  }

  // ── journal entries, batches and versions ──────────────────────────

  #record(entries: readonly JournalEntry[]): void {
    for (const entry of entries) {
      this.#entries.push(entry);
      this.#noteBatch(entry);
    }
    if (entries.some((entry) => entry.type !== 'mark')) this.#noteActivity();
  }

  #noteBatch(entry: JournalEntry): void {
    if (entry.type === 'mark') {
      this.#closeOpenBatch('mark');
      return;
    }
    if (!isAiAuthor(entry.author)) {
      this.#closeOpenBatch('human');
      return;
    }
    if (this.#openBatch && this.#openBatch.id !== entry.batch) this.#closeOpenBatch('idle');
    this.#openBatch = { id: entry.batch, at: Date.now() };
    this.#armBatchTimer(this.#options.batchIdleMs ?? FIVE_MINUTES);
  }

  // An AI batch still open when the session starts (an agent worked moments ago).
  #resumeBatch(): void {
    const last = this.#entries[this.#entries.length - 1];
    if (!last || last.type === 'mark' || !isAiAuthor(last.author)) return;
    const idle = this.#options.batchIdleMs ?? FIVE_MINUTES;
    const age = Date.now() - Date.parse(last.at);
    if (!(age < idle)) return;
    this.#openBatch = { id: last.batch, at: Date.now() - age };
    this.#armBatchTimer(idle - age);
  }

  #armBatchTimer(delay: number): void {
    if (this.#batchTimer) clearTimeout(this.#batchTimer);
    const batch = this.#openBatch?.id;
    this.#batchTimer = setTimeout(() => {
      this.#batchTimer = null;
      void this.#queue.run(async () => {
        if (!this.#openBatch || this.#openBatch.id !== batch) return;
        this.#closeOpenBatch('idle');
        await this.#flushClosures();
      }).catch((error) => this.#emitError(error, 'closing the AI batch'));
    }, Math.max(0, delay));
    this.#batchTimer.unref();
  }

  #closeOpenBatch(reason: 'idle' | 'human' | 'mark' | 'close'): void {
    if (!this.#openBatch) return;
    this.#closures.push({ id: this.#openBatch.id, reason });
    this.#openBatch = null;
    if (this.#batchTimer) clearTimeout(this.#batchTimer);
    this.#batchTimer = null;
  }

  // The after-ai versions of the batches that ended (outside the project lock: other writers go on).
  async #flushClosures(): Promise<void> {
    while (this.#closures.length) {
      const { id, reason } = this.#closures.shift() as { id: string; reason: 'idle' | 'human' | 'mark' | 'close' };
      const version = this.#options.backups?.enabled === false ? null : await this.#takeVersion('after-ai', { batch: id, author: SYSTEM });
      this.#emit({ type: 'batchClosed', batch: id, reason, version });
    }
  }

  // An auto version every intervalMs of activity: after a change, once the newest version is that old.
  #noteActivity(): void {
    if (this.#options.backups?.enabled === false || this.#versionTimer || this.#closing) return;
    const interval = this.#options.backups?.intervalMs ?? FIVE_MINUTES;
    const newest = newestVersionTime(this.root) ?? 0;
    this.#versionTimer = setTimeout(() => {
      this.#versionTimer = null;
      void this.#queue.run(() => this.#takeVersion('auto', { author: SYSTEM })).catch((error) => this.#emitError(error, 'taking a version'));
    }, Math.max(1000, newest + interval - Date.now()));
    this.#versionTimer.unref();
  }

  #versionDue(): boolean {
    const newest = newestVersionTime(this.root);
    return newest === null || Date.now() - newest >= (this.#options.backups?.intervalMs ?? FIVE_MINUTES);
  }

  // Takes a version (one at a time). Returns its id, or the newest version's when nothing changed.
  #takeVersion(reason: VersionReason, extra: { name?: string | null; batch?: string | null; author?: Author } = {}): Promise<string | null> {
    const take = async (): Promise<string | null> => {
      if (!fs.existsSync(this.root)) return null; // a version would recreate a folder that was moved or deleted
      try {
        const version: Version | null = await createVersion(this.root, {
          reason, name: extra.name ?? null, batch: extra.batch ?? null, author: extra.author ?? this.author,
          skip: (rel) => this.#skipInVersions(rel)
        });
        if (version) {
          this.#emit({ type: 'backupTaken', version: backupSummary(summarizeVersion(version)) });
          return version.id;
        }
        const versions = listVersions(this.root);
        return versions.length ? versions[versions.length - 1].id : null;
      } catch (error) {
        this.#emitError(error, `taking a ${reason} version`);
        return null;
      }
    };
    const next = (this.#versionInFlight ?? Promise.resolve(null)).then(take, take);
    this.#versionInFlight = next;
    void next.finally(() => { if (this.#versionInFlight === next) this.#versionInFlight = null; });
    return next;
  }

  // Once per session: the journal (30 days) and the backups (retention, garbage collection), under
  // the project lock so that no change appends a reference to a blob being collected.
  async #prune(): Promise<void> {
    if (this.#pruned || !fs.existsSync(this.root)) return;
    this.#pruned = true;
    await this.#queue.run(() => this.#locked(async () => {
      await this.#syncWithDisk();
      await pruneProjectData(this.root);
      // The journal as it is kept now (everything was read: the lock is held).
      this.#tail.reset();
      this.#entries = await this.#tail.read();
    }));
  }

  // ── media ──────────────────────────────────────────────────────────

  // A job finished: its files are journaled (import: the new master; optimize: the master replacing
  // the original, references rewritten when the extension changed), then left to the watcher again.
  #onMediaComplete(job: MediaJob): void {
    if (this.#closed) return;
    void this.#queue.run(async () => {
      try {
        if (job.status === 'done' && !this.#closed) {
          await this.#locked(async () => {
            await this.#syncWithDisk();
            try {
              await this.#journalMediaResult(job);
            } finally {
              await this.#recordOwn();
            }
          });
        }
      } finally {
        this.#media?.release(job);
        this.#monitor.observe(job.output);
        if (job.replaces) this.#monitor.observe(job.replaces);
        this.#monitor.scheduleRetry();
        await this.#afterChange();
      }
    }).catch((error) => this.#emitError(error, `journaling media job ${job.id}`));
  }

  async #journalMediaResult(job: MediaJob): Promise<void> {
    const paths = [job.output, ...(job.replaces && job.replaces !== job.output ? [job.replaces] : [])];
    const updates = new Map<string, SourceFile | null>();
    for (const rel of paths) updates.set(rel, fileOf(await this.#readDisk(rel)));
    const write = new Map<string, SourceFile>();
    if (job.type === 'optimize' && job.replaces && job.replaces !== job.output) {
      // References rewritten as `elabora media optimize` does (never in the plan or its versions).
      const files = withUpdates(this.#state.files, updates);
      const moved = replaceMediaReferences(commandContext(files, { root: this.root }), { moves: [{ from: job.replaces, to: job.output }] });
      for (const [rel, file] of moved.files ?? []) {
        if (file === files.get(rel) || file.kind !== 'text' || this.#state.brokenError(rel) !== undefined) continue; // a file being written by someone else is left
        updates.set(rel, file);
        write.set(rel, file);
      }
    }
    const author = job.type === 'import' ? this.#media?.authorOf(job) ?? SYSTEM : SYSTEM;
    const command = job.type === 'import'
      ? { name: 'import_media', args: { file: job.output } }
      : { name: 'optimize_media', args: { from: job.replaces ?? job.input, to: job.output } };
    if (!isAiAuthor(author) && author.kind !== 'external') this.#closeOpenBatch('human');
    await this.#journalChange({ updates, author, command, source: 'media', write });
  }

  // ── events ─────────────────────────────────────────────────────────

  #emit(event: EngineEvent): void {
    const message: EventMessage = { kind: 'event', event };
    for (const listener of [...this.#listeners]) {
      try {
        listener(message);
      } catch {
        // A listener's failure must not stop the session.
      }
    }
  }

  #emitError(error: unknown, context: string): void {
    const { message, code } = protocolError(error);
    this.#emit({ type: 'error', message, context, ...(code ? { code } : {}) });
  }

  #assertOpen(): void {
    if (this.#closing) throw new EngineError('closed', 'The session is closed');
  }

  // Writing into a folder that was moved or deleted would create it again.
  #assertPresent(): void {
    if (!fs.existsSync(this.root)) throw new EngineError('not-found', `The project folder ${this.root} is gone (moved or deleted)`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

// Every request of the protocol, checked complete by the compiler (a request missing here would be
// refused as bad-request).
const REQUEST_TYPES: Record<RequestType, true> = {
  summary: true, readFile: true, listFiles: true, readScreen: true, screenParts: true, findText: true, conversions: true, translationStatus: true,
  translationTable: true, screenTranslation: true, buildTranslation: true, run: true, undo: true, undoBatch: true, history: true, mark: true,
  diagnostics: true, importMedia: true, mediaJobs: true, cancelMediaJob: true, backups: true, createBackup: true, restoreBackup: true,
  renderScreen: true, openCanvas: true, canvasView: true, closeCanvas: true, migrate: true, build: true, close: true, narration: true, voices: true,
  installVoices: true, setSpeakerVoice: true, generateVoice: true, voiceTakes: true, cancelVoice: true, voiceSample: true, aligners: true,
  setVoiceKey: true, voiceAccount: true, voiceSearch: true, voiceEstimate: true,
  alignNarration: true, timeline: true, timelineAt: true, timelineMarks: true, narrationPeaks: true, importNarrationFiles: true, planVoiceover: true, planVersions: true, planDiff: true, planDocument: true, planDocumentPage: true, exportPlanDocument: true, dialogue: true, dialoguePlay: true, dialoguePage: true, exportDialogue: true, effects: true, transcribeRecording: true, transcribers: true, transcriptionEstimate: true, transcribeLine: true
};



const isRequestType = (type: string): type is RequestType => Object.hasOwn(REQUEST_TYPES, type);

const fileOf = (disk: DiskRead): SourceFile | null => (disk.kind === 'file' ? disk.file : null);
// What the bars show that depends on every screen, as compared between renders.
// What the build request asks of @elabora/node build; the session's validation options by default,
// so the package is checked as the app's findings are.
function buildOptions(params: BuildParams, validation: ValidationOptions = {}): BuildOptions {
  const { mediaQuality, release, profiles, name, target, web, languages: every } = params as Record<string, unknown>;
  if (mediaQuality !== undefined && !isPresetName(mediaQuality)) throw new EngineError('bad-request', `mediaQuality is high, medium or low (not ${JSON.stringify(mediaQuality)})`);
  if (release !== undefined && typeof release !== 'boolean') throw new EngineError('bad-request', 'release is true or false');
  if (profiles !== undefined && !(Array.isArray(profiles) && profiles.every((id) => typeof id === 'string'))) throw new EngineError('bad-request', 'profiles is a list of LMS profile ids');
  if (name !== undefined && typeof name !== 'string') throw new EngineError('bad-request', 'name is a string');
  if (target !== undefined && target !== 'scorm12' && target !== 'web') throw new EngineError('bad-request', `target is scorm12 or web (not ${JSON.stringify(target)})`);
  if (every !== undefined && every !== 'all') throw new EngineError('bad-request', `languages is "all" (not ${JSON.stringify(every)})`);
  const languages = every === 'all' ? { languages: 'all' as const } : {};
  if (target === 'web') {
    if (profiles !== undefined) throw new EngineError('bad-request', 'profiles are for the scorm12 target: a module for the web reports to no LMS');
    return { target, ...(mediaQuality !== undefined ? { mediaQuality } : {}), ...(web !== undefined ? { web: webOptions(web) } : {}), ...languages, release: release ?? validation.release ?? false };
  }
  if (web !== undefined) throw new EngineError('bad-request', 'web settings are for the web target (target: "web")');
  const targets = profiles ?? validation.profiles;
  return {
    ...(mediaQuality !== undefined ? { mediaQuality } : {}),
    ...(targets?.length ? { profiles: [...targets] } : {}),
    ...languages,
    release: release ?? validation.release ?? false
  };
}

// The web target's settings of a build request, checked (D41).
function webOptions(web: unknown): NonNullable<BuildOptions['web']> {
  if (typeof web !== 'object' || web === null || Array.isArray(web)) throw new EngineError('bad-request', 'web is an object: { progress, navigation, noindex, url, image, review }');
  const { progress, navigation, noindex, url, image, review, ...rest } = web as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new EngineError('bad-request', `web has no ${unknown.join(', ')} (progress, navigation, noindex, url, image, review)`);
  if (progress !== undefined && !WEB_PROGRESS.some((value) => value === progress)) throw new EngineError('bad-request', `web.progress is local or none (not ${JSON.stringify(progress)})`);
  if (navigation !== undefined && !WEB_NAVIGATION.some((value) => value === navigation)) throw new EngineError('bad-request', `web.navigation is authored or free (not ${JSON.stringify(navigation)})`);
  if (noindex !== undefined && typeof noindex !== 'boolean') throw new EngineError('bad-request', 'web.noindex is true or false');
  if (url !== undefined && typeof url !== 'string') throw new EngineError('bad-request', 'web.url is a string (https://…)');
  if (image !== undefined && typeof image !== 'string') throw new EngineError('bad-request', 'web.image is a file path');
  // A review build (D42): the origins of the review pages, checked by the build (E_WEB_REVIEW_ORIGIN).
  const origins = typeof review === 'object' && review !== null && !Array.isArray(review) ? (review as Record<string, unknown>).origins : undefined;
  if (review !== undefined && (!Array.isArray(origins) || !origins.every((origin) => typeof origin === 'string') || Object.keys(review as object).some((key) => key !== 'origins'))) throw new EngineError('bad-request', 'web.review is { origins: string[] } (https://revue.elabora.studio)');
  return {
    ...(progress !== undefined ? { progress: progress as 'local' | 'none' } : {}), ...(navigation !== undefined ? { navigation: navigation as 'authored' | 'free' } : {}),
    ...(noindex !== undefined ? { noindex } : {}), ...(url !== undefined ? { url } : {}), ...(image !== undefined ? { image } : {}),
    ...(Array.isArray(origins) ? { review: { origins: origins.map(String) } } : {})
  };
}

// The publish version's default name: the day, in the course language (French or English).
function publishName(language: string | undefined, date = new Date()): string {
  const french = (language ?? '').slice(0, 2) === 'fr';
  const day = date.toLocaleDateString(french ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return french ? `Publié le ${day}` : `Published on ${day}`;
}

export function changeView(entry: ChangeLike): ChangeView {
  return {
    type: entry.type, id: entry.id, seq: entry.seq, at: entry.at, author: entry.author, batch: entry.batch,
    ...(entry.command ? { command: entry.command } : {}),
    files: entry.files.map((file) => file.path), ops: entry.ops as Op[],
    ...(entry.unavailable?.length ? { unavailable: entry.inverse.flatMap((op) => (op.op === 'write' && 'blob' in op && entry.unavailable?.includes(op.blob) ? [op.file] : [])) } : {}),
    ...(entry.type === 'undo' ? { undoes: entry.undoes, skipped: entry.skipped } : {})
  };
}

function diagnosticsEvent(delta: DiagnosticsDelta): EngineEvent {
  return {
    type: 'diagnostics', screens: Object.fromEntries(delta.screens), removed: delta.removed, summary: delta.summary,
    ...(delta.project ? { project: delta.project } : {})
  };
}

function backupSummary(version: VersionSummary): BackupSummary {
  return { ...version };
}
