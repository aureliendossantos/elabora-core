// A course's charter (docs/design.md, the design layer): its theme (tokens, fonts, stylesheet, named
// styles, effects, backdrop and its variants), its components, the decoration its backdrop mounts,
// the presentation's widths and the player's bars, with the files they use (fonts and their licences,
// the stylesheets' pictures, the logo, the generators of those pictures). What a course says is not
// its charter: its screens, plan, narration, sounds, sources, translations, and the free objects its
// blocks place. `elabora projects create --charter` (and the library's createProject the app calls)
// makes a new course from a blank one and another course's charter (D69): a template's or a module's,
// with one screen to start from.

import fs from 'node:fs';
import path from 'node:path';
import { withCharter } from '@elabora/core/commands/new-course';
import { charterOf, PROVENANCE, provenanceOf, provenanceText, type CharterSource } from '@elabora/core/project/charter';
import { fieldOf, isRecord } from './util/values.ts';

export interface CharterCopy {
  files: string[]; // course-relative paths copied, sorted
  components: string[];
  object: string | null; // the backdrop's decoration
  generators: string[];
}

// Copies the charter of the course in `source` into the course in `target`, a course just made
// (initProject): its course.json takes the source's theme, presentation (the mode the author chose
// kept: `presentation`) and player bars, and the files they use (charterOf, the files a browser copies
// too) are copied beside its own. A file the target has already is replaced. `source` is read as it is:
// a module being edited is copied under its library lock (createProject).
export function copyCharter(source: string, target: string, { presentation }: { presentation?: 'slides' | 'scroll' } = {}): CharterCopy {
  const from = path.resolve(source);
  const to = path.resolve(target);
  const course = readJSON(path.join(from, 'course.json'));
  const chosen = charterOf(folderSource(from, course));
  const files = new Set(chosen.files);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
    fs.cpSync(path.join(from, file), path.join(to, file), { mode: fs.constants.COPYFILE_FICLONE, force: true });
  }
  if (Object.keys(chosen.provenance).length) {
    const own = provenanceOf(folderSource(to, {}));
    fs.mkdirSync(path.join(to, 'generators'), { recursive: true });
    fs.writeFileSync(path.join(to, PROVENANCE), provenanceText(own, chosen.provenance));
    files.add(PROVENANCE);
  }

  // The course's theme, presentation and player, as a browser writes them (withCharter, D124).
  fs.writeFileSync(path.join(to, 'course.json'), withCharter(fs.readFileSync(path.join(to, 'course.json'), 'utf8'), { theme: fieldOf(course, 'theme'), presentation: fieldOf(course, 'presentation'), player: fieldOf(course, 'player') }, presentation));

  return { files: [...files].sort(), components: chosen.components, object: chosen.object, generators: chosen.generators };
}

// A course's folder as charterOf reads it.
function folderSource(root: string, course: Record<string, unknown>): CharterSource {
  return { course, isFile: (file) => isFile(root, file), text: (file) => fs.readFileSync(path.join(root, file), 'utf8'), list: (folder) => list(root, folder), walk: (folder) => walk(root, folder) };
}

const isFile = (root: string, file: string): boolean => { try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; } };

function readJSON(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(value)) throw new Error(`${file}: not a JSON object`);
  return value;
}

function list(root: string, folder: string): string[] {
  try {
    return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `${folder}/${entry.name}`);
  } catch {
    return [];
  }
}

function walk(root: string, folder: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, folder), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const file = `${folder}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(root, file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}
