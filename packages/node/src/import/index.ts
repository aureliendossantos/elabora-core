import fs from 'node:fs';
import path from 'node:path';
import { convertCourse, slugify } from '@elabora/core/import/convert';
import type { ImportChoices, FontMapping } from '@elabora/core/import/convert';
import { findRiseCourse, readRiseLocale, readRiseRuntime, readRise, isRisePage, isRiseRuntime, RISE_RUNTIME_FILES } from '@elabora/core/import/rise';
import { parseProvidedData, readStorylinePublished } from '@elabora/core/import/storyline-published';
import { readStorylineSource } from '@elabora/core/import/storyline-source';
import type { StoryMediaFile } from '@elabora/core/import/storyline-source';
import { parseXml, descendantsNamed, attribute, deepText } from '@elabora/core/import/xml';
import type { SourceCourse, ImportKind } from '@elabora/core/import/model';
import type { ImportReport } from '@elabora/core/import/report';
import type { Author } from '@elabora/core/ops/types';
import { openSource, within } from './source.ts';
import type { ImportSource } from './source.ts';
import { findFont } from '../fonts/index.ts';
import { agentsFile, courseNotes } from '../agent-rules.ts';
import { TEMPLATES_DIR, checkBrief } from '../scaffold.ts';
import type { CourseBrief } from '../scaffold.ts';
import { validateDir } from '../project-reader.ts';
import { dataLocation } from '../data-dir.ts';
import * as edit from '../edit/index.ts';
import { ensureLibrary, stagingFolder } from '../library/location.ts';
import { newProjectId, writeProjectId, renameWithRetries, removeTree } from '../library/files.ts';
import { findProjectsByCourseId, getProject, validateAndCache } from '../library/projects.ts';
import type { LibraryProject } from '../library/projects.ts';
import { replaceWithStaged } from '../library/archive.ts';

// Importing a module made elsewhere (docs/decisions.md D47), beta: Storyline 360's source (.story),
// a course Storyline published (web or LMS, zipped or not), Rise 360's exports (web, SCORM, xAPI).
// detectImport says what a file is; importCourse makes an Elabora module of it, in a folder or in
// the app's library, with its report (import-report.json) listing every loss and the choices the
// author has to make. The reading and the conversion are @elabora/core's import/; this module
// opens the source, copies the media and writes the files.

export type ImportSourceKind = ImportKind | 'elabora-archive' | 'elabora-folder';

export interface DetectedImport {
  kind: ImportSourceKind | null; // null: not a source Elabora imports
  file: string;
  container: 'zip' | 'folder';
  root: string; // the folder of the course inside the source ('' at its root)
  package: 'scorm' | 'xapi' | 'cmi5' | 'web' | null; // how a published course was packaged
  beta: boolean; // Storyline and Rise: the importer is a beta
  reason: string; // in English, for people and agents
}

