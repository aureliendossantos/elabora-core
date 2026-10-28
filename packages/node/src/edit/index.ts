import fs from 'node:fs';
import path from 'node:path';
import * as commands from '@elabora/core/commands/index';
import type {
  CreateScreenArgs, UpdateScreenArgs, MoveScreenArgs, AddBlockArgs, UpdateBlockArgs, MoveBlockArgs, DuplicateBlockArgs, UpdateCourseArgs, IgnoreFindingsArgs, CreateObjectArgs,
  WriteObjectFileArgs, ObjectTemplates, CreateComponentArgs, ForkComponentArgs, WriteComponentFileArgs,
  MigrateComponentsArgs, AddLibraryComponentArgs, RenameArgs, AddFontArgs, SetCaptionsArgs, ConvertBlockArgs, UpsertLayerArgs, UpsertEventArgs, DuplicateScreenArgs, ReplaceTextArgs, ExportTranslationArgs, TranslateUnitArgs, ApproveTranslationArgs, SettleImportReportArgs
} from '@elabora/core/commands/index';
import type { Variable } from '@elabora/core/project/model';
import type { MigrationSteps } from '@elabora/core/components/migrate';
import { componentHash, BUILTINS } from '@elabora/core/components/registry';
import { TEMPLATES_DIR } from '../scaffold.ts';
import { loadProjectFromDir } from '../project-reader.ts';
import { loadMigrations } from '../component-migrations.ts';
import { runCommand, type EditOptions } from './executor.ts';
import { readLibrary, libraryComponent, publishToLibrary } from './library.ts';
import { resolveFont, type FontRequest } from '../fonts/index.ts';

// Edits of a course folder: the commands of @elabora/core/commands run as journaled, undoable changes
// under the project lock (executor.ts). The CLI, the MCP server and tests call these; each returns
// { ok, op, undo, change, files, diagnostics, summary, …what the command reports }.

export { EditError, runCommand, type EditOptions, type EditResult, type ChangeRef, type Written } from './executor.ts';
export { history, historyBatches, undo, undoBatch, appendMark, type HistoryEntry, type UndoResult } from './history.ts';
export { migrateProject, migrateIfOutdated, type MigrateOptions, type MigrateResult, type FormatMigrationRef } from './migrate.ts';
export { addResource, titleFromName } from './resources.ts';
export { COMPONENT_FILES } from '@elabora/core/commands/index';
export { componentHash, BUILTINS };

// ── screens ──────────────────────────────────────────────────────────

export function createScreen(dir: string, args: CreateScreenArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'create_screen', args, run: (context) => commands.createScreen(context, args) }, options);
}

export function updateScreen(dir: string, args: UpdateScreenArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'update_screen', args, run: (context) => commands.updateScreen(context, args) }, options);
}

export function deleteScreen(dir: string, args: { id: string }, options?: EditOptions) {
  return runCommand(dir, { name: 'delete_screen', args, run: (context) => commands.deleteScreen(context, args) }, options);
}

export function moveScreen(dir: string, args: MoveScreenArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'move_screen', args, run: (context) => commands.moveScreen(context, args) }, options);
}

export function duplicateScreen(dir: string, args: DuplicateScreenArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'duplicate_screen', args, run: (context) => commands.duplicateScreen(context, args) }, options);
}

// ── blocks ───────────────────────────────────────────────────────────

// parent: put the block in a slot of a component instance (block.slot picks the slot).
export function addBlock(dir: string, args: AddBlockArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'add_block', args, run: (context) => commands.addBlock(context, args) }, options);
}

// props are merged: keys set to null are removed.
export function updateBlock(dir: string, args: UpdateBlockArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'update_block', args, run: (context) => commands.updateBlock(context, args) }, options);
}

export function removeBlock(dir: string, args: { block: string }, options?: EditOptions) {
  return runCommand(dir, { name: 'remove_block', args, run: (context) => commands.removeBlock(context, args) }, options);
}

