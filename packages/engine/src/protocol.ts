import type { Diagnostic, Summary } from '@elabora/core/diagnostics/index';
import type { Author, Op, SkippedOp } from '@elabora/core/ops/types';
import type { BatchSummary } from '@elabora/core/ops/batch';
import type { Screen, Variable } from '@elabora/core/project/model';
import type { Anchor } from '@elabora/format';
import type { PlanApprovalState, PlanDiffView, PlanVersionsView } from '@elabora/core/project/plan-versions';
import type { PlanDocument } from '@elabora/core/plan-document/model';
import type { ExportedPlanDocument, PlanDocumentFormat } from '@elabora/node/plan-document-types';
import type { ExportedDialogue, DialogueExportFormat } from '@elabora/node/dialogue-export-types';
import type { DialogueView } from '@elabora/core/dialogue/view';
import type { PlayReport } from '@elabora/core/dialogue/play';
import type { RenderedScreen } from '@elabora/core/render/screen';
import type { MigrationNote } from '@elabora/core/format/migrations/types';
import type { PresetName } from '@elabora/core/media/presets';
import type { WebBuildOptions } from '@elabora/node/build-types';
import type { VoiceInfo, VoiceStatus, GenerateResult, TakeInfo, VoiceProgress, VoiceQuery, VoiceSearchResult, VoiceAccount, VoiceEstimate } from '@elabora/node/voice/types';
import type { AlignerView, AlignProgress, AlignResult } from '@elabora/node/align/types';
import type { TranscribeProgress, Transcript, TranscriberView, TranscriptionEstimate, TranscriptionService } from '@elabora/node/transcribe/types';
import type { NarrationPeaks, ImportedFile, LineFromAudioFileArgs, TextFromAudioFileArgs } from '@elabora/node/narration/types';
import type {
  CreateScreenArgs, UpdateScreenArgs, MoveScreenArgs, AddBlockArgs, ConvertBlockArgs, ConvertTarget, UpdateBlockArgs, MoveBlockArgs, DuplicateBlockArgs, UpdateCourseArgs, UpdatePlayerArgs, IgnoreFindingsArgs,
  CreateObjectArgs, WriteObjectFileArgs, CreateComponentArgs, ForkComponentArgs,
  WriteComponentFileArgs, MigrateComponentsArgs, AddLibraryComponentArgs, CommandDiagnostic, AddFontArgs, FontRequest, SettleImportReportArgs, AddResourceRequest,
  SetCaptionsArgs, UpsertLayerArgs, UpsertEventArgs, RenameArgs, DuplicateScreenArgs,
  UpdateNarrationArgs, AddNarrationLineArgs, UpdateNarrationLineArgs, MoveNarrationLineArgs, NarrationAudioFileArgs, RemoveSpeakerArgs, SetBlockTimingArgs, SetDialogueNodeArgs, RemoveDialogueNodeArgs, SetNarrationWordsArgs, SplitStepArgs, NarrationFromPlanArgs, KeepNarrationAudioArgs, SetPlanVoiceoverArgs,
  WritePlanArgs, SetPlanTextArgs, RevertPlanChangeArgs, CreatePlanVersionArgs, ApprovePlanArgs, RecordPlanSendArgs, SetPlanNoteArgs
} from '@elabora/core/commands/index';
import type { ScreenParts } from '@elabora/core/project/parts';
import type { NarrationView, TimelineView, ScreenAt, TimelineMark } from '@elabora/core/narration/view';
import type { EffectInfo } from '@elabora/core/narration/timeline';
import type { ReplaceTextArgs, TextMatch } from '@elabora/core/commands/text';
import type { ApproveTranslationArgs, ExportTranslationArgs, TranslateUnitArgs } from '@elabora/core/commands/translation';
import type { ScreenTranslation, TranslationStatus, TranslationTable } from '@elabora/core/i18n/translate';

// The engine's message protocol: what the desktop app sends over an Electron message port, and a
// server over a WebSocket. Transport-neutral and plain data (structured clone and JSON safe):
//   - a request carries an id; the engine answers it with one response, a result or a typed error;
//   - events tell what changed, whoever changed it (the app, an agent through the CLI or MCP, an
//     agent with its own file tools, a media job).
// This module imports types only, so a browser renderer can use it without Node types.

export type { Diagnostic, Summary, Author, Op, SkippedOp, BatchSummary, CommandDiagnostic, RenderedScreen, MigrationNote, PresetName, NarrationView, TimelineView, ScreenAt, PlanVersionsView, PlanDiffView };

// ── commands ─────────────────────────────────────────────────────────

