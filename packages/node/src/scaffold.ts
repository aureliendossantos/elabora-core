import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newCourseFiles, type NewCourseOptions } from '@elabora/core/commands/new-course';

export const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates');

export type InitOptions = NewCourseOptions;

// Scaffolds a course project: course.json, plan.json (draft), an intro screen, AGENTS.md and the
// CLAUDE.md that points to it, .gitignore; the files the core makes (newCourseFiles, D111).
export function initProject(dir: string, options: InitOptions): { dir: string; files: string[] } {
  const root = path.resolve(dir);
  if (fs.existsSync(path.join(root, 'course.json'))) throw new Error(`${root} already contains a course.json`);
  const files = newCourseFiles(options);
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  return { dir: root, files: [...files.keys()] };
}
