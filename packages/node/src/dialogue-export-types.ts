// The types of a dialogue's export (dialogue-export.ts, D61), without Node: the engine's protocol
// gives them to the app's renderer, which has no Node types.

export type DialogueExportFormat = 'html' | 'pdf';
export const DIALOGUE_EXPORT_FORMATS: readonly DialogueExportFormat[] = ['html', 'pdf'];

export interface ExportedDialogue {
  file: string;
  format: DialogueExportFormat;
  bytes: number;
  browser?: { engine: string; version: string };
}