// The commands the engine runs as changes, by their journaled names (the vocabulary of the CLI
// and the MCP server), with their arguments.
export interface CommandArgs {
  create_screen: CreateScreenArgs;
  update_screen: UpdateScreenArgs;
  delete_screen: { id: string };
  move_screen: MoveScreenArgs;
  duplicate_screen: DuplicateScreenArgs;
  add_block: AddBlockArgs;
  update_block: UpdateBlockArgs;
  remove_block: { block: string };
  move_block: MoveBlockArgs;
  duplicate_block: DuplicateBlockArgs;
  detach_block: { block: string };
  // « Transformer en… » (D63): the block becomes another type or presentation, its id and its items'
  // ids kept, its translations following; one undoable change. The conversions request lists the targets.
  convert_block: ConvertBlockArgs;
  upsert_layer: UpsertLayerArgs;
  remove_layer: { screen: string; id: string };
  upsert_event: UpsertEventArgs;
  remove_event: { screen: string; id: string };
  upsert_variable: { variable: Variable };
  remove_variable: { id: string };
  rename_variable: RenameArgs;
  update_course: UpdateCourseArgs;
  // The player's configuration, its tokens, resources, glossary and credits (D58).
  update_player: UpdatePlayerArgs;
  // « Ajouter une ressource »: any file copied into assets/resources/ and added to the resources, titled
  // as asked, else by the PDF's own title, else by its name (D58); undone, the copy goes.
  add_resource: AddResourceRequest;
  ignore_findings: IgnoreFindingsArgs;
  replace_text: ReplaceTextArgs;
  export_translation: ExportTranslationArgs;
  translate_text: TranslateUnitArgs;
  approve_translation: ApproveTranslationArgs;
  create_object: CreateObjectArgs;
  write_object_file: WriteObjectFileArgs;
  write_design_file: { file: string; content: string };
  // The plan and its versions (docs/decisions.md D52). The plan is written at any time, by the
  // author and by agents (an agent's write that changes a text kept « à l'identique » is refused,
  // E_PLAN_VERBATIM_LOCKED); items moved take their screens along (result.moved).
  write_plan: WritePlanArgs;
  // A validated text reworded on the canvas (by the block that shows it, or its id): the plan's text.
  set_plan_text: SetPlanTextArgs;
  // « Revenir à la V2 »: one change of planDiff undone (key: item:ITEM-3), back to the latest
  // validated version or the one given.
  revert_plan_change: RevertPlanChangeArgs;
  // A note for the client on a change in no version yet (target: its key); text null removes it.
  set_plan_note: SetPlanNoteArgs;
  // A person's (refused to an agent, E_PLAN_PERSON_ONLY): « Créer la V3 », the working copy frozen as
  // the next version; « Valider… », the client's validation of a version (the latest by default).
  create_plan_version: CreatePlanVersionArgs;
  approve_plan: ApprovePlanArgs;
  // A version exported for the client by the app itself (a PDF it printed): its day and format.
  // exportPlanDocument records it by itself.
  record_plan_send: RecordPlanSendArgs;
  set_captions: SetCaptionsArgs;
  update_narration: UpdateNarrationArgs;
  add_narration_line: AddNarrationLineArgs;
  update_narration_line: UpdateNarrationLineArgs;
  move_narration_line: MoveNarrationLineArgs;
  remove_narration_line: { screen: string; line: string };
  // A speaker leaves the course; its lines go to another speaker (to), or to none.
  remove_speaker: RemoveSpeakerArgs;
  // The audio of a line from a file (a voice tool's M4A, or a recording: provider "recording").
  set_narration_audio: NarrationAudioFileArgs;
  // « Couper à une réplique »: the line and those after it in its step start the next step; later
  // steps, their blocks, settings, anchors and reveal-step actions move one on.
  split_step: SplitStepArgs;
  // « La voix dit bien ce texte »: a line out of date because its text was corrected (a checked
  // transcription, a typo) keeps its audio; its words follow the corrected text.
  keep_narration_audio: KeepNarrationAudioArgs;
  // « Nouvelle réplique depuis un fichier audio… » (D46): a line made from a recording (file: an
  // absolute path), its text given or transcribed, its words timed, in one change.
  add_narration_line_with_audio: LineFromAudioFileArgs;
  // « Régénérer le texte d'après l'audio » (D46): the line's text becomes what its recording says
  // (text: as the author checked it; else transcribed now); the recording stays, its words timed again.
  set_narration_text_from_audio: TextFromAudioFileArgs;
  // A plan item's voice-over, line by line (null removes it), written in the plan.
  set_plan_voiceover: SetPlanVoiceoverArgs;
  // « Reprendre la voix off du plan »: the screen's script from its plan items' voice-over (replace:
  // a screen that has a narration loses it, and its audio).
  narration_from_plan: NarrationFromPlanArgs;
  // The word times of a line's audio (forced alignment), into its sidecar.
  set_narration_words: SetNarrationWordsArgs;
  // When a block comes and goes on its screen's timeline (in, out: patches; null removes).
  set_block_timing: SetBlockTimingArgs;
  // A node of a dialogue written whole (added after a node or first, or replaced in place), or removed (D61).
  set_dialogue_node: SetDialogueNodeArgs;
  remove_dialogue_node: RemoveDialogueNodeArgs;
  create_component: CreateComponentArgs;
  fork_component: ForkComponentArgs;
  write_component_file: WriteComponentFileArgs;
  migrate_components: MigrateComponentsArgs;
  add_component: AddLibraryComponentArgs & { library: string };
  publish_component: { library: string; component: string };
  add_font: FontRequest & AddFontArgs;
  // The import report (D47): decisions accepted as the import made them, or the report closed.
  settle_import_report: SettleImportReportArgs;
}

