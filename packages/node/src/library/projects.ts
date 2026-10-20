import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJSON } from '@elabora/core/util/json';
import type { Author } from '@elabora/core/ops/types';
import { updateCourseSettings } from '../edit/index.ts';
import { dataLocation } from '../data-dir.ts';
import { listProjectFiles, type FileInfo } from '../project-files.ts';
import { copySources, sourcesSize } from '../sources/index.ts';
import { HASH_CACHE_FILE, validateDir } from '../project-reader.ts';
import { initProject } from '../scaffold.ts';
import type { CourseBrief } from '../scaffold.ts';
import { withProjectLock } from '../journal/lock.ts';
import { LibraryError } from './errors.ts';
import { ELABORA_VERSION, copyProjectFile, folderSize, isEmptyShell, isProjectId, newProjectId, readProjectId, removeTree, renameWithRetries, writeProjectId } from './files.ts';
import { ensureLibrary, libraryEntries, libraryRoot, stagingFolder } from './location.ts';

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
  kind: 'example';
  id: string; // the example's course id
  version: string | null; // the example's version when the copy was made (course.json "version")
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
// `elabora projects list`.
export function resolveProjectId(reference: string, root: string = libraryRoot()): string {
  const wanted = reference.trim().toLowerCase();
  const ids = libraryEntries(root).filter(isProjectId);
  if (ids.includes(wanted)) return wanted;
  const matches = wanted.length >= 4 && /^[0-9a-f-]+$/.test(wanted) ? ids.filter((id) => id.startsWith(wanted)) : [];
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
    if (value.kind !== 'example' || typeof value.id !== 'string') return null;
    return { kind: 'example', id: value.id, version: typeof value.version === 'string' ? value.version : null, at: typeof value.at === 'string' ? value.at : '' };
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
}

// Scaffolds a course (initProject) in a staging folder and moves it into the library in one rename.
export async function createProject(options: CreateProjectOptions): Promise<LibraryProject> {
  const root = ensureLibrary();
  const staging = stagingFolder(root);
  try {
    const dir = path.join(staging, 'project');
    initProject(dir, { id: options.id, title: options.title, language: options.language, brief: options.brief });
    const id = newProjectId();
    writeProjectId(dir, id);
    await renameWithRetries(dir, path.join(root, id));
    validateAndCache(path.join(root, id));
    return getProject(id);
  } finally {
    await removeTree(staging);
  }
}

export interface DuplicateOptions {
  title?: string; // the copy's title (a journaled change in the copy); the same title by default
  author?: Author;
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
    const copy = newProjectId();
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
