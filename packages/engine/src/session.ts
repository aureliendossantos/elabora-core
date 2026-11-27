import fs from 'node:fs';
import path from 'node:path';
import { DELIVERY_FORMATS, isDeliveryFormat } from '@elabora/core/lms/formats';
import type { Author, ChangeLike, Files, JournalEntry, MarkEntry } from '@elabora/core/ops/types';
import { readChat } from '@elabora/node/chats';
import { sameContent } from '@elabora/core/ops/json';
import { isAiAuthor } from '@elabora/core/ops/batch';
import type { ProjectFiles, SourceFile } from '@elabora/core/project/files';
import type { FileInfo } from '@elabora/core/project/store';
import type { Project } from '@elabora/core/project/model';
import type { PlanDiffView, PlanVersionsView } from '@elabora/core/project/plan-versions';
import type { TextMatch } from '@elabora/core/commands/text';
import type { ScreenTranslation, TranslationStatus, TranslationTable } from '@elabora/core/i18n/translate';
import { buildTranslation } from '@elabora/node/translate';
import { packageWeights } from '@elabora/node/packaging/weights';
import type { PackageWeights } from '@elabora/core/media/weights';
import type { PlanDocument } from '@elabora/core/plan-document/model';
import { PLAN_DOCUMENT_FORMATS, planDocumentPage, readPlanDocument, writePlanDocument } from '@elabora/node/plan-document';
import { dialoguePage, writeDialogueExport, DIALOGUE_EXPORT_FORMATS } from '@elabora/node/dialogue-export';
import type { DialogueExportFormat, ExportedDialogue } from '@elabora/node/dialogue-export';
import type { DialogueView } from '@elabora/core/dialogue/view';
import { findDialogue } from '@elabora/core/dialogue/project';
import type { PlayReport } from '@elabora/core/dialogue/play';
import { localDay } from '@elabora/core/util/local-day';
import type { ExportedPlanDocument, PlanDocumentFormat } from '@elabora/node/plan-document';
import type { ScreenParts } from '@elabora/core/project/parts';
import type { TimelineView, ScreenAt, TimelineMark } from '@elabora/core/narration/view';
import type { EffectInfo } from '@elabora/core/narration/timeline';
import type { NarrationView } from '@elabora/core/narration/view';
import { parseJSON } from '@elabora/core/util/json';
import { sortDiagnostics } from '@elabora/core/diagnostics/index';
import type { Diagnostic } from '@elabora/core/diagnostics/index';
import type { ValidationOptions } from '@elabora/core/validate/index';
import * as edit from '@elabora/node/edit';
import type { EditOptions, EditResult, HostOptions, Written } from '@elabora/node/edit';
import { JOURNAL_DIR } from '@elabora/node/journal/journal';
import { projectDataDir } from '@elabora/node/data-dir';
import { agentRulesState, claudeMissing, updateAgentRules, AGENTS_FILE, CLAUDE_FILE } from '@elabora/node/agent-rules';
import { copyBlobTo } from '@elabora/node/blobs';
import type { BlobHash } from '@elabora/node/blobs';
import { createVersion, listVersions, restore } from '@elabora/node/backups/index';
import { findVersion, newestVersionTime, summarize as summarizeVersion } from '@elabora/node/backups/store';
import type { Version, VersionReason, VersionSummary } from '@elabora/node/backups/types';
import { pruneProjectData } from '@elabora/node/project-data';
import { FsStore } from '@elabora/node/store/fs-store';
import { readSnapshot } from '@elabora/node/store/snapshot';
import type { MediaJob } from '@elabora/node/media/jobs';
import { ProjectState } from './base/project-state.ts';
import { JournalTail } from './journal-tail.ts';
import { WriteQueue } from './base/queue.ts';
import { MediaSupervisor, jobInfo } from './media.ts';
import type { MediaOptions } from './media.ts';
import { replaceMediaReferences } from '@elabora/core/commands/media';
import { commandContext, unmetExpectation, type Expectation } from '@elabora/core/commands/index';
import { binaryFile } from '@elabora/core/project/files';
import type { FileMedia } from '@elabora/core/media/conformance';
import { isMediaAsset, mediaStatus, probeAssets } from '@elabora/node/store/media';
import { toSourceFile, withUpdates } from './disk.ts';
import type { SessionStore } from './disk.ts';
import { SessionThumbs } from './base/thumbs.ts';
import { SessionCanvas } from './base/canvas.ts';
import { startCanvasHost } from '@elabora/node/canvas/host';
import { SessionVoice } from './session-voice.ts';
import { SessionSounds } from './session-sounds.ts';
import type { GenerateSoundParams, GeneratedSound, SoundEstimate, SoundFound, SoundSearchParams } from '@elabora/node/sounds/types';
import type { CourseSound } from '@elabora/core/sounds/sounds';
import { SessionMonitor } from './session-monitor.ts';
import { SessionActivity } from './session-activity.ts';
import type { ActivityEntry } from '@elabora/node/activity';
import { SessionReads, documentOptions } from './base/reads.ts';
import { Renderer } from './base/render.ts';
import { COMMAND_NAMES, namedCommand } from '@elabora/core/commands/table';
import { NEED_SERVICES, SERVICES, isRequestType, notHere, serviceOf } from './base/services.ts';
import { Batches } from './base/batches.ts';
import { changeView, diagnosticsEvent } from './base/events.ts';
import { FolderChanges, fileOf } from './session-folder.ts';
import type { RenderedScreen } from '@elabora/core/render/screen';
import { build } from '@elabora/node/build';
import { WEB_NAVIGATION, WEB_PROGRESS } from '@elabora/node/build';
import type { BuildOptions, BuildResult } from '@elabora/node/build';
import { LOCK_FILE } from '@elabora/core/compile/state-model';
import { isPresetName } from '@elabora/core/media/presets';
import { EngineError, protocolError } from './errors.ts';
import { mediaTypeOf } from '@elabora/core/util/media-types';
import { SessionCloud, type CloudHeld, type CloudOptions, type Where } from './base/session-cloud.ts';
import { folderSnapshot, type PushSource } from '@elabora/node/cloud/projects';
import type { Presence } from '@elabora/core/sync/protocol';
import type {
  BackupSummary, BuildParams, BuildView, CanvasInfo, CanvasMoment, CanvasView, ChangeSource, ChangeView, CommandArgs, CommandName, DiagnosticsView, EngineEvent, EventMessage, ExternalNotes, FileEntry, FileView,
  FormatMigrationView, FormatStatus, HistoryView, MarkResult, EndTurnParams, EndTurnResult, MediaImportResult, MediaJobInfo, ProjectSummary, RenderScreenParams, RequestMessage,
  RequestResult, RequestType, ResponseMessage, RestoreView, Service, RunResult, ScreenView, TranslationBuildParams, TranslationBuildView, UndoView, VoiceView, GenerateVoiceParams, AlignNarrationParams, ConversionsParams, ConversionsView
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
  // A folder linked to a project in the cloud (D83): the session syncs it with the project's room.
  cloud?: CloudOptions;
  // The services the session offers over the protocol (D102): every one by default.
  services?: readonly Service[];
}