export type CommandName = keyof CommandArgs;

// ── views ────────────────────────────────────────────────────────────

// A journaled change as events and history show it.
export interface ChangeView {
  type: 'change' | 'undo';
  id: string;
  seq: number;
  at: string;
  author: Author;
  batch: string;
  command?: { name: string; args: unknown };
  files: string[];
  ops: Op[];
  undoes?: { batch?: string; changes: string[] };
  skipped?: SkippedOp[];
  // Binary files whose previous content was not kept (overwritten by another program before any
  // version stored it): undoing the change leaves them as they are.
  unavailable?: string[];
}

// Who made a change the engine reports: the engine itself (a request), the journal (another
// process: the CLI, the MCP server), the watcher (files written by a program that is not an Elabora
// tool, journaled as external), or a media job the engine ran.
export type ChangeSource = 'engine' | 'journal' | 'watcher' | 'media';

export interface ScreenOutline {
  id: string;
  title: string | null; // null: the screen file is missing or does not load
  file: string;
  errors: number;
  warnings: number;
  // How long a learner spends on it, estimated from what it holds (@elabora/core project/duration, D50).
  seconds: number;
}

// The format of the course's files against the one this Elabora writes. outdated: read migrated in
// memory (I_FORMAT_OUTDATED); the migrate request writes the migration (what `migrate` says: ask,
// auto on open, never: writes are refused). newer: written by a later Elabora, read-only here.
export interface FormatStatus {
  state: 'current' | 'outdated' | 'newer' | 'unknown';
  format: string | null; // as course.json declares it
  latest: string; // what this Elabora writes
  migrate: 'ask' | 'auto' | 'never';
  changes?: string[]; // outdated: what the migration changes, in a few lines
  files?: string[]; // outdated: the files it rewrites
}

export interface ProjectSummary {
  root: string;
  course: { id: string; title: string; language: string; version: string; format: string } | null;
  format: FormatStatus;
  outline: { id: string; title: string; screens: ScreenOutline[] }[];
  unlisted: string[]; // screen files no section lists
  // The plan's state from its versions (D52): latest and validated versions, the changes since the
  // validated one (the marks) and in no version (the pill's count); planVersions has the rest.
  plan: { state: PlanApprovalState; objectives: number; items: number; latest: number | null; validated: number | null; sinceValidated: number | null; unversioned: number | null };
  diagnostics: Summary;
  journal: { seq: number; openBatch: string | null };
  media: { queued: number; running: number };
}

export interface FileEntry {
  path: string;
  kind: 'text' | 'binary';
  size: number; // bytes
}

export type FileView =
  | { path: string; kind: 'text'; text: string; error?: string } // error: the file on disk does not parse (text: its last valid content)
  | { path: string; kind: 'binary'; size: number; hash: string | null };

export interface ScreenView {
  id: string;
  file: string;
  data: Screen;
  diagnostics: Diagnostic[]; // the screen's own findings and the project findings in its file
  error?: string; // the file on disk does not parse: data is its last valid content
}

export interface DiagnosticsView {
  screens: Record<string, Diagnostic[]>;
  project: Diagnostic[];
  summary: Summary;
}

export type VoiceView = VoiceInfo & VoiceStatus;

export interface AlignNarrationParams {
  screen?: string;
  lines?: string[];
  language?: string;
  force?: boolean;
}

export interface GenerateVoiceParams {
  screen: string;
  lines?: string[];
  all?: boolean;
  voice?: string;
  language?: string;
  take?: number;
  provider?: string;             // of voice (elevenlabs)
  // Paid voices (D29, D30): the share of the month's quota the author approved after voiceEstimate,
  // in percent; not needed under 1 % of the quota, refused without it from there (E_VOICE_SPEND).
  // dialogue: runs of several speakers said as one exchange.
  approvedPercent?: number;
  dialogue?: boolean;
}

export type ConversionsParams = { block: string; language?: string; probe?: false } | { probe: true; block?: string; language?: string };

