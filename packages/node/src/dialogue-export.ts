import path from 'node:path';
import { findDialogue, dialogueBlocks, courseEnv } from '@elabora/core/dialogue/project';
import { dialogueData } from '@elabora/core/dialogue/data';
import { dialogueDocumentHtml } from '@elabora/core/dialogue/document';
import { localDay } from '@elabora/core/util/local-day';
import type { Project } from '@elabora/core/project/model';
import { loadProjectFromDir } from './project-reader.ts';
import { planDocumentFontFaces, printPage } from './plan-document.ts';
import type { PrintedPdf } from './plan-document.ts';
import { writeFileAtomic } from './util/fs.ts';
import { DIALOGUE_EXPORT_FORMATS } from './dialogue-export-types.ts';
import type { DialogueExportFormat, ExportedDialogue } from './dialogue-export-types.ts';

// A dialogue's script and map for the client (docs/decisions.md D61): the page the core writes
// (dialogue/document.ts) with the plan's fonts, as HTML or printed to PDF by the plan's printer
// (D48). The app exports the same page.

export { DIALOGUE_EXPORT_FORMATS } from './dialogue-export-types.ts';
export type { DialogueExportFormat, ExportedDialogue } from './dialogue-export-types.ts';

export interface ExportDialogueOptions {
  block: string;
  to: DialogueExportFormat;
  // The file to write; <course>/dist/<course id>-<block>.<format> by default.
  out?: string;
  // The day the PDF is dated (YYYY-MM-DD; default: today).
  date?: string;
}

// The page of a dialogue of a project already read.
export function dialoguePage(project: Project, block: string): string {
  const ref = findDialogue(project, block);
  if (!ref) throw new Error(`No dialogue block "${block}" in the course (dialogues: ${dialogueBlocks(project).map((other) => other.id).join(', ') || 'none'}).`);
  const data = dialogueData(ref.props, { course: project.course, env: courseEnv(project), directions: 'keep' });
  const screenTitle = project.screens.get(ref.screen)?.data.title;
  return dialogueDocumentHtml(data, {
    id: ref.id, screen: ref.screen, course: project.course?.title, ...(typeof screenTitle === 'string' ? { screenTitle } : {}),
    language: project.course?.language ?? 'en', fontFaces: planDocumentFontFaces()
  });
}

export async function writeDialogueExport(project: Project, options: ExportDialogueOptions): Promise<ExportedDialogue> {
  if (!DIALOGUE_EXPORT_FORMATS.includes(options.to)) throw new Error(`Unknown format "${options.to}": html or pdf.`);
  const html = dialoguePage(project, options.block);
  const id = String(project.course?.id ?? 'course').replace(/[^A-Za-z0-9._-]+/g, '-');
  const file = path.resolve(options.out ?? path.join(path.resolve(project.root || '.'), 'dist', `${id}-${options.block}.${options.to}`));
  let content: string | Uint8Array = html;
  let browser: PrintedPdf['browser'] | undefined;
  if (options.to === 'pdf') ({ pdf: content, browser } = await printPage(html, options.date ?? localDay(), 'the dialogue', 'Export it as a page to print (--to html), or install Google Chrome.'));
  writeFileAtomic(file, content);
  return { file, format: options.to, bytes: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength, ...(browser ? { browser } : {}) };
}

export async function exportDialogue(dir: string, options: ExportDialogueOptions): Promise<ExportedDialogue> {
  return writeDialogueExport(loadProjectFromDir(dir), options);
}
