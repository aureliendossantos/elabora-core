import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJSON } from '@elabora/core/util/json';
import { slugify } from '@elabora/core/util/slug';
import type { Author } from '@elabora/core/ops/types';
import { updateCourseSettings } from '../edit/index.ts';
import { dataLocation } from '../data-dir.ts';
import { listProjectFiles, type FileInfo } from '../project-files.ts';
import { copySources, sourcesSize } from '../sources/index.ts';
import { HASH_CACHE_FILE, validateDir } from '../project-reader.ts';
import { initProject } from '../scaffold.ts';
import { createFromTemplate, moduleTemplate } from '../module-templates.ts';
import { copyCharter } from '../charter.ts';
import type { ModuleTemplate } from '../module-templates.ts';
import type { CourseBrief } from '../scaffold.ts';
import { withProjectLock } from '../journal/lock.ts';
import { appendMark } from '../journal/journal.ts';
import { LibraryError } from './errors.ts';
import { ELABORA_VERSION, MODULE_ID_PREFIX, copyProjectFile, folderSize, isEmptyShell, isProjectId, newProjectId, readProjectId, removeTree, renameWithRetries, writeProjectId } from './files.ts';
import { appLanguage, ensureLibrary, libraryEntries, libraryRoot, stagingFolder } from './location.ts';

// Projects of the library: one folder per project, named by its project id. The folders are the
// truth; what the home screen shows is read from them (course.json, file times and sizes), plus a
// validation summary cached in each project's data folder while its files stay as they were.

// In the project's data folder (data-dir.ts). The app draws the thumbnail; the library only
// reports it when it exists.
export const THUMBNAIL_FILE = 'thumbnail.png';
// In the project's data folder too, so it never travels in an archive: what the project was made
// from, when it is a copy of something Elabora ships (an example course). The app opens the copy it
// made from an example rather than making another.
export const ORIGIN_FILE = 'origin.json';
const SUMMARY_CACHE = path.join('cache', 'library.json');
const SUMMARY_FORMAT = 'elabora-library-summary/1';

export interface ValidationSummary {
  errors: number;
  warnings: number;
  infos: number;
  waived: number;
  checkedAt: string;
}

export interface ProjectOrigin {
  kind: 'example' | 'template';
  id: string; // the example's course id, or the template's id (module-templates.ts)
  version: string | null; // the example's or template's version when the copy was made (course.json "version")
  at: string; // when the copy was made
}

export interface LibraryProject {
  id: string; // project id, also the folder name
  path: string;
  courseId: string | null;
  title: string | null;
  language: string | null;
  format: string | null; // course format version (course.json "format")
  modifiedAt: string | null; // newest project file
  files: number;
  size: number; // bytes of the project's files
  dataSize: number; // bytes of its machine-local data: history, caches (clones may share blocks)
  sourcesSize: number; // bytes of the author's sources and their readable versions (sources/, D49): not the module's files
  thumbnail: string | null; // absolute path of <data>/thumbnail.png when it exists
  validation: ValidationSummary | null; // cached; null when never validated or the files changed since
  origin: ProjectOrigin | null; // what the project was made from (importArchive's origin)
  error: string | null; // why the project cannot be read; such projects are listed, not hidden
}

export interface ListOptions {
  // Validate the projects whose summary is missing or out of date, and cache the result (about a
  // second for a large course).
  validate?: boolean;
}

export function libraryProjectDir(id: string, root: string = libraryRoot()): string {
  if (!isProjectId(id)) throw new LibraryError('E_PROJECT_NOT_FOUND', `${JSON.stringify(id)} is not a project id.`);
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) throw new LibraryError('E_PROJECT_NOT_FOUND', `No project ${id} in the library ${root}.`);
  return dir;
}

// The project lock of a library project. A caller that waited for it may find the project gone
// (trashed or replaced by another call meanwhile); taking the lock then made an empty shell of its
// folder, which is removed, and the call fails as for a project that does not exist.
export async function withLibraryLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  let gone = false;
  try {
    return await withProjectLock(dir, async () => {
      if (readProjectId(dir) !== path.basename(dir)) {
        gone = true;
        throw new LibraryError('E_PROJECT_NOT_FOUND', `Project ${path.basename(dir)} is no longer in the library.`);
      }
      return run();
    });
  } finally {
    if (gone && isEmptyShell(dir)) await removeTree(dir);
  }
}