export interface ConversionsView {
  supported: true;
  block?: string;
  from?: ConvertTarget;
  // Sentences in the language asked for; progress: whether learners who started keep their progress
  // in the block (lost: the lock entities they lose).
  targets: { to: ConvertTarget; kept: string; lost: string; added: string; progress: { kept: boolean; lost: string[] } }[];
  refused: { to: ConvertTarget; reason: string }[];
}

export interface RunResult {
  command: string;
  change: ChangeView | null; // null: the command changed nothing
  files: string[];
  result: Record<string, unknown>; // what the command reports (ids it created…)
  diagnostics: Diagnostic[]; // findings in the touched files, and every error
  summary: Summary;
}

export interface UndoView extends RunResult {
  undone: number[]; // sequence numbers of the undone changes
  skipped: SkippedOp[]; // parts kept because they changed since
  batch?: string;
}

export interface HistoryItem {
  seq: number;
  id: string;
  op: string; // the command, undo, or the author kind for edits made outside Elabora
  at: string;
  author: Author;
  batch: string;
  files: string[];
  undone: boolean;
  ops?: Op[]; // with the ops param: what the change did, as in ChangeView
}

export interface HistoryView {
  changes: HistoryItem[]; // oldest first
  batches: BatchSummary[]; // oldest first
  openBatch: string | null; // the AI batch still open (closed after 5 minutes without AI changes)
}

export interface MarkResult {
  mark: { id: string; seq: number };
  version: string | null; // the before-ai version (or the newest one, when nothing changed since)
}

export interface MediaJobInfo {
  id: string;
  type: 'import' | 'optimize' | 'rendition';
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  input: string;
  output: string;
  replaces: string | null;
  progress: number;
  error: string | null;
  warnings: string[];
  createdAt: string;
  finishedAt: string | null;
}

export interface MediaImportResult {
  path: string; // where the master appears once the job is done
  job: MediaJobInfo;
}

export type VersionReason = 'auto' | 'before-ai' | 'after-ai' | 'close' | 'publish' | 'migration' | 'import' | 'restore' | 'manual';

export interface BackupSummary {
  id: string;
  time: string;
  reason: VersionReason;
  name: string | null;
  batch: string | null;
  author: Author | null;
  files: number;
  bytes: number;
  trimmed: number;
  skipped: number;
}

export interface RestoreView {
  version: string;
  before: string | null; // the version holding the project as it was just before
  change: ChangeView | null;
  unavailable: { path: string; reason: string }[];
  kept: { path: string; reason: string }[];
  failed: { path: string; error: string }[];
  unmatched: string[];
}

export interface FormatMigrationView {
  from: string;
  to: string;
  change: ChangeView | null;
}

// A SCORM package, or a module for the web, as `elabora build` makes it (into <project>/dist).
export interface BuildParams {
  mediaQuality?: PresetName; // overrides course.json delivery.mediaQuality
  release?: boolean;         // client delivery: the plan must be approved (default: the session's validation option)
  profiles?: string[];       // target LMS profiles (default: the session's validation option, else the strictest values); scorm12 only
  name?: string;             // the publish version's name (default: the date in the course language, « Publié le 7 octobre 2026 »)
  target?: 'scorm12' | 'web'; // default scorm12; web: a folder to serve and its ZIP (D41)
  web?: WebBuildOptions;     // the web target's settings: progress local|none, navigation authored|free, noindex, url, image, review { origins } (D42)
  languages?: 'all';         // one package of every approved language, switched in place by learners (D59)
}

export interface BuildView {
  ok: boolean;
  zip: string | null;        // the package (ok)
  dir: string | null;        // the web target's folder, ready to serve (ok); null for SCORM
  size: number;              // its size in bytes (0 when the build stopped)
  report: string | null;     // the build report (ok); the proof dossier is next to it
  summary: Summary;
  errors: Diagnostic[];      // what stopped the build: its errors, waived ones left out
  warnings: Diagnostic[];    // what the build found that did not stop it (W_PACKAGE_TOO_LARGE_FOR_SOME_LMS…), waived and ignored ones left out
  change: ChangeView | null; // elabora.lock.json as the build wrote it (new state keys), a system change
  version: string | null;    // the publish version (ok)
}

// A language's package (the app's « Versions »): the translated course generated as `elabora translate
// build` writes it, in the project's data folder, then built as `elabora build` builds a course, into
// <project>/dist (<course>-<lang>-<version>-scorm12.zip). Texts left to translate, to review or
// stale stop it, unless allowMissing (a draft: they stay in the source language); translations that
// break the text always do (refused, with what to fix).
export interface TranslationBuildParams {
  language: string;
  allowMissing?: boolean;
  mediaQuality?: PresetName;
  release?: boolean; // the translated plan must be approved
  profiles?: string[];
}

