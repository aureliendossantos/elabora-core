// Commands: the vocabulary of the CLI and the MCP server as pure functions over a files snapshot.
export { CommandError, Draft, commandContext, findBlock, type CommandContext, type CommandOutput, type CommandDiagnostic, type Placement, type BlockTarget, type BlockPlace } from './context.ts';
export { createScreen, updateScreen, deleteScreen, moveScreen, duplicateScreen, SCREEN_FIELDS, type CreateScreenArgs, type UpdateScreenArgs, type MoveScreenArgs, type DuplicateScreenArgs } from './screens.ts';
export { addBlock, updateBlock, removeBlock, moveBlock, duplicateBlock, detachBlock, type AddBlockArgs, type UpdateBlockArgs, type MoveBlockArgs, type DuplicateBlockArgs } from './blocks.ts';
export { upsertLayer, removeLayer, upsertEvent, removeEvent, upsertVariable, removeVariable } from './layers-events-variables.ts';
export type { UpsertLayerArgs, UpsertEventArgs } from './layers-events-variables.ts';
export { updateCourseSettings, ignoreFindings, COURSE_FIELDS, type UpdateCourseArgs, type IgnoreFindingsArgs } from './course.ts';
export { createObject, writeObjectFile, writeDesignFile, OBJECT_FILES, type ObjectFile, type ObjectTemplates, type CreateObjectArgs, type WriteObjectFileArgs } from './objects-design.ts';
export {
  writePlan, setPlanText, setPlanVoiceover, revertPlanChange, createPlanVersion, approvePlan, recordPlanSend, setPlanNote,
  type WritePlanArgs, type WritePlanResult, type SetPlanTextArgs, type SetPlanVoiceoverArgs, type RevertPlanChangeArgs, type CreatePlanVersionArgs, type CreatePlanVersionResult,
  type ApprovePlanArgs, type RecordPlanSendArgs, type SetPlanNoteArgs
} from './plan.ts';
export {
  createComponent, forkComponent, writeComponentFile, migrateComponents, migrationPlans, addLibraryComponent, publishComponent, checkComponentId, COMPONENT_FILES,
  type CreateComponentArgs, type ForkComponentArgs, type WriteComponentFileArgs, type MigrateComponentsArgs, type MigrationPlan, type MigrationSummary,
  type LibraryComponent, type AddLibraryComponentArgs
} from './components.ts';
export { schemaFor, schemaProblems } from './schemas.ts';
export { replaceMediaReferences, setCaptions, toWebVtt, type MediaMove, type ReplaceMediaArgs, type ReplaceMediaResult, type SetCaptionsArgs } from './media.ts';
export { renameId, renameVariable, type RenameArgs, type RenameResult, type RenamedKind } from './rename.ts';
export { exportTranslation, translateText, approveTranslation, type ExportTranslationArgs, type TranslateUnitArgs, type ApproveTranslationArgs } from './translation.ts';
export { findText, replaceText, type TextMatch, type FindTextOptions, type ReplaceTextArgs, type ReplaceTextResult } from './text.ts';
export { updateNarration, addNarrationLine, updateNarrationLine, moveNarrationLine, removeNarrationLine, removeSpeaker, setNarrationAudio, setNarrationWords, splitStep, narrationFromPlan, planVoiceover, keepNarrationAudio, addNarrationLineWithAudio, setNarrationTextFromAudio, LINE_FIELDS, type KeepNarrationAudioArgs, type AddNarrationLineWithAudioArgs, type SetNarrationTextFromAudioArgs, type SetNarrationWordsArgs, type SplitStepArgs, type NarrationFromPlanArgs, type UpdateNarrationArgs, type AddNarrationLineArgs, type UpdateNarrationLineArgs, type MoveNarrationLineArgs, type SetNarrationAudioArgs, type NarrationAudioFileArgs, type RemoveSpeakerArgs } from './narration.ts';
export { setBlockTiming, reanchorLine, type SetBlockTimingArgs, type MomentPatch, type Reanchored } from './timing.ts';
export { upgradeThemeCascade, type UpgradeThemeResult } from './theme.ts';
export { updatePlayer, type UpdatePlayerArgs } from './player.ts';
export { addFont, type AddFontArgs, type AddFontResult, type FontFace, type FontRequest, type FontSource } from './fonts.ts';
export { addResource, RESOURCES_FOLDER, type AddResourceArgs, type AddResourceRequest, type AddResourceResult } from './resources.ts';
export { settleImportReport, IMPORT_REPORT, type SettleImportReportArgs } from './import-report.ts';
