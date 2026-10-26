import * as edit from '@elabora/node/edit';
import type { EditOptions, EditResult } from '@elabora/node/edit';
import type { CommandArgs, CommandName } from './protocol.ts';
import { setNarrationAudio } from '@elabora/node/narration/audio';
import { addNarrationLineFromAudio, setNarrationTextFromAudio } from '@elabora/node/narration/from-audio';

// The commands a session runs, by journaled name: the edits of @elabora/node, which run the pure
// commands of @elabora/core as journaled changes under the project lock. The session passes its
// snapshot and its own options (no validation of the whole folder, no automatic version).

type Runner<Name extends CommandName> = (dir: string, args: CommandArgs[Name], options: EditOptions) => EditResult | Promise<EditResult>;

export const COMMANDS: { readonly [Name in CommandName]: Runner<Name> } = {
  create_screen: edit.createScreen,
  update_screen: edit.updateScreen,
  delete_screen: edit.deleteScreen,
  move_screen: edit.moveScreen,
  duplicate_screen: edit.duplicateScreen,
  add_block: edit.addBlock,
  update_block: edit.updateBlock,
  remove_block: edit.removeBlock,
  move_block: edit.moveBlock,
  duplicate_block: edit.duplicateBlock,
  detach_block: edit.detachBlock,
  convert_block: edit.convertBlock,
  upsert_layer: edit.upsertLayer,
  remove_layer: edit.removeLayer,
  upsert_event: edit.upsertEvent,
  remove_event: edit.removeEvent,
  upsert_variable: edit.upsertVariable,
  remove_variable: edit.removeVariable,
  rename_variable: edit.renameVariable,
  update_course: edit.updateCourseSettings,
  update_player: edit.updatePlayer,
  add_resource: edit.addResource,
  ignore_findings: edit.ignoreFindings,
  replace_text: edit.replaceText,
  export_translation: edit.exportTranslationChange,
  translate_text: edit.translateText,
  approve_translation: edit.approveTranslation,
  create_object: edit.createObject,
  write_object_file: edit.writeObjectFile,
  write_design_file: edit.writeDesignFile,
  write_plan: edit.writePlan,
  set_plan_text: edit.setPlanText,
  revert_plan_change: edit.revertPlanChange,
  set_plan_note: edit.setPlanNote,
  create_plan_version: edit.createPlanVersion,
  approve_plan: edit.approvePlan,
  record_plan_send: edit.recordPlanSend,
  set_captions: edit.setCaptions,
  update_narration: edit.updateNarration,
  add_narration_line: edit.addNarrationLine,
  update_narration_line: edit.updateNarrationLine,
  move_narration_line: edit.moveNarrationLine,
  remove_narration_line: edit.removeNarrationLine,
  remove_speaker: edit.removeSpeaker,
  set_narration_audio: setNarrationAudio,
  set_narration_words: edit.setNarrationWords,
  split_step: edit.splitStep,
  keep_narration_audio: edit.keepNarrationAudio,
  add_narration_line_with_audio: addNarrationLineFromAudio,
  set_narration_text_from_audio: setNarrationTextFromAudio,
  set_plan_voiceover: edit.setPlanVoiceover,
  narration_from_plan: edit.narrationFromPlan,
  set_block_timing: edit.setBlockTiming,
  set_dialogue_node: edit.setDialogueNode,
  remove_dialogue_node: edit.removeDialogueNode,
  create_component: edit.createComponent,
  fork_component: edit.forkComponent,
  write_component_file: edit.writeComponentFile,
  migrate_components: async (dir, args, options) => {
    const result = await edit.migrateComponents(dir, args, options);
    // Nothing to migrate: no change, said as an edit result.
    return 'op' in result ? result : { ...result, ok: true, op: 'migrate_components', undo: null, change: null, files: [], diagnostics: [], summary: null };
  },
  add_component: edit.addLibraryComponent,
  publish_component: edit.publishComponent,
  add_font: edit.addFont,
  settle_import_report: edit.settleImportReport
};

export const isCommandName = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);

// Fields of an edit result that are not what the command itself reports.
const EDIT_FIELDS = new Set(['ok', 'op', 'undo', 'change', 'files', 'diagnostics', 'summary', 'backup', 'written', 'undone', 'skipped', 'batch']);

export function commandResult(result: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).filter(([key]) => !EDIT_FIELDS.has(key)));
}

// Runs a command by name with its arguments (the protocol checks the name; the command checks its
// arguments and refuses what does not fit).
export function runNamedCommand<Name extends CommandName>(name: Name, dir: string, args: CommandArgs[Name], options: EditOptions): EditResult | Promise<EditResult> {
  const runner = COMMANDS[name] as Runner<Name>;
  return runner(dir, args, options);
}