export interface TranslationBuildView {
  language: string;
  ok: boolean;
  zip: string | null;
  size: number;
  report: string | null;
  units: number;
  untranslated: number; // left in the source language (allowMissing)
  unplaced: number; // word anchors whose marker the translation has not placed: at their line's start (allowMissing)
  plan: string | null; // the translated plan in the package: approved, or draft (not approved); null: no plan
  summary: Summary;
  errors: Diagnostic[]; // what stopped the package's build
  warnings: Diagnostic[]; // what the build found that did not stop it (W_PACKAGE_TOO_LARGE_FOR_SOME_LMS…), waived and ignored ones left out
}

// The editor canvas (docs/architecture/rendering.md, Rendering a screen): a local page that the app shows in
// a frame; the engine pushes the shown screen to it after every change that affects it, the
// change's sequence number as render id.
export interface CanvasInfo {
  url: string; // the page, with its token
  base: string; // http://127.0.0.1:<port>
  token: string;
  view: CanvasView;
}

export interface CanvasView {
  screen: string | null;
  state: 'initial' | 'answered';
  step: number | null;
  layer: string | null;
  language: string | null;
  // A timed screen at a moment (docs/decisions.md D28): a time in seconds on its timeline (the
  // playhead), or an anchor ({ line, word… }, { seconds }) the engine resolves in the language
  // shown; null: as captures show it, at the end of its steps. With a layer that has a timeline of
  // its own (D62), the moment is on the layer's timeline (the screen under it at its end or its step).
  at?: CanvasMoment | null;
  // Every step shown, those after the first faded in their place (the editor's phone width).
  ghost?: boolean;
  // A dialogue of the screen (D61) after these choices (option ids from its start), at rest, or at a
  // node; null: each dialogue at its start.
  dialogue?: CanvasDialogue | null;
}

export interface CanvasDialogue {
  block: string;
  choices?: string[];
  node?: string;
}

export type CanvasMoment = { time: number } | Anchor;

export interface RenderScreenParams {
  screen: string;
  state?: 'initial' | 'answered';
  step?: number;
  layer?: string;
  language?: string;
  at?: CanvasMoment;
  ghost?: boolean;
  dialogue?: CanvasDialogue;
}

// ── requests ─────────────────────────────────────────────────────────

type NoParams = Record<string, never>;

export type RunParams = { [Name in CommandName]: { command: Name; args: CommandArgs[Name]; author?: Author } }[CommandName];