// Running media jobs at close: cancel them (default: an interrupted conversion of a dropped file is
// queued again at the next open, since the file is still not conformant; an import is lost, so the
// app asks first when summary().media says imports run), wait for them, or leave them running in
// this process without journaling their result.
export interface CloseOptions {
  media?: 'leave' | 'wait' | 'cancel';
}

const FIVE_MINUTES = 5 * 60_000;
const SYSTEM: Author = { kind: 'system' };

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
  #entries: JournalEntry[];
  readonly #queue = new WriteQueue();
  readonly #listeners = new Set<(message: EventMessage) => void>();
  #cloud: SessionCloud | null = null;
  readonly #monitor: SessionMonitor;
  // Where the changes come from and go: the folder (session-folder.ts).
  readonly #folder: FolderChanges;
  readonly #activity: SessionActivity;
  readonly #media: MediaSupervisor | null;
  // The AI batches and the chat's turns (base/batches.ts).
  readonly #batches: Batches;
  #versionTimer: NodeJS.Timeout | null = null;
  #versionInFlight: Promise<string | null> | null = null;
  #pruned = false;
  #timers: NodeJS.Timeout[] = [];
  #closing: Promise<{ version: string | null }> | null = null;
  #closed = false;
  readonly #canvas: SessionCanvas;
  readonly #thumbs: SessionThumbs;
  readonly #voice: SessionVoice;
  readonly #sounds: SessionSounds;
  readonly #reads: SessionReads;
  readonly #services: ReadonlySet<Service>;
  // Media: the hash each media file was probed at, what could not be read, whether ffprobe is there,
  // and whether media jobs started or finished since the media status was last given.
  readonly #mediaChecked = new Map<string, string>();
  // What each file's probe said, by path and hash: a file that comes back as it was (an undo restores
  // a removed image) has it again without a probe, which the hash above would skip.
  readonly #mediaVerdicts = new Map<string, FileMedia>();
  readonly #unreadable = new Map<string, string>();
  #toolsMissing = false;
  #jobsChanged = false;

  constructor(init: SessionInit) {
    this.root = init.root;
    this.store = init.store;
    this.#state = init.state;
    this.#entries = init.entries;
    this.#options = init.options;
    this.author = init.options.author ?? { kind: 'human' };
    const project = () => this.#state.project;
    const reportError = (error: unknown, context: string) => this.#emitError(error, context);
    this.#services = new Set(init.options.services ?? SERVICES);
    this.#batches = new Batches({
      idleMs: init.options.batchIdleMs ?? FIVE_MINUTES,
      run: (work) => this.#queue.run(work),
      version: (batch) => (this.#options.backups?.enabled === false ? Promise.resolve(null) : this.#takeVersion('after-ai', { batch, author: SYSTEM })),
      emit: (event) => this.#emit(event),
      reportError: (error, context) => this.#emitError(error, context)
    });
    const renderer = new Renderer();
    this.#canvas = new SessionCanvas({ sink: ({ port, debug }) => startCanvasHost({ root: this.root, port, debug }), project, renderer, reportError });
    // The miniatures' renders (D133): this computer's canvas host serves the module's files whatever renders named.
    this.#thumbs = new SessionThumbs({ project, files: () => this.#state.files, root: this.root, renderer, named: () => {}, assertOpen: () => this.#assertOpen() });
    this.#voice = new SessionVoice({ root: this.root, author: this.author, project, run: this.run.bind(this), assertOpen: () => this.#assertOpen(), emit: (event) => this.#emit(event) });
    this.#sounds = new SessionSounds({ run: this.run.bind(this), assertOpen: () => this.#assertOpen(), emit: (event) => this.#emit(event) });
    this.#reads = new SessionReads({
      root: this.root, state: this.#state, renderer, entries: () => this.#entries, journalSeq: () => this.#folder.lastSeq, openBatch: () => this.openBatch,
      mediaJobs: () => this.#media?.jobs() ?? [], migrate: init.options.migrate, services: init.options.services ?? SERVICES,
      takeDialogue: (take) => takeDialogue(this.root, take), assertOpen: () => this.#assertOpen()
    });
    this.#activity = new SessionActivity({ root: this.root, emit: (event) => this.#emit(event), reportError });
    // The rescan reads the agents' activity too: a line its watcher missed shows at the next one.
    this.#monitor = new SessionMonitor({ store: this.store, journalDir: init.tail.dir, options: this.#options, closing: () => this.#closing !== null, refresh: () => this.#queue.run(() => this.#folder.refresh()), reportError, onRescan: () => void this.#activity.poke() });
    this.#folder = new FolderChanges({
      root: this.root, store: this.store, state: this.#state, tail: init.tail, monitor: this.#monitor, stats: init.stats, lockTimeoutMs: this.#options.lockTimeoutMs,
      host: {
        taken: (entries, source) => this.#taken(entries, source),
        afterChange: () => this.#afterChange(),
        emit: (event) => this.#emit(event),
        owns: (rel) => this.#media?.owns(rel) ?? false,
        rescanned: () => { this.#jobsChanged = true; }
      }
    });
    for (const [rel, file] of init.state.files) {
      if (file.kind !== 'binary' || !file.media) continue;
      this.#mediaChecked.set(rel, file.hash ?? '');
      this.#mediaVerdicts.set(`${rel}\n${file.hash ?? ''}`, file.media);
    }
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
    this.#batches.resume(this.#entries, (chat, at) => readChat(this.root, chat).some((line) => line.type === 'turn-end' && line.at >= at));
    await this.#monitor.start();
    this.#activity.start(this.#options.watch !== false);
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
    // date, as a system change (agent-rules.ts, D34), with the CLAUDE.md that points to them when it
    // is missing. A course in an older format waits for its migration.
    if (!this.#state.project.migration && this.#agentRulesDue()) void this.#change(SYSTEM, async () => this.#committed(updateAgentRules(this.root, this.#editOptions(SYSTEM)))).catch((error) => this.#emitError(error, 'updating the rules for agents'));
    if (backups.prune !== false) {
      const timer = setTimeout(() => void this.#prune().catch((error) => this.#emitError(error, 'pruning the project data')), backups.pruneDelayMs ?? 60_000);
      timer.unref();
      this.#timers.push(timer);
    }
    if (this.#options.cloud) await this.#startCloud(this.#options.cloud);
  }

  // ── a project in the cloud (D83) ───────────────────────────────────

  // A folder just linked to a project (elabora cloud project create, push or clone did it, or the
  // app): the open session starts syncing it, as if it had been opened with options.cloud.
  async linkCloud(options: CloudOptions): Promise<void> {
    this.#assertOpen();
    if (this.#cloud) throw new Error('This session already syncs a project in the cloud.');
    await this.#startCloud(options);
  }

  // The copy synced again with the session signed in now (the options read again: cloudSessionOptions): after
  // a sign-in, a copy held signed-out or other-account goes on, or stays held if the account is still not
  // its link's. What the copy had not sent is taken again from its link and its journal.
  async cloudRestart(options: CloudOptions): Promise<void> {
    this.#assertOpen();
    const previous = this.#cloud;
    this.#cloud = null;
    previous?.stop();
    await this.#startCloud(options);
  }

  // What a first upload of the open module sends (pushFolder's source): its files and the journal's
  // last entry, read together in the session's queue and under the project's lock. Whatever is done
  // in the module during the upload comes after that entry, and goes to the room as the changes of
  // its authors once linkCloud starts (D88).
  async cloudSnapshot(): Promise<PushSource> {
    this.#assertOpen();
    return this.#queue.run(() => this.#folder.locked(async () => {
      await this.#folder.sync();
      return folderSnapshot(this.root);
    }));
  }

  async #startCloud(options: CloudOptions): Promise<void> {
    const cloud = new SessionCloud({
      files: () => this.#state.files,
      step: (work) => this.#queue.run(async () => {
        try {
          return await this.#folder.write(work);
        } finally {
          await this.#afterChange();
        }
      }),
      write: (before, after, author, batch, seq) => this.#writeFromRoom(before, after, author, batch, seq),
      emit: (event) => this.#emit(event),
      notes: (change) => this.#folder.externalNotes(change),
      ended: () => { if (this.#cloud === cloud) this.#cloud = null; },
      version: (name) => this.#takeVersion('restore', { name, author: SYSTEM })
    }, options);
    this.#cloud = cloud;
    const since = options.link.journal;
    await cloud.start(this.#entries.filter((entry): entry is ChangeLike => entry.type !== 'mark' && entry.seq > since));
  }

  // Where the person is in the module (D91), shown to the others in the project's room.
  cloudWhere(where: Where): void {
    this.#cloud?.where(where);
  }

  // Try the room again now: a copy it kept out for its storage or its connections (elabora-cloud C80, C83).
  cloudRetry(): void {
    this.#cloud?.retry();
  }

  // The copy of the project in the cloud: connected, the room's number, changes waiting, who is there,
  // the team and project (null: not linked).
  get cloud(): { online: boolean; head: number; pending: number; client: string; team: string; project: string; peers: readonly Presence[]; role: 'owner' | 'editor' | 'viewer' | null; held: CloudHeld | null; settled: () => Promise<void> } | null {
    const cloud = this.#cloud;
    return cloud && { online: cloud.online, head: cloud.head, pending: cloud.pending, client: cloud.link.client, team: cloud.link.team, project: cloud.link.project, peers: cloud.peers, role: cloud.role, held: cloud.held, settled: () => cloud.settled() };
  }

  // What the room changed in the view, written in the folder and journaled as the change of its
  // author (never sent back: its command is sync).
  async #writeFromRoom(before: ProjectFiles | Files, after: Files, author: Author, batch: string | undefined, seq: number): Promise<void> {
    const updates = new Map<string, SourceFile | null>();
    const write = new Map<string, SourceFile>();
    for (const rel of new Set([...before.keys(), ...after.keys()])) {
      const file = after.get(rel);
      if (before.get(rel) === file || (file && sameContent(before.get(rel), file))) continue;
      const target = path.join(this.root, ...rel.split('/'));
      if (!file) {
        fs.rmSync(target, { force: true });
        updates.set(rel, null);
      } else if (file.kind === 'text') {
        const source = toSourceFile(this.root, rel, file) as SourceFile;
        updates.set(rel, source);
        write.set(rel, source);
      } else {
        await copyBlobTo(this.root, file.hash as BlobHash, target);
        updates.set(rel, fileOf(await this.#folder.readDisk(rel)));
      }
    }
    if (!updates.size) return;
    await this.#folder.journal({ updates, author, command: { name: 'sync', args: { seq } }, source: 'cloud', write, ...(batch ? { batch } : {}) });
  }

  // Ends the session: stops the voices' jobs (what they said stays), reconciles what changed last,
  // closes the open AI batch, takes the close version, prunes the project's data if the session has
  // not yet. Requests fail afterwards.
  close(options: CloseOptions = {}): Promise<{ version: string | null }> {
    this.#closing ??= (async () => {
      // The voices stop first: a line being said when the author leaves is not paid for nothing.
      this.#voice.close();
      this.#cloud?.stop();
      this.#monitor.stop();
      this.#activity.stop();
      this.#batches.stop();
      for (const timer of [...this.#timers, this.#versionTimer]) if (timer) clearTimeout(timer);
      // Results of the jobs that finish meanwhile are journaled by the queue, before what follows.
      const mode = options.media ?? 'cancel';
      if (mode !== 'leave') await this.#media?.close(mode);
      await this.#queue.run(() => this.#folder.refresh(true)).catch((error) => this.#emitError(error, 'reconciling changes'));
      let version: string | null = null;
      await this.#queue.run(async () => {
        this.#batches.close('close');
        await this.#batches.flush();
        if (this.#options.backups?.enabled !== false) version = await this.#takeVersion('close', { author: SYSTEM });
      });
      if (this.#options.backups?.prune !== false && !this.#pruned) await this.#prune().catch((error) => this.#emitError(error, 'pruning the project data'));
      if (mode === 'leave') await this.#media?.close('leave');
      await this.#canvas.close();
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
  get journalSeq(): number { return this.#folder.lastSeq; }
  get openBatch(): string | null { return this.#batches.open; }

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
    await this.#queue.run(() => this.#folder.refresh());
  }

  // ── protocol ───────────────────────────────────────────────────────

  // ports: what came transferred with the message (a relay's port: not served here).
  async handle(message: unknown, ports: readonly unknown[] = []): Promise<ResponseMessage> {
    const request = (message ?? {}) as Partial<RequestMessage>;
    const id = typeof request.id === 'string' ? request.id : '';
    const type = typeof request.type === 'string' ? request.type : '';
    try {
      if (!id || request.kind !== 'request' || !isRequestType(type)) throw new EngineError('bad-request', `Not a request of the engine protocol: ${JSON.stringify(message)?.slice(0, 200)}`);
      const result = await this.#dispatch(request as RequestMessage, ports);
      return { kind: 'response', id, type, ok: true, result } as ResponseMessage;
    } catch (error) {
      return { kind: 'response', id, type, ok: false, error: protocolError(error) };
    }
  }

  async #dispatch(request: RequestMessage, ports: readonly unknown[]): Promise<RequestResult<RequestType>> {
    const service = serviceOf(request.type);
    if (service && !this.#services.has(service)) {
      this.#assertOpen();
      throw notHere(request.type, service);
    }
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.type) {
      case 'summary': return this.summary();
      case 'readFile': return this.readFile(request.params.path);
      case 'readMedium': {
        const { path: rel } = this.#reads.mediumOf(request.params.path);
        const bytes = await fs.promises.readFile(path.join(this.root, rel)).catch(() => null);
        if (!bytes) throw new EngineError('not-found', `${rel} is not on the disk`);
        return { path: rel, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), type: mediaTypeOf(rel) };
      }
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
      case 'packageWeights': return this.packageWeights();
      case 'translationTable': return this.translationTable(request.params.language);
      case 'screenTranslation': return this.screenTranslation(request.params.screen, request.params.language);
      case 'buildTranslation': return this.buildTranslation(request.params);
      case 'run': {
        if (typeof request.params.command !== 'string' || !namedCommand(request.params.command)) throw new EngineError('bad-request', `Unknown command "${String(params.command)}" (commands: ${COMMAND_NAMES.join(', ')})`);
        const need = namedCommand(request.params.command)?.needs;
        if (need && !this.#services.has(NEED_SERVICES[need])) { this.#assertOpen(); throw notHere('run', NEED_SERVICES[need]); }
        return this.run(request.params.command, request.params.args, request.params.author, request.params.expect);
      }
      case 'undo': return this.undo(request.params.seq);
      case 'undoBatch': return this.undoBatch(request.params.batch);
      case 'redo': return this.redo();
      case 'history': return this.history(request.params.limit, { ops: request.params.ops });
      case 'mark': return this.mark(request.params.request, this.author, request.params.chat);
      case 'endTurn': return this.endTurn(request.params);
      case 'diagnostics': return this.diagnostics(request.params.screen);
      case 'importMedia': return this.importMedia(request.params.path, { to: request.params.to, name: request.params.name });
      case 'mediaJobs': return this.mediaJobs();
      case 'activity': return this.activity(request.params.limit);
      case 'cancelMediaJob': return this.cancelMediaJob(request.params.id);
      case 'backups': return this.backups();
      case 'createBackup': return this.createBackup(request.params.name);
      case 'restoreBackup': return this.restoreBackup(request.params.version, request.params.paths);
      case 'renderScreen': return this.renderScreen(request.params);
      case 'openCanvas': return this.openCanvas(request.params);
      case 'canvasView': return this.canvasView(request.params);
      case 'closeCanvas': return this.closeCanvas();
      case 'thumbRender': return this.#thumbs.thumbRender(request.params);
      case 'momentRender': return this.#thumbs.momentRender(request.params);
      case 'blockPreviewRender': return this.#thumbs.blockPreviewRender(request.params);
      case 'measureRender': return this.#thumbs.measureRender(request.params);
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
      case 'soundSearch': return this.soundSearch(request.params);
      case 'soundPreview': return this.soundPreview(request.params);
      case 'courseSounds': return this.courseSounds();
      case 'soundEstimate': return this.soundEstimate(request.params ?? {});
      case 'generateSound': return this.generateSound(request.params);
      case 'aligners': return this.aligners(request.params.language);
      case 'alignNarration': return this.alignNarration(request.params);
      case 'build': return this.build(request.params);
      case 'close': return this.close();
      // The desktop serves the module's files to its canvas from its local server.
      case 'relayPort':
        if (!ports[0]) throw new EngineError('bad-request', 'relayPort takes the port transferred with its message');
        throw new EngineError('not-available', 'This session serves the module\'s files from its local server', { code: 'E_NOT_HERE' });
      // The desktop's host restarts a held copy with the new session's token (cloudRestart, a method of its own).
      case 'cloudRestart': throw new EngineError('not-available', 'This session is restarted by its host, with the new session\'s token', { code: 'E_NOT_HERE' });
      // The desktop holds the ElevenLabs key itself (setVoiceKey): no page holds it for this session.
      case 'voiceKeyPort':
        if (!ports[0]) throw new EngineError('bad-request', 'voiceKeyPort takes the port transferred with its message');
        throw new EngineError('not-available', 'This session holds the ElevenLabs key itself (setVoiceKey)', { code: 'E_NOT_HERE' });
    }
  }

  // ── reads ──────────────────────────────────────────────────────────

  summary(): ProjectSummary { return this.#reads.summary(); }

  listFiles(dir?: string): FileEntry[] { return this.#reads.listFiles(dir); }

  readFile(rel: string): FileView { return this.#reads.readFile(rel); }

  readScreen(id: string): ScreenView { return this.#reads.readScreen(id); }

  screenParts(id: string): ScreenParts { return this.#reads.screenParts(id); }

  narration(id: string, language?: string, layer?: string): NarrationView | null { return this.#reads.narration(id, language, layer); }

  timeline(id: string, language?: string, layer?: string): TimelineView | null { return this.#reads.timeline(id, language, layer); }

  timelineAt(params: { screen: string; time?: number; at?: CanvasMoment; language?: string; layer?: string }): ScreenAt | null { return this.#reads.timelineAt(params); }

  timelineMarks(screen: string, language?: string, layer?: string): TimelineMark[] | null { return this.#reads.timelineMarks(screen, language, layer); }

  // The waveform of a narrated screen's lines, decoded once per audio file (cached in the data folder).
  async narrationPeaks({ screen, language, perSecond }: { screen: string; language?: string; perSecond?: number }): Promise<NarrationPeaks | null> {
    this.#assertOpen();
    if (!this.#state.project.screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    return narrationPeaks(this.root, this.#state.project, screen, { ...(language ? { language } : {}), ...(typeof perSecond === 'number' ? { perSecond } : {}) });
  }

  effects(): EffectInfo[] { return this.#reads.effects(); }

  planVoiceover(screen: string): { item: string; speaker?: string; text: string }[] { return this.#reads.planVoiceover(screen); }

  planVersions(): PlanVersionsView { return this.#reads.planVersions(); }

  planDiff(refs: { from?: unknown; to?: unknown }): PlanDiffView { return this.#reads.planDiff(refs); }

  planDocument(date?: string, version?: number | 'current'): PlanDocument | null { return this.#reads.planDocument(date, version); }

  planDocumentPage(date?: string, version?: number | 'current'): { html: string; date: string; title: string; version: string | null } {
    this.#assertOpen();
    const options = documentOptions(date, version);
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
    const options = documentOptions(params.date, params.version);
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

  dialogue(block: string): DialogueView | null { return this.#reads.dialogue(block); }

  dialoguePlay(params: { block: string; choices: string[] }): PlayReport { return this.#reads.dialoguePlay(params); }

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

  conversions(params: ConversionsParams): ConversionsView { return this.#reads.conversions(params); }

  findText(query: string, caseSensitive = false): TextMatch[] { return this.#reads.findText(query, caseSensitive); }

  // What a package would weigh at each media quality (« Publier »), and each media in it, as the
  // project is in memory: renditions and narration tracks as cached, else estimated; nothing encoded
  // or written.
  packageWeights(): Promise<PackageWeights> {
    this.#assertOpen();
    return packageWeights(this.#state.project);
  }

  translationStatus(to?: string): TranslationStatus[] { return this.#reads.translationStatus(to); }

  translationTable(language: string): TranslationTable { return this.#reads.translationTable(language); }

  screenTranslation(screen: string, language: string): ScreenTranslation { return this.#reads.screenTranslation(screen, language); }

  diagnostics(screen?: string): DiagnosticsView { return this.#reads.diagnostics(screen); }

  history(limit = 50, options: { ops?: boolean } = {}): HistoryView { return this.#reads.history(limit, options); }

  // What agents did lately, through Elabora's tools (the 'activity' events say what comes next).
  activity(limit?: number): ActivityEntry[] {
    this.#assertOpen();
    return this.#activity.recent(limit);
  }

  mediaJobs(): MediaJobInfo[] {
    this.#assertOpen();
    return (this.#media?.jobs() ?? []).map(jobInfo);
  }

  backups(): BackupSummary[] {
    this.#assertOpen();
    return listVersions(this.root).map(backupSummary);
  }

  renderScreen(params: RenderScreenParams): RenderedScreen { return this.#reads.renderScreen(params); }

  formatStatus(): FormatStatus { return this.#reads.formatStatus(); }

  // ── canvas (base/canvas.ts) ─────────────────────────────────────

  // Starts the canvas host of the project (once): the app shows its page in a frame.
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

  // Rules written by an earlier Elabora and edited by nobody, or no CLAUDE.md beside them.
  #agentRulesDue(): boolean {
    const file = this.#state.files.get(AGENTS_FILE);
    if (file?.kind !== 'text') return false;
    return agentRulesState(file.text).status === 'outdated' || claudeMissing(file.text, this.#state.files.has(CLAUDE_FILE));
  }

  // Under the lock, in a write: the migration through the node edits, given the snapshot.
  async #migrateFormat(): Promise<{ from: string; to: string; seq: number | null } | null> {
    if (!this.#state.project.migration) return null;
    if (this.#options.backups?.enabled !== false) await this.#takeVersion('migration', { author: SYSTEM });
    const ref = edit.migrateIfOutdated(this.root, this.#editOptions(SYSTEM));
    if (!ref) return null;
    this.#adopt(ref.written);
    if (ref.change) this.#folder.own(ref.change.seq, 'engine');
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
      this.#batches.close('human');
      await this.#batches.flush();
      await this.#folder.locked(() => this.#folder.sync());
      let result: BuildResult;
      let seq: number | null = null;
      try {
        result = await build(this.root, { ...options, emit: options.target === 'web' ? 'both' : 'zip', onMedia: ({ job }) => this.#emit({ type: 'mediaJob', job: jobInfo(job) }) });
      } finally {
        // Written even when the build stops after assigning keys, or fails.
        seq = await this.#folder.locked(async () => {
          try {
            return await this.#journalLock(params);
          } finally {
            await this.#folder.takeNew();
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
        change: this.#changeView(seq), version, languages: result.ok ? result.report.languages ?? null : null
      };
    });
  }

  // Under the lock, after a build: elabora.lock.json as it wrote it, journaled as a system change
  // (the journal's new entries first, so the change starts from what other writers left).
  async #journalLock(params: BuildParams): Promise<number | null> {
    await this.#folder.takeNew();
    this.#monitor.forget(LOCK_FILE);
    const disk = await this.#folder.readDisk(LOCK_FILE);
    const file = fileOf(disk);
    if (disk.kind === 'unstable' || !file || sameContent(this.#state.files.get(LOCK_FILE), file)) return null;
    if (file.kind !== 'text' || parseJSON(file.text).error !== undefined) {
      this.#monitor.observe(LOCK_FILE); // not the build's: left to the watcher
      return null;
    }
    return this.#folder.journal({ updates: new Map([[LOCK_FILE, file]]), author: SYSTEM, command: { name: 'build', args: params }, source: 'engine' });
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
      await this.#folder.locked(() => this.#folder.sync());
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
  // expect: the values the change was decided on (Expectation), checked here, in the write queue and
  // under the lock, after the folder was read again: one changed meanwhile refuses it, nothing written.
  // host: how this computer makes what the command needs (a voice's aligner, its progress).
  async run<Name extends CommandName>(name: Name, args: CommandArgs[Name], author: Author = this.author, expect?: readonly Expectation[], host: Omit<HostOptions, keyof EditOptions> = {}): Promise<RunResult> {
    this.#assertOpen();
    if (!namedCommand(name)) throw new EngineError('bad-request', `Unknown command "${String(name)}"`);
    if (expect !== undefined && !Array.isArray(expect)) throw new EngineError('bad-request', 'expect: a list of expected values');
    return this.#change(author, async () => {
      // An outdated course is migrated first, by its own change after a migration version.
      await this.#migrateFormat();
      const unmet = expect?.length ? unmetExpectation(this.#state.project, expect) : null;
      if (unmet) throw new EngineError('refused', `${unmet}: nothing written.`, { code: 'E_EXPECTED' });
      const result: EditResult = await edit.run(this.root, name, args, { ...this.#editOptions(author), ...host });
      return this.#committed(result);
    }).then(({ result, change }) => this.#runResult(result.op ?? name, result, change));
  }

  // ⌘Z without seq: the author's last step (D79): their last change, or the batch of an agent they launched.
  async undo(seq?: number, author: Author = this.author): Promise<UndoView> {
    this.#assertOpen();
    return this.#change(author, async () => {
      // A change the journal does not have is not found (the protocol's not-found), not refused.
      if (seq !== undefined && !this.#entries.some((entry) => entry.type !== 'mark' && entry.seq === seq)) throw new EngineError('not-found', `No change ${seq} in the journal`);
      return this.#committed(edit.undo(this.root, seq, this.#editOptions(author)));
    })
      .then(({ result, change }) => ({ ...this.#runResult('undo', result, change), undone: [result.undone].flat(), skipped: result.skipped }));
  }

  // ⇧⌘Z: the author's last undo undone again, while no change of theirs came after it (D79).
  async redo(author: Author = this.author): Promise<UndoView> {
    this.#assertOpen();
    return this.#change(author, async () => this.#committed(edit.redo(this.root, this.#editOptions(author))))
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
  // chat: a turn of Elabora's chat begins; the mark's id is the turn's, and the batch of all its
  // agent writes until endTurn.
  async mark(request: string, author: Author = this.author, chat?: string): Promise<MarkResult> {
    this.#assertOpen();
    return this.#queue.run(async () => {
      this.#assertPresent();
      this.#batches.close('mark');
      await this.#batches.flush();
      const mark = await this.#folder.write(async () => {
        const { mark } = edit.appendMark(this.root, request, { author, ...(chat ? { chat } : {}) });
        this.#folder.own(mark.seq, 'engine');
        return mark;
      });
      await this.#afterChange();
      const version = await this.#takeVersion('before-ai', { author });
      return { mark, version };
    });
  }

  // A turn of Elabora's chat ended (the host has session/prompt's answer): its batch closes (the
  // after-ai version, batchClosed with reason turn). The transcript is the host's.
  async endTurn(params: EndTurnParams): Promise<EndTurnResult> {
    this.#assertOpen();
    return this.#queue.run(async () => {
      // The agent's last changes, written by its MCP server, may not have reached the session yet.
      if (await this.#folder.hasNew()) await this.#folder.locked(() => this.#folder.sync());
      const mark = this.#entries.find((entry): entry is MarkEntry => entry.type === 'mark' && entry.id === params.turn);
      const chat = mark?.chat;
      if (!chat) throw new EngineError('not-found', `No turn ${params.turn} of the chat in the journal`);
      this.#batches.endTurn(chat, params.turn);
      await this.#batches.flush();
      const changes = this.#entries.filter((entry) => entry.type !== 'mark' && entry.batch === params.turn).length;
      return { batch: changes ? params.turn : null, changes };
    });
  }

  // ── voices, alignment and transcription (session-voice.ts) ─────────

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
  transcribers(language?: string): TranscriberView { return this.#voice.transcribers(language); }
  async transcribeRecording({ file, language, install, service, approvedPercent }: { file: string; language?: string; install?: boolean; service?: TranscriptionService; approvedPercent?: number }): Promise<Transcript> { return this.#voice.transcribeRecording({ file, language, install, service, approvedPercent }); }
  async transcriptionEstimate({ file, screen, line, language }: { file?: string; screen?: string; line?: string; language?: string }): Promise<TranscriptionEstimate> { return this.#voice.transcriptionEstimate({ file, screen, line, language }); }
  async transcribeLine({ screen, line, language, install, service, approvedPercent }: { screen: string; line: string; language?: string; install?: boolean; service?: TranscriptionService; approvedPercent?: number }): Promise<{ before: string; transcript: Transcript; audioHash: `sha256:${string}` | null }> { return this.#voice.transcribeLine({ screen, line, language, install, service, approvedPercent }); }

  // ── sounds (session-sounds.ts, D67) ────────────────────────────────

  async soundSearch(params: SoundSearchParams): Promise<{ sounds: SoundFound[] }> { return this.#sounds.soundSearch(params); }
  async soundPreview(params: { from: string }): Promise<{ audio: Uint8Array; type: string }> { return this.#sounds.soundPreview(params); }
  courseSounds(): CourseSound[] { return this.#reads.courseSounds(); }
  async soundEstimate(params: { duration?: number } = {}): Promise<SoundEstimate> { return this.#sounds.soundEstimate(params); }
  async generateSound(params: GenerateSoundParams, author: Author = this.author): Promise<GeneratedSound> { return this.#sounds.generateSound(params, author); }

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
    // The change of the person who asked for it (D79): their ⌘Z takes it back.
    return this.#change(this.author, async () => {
      const result = await restore(this.root, version, { paths, author: this.author, skip: (rel) => this.#skipInVersions(rel) });
      const updates = new Map<string, SourceFile | null>();
      for (const change of result.changes) updates.set(change.path, fileOf(await this.#folder.readDisk(change.path)));
      const seq = await this.#folder.journal({ updates, author: this.author, command: { name: 'restore_backup', args: { version, paths: paths ?? null } }, source: 'engine' });
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
        this.#batches.close('human');
        await this.#batches.flush();
      }
      // A course about to be migrated gets its migration version instead.
      if (this.#options.backups?.enabled !== false && !migration && !this.#versionInFlight && this.#versionDue()) await this.#takeVersion('auto', { author: SYSTEM });
      try {
        return await this.#folder.write(work);
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
        if (stale.length) this.#folder.reconcileSync(stale);
        return this.#state.files;
      }
    };
  }

  // Takes in what an edit wrote, without reading the folder.
  #committed<Result extends EditResult>(result: Result): { result: Result; change: number | null } {
    // The executor migrated the course first (another writer made it outdated meanwhile).
    if (result.formatMigration) {
      this.#adopt(result.formatMigration.written);
      if (result.formatMigration.change) this.#folder.own(result.formatMigration.change.seq, 'engine');
    }
    this.#adopt(result.written);
    if (result.change) this.#folder.own(result.change.seq, 'engine');
    return { result, change: result.change?.seq ?? null };
  }

  #adopt(written: Written | undefined): void {
    if (!written) return;
    const updates = new Map<string, SourceFile | null>();
    for (const [rel, file] of written.after) if (written.before.get(rel) !== file) updates.set(rel, toSourceFile(this.root, rel, file));
    for (const rel of written.before.keys()) if (!written.after.has(rel)) updates.set(rel, null);
    for (const rel of updates.keys()) this.#folder.recordStat(rel);
    this.#state.update(updates);
  }

  #runResult(command: string, result: EditResult, seq: number | null): RunResult {
    const touched = new Set(result.files);
    const { screens, project, summary } = this.#state.diagnostics();
    const all: Diagnostic[] = [...project];
    for (const list of screens.values()) all.push(...list);
    return {
      command, change: seq === null ? null : this.#changeView(seq), files: result.files, result: edit.commandResult(result),
      diagnostics: sortDiagnostics(all.filter((d) => touched.has(d.file ?? '') || (d.severity === 'error' && !d.waived))), summary
    };
  }

  #changeView(seq: number | null): ChangeView | null {
    if (seq === null) return null;
    const entry = this.#entries.find((candidate): candidate is ChangeLike => candidate.seq === seq && candidate.type !== 'mark');
    return entry ? changeView(entry) : null;
  }

  // Validates what changed and tells the app (the canvas first); then the AI batches that ended.
  async #afterChange(): Promise<void> {
    await this.#refreshMedia();
    this.#canvas.changed(this.#state.takeChanged(), this.#folder.lastSeq);
    const delta = this.#state.validate();
    if (delta) this.#emit(diagnosticsEvent(delta));
    await this.#batches.flush();
  }

  // ── media status ───────────────────────────────────────────────────

  // Media files of assets/ new or changed since they were probed get their verdict (the probe
  // cache answers for files the CLI already probed); the media status follows (jobs under way,
  // unreadable files, ffprobe), and media that are not conformant masters are converted.
  async #refreshMedia(): Promise<void> {
    // Not given to the conversion below: undoing a conversion must not convert it again.
    const again: [string, SourceFile][] = [];
    for (const [rel, file] of this.#state.files) {
      if (file.kind !== 'binary' || file.media || this.#mediaChecked.get(rel) !== (file.hash ?? '')) continue;
      const media = this.#mediaVerdicts.get(`${rel}\n${file.hash ?? ''}`);
      if (media) again.push([rel, binaryFile(file.size, { ...(file.hash ? { hash: file.hash } : {}), media })]);
    }
    if (again.length) this.#state.update(again);
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
        this.#mediaVerdicts.set(`${rel}\n${file.hash ?? ''}`, media);
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

  // ── journal entries, batches and versions ──────────────────────────

  // What the external change left out or replaced, by its id (a project in the cloud tells the others).
  externalNotes(change: string): ExternalNotes | undefined { return this.#folder.externalNotes(change); }

  // Journal entries the folder took in, in order: recorded, given to the copy in the cloud, told.
  #taken(entries: readonly JournalEntry[], source: (entry: JournalEntry) => ChangeSource): void {
    this.#record(entries);
    if (this.#cloud) for (const entry of entries) if (entry.type !== 'mark') this.#cloud.take(entry);
    for (const entry of entries) if (entry.type !== 'mark') this.#emit({ type: 'changed', source: source(entry), change: changeView(entry) });
  }

  #record(entries: readonly JournalEntry[]): void {
    for (const entry of entries) {
      this.#entries.push(entry);
      this.#batches.note(entry);
    }
    if (entries.some((entry) => entry.type !== 'mark')) this.#noteActivity();
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
    await this.#queue.run(() => this.#folder.locked(async () => {
      await this.#folder.sync();
      await pruneProjectData(this.root);
      // The journal as it is kept now (everything was read: the lock is held).
      this.#entries = await this.#folder.reread();
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
          await this.#folder.locked(async () => {
            await this.#folder.sync();
            try {
              await this.#journalMediaResult(job);
            } finally {
              await this.#folder.takeNew();
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
    for (const rel of paths) updates.set(rel, fileOf(await this.#folder.readDisk(rel)));
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
    if (!isAiAuthor(author) && author.kind !== 'external') this.#batches.close('human');
    await this.#folder.journal({ updates, author, command, source: 'media', write });
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

// What the build request asks of @elabora/node build; the session's validation options by default,
// so the package is checked as the app's findings are.
function buildOptions(params: BuildParams, validation: ValidationOptions = {}): BuildOptions {
  const { mediaQuality, release, profiles, name, target, web, languages: every } = params as Record<string, unknown>;
  if (mediaQuality !== undefined && !isPresetName(mediaQuality)) throw new EngineError('bad-request', `mediaQuality is high, medium or low (not ${JSON.stringify(mediaQuality)})`);
  if (release !== undefined && typeof release !== 'boolean') throw new EngineError('bad-request', 'release is true or false');
  if (profiles !== undefined && !(Array.isArray(profiles) && profiles.every((id) => typeof id === 'string'))) throw new EngineError('bad-request', 'profiles is a list of LMS profile ids');
  if (name !== undefined && typeof name !== 'string') throw new EngineError('bad-request', 'name is a string');
  if (target !== undefined && target !== 'web' && !isDeliveryFormat(target)) throw new EngineError('bad-request', `target is ${DELIVERY_FORMATS.join(', ')} or web (not ${JSON.stringify(target)})`);
  if (every !== undefined && every !== 'all' && !(Array.isArray(every) && every.every((language) => typeof language === 'string'))) throw new EngineError('bad-request', `languages is "all" or a list of language tags (not ${JSON.stringify(every)})`);
  const languages = every !== undefined ? { languages: every as 'all' | string[] } : {};
  if (target === 'web') {
    if (profiles !== undefined) throw new EngineError('bad-request', 'profiles are for LMS packages: a module for the web reports to no LMS');
    return { target, ...(mediaQuality !== undefined ? { mediaQuality } : {}), ...(web !== undefined ? { web: webOptions(web) } : {}), ...languages, release: release ?? validation.release ?? false };
  }
  if (web !== undefined) throw new EngineError('bad-request', 'web settings are for the web target (target: "web")');
  const targets = profiles ?? validation.profiles;
  return {
    ...(target !== undefined ? { target } : {}),
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

function backupSummary(version: VersionSummary): BackupSummary {
  return { ...version };
}