// Moves a block within its screen, to another screen, into a layer or into the slots of a
// component instance (parent; slot picks the slot, null clears it).
export function moveBlock(dir: string, args: MoveBlockArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'move_block', args, run: (context) => commands.moveBlock(context, args) }, options);
}

export function duplicateBlock(dir: string, args: DuplicateBlockArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'duplicate_block', args, run: (context) => commands.duplicateBlock(context, args) }, options);
}

export function detachBlock(dir: string, args: { block: string }, options?: EditOptions) {
  return runCommand(dir, { name: 'detach_block', args, run: (context) => commands.detachBlock(context, args) }, options);
}

// « Transformer en… » (D63): the block becomes another type or presentation in place, its id and its
// items' ids kept, its translations following; without to, or with dryRun, nothing is written and the
// result says what it would do (the possible targets, without to).
export function convertBlock(dir: string, args: ConvertBlockArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'convert_block', args, run: (context) => commands.convertBlock(context, args) }, options);
}

// Gives a section, screen, layer, block or event another id: its references, the screen file and
// the state lock follow, in one change (learner progress keeps its key).
export function rename(dir: string, args: RenameArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'rename', args, run: (context) => commands.renameId(context, args) }, options);
}

// ── layers, events, variables, course ────────────────────────────────

export function upsertLayer(dir: string, args: UpsertLayerArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'upsert_layer', args, run: (context) => commands.upsertLayer(context, args) }, options);
}

export function removeLayer(dir: string, args: { screen: string; id: string }, options?: EditOptions) {
  return runCommand(dir, { name: 'remove_layer', args, run: (context) => commands.removeLayer(context, args) }, options);
}

export function upsertEvent(dir: string, args: UpsertEventArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'upsert_event', args, run: (context) => commands.upsertEvent(context, args) }, options);
}

export function removeEvent(dir: string, args: { screen: string; id: string }, options?: EditOptions) {
  return runCommand(dir, { name: 'remove_event', args, run: (context) => commands.removeEvent(context, args) }, options);
}

export function upsertVariable(dir: string, args: { variable: Variable }, options?: EditOptions) {
  return runCommand(dir, { name: 'upsert_variable', args, run: (context) => commands.upsertVariable(context, args) }, options);
}

export function renameVariable(dir: string, args: RenameArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'rename_variable', args, run: (context) => commands.renameVariable(context, args) }, options);
}

// The course's words found and replaced in one change (not the plan's validated texts).
export function replaceText(dir: string, args: ReplaceTextArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'replace_text', args, run: (context) => commands.replaceText(context, args) }, options);
}

// A language started or brought up to date (translations/<lang>.xlf), texts translated, the translated
// plan approved: changes.
export function exportTranslationChange(dir: string, args: ExportTranslationArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'export_translation', args, run: (context) => commands.exportTranslation(context, args) }, options);
}

export function translateText(dir: string, args: TranslateUnitArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'translate_text', args, run: (context) => commands.translateText(context, args) }, options);
}

export function approveTranslation(dir: string, args: ApproveTranslationArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'approve_translation', args, run: (context) => commands.approveTranslation(context, args) }, options);
}

export function removeVariable(dir: string, args: { id: string }, options?: EditOptions) {
  return runCommand(dir, { name: 'remove_variable', args, run: (context) => commands.removeVariable(context, args) }, options);
}

export function updateCourseSettings(dir: string, fields: UpdateCourseArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'update_course', args: fields, run: (context) => commands.updateCourseSettings(context, fields) }, options);
}

// Warnings the author ignores, or brings back (course.json ignored, D31): one change.
export function ignoreFindings(dir: string, args: IgnoreFindingsArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'ignore_findings', args, run: (context) => commands.ignoreFindings(context, args) }, options);
}

// The course's theme put under its components, its look kept (cascade D32): one change.
export function upgradeThemeCascade(dir: string, options?: EditOptions) {
  return runCommand(dir, { name: 'upgrade_theme', args: {}, run: (context) => commands.upgradeThemeCascade(context) }, options);
}