export class ImportError extends Error {
  readonly code: 'E_IMPORT_UNKNOWN' | 'E_IMPORT_ELABORA' | 'E_IMPORT_TARGET' | 'E_IMPORT_UNREADABLE';
  constructor(code: ImportError['code'], message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export const IMPORT_REPORT_FILE = 'import-report.json';

const dirOf = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
const shortest = (paths: string[]) => [...paths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

async function detectIn(source: ImportSource, file: string): Promise<DetectedImport> {
  const paths = source.paths();
  const result = (kind: ImportSourceKind | null, root: string, reason: string): DetectedImport => {
    const prefix = root ? `${root}/` : '';
    const has = (name: string) => source.has(`${prefix}${name}`) || source.has(name);
    const packaging: DetectedImport['package'] = kind === 'storyline-published' || kind === 'rise'
      ? (has('imsmanifest.xml') || paths.some((p) => p.endsWith('imsmanifest.xml')) ? 'scorm' : paths.some((p) => p.endsWith('cmi5.xml')) ? 'cmi5' : paths.some((p) => p.endsWith('tincan.xml')) ? 'xapi' : 'web')
      : null;
    return { kind, file, container: source.container, root, package: packaging, beta: kind !== null && !kind.startsWith('elabora'), reason };
  };
  if (source.has('elabora-archive.json')) return result('elabora-archive', '', 'an Elabora project archive');
  if (source.container === 'folder' && source.has('course.json')) return result('elabora-folder', '', 'an Elabora course folder');
  if (source.has('story/story.xml')) return result('storyline-source', '', 'a Storyline project (.story)');
  const published = shortest(paths.filter((p) => p.endsWith('html5/data/js/data.js')));
  const publishedRoot = published.length ? published[0].replace(/\/?html5\/data\/js\/data\.js$/, '') : null;
  const depth = (root: string) => (root ? root.split('/').length : 0);
  // Rise is looked for first: an export can hold a Storyline block's publication in its assets, and
  // the Rise course is then what is imported. A Rise course is told by its player page (2017–2025:
  // the data is in the page or in a locale file beside it) or by the `runtime-data.js` beside the
  // page (2026); the one nearest the root wins (a root course before an older export nested in it),
  // and a Storyline publication nearer the root than any of them is the course.
  const candidates: { root: string; file: string; runtime: boolean }[] = [];
  for (const file of paths) {
    const runtime = RISE_RUNTIME_FILES.find((name) => file === name || file.endsWith(`/${name}`));
    if (runtime) candidates.push({ root: file.slice(0, file.length - runtime.length).replace(/\/$/, ''), file, runtime: true });
  }
  for (const page of shortest(paths.filter((p) => /(^|\/)index\.html$/.test(p))).slice(0, 8)) candidates.push({ root: dirOf(page), file: page, runtime: false });
  candidates.sort((a, b) => depth(a.root) - depth(b.root) || Number(b.runtime) - Number(a.runtime) || a.file.localeCompare(b.file));
  for (const { root, file, runtime } of candidates) {
    if (publishedRoot !== null && depth(publishedRoot) < depth(root)) break;
    const text = await source.readText(file, 32 * 1024 * 1024).catch(() => '');
    if (runtime ? isRiseRuntime(text) : isRisePage(text)) return result('rise', root, 'a Rise 360 export');
  }
  if (publishedRoot !== null) return result('storyline-published', publishedRoot, 'a course published by Storyline');
  if (paths.some((p) => p.endsWith('.story'))) return result(null, '', 'an archive that holds .story files: import each .story file itself');
  return result(null, '', 'neither a Storyline project (.story), nor a course published by Storyline, nor a Rise 360 export');
}

// What a file or folder is, before importing it. An HTML file (story.html, index.html) stands for its folder.
export async function detectImport(file: string): Promise<DetectedImport> {
  const resolved = resolveInput(file);
  let source: ImportSource;
  try {
    source = await openSource(resolved);
  } catch (error) {
    return { kind: null, file: resolved, container: 'zip', root: '', package: null, beta: false, reason: `not readable as a ZIP archive or a folder (${(error as Error).message})` };
  }
  try {
    return await detectIn(source, resolved);
  } finally {
    await source.close();
  }
}

function resolveInput(file: string): string {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new ImportError('E_IMPORT_UNREADABLE', `${file} does not exist.`);
  if (/\.html?$/i.test(resolved) && fs.statSync(resolved).isFile()) return path.dirname(resolved);
  return resolved;
}

export interface ImportCourseOptions {
  file: string; // a .story, a published course (zip or folder, or its story.html), a Rise export (zip or folder)
  // The folder to write the module into (created; must be empty if it exists). Without it, the module
  // becomes a new project of the app's library.
  dir?: string;
  id?: string; // course id (a slug); from the title by default
  title?: string; // the source's title by default
  language?: string; // BCP 47; the source's, else fr
  choices?: Partial<ImportChoices>; // the report's decisions taken otherwise (run again with them)
  author?: Author; // who adds the fonts (a journaled change); system by default
  // What the author said of the module as they made it (the app's « Nouveau module » page, D51), kept
  // as a new course keeps it: who it is for, the business goal and the duration in the draft plan,
  // the LMS in course.json, the notes in AGENTS.md. Its presentation is the presentation choice's
  // default (a Rise export is always pages that scroll).
  brief?: CourseBrief;
  defaultLanguage?: string; // the language when the source says none (Storyline does not; Rise does)
  // A library project the import takes the place of (the report's choices made again in the app): its
  // project id and folder, history and sources kept, a version of it just before (reason import) and
  // its files in the trash, as an archive's replacement does. Unless given, the module keeps its
  // title, course id and language, its AGENTS.md and what the author said of it (D51) in its plan
  // and course.json.
  replace?: string;
}

export interface ImportCourseResult {
  status: 'imported';
  kind: ImportKind;
  dir: string; // the module's folder
  project: LibraryProject | null; // the library project, when no dir was given
  report: ImportReport;
  files: string[]; // what was written, project paths, media included
  fonts: string[]; // the vetted families added (elabora font add)
  validation: { errors: number; warnings: number; infos: number };
  replaced: { trashEntry: string; version: string | null } | null; // replace: the module as it was (restoring the version undoes the import)
  durationMs: number;
}

// Imports a Storyline or Rise module as an Elabora module.
export async function importCourse(options: ImportCourseOptions): Promise<ImportCourseResult> {
  const started = Date.now();
  const resolved = resolveInput(options.file);
  const source0 = await openSource(resolved);
  // Closed once: before a replacement moves the folder it may be read from (its sources/), and at the end.
  let closed: Promise<void> | null = null;
  const opened: ImportSource = { ...source0, close: () => (closed ??= source0.close()) };
  try {
    const detected = await detectIn(opened, resolved);
    if (detected.kind === 'elabora-archive' || detected.kind === 'elabora-folder') throw new ImportError('E_IMPORT_ELABORA', `${options.file} is ${detected.reason}: import it with elabora import (library.importArchive or importFolder), not as a Storyline or Rise module.`);
    if (!detected.kind) throw new ImportError('E_IMPORT_UNKNOWN', `${options.file} is ${detected.reason}.`);
    const kind = detected.kind;
    if (options.replace !== undefined && options.dir) throw new ImportError('E_IMPORT_TARGET', 'An import replaces a library project (replace) or goes into a folder (dir), not both.');
    const replacing = options.replace !== undefined ? getProject(options.replace) : null;
    const kept = replacing ? keptOf(replacing.path) : null;
    if (options.brief) checkBrief(options.brief);
    const brief = options.brief ?? kept?.brief;
    const source = within(opened, detected.root);
    const course = await readSource(kind, source, resolved);
    const fallbackTitle = path.basename(resolved).replace(/\.(story|zip)$/i, '').replace(/[_-]+/g, ' ').trim();
    const title = options.title || kept?.title || course.title || fallbackTitle;
    const converted = convertCourse(course, {
      id: options.id ?? kept?.id ?? (options.dir ? undefined : libraryCourseId(title)),
      title,
      language: options.language || kept?.language || course.language || options.defaultLanguage,
      choices: { ...(brief?.presentation ? { presentation: brief.presentation } : {}), ...options.choices },
      file: path.basename(resolved),
      mapFont: vettedFont,
      hasMedia: (file) => source.has(file)
    });
    if (brief) keepBrief(converted.files, brief);
    // Imported again: a decision the author accepted stays accepted while the import makes it the same way.
    for (const decision of converted.report.decisions) {
      if (kept?.accepted.some((before) => before.id === decision.id && before.title === decision.title && before.applied === decision.applied)) decision.accepted = true;
    }

    const write = async (target: string): Promise<{ files: string[]; fonts: string[] }> => {
      const files: string[] = [];
      for (const [file, text] of converted.files) {
        await fs.promises.mkdir(path.dirname(path.join(target, file)), { recursive: true });
        await fs.promises.writeFile(path.join(target, file), text);
        files.push(file);
      }
      const notes = options.brief?.notes;
      await fs.promises.writeFile(path.join(target, 'AGENTS.md'), notes === undefined && kept?.agents ? kept.agents : agentsFile(courseNotes(brief?.notes)));
      await fs.promises.copyFile(path.join(TEMPLATES_DIR, 'course', 'gitignore'), path.join(target, '.gitignore'));
      await fs.promises.mkdir(path.join(target, 'assets'), { recursive: true });
      for (const medium of converted.media) {
        const to = path.join(target, ...medium.to.split('/'));
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        await source.copyTo(medium.from, to);
        files.push(medium.to);
      }
      await fs.promises.writeFile(path.join(target, IMPORT_REPORT_FILE), `${JSON.stringify(converted.report, null, 2)}\n`);
      files.push('AGENTS.md', '.gitignore', IMPORT_REPORT_FILE);
      // Fonts the module embeds: vetted families, copied with their licence, as `elabora font add`.
      const fonts: string[] = [];
      for (const font of converted.fonts) {
        edit.addFont(target, { family: font.family, for: font.for }, { author: options.author ?? { kind: 'system', name: 'import' }, validate: false, autoVersion: false });
        fonts.push(font.family);
      }
      return { files: files.sort(), fonts };
    };

    if (options.dir) {
      const target = path.resolve(options.dir);
      if (fs.existsSync(target) && fs.readdirSync(target).length) throw new ImportError('E_IMPORT_TARGET', `${options.dir} is not empty: import into a new folder.`);
      await fs.promises.mkdir(target, { recursive: true });
      const written = await write(target);
      const summary = validateDir(target).summary;
      return { status: 'imported', kind, dir: target, project: null, report: converted.report, ...written, validation: counted(summary), replaced: null, durationMs: Date.now() - started };
    }

    // The library: built in its staging folder, moved into place with one rename.
    const root = ensureLibrary();
    const staging = stagingFolder(root);
    let createdData: string | null = null;
    try {
      const stage = path.join(staging, 'project');
      await fs.promises.mkdir(stage, { recursive: true });
      const id = newProjectId();
      writeProjectId(stage, id);
      if (!dataLocation(stage).inProject) createdData = dataLocation(stage).dir;
      const written = await write(stage);
      // A replacement takes the project's place with its id (its own, made for the fonts' changes,
      // goes with the staging folder).
      const target = replacing ? replacing.path : path.join(root, id);
      // Every medium is copied: the source is closed before its folder moves (Windows refuses to move a
      // folder holding an open file, and a module imported again is read from its own sources/).
      if (replacing) await opened.close();
      const replaced = replacing ? await replaceWithStaged(target, stage, { author: options.author ?? null }) : null;
      if (!replacing) await renameWithRetries(stage, target);
      if (!replacing) createdData = null;
      const validation = validateAndCache(target);
      const project = getProject(path.basename(target));
      return { status: 'imported', kind, dir: target, project, report: converted.report, ...written, validation: { errors: validation.errors, warnings: validation.warnings, infos: validation.infos }, replaced, durationMs: Date.now() - started };
    } finally {
      await removeTree(staging);
      if (createdData) await removeTree(createdData);
    }
  } finally {
    await opened.close();
  }
}

// A new module of the library gets a course id no other module there has (an LMS tells courses by
// it, and an archive of one would ask to replace the other): the title's, numbered when taken.
function libraryCourseId(title: string): string {
  const base = slugify(title, 'imported', 48);
  let id = base;
  for (let n = 2; findProjectsByCourseId(id).length; n++) id = `${base.slice(0, 44).replace(/-+$/, '')}-${n}`;
  return id;
}

const counted = (summary: { errors: number; warnings: number; infos?: number }) => ({ errors: summary.errors, warnings: summary.warnings, infos: summary.infos ?? 0 });

// The brief in the converted files, as a new course keeps it (scaffold.ts initProject): who it is for,
// the business goal and the duration in the draft plan, the LMS in course.json.
function keepBrief(files: Map<string, string>, brief: CourseBrief): void {
  const change = (file: string, edit: (value: Record<string, unknown>) => void) => {
    const value = JSON.parse(files.get(file)!) as Record<string, unknown>;
    edit(value);
    files.set(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  if (brief.audience?.trim() || brief.businessGoal?.trim() || brief.duration) change('plan.json', (plan) => {
    if (brief.businessGoal?.trim()) plan.businessGoal = brief.businessGoal.trim();
    if (brief.audience?.trim()) plan.audience = { ...(plan.audience as object), role: brief.audience.trim() };
    if (brief.duration) plan.duration = { ...(brief.duration.min ? { min: brief.duration.min } : {}), ...(brief.duration.max ? { max: brief.duration.max } : {}) };
  });
  if (brief.lms?.length) change('course.json', (course) => { course.delivery = { lms: [...new Set(brief.lms)] }; });
}

// What a module keeps when it is imported again (replace): its title, course id and language, its
// AGENTS.md (the author's notes with it), what the author said of it (D51) in its plan and
// course.json, and the decisions of its report the author accepted. Its presentation is a choice of
// the import.
function keptOf(dir: string): { title?: string; id?: string; language?: string; brief: CourseBrief; agents: string | null; accepted: { id: string; title: string; applied: string }[] } {
  const read = (file: string): Record<string, unknown> => {
    try { const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); return value && typeof value === 'object' ? value as Record<string, unknown> : {}; } catch { return {}; }
  };
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
  const course = read('course.json');
  const plan = read('plan.json');
  const brief: CourseBrief = {};
  const audience = text((plan.audience as Record<string, unknown> | undefined)?.role);
  if (audience) brief.audience = audience;
  const goal = text(plan.businessGoal);
  if (goal) brief.businessGoal = goal;
  const duration = plan.duration as { min?: unknown; max?: unknown } | undefined;
  if (duration && (typeof duration.min === 'number' || typeof duration.max === 'number')) brief.duration = { ...(typeof duration.min === 'number' ? { min: duration.min } : {}), ...(typeof duration.max === 'number' ? { max: duration.max } : {}) };
  const lms = (course.delivery as { lms?: unknown } | undefined)?.lms;
  if (Array.isArray(lms) && lms.length && lms.every((entry) => typeof entry === 'string')) brief.lms = lms as string[];
  let agents: string | null = null;
  try { agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'); } catch { /* none: the template's */ }
  // The decisions of its report the author accepted.
  const decisions = (read(IMPORT_REPORT_FILE) as { decisions?: unknown }).decisions;
  const accepted = (Array.isArray(decisions) ? decisions : []).filter((entry): entry is { id: string; title: string; applied: string } => !!entry && typeof entry === 'object' && (entry as { accepted?: unknown }).accepted === true);
  return { title: text(course.title), id: text(course.id), language: text(course.language), brief, agents, accepted };
}

// The source read into the importer's model.
async function readSource(kind: ImportKind, source: ImportSource, file: string): Promise<SourceCourse> {
  if (kind === 'rise') {
    const unreadable = (detail: string) => new ImportError('E_IMPORT_UNREADABLE', `${path.basename(file)}: ${detail}`);
    let data: Record<string, unknown> | null = null;
    try {
      // The player page holds the course (2017–2025) or names its locale file; a 2026 export keeps it in runtime-data.js.
      const page = source.has('index.html') ? findRiseCourse(await source.readText('index.html')) : null;
      data = page?.data ?? null;
      if (!data && page?.localeFile && source.has(page.localeFile)) data = readRiseLocale(await source.readText(page.localeFile));
      for (const name of RISE_RUNTIME_FILES) if (!data && source.has(name)) data = readRiseRuntime(await source.readText(name));
    } catch (error) {
      throw unreadable(`the Rise course data cannot be decoded (${(error as Error).message}).`);
    }
    if (!data) throw unreadable('the Rise course data was not found in its index.html or runtime-data.js.');
    return readRise(data, { has: (name) => source.has(name) });
  }
  if (kind === 'storyline-published') {
    const provided = async (name: string) => (source.has(name) ? parseProvidedData(await source.readText(name))?.data ?? null : null);
    const data = await provided('html5/data/js/data.js');
    if (!data) throw new ImportError('E_IMPORT_UNREADABLE', `${path.basename(file)}: html5/data/js/data.js cannot be read.`);
    const frame = await provided('html5/data/js/frame.js');
    const slides = new Map<string, Record<string, unknown>>();
    const scenes = Array.isArray(data.scenes) ? data.scenes as Record<string, unknown>[] : [];
    for (const scene of scenes) for (const slide of Array.isArray(scene.slides) ? scene.slides as Record<string, unknown>[] : []) {
      const url = typeof slide.html5url === 'string' ? slide.html5url : '';
      if (url && !slides.has(url)) { const read = await provided(url); if (read) slides.set(url, read); }
    }
    const meta = source.has('meta.xml') ? parseXml(await source.readText('meta.xml')) : null;
    const title = attribute(descendantsNamed(meta, 'project')[0], 'title');
    return readStorylinePublished({ data, frame, slides, has: (name) => source.has(name), ...(title ? { title } : {}) });
  }
  const files = new Map<string, string>();
  for (const name of source.paths()) {
    if (/^story\/.*\.(xml|rels)$/i.test(name) && !name.startsWith('story/media/')) files.set(name, await source.readText(name));
  }
  const media: StoryMediaFile[] = [];
  for (const name of source.paths().filter((entry) => entry.startsWith('story/media/'))) media.push({ path: name, size: source.size(name), md5: await source.hash(name, 'md5') });
  // The package's title: its core properties (dc:title).
  let title: string | undefined;
  const core = source.paths().find((name) => name.endsWith('.psmdcp'));
  if (core) title = deepText(descendantsNamed(parseXml(await source.readText(core)), 'title')[0]).trim() || undefined;
  return readStorylineSource({ files, media, ...(title ? { title } : {}) });
}

// A font of the source as a font Elabora may embed: the same family when it is vetted, else a
// vetted family of its kind (Storyline's own "Articulate" font and system fonts have no web licence).
export function vettedFont(family: string): FontMapping | null {
  const name = family.trim();
  // "+major" and "+minor" name the fonts of the source's theme: the module's theme sets its own.
  if (!name || name.startsWith('+')) return null;
  const same = findFont(name);
  if (same) return { family: same.family, same: true };
  if (/mono|courier|consolas|menlo|code/i.test(name)) return { family: 'JetBrains Mono', same: false };
  if (/times|georgia|garamond|cambria|palatino|book antiqua|baskerville|serif|minion|caslon|merriweather|playfair|lora/i.test(name) && !/sans/i.test(name)) return { family: 'Source Serif 4', same: false };
  if (/hand|script|comic|print|brush|marker|forte|chalk|caveat|bradley/i.test(name)) return { family: 'Caveat', same: false };
  if (/impact|bebas|oswald|condensed|league gothic|anton/i.test(name)) return { family: 'Oswald', same: false };
  return { family: 'Source Sans 3', same: false };
}