export interface Requests {
  summary: { params: NoParams; result: ProjectSummary };
  readFile: { params: { path: string }; result: FileView };
  // The files of the project under a folder (all of them without one), sorted: the plan's versions
  // (plan-versions/), the media (assets/)…
  listFiles: { params: { dir?: string }; result: FileEntry[] };
  readScreen: { params: { screen: string }; result: ScreenView };
  // What the events of a screen can name: its blocks (what each triggers or takes), layers and
  // steps, the course's screens and variables. An event editor offers these.
  screenParts: { params: { screen: string }; result: ScreenParts };
  // A narrated screen as an editor shows it: its settings, each line in a language (default: the
  // course's) with its audio's state and its place on the timeline, the steps' segments; null: not
  // narrated (docs/decisions.md D24).
  // layer: that layer's narration (D62); each line says its track (the screen's, a layer's).
  narration: { params: { screen: string; language?: string; layer?: string }; result: NarrationView | null };
  // A timed screen's timeline as the Chronologie view shows it: lines with their words and times,
  // timed blocks with their moments, events on it (null: not timed); and the screen at a time.
  // layer: the timeline of that layer of the screen (D62).
  timeline: { params: { screen: string; language?: string; layer?: string }; result: TimelineView | null };
  timelineAt: { params: { screen: string; time?: number; at?: CanvasMoment; language?: string; layer?: string }; result: ScreenAt | null };
  // The marks of a timed screen, a storyboard (the Revue, elabora look --sheet): its start, each block
  // that comes or goes, each cue, each step's end, with the time to show each at (canvasView { at }).
  timelineMarks: { params: { screen: string; language?: string; layer?: string }; result: TimelineMark[] | null };
  // The effects a block's timing can take (built-in presets, then the theme's theme.effects), with
  // their default duration, the directions they take and what they do.
  effects: { params: NoParams; result: EffectInfo[] };
  // Transcription (docs/decisions.md D46). What can transcribe a language here (the local model,
  // installed or its size; ElevenLabs when the author gave a key); what a recording says (file: an
  // absolute path), on this computer by default (install: download the model first, transcribeProgress
  // events; otherwise not-available, E_TRANSCRIBE_NOT_INSTALLED) or with ElevenLabs (refused with
  // E_TRANSCRIBE_SPEND from 1 % of the quota unless approvedPercent covers it); what that would take
  // of the quota (a file, or a line's recording); what a line's recording says beside its text now,
  // before « Régénérer le texte d'après l'audio » writes it (set_narration_text_from_audio).
  transcribers: { params: { language?: string }; result: TranscriberView };
  transcribeRecording: { params: { file: string; language?: string; install?: boolean; service?: TranscriptionService; approvedPercent?: number }; result: Transcript };
  transcriptionEstimate: { params: { file?: string; screen?: string; line?: string; language?: string }; result: TranscriptionEstimate };
  transcribeLine: { params: { screen: string; line: string; language?: string; install?: boolean; service?: TranscriptionService; approvedPercent?: number }; result: { before: string; transcript: Transcript; audioHash: `sha256:${string}` | null } };
  // The voice-over the validated plan gives a screen (the items it covers), line by line: when there
  // is one, a screen without narration offers « Reprendre la voix off du plan » (narration_from_plan).
  planVoiceover: { params: { screen: string }; result: { item: string; speaker?: string; text: string }[] };
  // The plan's versions (docs/decisions.md D52): each one made, sent, validated, with its notes; the
  // working copy's state, its changes since the validated version and in no version; what an export
  // shows by default and how many changes it would not show (export: the warning before exporting);
  // the texts kept « à l'identique » changed since the validation; the notes waiting.
  planVersions: { params: NoParams; result: PlanVersionsView };
  // What changed in the plan, element by element: from a version (2), « validated » (default) or
  // « latest », to a version or « current » (default).
  planDiff: { params: { from?: number | 'validated' | 'latest' | 'current'; to?: number | 'validated' | 'latest' | 'current' }; result: PlanDiffView };
  // The plan's document (docs/decisions.md D48, D52): what the client reads, comments and signs, as
  // data; null without a readable plan. version: 2 or « current » (the Document view shows the
  // working copy); the latest version by default, as an export. date: the day it is made (today).
  planDocument: { params: { date?: string; version?: number | 'current' }; result: PlanDocument | null };
  // The same as one HTML page, fonts inline, for the app to print with webContents.printToPDF
  // (PLAN_PDF_ELECTRON) and finish with finishPlanPdf(pdf, date); version: what it shows (« V2 »,
  // null for the working copy), so that the app records the send (record_plan_send).
  planDocumentPage: { params: { date?: string; version?: number | 'current' }; result: { html: string; date: string; title: string; version: string | null } };
  // The document written to file (an absolute path): .docx, .html, or .pdf printed by Chromium here;
  // the send recorded on the version it shows (one change, record_plan_send). Never makes a version.
  exportPlanDocument: { params: { format: PlanDocumentFormat; file: string; date?: string; version?: number | 'current' }; result: ExportedPlanDocument };
  // A dialogue block (D61) for its editor: its data (stage directions kept), its script, its map
  // (placed by the core: nothing stored in the module) and its paths; null when there is no such block.
  dialogue: { params: { block: string }; result: DialogueView | null };
  // « Jouer un chemin »: the path of the choices given (option ids, one per decision met), its beats
  // as text, its score, its ending and its duration; error says which choice was not offered.
  dialoguePlay: { params: { block: string; choices: string[] }; result: PlayReport };
  // The dialogue's script and map as one HTML page, fonts inline, for the app to print (as
  // planDocumentPage), dated date (YYYY-MM-DD).
  dialoguePage: { params: { block: string; date?: string }; result: { html: string; date: string; title: string } };
  // The same written to file (an absolute path), .html or .pdf printed by Chromium here.
  exportDialogue: { params: { block: string; format: DialogueExportFormat; file: string; date?: string }; result: ExportedDialogue };
  // The waveform of a narrated screen's lines (the Chronologie view): the loudest sample of each
  // slice, 0 to 255, perSecond slices a second (default 50); null: not narrated.
  narrationPeaks: { params: { screen: string; language?: string; perSecond?: number }; result: NarrationPeaks | null };
  // Recordings of several lines at once (« Importer des enregistrements »): each file (absolute
  // paths) to the line its name gives (a line id, <screen>-<line>, or its number in the screen), the
  // others, with a screen, to the line whose text the word aligner finds in it; one change a line.
  importNarrationFiles: { params: { files: string[]; screen?: string; language?: string; keepSilence?: boolean }; result: { language: string; files: ImportedFile[] } };
  // The course's words that hold a text (not the plan's validated texts): where each one is.
  findText: { params: { query: string; caseSensitive?: boolean }; result: TextMatch[] };
  // « Transformer en… » (D63): what a block may become, and for each what is kept, lost and added, in
  // language (fr, else en); refused targets with their reason. { probe: true } answers { supported: true }
  // with no targets (an app asks once whether the engine converts).
  conversions: { params: ConversionsParams; result: ConversionsView };
  // The course's languages (translations/<lang>.xlf) and how far each is; one as a bilingual table.
  translationStatus: { params: { to?: string }; result: TranslationStatus[] };
  translationTable: { params: { language: string }; result: TranslationTable };
  // One screen's texts in a language, with where the canvas shows each (the canvas shows the screen
  // in that language: canvasView { language }); and a language built as its own package.
  screenTranslation: { params: { screen: string; language: string }; result: ScreenTranslation };
  buildTranslation: { params: TranslationBuildParams; result: TranslationBuildView };
  run: { params: RunParams; result: RunResult };
  undo: { params: { seq?: number }; result: UndoView };
  undoBatch: { params: { batch?: string }; result: UndoView };
  history: { params: { limit?: number; ops?: boolean }; result: HistoryView };
  mark: { params: { request: string }; result: MarkResult };
  diagnostics: { params: { screen?: string }; result: DiagnosticsView };
  importMedia: { params: { path: string; to?: string; name?: string }; result: MediaImportResult };
  mediaJobs: { params: NoParams; result: MediaJobInfo[] };
  cancelMediaJob: { params: { id: string }; result: MediaJobInfo | null };
  backups: { params: NoParams; result: BackupSummary[] };
  createBackup: { params: { name?: string }; result: BackupSummary | null };
  restoreBackup: { params: { version: string; paths?: string[] }; result: RestoreView };
  renderScreen: { params: RenderScreenParams; result: RenderedScreen };
  openCanvas: { params: { port?: number; debug?: boolean }; result: CanvasInfo };
  // Changes what the canvas shows: another screen or language (a new render), or the state, step
  // or layer of the screen shown (null: none). id: the render or view id the page reports back.
  canvasView: { params: Partial<CanvasView>; result: { id: string; pages: number; view: CanvasView } };
  closeCanvas: { params: NoParams; result: { closed: boolean } };
  migrate: { params: NoParams; result: FormatMigrationView | null };
  // Generated narration (docs/decisions.md D25). The voices of a language and whether their model is
  // on this computer (else its size); its download (voiceProgress events, phase install); a
  // speaker's voice (course.json speakers[].voices[<lang>], one change); the lines of a screen said
  // by their speakers' voices (missing or out of date by default, all, or some; voice: set it first;
  // take: put back an earlier take of one line), one change a line, voiceProgress events while it
  // runs; the takes of a line kept on this computer.
  voices: { params: { language?: string }; result: VoiceView[] };
  installVoices: { params: { language: string }; result: { language: string; installed: boolean } };
  setSpeakerVoice: { params: { speaker: string; voice: string; language?: string; provider?: string; name?: string; settings?: Record<string, unknown> }; result: { change: number | null } };
  // ElevenLabs (docs/decisions.md D29, D40). The key the app keeps in the system's secure storage,
  // given to the engine in memory only (null forgets it; a key in the agents' file is read there); the account: plan, its quota and the share used,
  // the key masked, and with check its permissions tried without spending; voices searched (the
  // account's, then the library's); what generating a screen's lines would cost before anything is
  // spent, as a share of the month's quota and whether that needs the author's approval (D30).
  setVoiceKey: { params: { provider: 'elevenlabs'; key: string | null }; result: { key: string | null } };
  voiceAccount: { params: { provider: 'elevenlabs'; check?: boolean }; result: VoiceAccount };
  voiceSearch: { params: VoiceQuery; result: VoiceSearchResult };
  voiceEstimate: { params: GenerateVoiceParams; result: VoiceEstimate };
  generateVoice: { params: GenerateVoiceParams; result: GenerateResult };
  voiceTakes: { params: { screen: string; line: string; language?: string }; result: { language: string; takes: TakeInfo[] } };
  // Stops what the voices are making: a screen's generation (its lines said so far stay, the result
  // says cancelled), or every generation and download without a screen. How many were stopped.
  cancelVoice: { params: { screen?: string }; result: { cancelled: number } };
  // A voice heard before it is chosen: a few words said by it, written nowhere; its model must be on
  // this computer (not-available, E_VOICE_NOT_INSTALLED). WAV bytes, mono.
  // A paid voice (ElevenLabs) is refused (E_VOICE_PAID: its preview is heard free) unless spend: it
  // then says the author's words, at a cost far under 1 % of the quota (D30).
  voiceSample: { params: { voice: string; provider?: string; language?: string; text: string; spend?: boolean; name?: string }; result: { audio: Uint8Array; duration: number } };
  // Word times (docs/decisions.md D27): the word aligners and whether they are on this computer; the
  // voiced lines of a screen (or of every screen) timed by forced alignment, their words written into
  // their sidecars (set_narration_words, one change a line), the aligner of the language downloaded
  // first (alignProgress events); lines already timed by the same aligner are skipped unless force.
  // cancelVoice stops it (its screen, or every job). A line made or imported once the aligner is
  // here is timed at once, in the same change as its audio.
  aligners: { params: { language?: string }; result: AlignerView[] };
  alignNarration: { params: AlignNarrationParams; result: AlignResult };
  build: { params: BuildParams; result: BuildView };
  close: { params: NoParams; result: { version: string | null } };
}