// The player's configuration, its tokens and the content its items show (D58): one change.
export function updatePlayer(dir: string, args: commands.UpdatePlayerArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'update_player', args, run: (context) => commands.updatePlayer(context, args) }, options);
}

// ── objects and design files ─────────────────────────────────────────

function objectTemplates(): ObjectTemplates {
  const read = (file: string) => fs.readFileSync(path.join(TEMPLATES_DIR, 'object', file), 'utf8');
  return Object.fromEntries(commands.OBJECT_FILES.map((file) => [file, read(file)])) as ObjectTemplates;
}

export function createObject(dir: string, args: CreateObjectArgs, options?: EditOptions) {
  const templates = objectTemplates();
  return runCommand(dir, { name: 'create_object', args, run: (context) => commands.createObject(context, args, templates) }, options);
}

// The content is in the operations: the journaled arguments only say how long it was.
export function writeObjectFile(dir: string, args: WriteObjectFileArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'write_object_file', args: { object: args.object, file: args.file, bytes: args.content.length }, run: (context) => commands.writeObjectFile(context, args) }, options);
}

export function writeDesignFile(dir: string, args: { file: string; content: string }, options?: EditOptions) {
  return runCommand(dir, { name: 'write_design_file', args: { file: args.file, bytes: args.content.length }, run: (context) => commands.writeDesignFile(context, args) }, options);
}

// A font and its licence into theme/fonts/<id>/, its faces in course.json, its stack in the tokens
// (for): a vetted font of @elabora/fonts by its family, a Fontsource package (from) or local files
// (files, license); latin, and latin-ext when a language of the course needs it (or the subsets
// asked). Adding a family again replaces its faces.
export function addFont(dir: string, args: FontRequest & AddFontArgs, options?: EditOptions) {
  const font = resolveFont(args);
  const result = runCommand(dir, { name: 'add_font', args, run: (context) => commands.addFont(context, { for: args.for, subsets: args.subsets }, font.source), sources: font.sources }, options);
  return { ...result, origin: font.origin, notes: [...font.notes, ...result.notes] };
}

// The import report settled in the app (D47): decisions accepted, or the report closed (deleted).
export function settleImportReport(dir: string, args: SettleImportReportArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'settle_import_report', args, run: (context) => commands.settleImportReport(context, args) }, options);
}

// ── contract layer (D52) ─────────────────────────────────────────────

// The plan written at any time, whole or by a JSON Patch, its schema checked first; an agent's write
// that changes a text kept « à l'identique » is refused.
export function writePlan(dir: string, args: commands.WritePlanArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'write_plan', args, run: (context) => commands.writePlan(context, args) }, options);
}

// A validated text reworded (the canvas: the block keeps its textRef).
export function setPlanText(dir: string, args: commands.SetPlanTextArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'set_plan_text', args, run: (context) => commands.setPlanText(context, args) }, options);
}

// « Revenir à la V2 »: one change undone, the element as the version has it.
export function revertPlanChange(dir: string, args: commands.RevertPlanChangeArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'revert_plan_change', args, run: (context) => commands.revertPlanChange(context, args) }, options);
}

// A person's: the working copy frozen as the next version.
export function createPlanVersion(dir: string, args: commands.CreatePlanVersionArgs = {}, options?: EditOptions) {
  return runCommand(dir, { name: 'create_plan_version', args, run: (context) => commands.createPlanVersion(context, args) }, options);
}

// A person's: the client validated a version (the latest by default).
export function approvePlan(dir: string, args: commands.ApprovePlanArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'approve_plan', args, run: (context) => commands.approvePlan(context, args) }, options);
}

// A version exported for the client: its day and format, recorded on it.
export function recordPlanSend(dir: string, args: commands.RecordPlanSendArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'record_plan_send', args, run: (context) => commands.recordPlanSend(context, args) }, options);
}

// A note for the client on a change not in a version yet (null removes it).
export function setPlanNote(dir: string, args: commands.SetPlanNoteArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'set_plan_note', args, run: (context) => commands.setPlanNote(context, args) }, options);
}

