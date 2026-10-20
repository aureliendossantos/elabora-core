import fs from 'node:fs';
import path from 'node:path';
import { lessonMdExport } from '@elabora/core/interop/lesson-md';
import type { Project } from '@elabora/core/project/model';

export interface LessonMdLoss {
  screen: string | null;
  block: string | null;
  loss: string;
}

// LESSON.md export into a folder: the files the core computed, and the media copied from the
// project folder (media files are copied, never loaded).
export function exportLessonMd(project: Project, outDir: string): { files: string[]; losses: LessonMdLoss[] } {
  const exported = lessonMdExport(project);
  const output: Map<string, string> = exported.output;
  const media: { from: string; name: string }[] = exported.media;
  fs.mkdirSync(path.join(outDir, 'media'), { recursive: true });
  for (const { from, name } of media) fs.copyFileSync(path.join(project.root, from), path.join(outDir, name));
  for (const [name, text] of output) fs.writeFileSync(path.join(outDir, name), text);
  return { files: exported.files, losses: exported.losses };
}