export type RequestType = keyof Requests;
export type RequestParams<Type extends RequestType> = Requests[Type]['params'];
export type RequestResult<Type extends RequestType> = Requests[Type]['result'];

export type RequestMessage = { [Type in RequestType]: { kind: 'request'; id: string; type: Type; params: RequestParams<Type> } }[RequestType];

// What went wrong, for the app to act on:
//   refused        the command or undo was refused (code: the diagnostic catalogue's, E_LOCKED,
//                  E_CONFLICT, E_SCHEMA…; diagnostics say why)
//   not-found      no such file, screen, change, batch, version or media job
//   bad-request    the message is not a request the engine knows
//   not-available  not possible in this session (media off, no canvas open)
//   closed         the session is closed
//   internal       a bug or an I/O failure (message says which)
export type ErrorKind = 'refused' | 'not-found' | 'bad-request' | 'not-available' | 'closed' | 'internal';

export interface ProtocolError {
  kind: ErrorKind;
  message: string;
  code?: string;
  diagnostics?: CommandDiagnostic[];
}

export type ResponseMessage =
  | { [Type in RequestType]: { kind: 'response'; id: string; type: Type; ok: true; result: RequestResult<Type> } }[RequestType]
  | { kind: 'response'; id: string; type: string; ok: false; error: ProtocolError };