// A screen's narration (docs/decisions.md D24): its settings and its lines; the audio of a line,
// with its sidecar, from bytes already stored (narration.ts imports a file).
export function updateNarration(dir: string, args: commands.UpdateNarrationArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'update_narration', args, run: (context) => commands.updateNarration(context, args) }, options);
}

export function addNarrationLine(dir: string, args: commands.AddNarrationLineArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'add_narration_line', args, run: (context) => commands.addNarrationLine(context, args) }, options);
}

export function updateNarrationLine(dir: string, args: commands.UpdateNarrationLineArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'update_narration_line', args, run: (context) => commands.updateNarrationLine(context, args) }, options);
}

export function moveNarrationLine(dir: string, args: commands.MoveNarrationLineArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'move_narration_line', args, run: (context) => commands.moveNarrationLine(context, args) }, options);
}

// A block carries on from a block of another screen, or no longer does, and the length of the
// passage to it (continuity, D65).
export function setContinuity(dir: string, args: commands.SetContinuityArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'set_continuity', args, run: (context) => commands.setContinuity(context, args) }, options);
}

// When a block comes and goes on its screen's timeline (docs/decisions.md D28).
export function setBlockTiming(dir: string, args: commands.SetBlockTimingArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'set_block_timing', args, run: (context) => commands.setBlockTiming(context, args) }, options);
}

// A node of a dialogue written whole, or removed (docs/decisions.md D61).
export function setDialogueNode(dir: string, args: commands.SetDialogueNodeArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'set_dialogue_node', args, run: (context) => commands.setDialogueNode(context, args) }, options);
}

export function removeDialogueNode(dir: string, args: commands.RemoveDialogueNodeArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'remove_dialogue_node', args, run: (context) => commands.removeDialogueNode(context, args) }, options);
}

export function removeNarrationLine(dir: string, args: { screen: string; line: string }, options?: EditOptions) {
  return runCommand(dir, { name: 'remove_narration_line', args, run: (context) => commands.removeNarrationLine(context, args) }, options);
}

// A speaker leaves the course; its lines go to another speaker, or to none.
export function removeSpeaker(dir: string, args: commands.RemoveSpeakerArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'remove_speaker', args, run: (context) => commands.removeSpeaker(context, args) }, options);
}

// sources: the audio's bytes (or the path of a file holding them) by hash.
export function setNarrationAudioChange(dir: string, args: commands.SetNarrationAudioArgs, sources: ReadonlyMap<string, Uint8Array | string>, options?: EditOptions) {
  return runCommand(dir, { name: 'set_narration_audio', args, run: (context) => commands.setNarrationAudio(context, args), sources }, options);
}

// A plan item's voice-over, written in the plan.
export function setPlanVoiceover(dir: string, args: commands.SetPlanVoiceoverArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'set_plan_voiceover', args, run: (context) => commands.setPlanVoiceover(context, args) }, options);
}

// « La voix dit bien ce texte »: the corrected text keeps its audio.
export function keepNarrationAudio(dir: string, args: commands.KeepNarrationAudioArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'keep_narration_audio', args, run: (context) => commands.keepNarrationAudio(context, args) }, options);
}

// « Nouvelle réplique depuis un fichier audio… »: a line and its recording in one change (sources:
// the audio's bytes by hash; narration/from-audio.ts encodes the file and transcribes it).
export function addNarrationLineWithAudioChange(dir: string, args: commands.AddNarrationLineWithAudioArgs, sources: ReadonlyMap<string, Uint8Array | string>, options?: EditOptions) {
  return runCommand(dir, { name: 'add_narration_line_with_audio', args, run: (context) => commands.addNarrationLineWithAudio(context, args), sources }, options);
}

// « Régénérer le texte d'après l'audio »: the line's text becomes what its recording says.
export function setNarrationTextFromAudioChange(dir: string, args: commands.SetNarrationTextFromAudioArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'set_narration_text_from_audio', args, run: (context) => commands.setNarrationTextFromAudio(context, args) }, options);
}