// A project by its id or a unique start of it (4 characters or more), as people copy them from
// `elabora projects list`, or the six letters that end an « elabora-module-… » id.
export function resolveProjectId(reference: string, root: string = libraryRoot()): string {
  const wanted = reference.trim().toLowerCase();
  const ids = libraryEntries(root).filter(isProjectId);
  if (ids.includes(wanted)) return wanted;
  if (ids.includes(MODULE_ID_PREFIX + wanted)) return MODULE_ID_PREFIX + wanted;
  const matches = wanted.length >= 4 && /^[0-9a-z-]+$/.test(wanted) ? ids.filter((id) => id.startsWith(wanted)) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new LibraryError('E_PROJECT_NOT_FOUND', `Several projects start with ${reference}: ${matches.join(', ')}.`, { candidates: matches });
  throw new LibraryError('E_PROJECT_NOT_FOUND', `No project ${JSON.stringify(reference)} in the library ${root}.`);
}

export function listProjects(options: ListOptions = {}): LibraryProject[] {
  const root = libraryRoot();
  const projects: LibraryProject[] = [];
  for (const name of libraryEntries(root)) {
    const project = describeProject(path.join(root, name), options);
    if (project) projects.push(project);
  }
  const time = (p: LibraryProject) => (p.modifiedAt ? Date.parse(p.modifiedAt) : 0);
  return projects.sort((a, b) => time(b) - time(a) || (a.id < b.id ? -1 : 1));
}

export function getProject(id: string, options: ListOptions = {}): LibraryProject {
  const project = describeProject(libraryProjectDir(id), options);
  if (!project) throw new LibraryError('E_PROJECT_NOT_FOUND', `No project ${id} in the library.`);
  return project;
}

// The projects whose course has this id (archives name courses by their course id).
export function findProjectsByCourseId(courseId: string): LibraryProject[] {
  const root = libraryRoot();
  const found: LibraryProject[] = [];
  for (const name of libraryEntries(root)) {
    if (readCourseInfo(path.join(root, name)).courseId !== courseId) continue;
    const project = describeProject(path.join(root, name), {});
    if (project) found.push(project);
  }
  return found;
}

interface CourseInfo {
  courseId: string | null;
  title: string | null;
  language: string | null;
  format: string | null;
  error: string | null;
}

export function readCourseInfo(dir: string): CourseInfo {
  const empty = { courseId: null, title: null, language: null, format: null };
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'course.json'), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ...empty, error: code === 'ENOENT' ? 'course.json is missing.' : `course.json cannot be read (${code ?? (error as Error).message}).` };
  }
  const parsed = parseJSON(text);
  if (parsed.error !== undefined) return { ...empty, error: `course.json is not valid JSON: ${parsed.error}` };
  const course = parsed.value;
  if (!course || typeof course !== 'object' || Array.isArray(course)) return { ...empty, error: 'course.json is not a JSON object.' };
  const field = (key: string) => {
    const value = (course as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  };
  return { courseId: field('id'), title: field('title'), language: field('language'), format: field('format'), error: null };
}

function describeProject(dir: string, options: ListOptions): LibraryProject | null {
  const name = path.basename(dir);
  const id = readProjectId(dir);
  const course = readCourseInfo(dir);
  let files: FileInfo[] = [];
  let listError: string | null = null;
  try {
    files = listProjectFiles(dir, { onSkipped: () => {} }).files;
  } catch (error) {
    listError = `The folder cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}).`;
  }
  // An empty shell (a writer that locked a project while it was being moved to the trash creates
  // its .elabora/ folder again): not a project.
  if (!id && !files.length && !listError) return null;

  let error = listError ?? course.error;
  if (!isProjectId(name)) error = 'Not a library project: the folder name is not a project id. Import the folder instead (importFolder).';
  else if (id !== name) error = id ? `The project id in .elabora/project-id (${id}) is not the folder name.` : 'The project has no id (.elabora/project-id is missing).';

  let newest = 0;
  let size = 0;
  for (const file of files) {
    size += file.size;
    if (file.mtimeMs > newest) newest = file.mtimeMs;
  }
  if (!newest) newest = fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0;

  // The data folder is only looked up for projects with an id: finding it may otherwise create one.
  let dataSize = 0;
  let thumbnail: string | null = null;
  let validation: ValidationSummary | null = null;
  let origin: ProjectOrigin | null = null;
  if (id === name) {
    const data = dataLocation(dir).dir;
    origin = readOrigin(data);
    dataSize = folderSize(data).bytes;
    const image = path.join(data, THUMBNAIL_FILE);
    if (fs.existsSync(image)) thumbnail = image;
    const fingerprint = filesFingerprint(files);
    validation = readSummary(data, fingerprint);
    if (!validation && options.validate && !error) validation = validateAndCache(dir);
  }
  return {
    id: name,
    path: dir,
    courseId: course.courseId,
    title: course.title,
    language: course.language,
    format: course.format,
    modifiedAt: newest ? new Date(newest).toISOString() : null,
    files: files.length,
    size,
    dataSize,
    sourcesSize: sourcesSize(dir).bytes,
    thumbnail,
    validation,
    origin,
    error,
  };
}