// ── events ───────────────────────────────────────────────────────────

export type EngineEvent =
  // A change was journaled (or an undo), by the engine or found in the journal or on disk.
  | { type: 'changed'; source: ChangeSource; change: ChangeView }
  // Findings that changed: screens whose list changed (removed: screens gone), the project's
  // findings when they changed, and the summary over everything.
  | { type: 'diagnostics'; screens: Record<string, Diagnostic[]>; removed: string[]; project?: Diagnostic[]; summary: Summary }
  | { type: 'mediaJob'; job: MediaJobInfo }
  // A voice model downloading (phase install) or a line being said (phase line: its fraction).
  | { type: 'voiceProgress'; screen?: string; progress: VoiceProgress }
  // The word aligner downloading (phase install) or timing a line.
  | { type: 'alignProgress'; screen?: string; progress: AlignProgress }
  // The transcriber downloading (phase install) or hearing a recording.
  | { type: 'transcribeProgress'; progress: TranscribeProgress }
  | { type: 'backupTaken'; version: BackupSummary }
  // An AI batch is over: idle for 5 minutes, a human change, a mark, or the session closing.
  | { type: 'batchClosed'; batch: string; reason: 'idle' | 'human' | 'mark' | 'close'; version: string | null }
  // A background task failed (the watcher, a version, a media job's reconciliation…).
  | { type: 'error'; message: string; code?: string; context?: string }
  | { type: 'closed' };

export type EventMessage = { kind: 'event'; event: EngineEvent };

export type EngineMessage = RequestMessage | ResponseMessage | EventMessage;

// ── client ───────────────────────────────────────────────────────────

export class ProtocolRequestError extends Error {
  readonly kind: ErrorKind;
  readonly code: string | undefined;
  readonly diagnostics: CommandDiagnostic[];

  constructor(error: ProtocolError) {
    super(error.message);
    this.name = 'ProtocolRequestError';
    this.kind = error.kind;
    this.code = error.code;
    this.diagnostics = error.diagnostics ?? [];
  }
}

// The app's side of a transport: send requests, get typed results, receive events.
//   const client = new ProtocolClient((message) => port.postMessage(message));
//   port.onmessage = ({ data }) => client.receive(data);
//   const summary = await client.request('summary', {});
export class ProtocolClient {
  readonly #send: (message: RequestMessage) => void;
  readonly #pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  #next = 0;

  constructor(send: (message: RequestMessage) => void) {
    this.#send = send;
  }

  request<Type extends RequestType>(type: Type, params: RequestParams<Type>): Promise<RequestResult<Type>> {
    const id = `r${++this.#next}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.#send({ kind: 'request', id, type, params } as RequestMessage);
    });
  }

  receive(message: ResponseMessage | EventMessage): void {
    if (message.kind === 'event') {
      for (const listener of this.#listeners) listener(message.event);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new ProtocolRequestError(message.error));
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