// « Reprendre la voix off du plan »: the screen's script from the voice-over its plan items give.
export function narrationFromPlan(dir: string, args: commands.NarrationFromPlanArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'narration_from_plan', args, run: (context) => commands.narrationFromPlan(context, args) }, options);
}

// « Couper à une réplique »: the line and those after it in its step start the next step.
export function splitStep(dir: string, args: commands.SplitStepArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'split_step', args, run: (context) => commands.splitStep(context, args) }, options);
}

// The word times of a line's audio, into its sidecar (docs/decisions.md D27: elabora narration align).
export function setNarrationWords(dir: string, args: commands.SetNarrationWordsArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'set_narration_words', args, run: (context) => commands.setNarrationWords(context, args) }, options);
}

// A video's captions: a WebVTT (or SubRip) text written under assets/captions/ and named by the block.
export function setCaptions(dir: string, args: SetCaptionsArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'set_captions', args, run: (context) => commands.setCaptions(context, args) }, options);
}

// ── components ───────────────────────────────────────────────────────

// A new component: block type (level block) or screen layout (level screen).
export function createComponent(dir: string, args: CreateComponentArgs, options?: EditOptions) {
  commands.checkComponentId(args.id);
  return runCommand(dir, { name: 'create_component', args, run: (context) => commands.createComponent(context, args) }, options);
}

export function forkComponent(dir: string, args: ForkComponentArgs, options?: EditOptions) {
  commands.checkComponentId(args.id);
  return runCommand(dir, { name: 'fork_component', args, run: (context) => commands.forkComponent(context, args) }, options);
}

export function writeComponentFile(dir: string, args: WriteComponentFileArgs, options?: EditOptions) {
  return runCommand(dir, { name: 'write_component_file', args: { component: args.component, file: args.file, bytes: args.content.length }, run: (context) => commands.writeComponentFile(context, args) }, options);
}

// Runs the migration steps of components/<id>/migrations.mjs on every instance (and layout props),
// checks the results against the new schema, then writes everything in one undoable change.
export async function migrateComponents(dir: string, args: MigrateComponentsArgs = {}, options?: EditOptions) {
  const project = loadProjectFromDir(dir);
  const plans = commands.migrationPlans(project, args);
  if (!plans.length) return { ok: true, migrated: [], message: 'Nothing to migrate.' };
  // Importing migrations.mjs is asynchronous: the steps are loaded first, then the change runs.
  const functions = new Map<string, MigrationSteps>();
  for (const { descriptor } of plans) functions.set(descriptor.id, await loadMigrations(project.root, descriptor));
  const journaled = { component: args.component, from: args.from };
  return runCommand(dir, { name: 'migrate_components', args: journaled, run: (context) => commands.migrateComponents(context, args, functions) }, options);
}

// Copies a library component into the course (or over an older copy: upgrade).
export function addLibraryComponent(dir: string, args: AddLibraryComponentArgs & { library: string }, options?: EditOptions) {
  const library = readLibrary(args.library);
  const { source, sources } = libraryComponent(library, args.component);
  const name = args.upgrade ? 'upgrade_component' : 'add_component';
  return runCommand(dir, { name, args: { library: library.id, component: args.component, as: args.as || args.component }, run: (context) => commands.addLibraryComponent(context, args, source), sources }, options);
}

// Copies a course component into a library (outside the course: not undoable), then records the
// library as its origin in the course.
export function publishComponent(dir: string, args: { library: string; component: string }, options?: EditOptions) {
  const library = readLibrary(args.library);
  const project = loadProjectFromDir(dir);
  const source = project.components.get(args.component);
  if (!source?.manifest) throw new commands.CommandError(`No component "${args.component}" in components/`);
  publishToLibrary(library, source, path.join(project.root, source.folder));
  return runCommand(dir, { name: 'publish_component', args: { library: library.id, component: args.component }, run: (context) => commands.publishComponent(context, { component: args.component, library: library.id }) }, options);
}