function readOrigin(dataDir: string): ProjectOrigin | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, ORIGIN_FILE), 'utf8')) as Partial<ProjectOrigin>;
    if ((value.kind !== 'example' && value.kind !== 'template') || typeof value.id !== 'string') return null;
    return { kind: value.kind, id: value.id, version: typeof value.version === 'string' ? value.version : null, at: typeof value.at === 'string' ? value.at : '' };
  } catch {
    return null;
  }
}

// Records what a project was made from, in its data folder (atomically: a half-written file would
// read as no origin).
export function writeOrigin(dir: string, origin: Omit<ProjectOrigin, 'at'>, now: Date = new Date()): ProjectOrigin {
  const value: ProjectOrigin = { kind: origin.kind, id: origin.id, version: origin.version ?? null, at: now.toISOString() };
  const file = path.join(dataLocation(dir).dir, ORIGIN_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return value;
}

// The files as they are (paths, sizes, times) and the Elabora version: a summary computed for the same
// fingerprint is still right.
function filesFingerprint(files: readonly FileInfo[]): string {
  const hash = crypto.createHash('sha256').update(`${ELABORA_VERSION}\n`);
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.mtimeMs}\n`);
  return hash.digest('hex');
}

function readSummary(dataDir: string, fingerprint: string): ValidationSummary | null {
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(dataDir, SUMMARY_CACHE), 'utf8')) as { format?: string; fingerprint?: string; validation?: ValidationSummary };
    if (cached.format === SUMMARY_FORMAT && cached.fingerprint === fingerprint && cached.validation) return cached.validation;
  } catch {
    // none yet
  }
  return null;
}

// Records a summary for the project's files as they are now. A cache: written without the project
// lock, atomically, and never an error.
export function cacheValidation(dir: string, summary: { errors: number; warnings: number; infos: number; waived: number }): ValidationSummary {
  const validation: ValidationSummary = { errors: summary.errors, warnings: summary.warnings, infos: summary.infos, waived: summary.waived, checkedAt: new Date().toISOString() };
  try {
    const { files } = listProjectFiles(dir, { onSkipped: () => {} });
    const file = path.join(dataLocation(dir).dir, SUMMARY_CACHE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ format: SUMMARY_FORMAT, fingerprint: filesFingerprint(files), validation })}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // read-only folder: validated again next time
  }
  return validation;
}

// Validates a project folder and caches the summary.
export function validateAndCache(dir: string): ValidationSummary {
  return cacheValidation(dir, validateDir(dir).summary);
}

export function validateLibraryProject(id: string): ValidationSummary {
  return validateAndCache(libraryProjectDir(id));
}

export interface CreateProjectOptions {
  id: string; // the course id (lowercase letters, digits and hyphens)
  title: string;
  language?: string; // fr by default, as `elabora init`
  brief?: CourseBrief; // what the author said of it as they created it (D51)
  // A module template's folder (module-templates.ts, D68): the course starts as a copy of it, in the
  // language asked when the template has its translation.
  template?: string;
  // A course folder whose charter the course takes (charter.ts, D69): a blank course, one screen, in
  // that course's theme, fonts, components and backdrop. Not with a template.
  charter?: string;
}

// Scaffolds a course (initProject, or a copy of a template) in a staging folder and moves it into the
// library in one rename.
export async function createProject(options: CreateProjectOptions): Promise<LibraryProject> {
  const root = ensureLibrary();
  const staging = stagingFolder(root);
  try {
    const dir = path.join(staging, 'project');
    if (options.template && options.charter) throw new LibraryError('E_INVALID_ARGUMENT', 'A module starts from a template or from another module\'s charter, not both.');
    if (options.template) {
      const template = readCourseInfo(options.template);
      await createFromTemplate(options.template, dir, { id: options.id, title: options.title, language: options.language, brief: options.brief });
      writeOrigin(dir, { kind: 'template', id: template.courseId ?? path.basename(options.template), version: templateVersion(options.template) });
    } else if (options.charter) {
      const source = path.resolve(options.charter);
      const info = readCourseInfo(source);
      const notes = [charterNote(info.title ?? path.basename(source), info.courseId), options.brief?.notes?.trim() ?? ''].filter(Boolean).join('\n\n');
      initProject(dir, { id: options.id, title: options.title, language: options.language, brief: { ...options.brief, notes } });
      // A module of the library is copied as one state of it, as duplicateProject does.
      const copy = () => Promise.resolve(copyCharter(source, dir, { presentation: options.brief?.presentation }));
      if (path.dirname(source) === path.resolve(root)) await withLibraryLock(source, copy);
      else await copy();
    } else initProject(dir, { id: options.id, title: options.title, language: options.language, brief: options.brief });
    const id = newProjectId(root);
    writeProjectId(dir, id);
    await renameWithRetries(dir, path.join(root, id));
    validateAndCache(path.join(root, id));
    return getProject(id);
  } finally {
    await removeTree(staging);
  }
}

// A new module of the library gets a course id no other module there has (an LMS tells courses by
// it, and an archive of one would ask to replace the other): the title's, numbered when taken.
export function newCourseId(title: string, fallback = 'module'): string {
  const base = slugify(title, fallback, 48);
  let id = base;
  for (let n = 2; findProjectsByCourseId(id).length; n++) id = `${base.slice(0, 44).replace(/-+$/, '')}-${n}`;
  return id;
}

export interface NewModuleOptions {
  title: string;
  courseId?: string; // the title's by default (newCourseId)
  language?: string; // the app's by default (appLanguage)
  template?: string; // a module template's id (elabora templates)
  charter?: string; // a module whose charter it takes (D69): its project id, or a course folder
  request?: string; // the author's request, in their words: kept in the course's notes for agents (D51)
  author?: Author; // an agent: a mark of it labels its work on the module in the history
}

export interface NewModule {
  project: LibraryProject;
  template: ModuleTemplate | null;
  charter: { dir: string; title: string | null } | null; // the course whose charter it took
  language: string;
  languageFrom: 'given' | 'app'; // asked for, or the app's
}

// A module of the library, as `elabora projects create` and agents (elabora_projects_create) make it:
// blank or from a template, in the language asked, else the app's. Made by an agent, it begins its
// history with a mark of that agent, as « Demander à l'IA » does: the agent's first work on it (the
// plan, the screens) shows as AI work, labelled with the author's request. Nothing in the journal
// undoes the creation itself: the trash takes a module back.
export async function createModule(options: NewModuleOptions): Promise<NewModule> {
  const title = options.title.trim();
  if (!title) throw new LibraryError('E_INVALID_ARGUMENT', 'A module needs a title.');
  const template = options.template ? moduleTemplate(options.template) : null;
  const charter = options.charter ? charterSource(options.charter) : null;
  const language = options.language ?? appLanguage();
  const request = options.request?.trim().replace(/\s*\n\s*/g, ' ');
  const project = await createProject({
    id: options.courseId ?? newCourseId(title), title, language,
    ...(request ? { brief: { notes: requestNotes(request, language) } } : {}),
    ...(template ? { template: template.dir } : {}),
    ...(charter ? { charter } : {})
  });
  // The module is made: a mark that cannot be written loses its label, not the module (a retry would make another).
  if (options.author?.kind === 'agent') try { appendMark(project.path, { request: request || title, author: options.author }); } catch { /* unlabelled */ }
  return { project, template, charter: charter ? { dir: charter, title: readCourseInfo(charter).title } : null, language, languageFrom: options.language ? 'given' : 'app' };
}

// The course a charter is taken from: a project of the library by its id, or a course folder (absolute,
// or relative to the current folder). A reference with a slash or starting with a dot is a folder; a
// bare name is a project id first, and the folder of that name in the current folder otherwise.
export function charterSource(reference: string): string {
  const folder = path.resolve(reference);
  const isFolder = fs.existsSync(path.join(folder, 'course.json'));
  if (isFolder && (path.isAbsolute(reference) || /[\\/]|^\./.test(reference))) return folder;
  let id: string | null = null;
  try { id = resolveProjectId(reference); } catch (error) {
    if (isFolder) return folder;
    if (error instanceof LibraryError && error.code === 'E_PROJECT_NOT_FOUND') throw new LibraryError('E_PROJECT_NOT_FOUND', `${error.message} Nor a folder with a course.json at ${folder}.`);
    throw error;
  }
  // Only a whole id beats the folder of that name: a prefix of an id is a shorthand, not a reason to leave it.
  const wanted = reference.trim().toLowerCase();
  if (isFolder && id !== wanted && id !== `mod-${wanted}`) return folder;
  const dir = libraryProjectDir(id);
  if (!fs.existsSync(path.join(dir, 'course.json'))) throw new LibraryError('E_INVALID_ARGUMENT', `${reference}: not a module with a course.json.`);
  return dir;
}

// What AGENTS.md says of a charter taken from another course, for the agents that write the screens.
function charterNote(title: string, courseId: string | null): string {
  return `This course's charter is copied from the module « ${title} »${courseId ? ` (${courseId})` : ''}: its theme (tokens, fonts, stylesheet, named styles, backdrop and its variants), its components and the player's bars. Keep it: build the screens with its components, styles and backdrop variants (elabora look shows them), and change the charter only when the author asks.`;
}

// The author's request under the course's notes for agents, as the app's « Nouveau module » page
// writes it, in the course's language (French or English).
function requestNotes(request: string, language: string, now = new Date()): string {
  const french = language.toLowerCase().startsWith('fr');
  const date = now.toLocaleDateString(french ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return french ? `Ce que l’auteur a dit en créant le module, le ${date} :\n- Demande : « ${request} »` : `What the author said when creating the course, on ${date}:\n- Request: “${request}”`;
}

export interface DuplicateOptions {
  title?: string; // the copy's title (a journaled change in the copy); the same title by default
  author?: Author;
}

function templateVersion(dir: string): string | null {
  const version: unknown = (JSON.parse(fs.readFileSync(path.join(dir, 'course.json'), 'utf8')) as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

// A copy of a project's files (clones where the file system allows it) under a new id. The history
// stays with the original. The course id is kept: the copy is the same course until someone changes
// it (a new course id gives a new SCORM identifier in LMSs).
export async function duplicateProject(id: string, options: DuplicateOptions = {}): Promise<LibraryProject> {
  const root = ensureLibrary();
  const source = libraryProjectDir(id, root);
  const staging = stagingFolder(root);
  try {
    const dir = path.join(staging, 'project');
    // The lock keeps writers out while the files are copied: the copy is one state of the project.
    await withLibraryLock(source, async () => {
      const { files } = listProjectFiles(source, { onSkipped: () => {} });
      for (const file of files) await copyProjectFile(path.join(source, ...file.path.split('/')), path.join(dir, ...file.path.split('/')));
      // The author's sources go with the copy (D49), their readable versions too.
      await copySources(source, dir, copyProjectFile);
    });
    fs.mkdirSync(dir, { recursive: true });
    const copy = newProjectId(root);
    writeProjectId(dir, copy);
    // The copies keep the files' sizes and times: the original's summary and file hashes hold for
    // them (a 300 MB course is not hashed again).
    for (const cache of [SUMMARY_CACHE, HASH_CACHE_FILE]) {
      const from = path.join(dataLocation(source).dir, cache);
      const to = path.join(dataLocation(dir).dir, cache);
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    await renameWithRetries(dir, path.join(root, copy));
    if (options.title !== undefined) await renameProject(copy, options.title, { author: options.author });
    return getProject(copy);
  } finally {
    await removeTree(staging);
  }
}

// Renames a project: its title only, as an edit of course.json (journaled, undoable). The folder,
// the project id and the course id stay.
export async function renameProject(id: string, title: string, options: { author?: Author } = {}): Promise<LibraryProject> {
  const dir = libraryProjectDir(id);
  const trimmed = title.trim();
  if (!trimmed) throw new LibraryError('E_INVALID_ARGUMENT', 'A project title cannot be empty.');
  const result = updateCourseSettings(dir, { title: trimmed }, { author: options.author });
  cacheValidation(dir, result.summary as { errors: number; warnings: number; infos: number; waived: number });
  return getProject(id);
}
