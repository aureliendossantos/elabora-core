import fs from 'node:fs';
import path from 'node:path';
import { isTextPath } from '@elabora/core/project/files';
import type { Author } from '@elabora/core/ops/types';
import { FORMAT as COURSE_FORMAT } from '@elabora/format/schemas';
import { isNewerFormat } from '@elabora/core/format/version';
import { migrateIfOutdated } from '../edit/migrate.ts';
import type { BlobHash } from '../blobs.ts';
import { dataLocation, TOOL_DIR } from '../data-dir.ts';
import { isIgnoredPath, listProjectFiles, type FileInfo } from '../project-files.ts';
import { isSourcePath, SOURCES_DIR } from '@elabora/core/project/files';
import { copySources, sourceFiles } from '../sources/index.ts';
import { lockPath, withProjectLock } from '../journal/lock.ts';
import { withBackupsLock } from '../backups/lock.ts';
import { createVersion } from '../backups/create.ts';
import { isSafeProjectPath, newestVersion } from '../backups/store.ts';
import { writeZip, ZipLimitError, type ZipInput } from '../packaging/zip-writer.ts';
import { ZipFormatError, ZipReader, type ZipReaderEntry } from '../packaging/zip-reader.ts';
import { LibraryError } from './errors.ts';
import {
  ELABORA_VERSION, assertSpace, compactTime, copyProjectFile, digestBytes, digestFile, heldLock, isInside, newProjectId, removeTree,
  renameWithRetries, windowsNameProblem, writeProjectId
} from './files.ts';
import { HISTORY_PATH, HISTORY_PREFIX, checkHistory, collectHistory, installHistory, type ArchiveFile, type HistorySummary } from './history.ts';
import { TRASH_DIR, ensureLibrary, libraryRoot, stagingFolder } from './location.ts';
import { findProjectsByCourseId, getProject, readCourseInfo, validateAndCache, withLibraryLock, writeOrigin, type LibraryProject, type ProjectOrigin, type ValidationSummary } from './projects.ts';
import { moveToTrash } from './trash.ts';

// Project archives (docs/architecture/storage.md, Project library and archives): `<course id>.elabora`, a ZIP
// written as a stream. At its root, the project's files as listProjectFiles lists them (no
// machine-local data), so that unzipping one gives the course folder; elabora-archive.json, the
// manifest, lists every file with its size and SHA-256; with the history, history/ holds the
// journal, the backup versions and their contents (history.ts). Text is deflated, everything else
// stored as it is (media are compressed already).
//
// The hashes catch damage and hand edits on the way; they are not a signature: whoever can change
// a file can change the manifest. Import refuses an archive whose files do not match its manifest,
// or that would write anywhere but in the project's files (and in its history, by the rules of
// history.ts).

export const ARCHIVE_FORMAT = 'elabora-archive/1';
export const ARCHIVE_EXTENSION = '.elabora';
export const MANIFEST_NAME = 'elabora-archive.json';
const HASH = /^sha256:[0-9a-f]{64}$/;
// What operating systems add when someone zips or unzips by hand: never content, ignored on import.
const OS_ENTRY = /(^|\/)(__MACOSX\/.*|\.DS_Store|Thumbs\.db|desktop\.ini)$/;

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  elabora: string; // version of Elabora that wrote the archive
  exportedAt: string;
  course: { id: string | null; title: string | null; language: string | null; format: string | null };
  history: boolean;
  files: ArchiveFile[]; // project files, at the root of the archive
  historyFiles: ArchiveFile[]; // entries under history/
  historyBlobsInFiles: BlobHash[]; // history contents that are project files of the archive: stored once, there
}

export interface Progress {
  phase: 'reading' | 'writing' | 'extracting' | 'copying';
  done: number; // bytes
  total: number;
}

export interface ExportOptions {
  history?: boolean; // include the journal and the backups (versions and the contents they refer to)
  sources?: boolean; // include the author's sources (sources/, D49) and their readable versions: left out by default, a client's brief may hold personal data
  onProgress?: (progress: Progress) => void;
  now?: Date;
}

export interface ExportResult {
  file: string;
  size: number; // bytes of the archive
  sha256: string; // of the archive
  courseId: string | null;
  files: number;
  bytes: number; // bytes of the project's files
  sources: { files: number; bytes: number } | null; // the author's sources it carries (sources: true), else null
  history: HistorySummary | null;
  // Not in the archive: symbolic links (never followed) and sync services' conflict copies.
  skipped: { path: string; reason: 'symlink' | 'conflict-copy' }[];
  warnings: string[]; // file names that Windows cannot hold, history that could not be read
  durationMs: number;
}

// The archive's file name for a course: its course id.
export function archiveName(courseId: string | null): string {
  const safe = (courseId ?? '').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'course'}${ARCHIVE_EXTENSION}`;
}

// Writes a project folder (in the library or anywhere: `elabora export` works on any course folder)
// to an archive. The project lock is held while it is read and written, so the archive is one state
// of the project; with the history, the backups lock too, so no version or content goes meanwhile.
export async function exportProject(projectDir: string, outFile: string, options: ExportOptions = {}): Promise<ExportResult> {
  const started = Date.now();
  const root = path.resolve(projectDir);
  const out = path.resolve(outFile);
  if (!fs.existsSync(path.join(root, 'course.json'))) throw new LibraryError('E_NOT_A_COURSE', `${root} has no course.json: it is not an Elabora course folder.`);
  const inProject = path.relative(root, out).split(path.sep).join('/');
  if (isInside(out, root) && (!isIgnoredPath(inProject) || isSourcePath(inProject))) {
    throw new LibraryError('E_ARCHIVE_TARGET', `The archive would be written inside the project (${inProject}) and become part of its next export: write it elsewhere, or under dist/.`);
  }
  const write = () => (options.history ? withBackupsLock(root, 'export', () => writeArchive(root, out, options)) : writeArchive(root, out, options));
  const result = await withLockIfWritable(root, write);
  return { ...result, durationMs: Date.now() - started };
}

// A folder on a read-only volume can still be exported: nobody writes there either.
async function withLockIfWritable<T>(dir: string, run: () => Promise<T>): Promise<T> {
  let locked = false;
  try {
    return await withProjectLock(dir, () => {
      locked = true;
      return run();
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (locked || !(code === 'EACCES' || code === 'EROFS' || code === 'EPERM')) throw error;
    return run();
  }
}

async function writeArchive(root: string, out: string, options: ExportOptions): Promise<Omit<ExportResult, 'durationMs'>> {
  const skipped: ExportResult['skipped'] = [];
  const warnings: string[] = [];
  const { files, artefacts } = listProjectFiles(root, {
    onSkipped: (file, reason, error) => {
      if (reason === 'symlink') skipped.push({ path: file, reason });
      else throw new LibraryError('E_FILE_UNAVAILABLE', `${file} cannot be read (${error?.code ?? 'unknown error'}): the archive would be incomplete.`, { path: file });
    },
  });
  const listed = new Set(files.map((file) => file.path));
  for (const artefact of artefacts) {
    if (artefact.kind === 'conflict-copy') skipped.push({ path: artefact.path, reason: 'conflict-copy' });
    else if (artefact.original && !listed.has(artefact.original)) {
      throw new LibraryError('E_FILE_UNAVAILABLE', `${artefact.original} is only in the cloud (iCloud): download it first, or the archive would be incomplete.`, { path: artefact.original });
    }
  }
  if (listed.has(MANIFEST_NAME)) throw new LibraryError('E_RESERVED_NAME', `The project has a file named ${MANIFEST_NAME}, the name of the archive's manifest: rename it.`);
  for (const file of files) {
    const problem = windowsNameProblem(file.path);
    if (problem) warnings.push(problem);
  }

  // The author's sources when asked (D49): files of the archive like the others, under sources/,
  // which an older Elabora imports as course files.
  const sources = options.sources ? sourceFiles(root) : [];
  for (const file of sources) {
    const problem = windowsNameProblem(file.path);
    if (problem) warnings.push(problem);
  }
  let total = [...files, ...sources].reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  const reading = (bytes: number) => {
    done += bytes;
    options.onProgress?.({ phase: 'reading', done, total: Math.max(total, done) });
  };
  const inputs: ZipInput[] = [];
  const manifestFiles: ArchiveFile[] = [];
  for (const file of [...files, ...sources]) {
    const absolute = path.join(root, ...file.path.split('/'));
    if (isTextPath(file.path)) {
      const data = await fs.promises.readFile(absolute);
      const digest = digestBytes(data);
      inputs.push({ name: file.path, data });
      manifestFiles.push({ path: file.path, size: digest.size, hash: digest.hash });
      reading(digest.size);
    } else {
      // One read for the hash and the CRC; the writer reads the file once more and checks both.
      const digest = await digestFile(absolute, reading);
      inputs.push({ name: file.path, file: absolute, store: true, known: { crc: digest.crc, size: digest.size } });
      manifestFiles.push({ path: file.path, size: digest.size, hash: digest.hash });
    }
  }

  let history: Awaited<ReturnType<typeof collectHistory>> | null = null;
  if (options.history) {
    history = await collectHistory(root, new Set(manifestFiles.filter((file) => !isSourcePath(file.path)).map((file) => file.hash)), reading);
    for (const entry of history.files) {
      if (listed.has(entry.path)) throw new LibraryError('E_RESERVED_NAME', `The project has a file named ${entry.path}, where the archive keeps its history: rename it.`);
    }
    inputs.push(...history.inputs);
    warnings.push(...history.summary.problems.map((problem) => `Backup version left out: ${problem}`));
    if (history.summary.missingBlobs.length) warnings.push(`${history.summary.missingBlobs.length} content(s) of the history are no longer in the store and are not in the archive.`);
  }

  const course = readCourseInfo(root);
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    elabora: ELABORA_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    course: { id: course.courseId, title: course.title, language: course.language, format: course.format },
    history: !!options.history,
    files: manifestFiles,
    historyFiles: history?.files ?? [],
    historyBlobsInFiles: history?.blobsInFiles ?? [],
  };
  inputs.push({ name: MANIFEST_NAME, data: `${JSON.stringify(manifest, null, 1)}\n` });

  let written;
  try {
    written = await writeZip(out, inputs, { onProgress: (bytes, size) => options.onProgress?.({ phase: 'writing', done: bytes, total: size }) });
  } catch (error) {
    if (error instanceof ZipLimitError) throw new LibraryError('E_ARCHIVE_TOO_LARGE', `${error.message}${options.history ? ' Export without the history.' : ''}`);
    throw error;
  }
  const courseFiles = manifestFiles.filter((file) => !isSourcePath(file.path));
  const sourced = manifestFiles.filter((file) => isSourcePath(file.path));
  return {
    file: written.path,
    size: written.size,
    sha256: written.sha256,
    courseId: course.courseId,
    files: courseFiles.length,
    bytes: courseFiles.reduce((sum, file) => sum + file.size, 0),
    sources: options.sources ? { files: sourced.length, bytes: sourced.reduce((sum, file) => sum + file.size, 0) } : null,
    history: history?.summary ?? null,
    skipped,
    warnings,
  };
}

// ── reading an archive ───────────────────────────────────────────────

export interface ArchiveSummary {
  file: string;
  courseId: string | null;
  title: string | null;
  language: string | null;
  format: string | null;
  elabora: string;
  exportedAt: string;
  history: boolean;
  files: number;
  bytes: number; // bytes of the project's files
  sources: { files: number; bytes: number }; // the author's sources it carries (sources/, D49)
  historyBytes: number;
}

interface CheckedArchive {
  manifest: ArchiveManifest;
  entries: Map<string, ZipReaderEntry>; // by name, for the files and the history
  summary: ArchiveSummary;
}

async function openArchive(file: string): Promise<ZipReader> {
  try {
    return await ZipReader.open(path.resolve(file));
  } catch (error) {
    if (error instanceof ZipFormatError) throw new LibraryError('E_ARCHIVE_INVALID', `${file} is not an Elabora archive: ${error.message}`);
    throw error;
  }
}

// What the app shows before an import: the course, when it was exported and by which Elabora, whether
// it has its history, and the library projects that hold the same course.
export async function inspectArchive(file: string): Promise<{ archive: ArchiveSummary; existing: LibraryProject[] }> {
  const reader = await openArchive(file);
  try {
    const { summary } = await readArchive(reader);
    return { archive: summary, existing: summary.courseId ? findProjectsByCourseId(summary.courseId) : [] };
  } finally {
    await reader.close();
  }
}

async function readArchive(reader: ZipReader): Promise<CheckedArchive> {
  const unsafe = (name: string, why: string) => new LibraryError('E_ARCHIVE_UNSAFE_PATH', `The archive has an entry ${JSON.stringify(name)} ${why}: it is refused.`, { path: name });
  const damaged = (message: string) => new LibraryError('E_ARCHIVE_DAMAGED', `The archive is damaged or was changed after it was exported: ${message}`);

  // Every name first, listed or not: nothing that could escape the project goes further.
  const byName = new Map<string, ZipReaderEntry>();
  for (const entry of reader.entries) {
    if (entry.name.endsWith('/') || OS_ENTRY.test(entry.name)) continue;
    if (!isSafeEntryName(entry.name)) throw unsafe(entry.name, 'that points outside the project');
    if (byName.has(entry.name)) throw damaged(`two entries are named ${entry.name}.`);
    byName.set(entry.name, entry);
  }
  const manifestEntry = byName.get(MANIFEST_NAME);
  if (!manifestEntry) throw new LibraryError('E_ARCHIVE_INVALID', `${reader.file} has no ${MANIFEST_NAME}: it is not an Elabora archive. If it is a zipped course folder, unzip it and import the folder.`);
  const manifest = parseManifest((await reader.readEntry(manifestEntry, 256 * 1024 * 1024)).toString('utf8'));

  const entries = new Map<string, ZipReaderEntry>();
  const take = (file: ArchiveFile) => {
    const entry = byName.get(file.path);
    if (!entry) throw damaged(`${file.path} is missing.`);
    if (entry.size !== file.size) throw damaged(`${file.path} does not have the size its manifest gives.`);
    entries.set(file.path, entry);
  };
  const lowerCase = new Map<string, string>();
  for (const file of manifest.files) {
    if (file.path === MANIFEST_NAME || !isSafeArchivePath(file.path)) throw unsafe(file.path, 'that is not a project file (tool folders, .elabora/ and temporary files never are)');
    const problem = windowsNameProblem(file.path);
    if (problem && process.platform === 'win32') throw unsafe(file.path, `that Windows cannot hold (${problem})`);
    // Two names that differ only by case are one file on macOS and Windows.
    const key = file.path.toLowerCase();
    if (lowerCase.has(key)) throw unsafe(file.path, `that is the same file as ${lowerCase.get(key)} on macOS and Windows`);
    lowerCase.set(key, file.path);
    take(file);
  }
  // A file and a folder of the same name cannot both exist.
  for (const file of manifest.files) {
    const segments = file.path.toLowerCase().split('/');
    for (let i = 1; i < segments.length; i++) {
      const folder = segments.slice(0, i).join('/');
      if (lowerCase.has(folder)) throw unsafe(file.path, `inside ${lowerCase.get(folder)}, which is a file`);
    }
  }
  if (!manifest.files.some((file) => file.path === 'course.json')) throw new LibraryError('E_NOT_A_COURSE', 'The archive has no course.json: it does not hold an Elabora course.');
  if (!manifest.history && (manifest.historyFiles.length || manifest.historyBlobsInFiles.length)) throw damaged('it lists history but says it has none.');
  for (const file of manifest.historyFiles) {
    if (!HISTORY_PATH.test(file.path)) throw unsafe(file.path, 'that is not part of a project history');
    if (file.path.startsWith(`${HISTORY_PREFIX}blobs/`) && file.hash !== `sha256:${file.path.slice(`${HISTORY_PREFIX}blobs/`.length)}`) throw damaged(`${file.path} is not named by its hash.`);
    take(file);
  }
  const projectHashes = new Set(manifest.files.map((file) => file.hash));
  for (const hash of manifest.historyBlobsInFiles) if (!projectHashes.has(hash)) throw damaged(`its history refers to ${hash} as a project file, and no project file has it.`);
  for (const name of byName.keys()) {
    if (name !== MANIFEST_NAME && !entries.has(name)) throw damaged(`${name} is not in its manifest.`);
  }
  const sum = (list: readonly ArchiveFile[]) => list.reduce((total, file) => total + file.size, 0);
  return {
    manifest,
    entries,
    summary: {
      file: reader.file,
      courseId: manifest.course.id,
      title: manifest.course.title,
      language: manifest.course.language,
      format: manifest.course.format,
      elabora: manifest.elabora,
      exportedAt: manifest.exportedAt,
      history: manifest.history,
      files: manifest.files.filter((entry) => !isSourcePath(entry.path)).length,
      bytes: sum(manifest.files.filter((entry) => !isSourcePath(entry.path))),
      sources: { files: manifest.files.filter((entry) => isSourcePath(entry.path)).length, bytes: sum(manifest.files.filter((entry) => isSourcePath(entry.path))) },
      historyBytes: sum(manifest.historyFiles),
    },
  };
}

const origin = (given: NonNullable<ImportOptions['origin']>): Omit<ProjectOrigin, 'at'> => ({ kind: given.kind, id: given.id, version: given.version ?? null });

// A file of the archive: a project file, or one of the author's sources (D49), under the same rules
// as a file of any other folder.
function isSafeArchivePath(p: string): boolean {
  if (isSafeProjectPath(p)) return true;
  return isSourcePath(p) && p !== SOURCES_DIR && isSafeProjectPath(`x/${p.slice(SOURCES_DIR.length + 1)}`);
}

// Relative POSIX names without '.' or '..' segments: nothing else is ever extracted.
function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function parseManifest(text: string): ArchiveManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new LibraryError('E_ARCHIVE_INVALID', `${MANIFEST_NAME} is not valid JSON (${(error as Error).message}).`);
  }
  const invalid = (what: string) => new LibraryError('E_ARCHIVE_INVALID', `${MANIFEST_NAME}: ${what}.`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('not an object');
  const value = migrateManifest(raw as Record<string, unknown>);
  const files = (list: unknown, where: string): ArchiveFile[] => {
    if (!Array.isArray(list)) throw invalid(`${where} is not a list`);
    return list.map((item: unknown) => {
      const file = item as Partial<ArchiveFile> | null;
      if (!file || typeof file.path !== 'string' || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.hash !== 'string' || !HASH.test(file.hash)) {
        throw invalid(`an entry of ${where} is not { path, size, hash }`);
      }
      return { path: file.path, size: file.size, hash: file.hash as BlobHash };
    });
  };
  const course = (value.course ?? {}) as Record<string, unknown>;
  const field = (key: string) => (typeof course[key] === 'string' ? (course[key] as string) : null);
  const blobs = value.historyBlobsInFiles ?? [];
  if (!Array.isArray(blobs) || blobs.some((hash) => typeof hash !== 'string' || !HASH.test(hash))) throw invalid('historyBlobsInFiles is not a list of hashes');
  return {
    format: ARCHIVE_FORMAT,
    elabora: typeof value.elabora === 'string' ? value.elabora : 'unknown',
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
    course: { id: field('id'), title: field('title'), language: field('language'), format: field('format') },
    history: value.history === true,
    files: files(value.files, 'files'),
    historyFiles: files(value.historyFiles ?? [], 'historyFiles'),
    historyBlobsInFiles: blobs as BlobHash[],
  };
}

// Manifests of older archive formats are brought to the current one here, one step per version.
// There is only elabora-archive/1 so far.
function migrateManifest(value: Record<string, unknown>): Record<string, unknown> {
  if (value.format === ARCHIVE_FORMAT) return value;
  const version = typeof value.format === 'string' ? /^elabora-archive\/(\d+)$/.exec(value.format) : null;
  if (version && Number(version[1]) > 1) throw new LibraryError('E_ARCHIVE_NEWER', `This archive (${value.format}) was made by a newer version of Elabora (${String(value.elabora)}): update Elabora to import it.`);
  throw new LibraryError('E_ARCHIVE_INVALID', `${MANIFEST_NAME} has the unknown format ${JSON.stringify(value.format)}.`);
}

// A course in a newer format than this Elabora reads is refused before anything is written.
function checkCourseFormat(format: string | null): void {
  if (format && isNewerFormat(format)) {
    throw new LibraryError('E_ARCHIVE_NEWER', `This course uses the format ${format}, newer than the one this version of Elabora reads (${COURSE_FORMAT}): update Elabora to import it.`);
  }
}

// An imported course in an older format is migrated (docs/architecture/operations.md, Identifiers and format
// version) once its files and history are in place, before it appears in the library (a
// replacement: under the project's lock, right after it took the old one's place): the core
// migrations run on its files, written as one `system` change after a backup version (reason
// `migration`), so that its history holds the course as it came. Returns the format it had.
function migrateCourseFormat(projectDir: string): string | null {
  return migrateIfOutdated(projectDir)?.from ?? null;
}

// ── importing ────────────────────────────────────────────────────────

export interface ImportOptions {
  // When the library already holds the archive's course (same course id): `ask` (default) imports
  // nothing and returns the projects concerned, `copy` imports a new project beside them, `replace`
  // replaces that project (see importArchive).
  onExisting?: 'ask' | 'replace' | 'copy';
  replace?: string; // the project id to replace, when several hold the course (implies replace)
  author?: Author; // recorded with the backup version taken before a replacement
  // What the archive is a copy of, kept with the project (LibraryProject.origin): an example the
  // app ships. Written before the project appears in the library.
  origin?: { kind: 'example'; id: string; version?: string | null };
  onProgress?: (progress: Progress) => void;
}

export interface ImportedProject {
  status: 'imported';
  project: LibraryProject;
  validation: ValidationSummary;
  mode: 'new' | 'replace';
  // The replaced project: its files went to the trash (entry), its history stayed with the project,
  // with a version of its state just before (version: restoring it undoes the import).
  replaced: { trashEntry: string; version: string | null } | null;
  history: HistorySummary | null; // what the archive's history added
  migratedFrom: string | null; // the course format before the import migrated it; null when it was current
  skipped: { path: string; reason: 'symlink' | 'conflict-copy' }[]; // importFolder only
  durationMs: number;
}

export interface ImportConflict {
  status: 'exists';
  archive: ArchiveSummary;
  existing: LibraryProject[];
}

export type ImportResult = ImportedProject | ImportConflict;

// Imports an archive into the library. The archive is checked as a whole (manifest, names, sizes)
// before anything is written, then extracted into a staging folder of the library, each file checked
// against its hash, and only then moved into place with renames: an interrupted import leaves no
// project behind. A new project gets a new project id. A replacement keeps the replaced project's
// id and folder (agents working on its path keep working), puts the replaced files in the trash,
// keeps its history and adds a backup version of the state just before.
export async function importArchive(file: string, options: ImportOptions = {}): Promise<ImportResult> {
  const started = Date.now();
  const reader = await openArchive(file);
  try {
    const archive = await readArchive(reader);
    const { manifest, summary } = archive;
    checkCourseFormat(summary.format);
    const existing = summary.courseId ? findProjectsByCourseId(summary.courseId) : [];
    let target: LibraryProject | null = null;
    if (options.replace !== undefined) {
      target = getProject(options.replace);
      if (target.courseId !== summary.courseId) throw new LibraryError('E_REPLACE_TARGET', `Project ${target.id} holds the course ${target.courseId ?? '(unknown)'}, not ${summary.courseId ?? '(unknown)'}: import the archive as a new project instead.`);
    } else if (existing.length) {
      const onExisting = options.onExisting ?? 'ask';
      if (onExisting === 'ask') return { status: 'exists', archive: summary, existing };
      if (onExisting === 'replace') {
        if (existing.length > 1) throw new LibraryError('E_REPLACE_TARGET', `${existing.length} projects hold the course ${summary.courseId}: say which one to replace (${existing.map((p) => p.id).join(', ')}).`, { candidates: existing.map((p) => p.id) });
        target = existing[0];
      }
    }

    const root = ensureLibrary();
    await assertSpace(root, summary.bytes + summary.historyBytes, 'Importing the archive');
    const staging = stagingFolder(root);
    let createdData: string | null = null;
    try {
      const projectStage = path.join(staging, 'project');
      const historyStage = path.join(staging, 'history');
      await extract(reader, archive, projectStage, historyStage, options.onProgress);
      if (manifest.history) await checkHistory(historyStage, manifest.historyFiles);
      checkCourseFormat(readCourseInfo(projectStage).format);

      let dir: string;
      let history: HistorySummary | null = null;
      let replaced: ImportedProject['replaced'] = null;
      let migratedFrom: string | null = null;
      if (target) {
        dir = target.path;
        ({ history, replaced, migratedFrom } = await replaceProject(target.path, projectStage, historyStage, manifest, options));
      } else {
        const id = newProjectId();
        writeProjectId(projectStage, id);
        if (!dataLocation(projectStage).inProject) createdData = dataLocation(projectStage).dir;
        if (options.origin) writeOrigin(projectStage, origin(options.origin));
        if (manifest.history) history = await installHistory(projectStage, historyStage, manifest.historyFiles, manifest.historyBlobsInFiles, manifest.files, { kind: 'own' });
        migratedFrom = migrateCourseFormat(projectStage);
        dir = path.join(root, id);
        await renameWithRetries(projectStage, dir);
        createdData = null;
      }
      const validation = validateAndCache(dir);
      return {
        status: 'imported', project: getProject(path.basename(dir)), validation, mode: target ? 'replace' : 'new', replaced, history, migratedFrom, skipped: [],
        durationMs: Date.now() - started,
      };
    } finally {
      // Data kept outside the project (ELABORA_DATA_DIR) for a project that never appeared.
      if (createdData) await removeTree(createdData);
      await removeTree(staging);
    }
  } finally {
    await reader.close();
  }
}

async function extract(reader: ZipReader, archive: CheckedArchive, projectStage: string, historyStage: string, onProgress?: (progress: Progress) => void): Promise<void> {
  const { manifest, entries, summary } = archive;
  const total = summary.bytes + summary.historyBytes;
  let done = 0;
  const onBytes = (bytes: number) => {
    done += bytes;
    onProgress?.({ phase: 'extracting', done, total });
  };
  const folders = new Set<string>();
  const one = async (file: ArchiveFile, target: string) => {
    const folder = path.dirname(target);
    if (!folders.has(folder)) {
      await fs.promises.mkdir(folder, { recursive: true });
      folders.add(folder);
    }
    // Flushed: the folder appears in the library by a rename, and must hold whole files then.
    const result = await reader.extractEntry(entries.get(file.path)!, target, { flush: true, onBytes });
    if (`sha256:${result.sha256}` !== file.hash) {
      throw new LibraryError('E_ARCHIVE_DAMAGED', `The archive is damaged or was changed after it was exported: ${file.path} does not have the content its manifest gives.`, { path: file.path });
    }
  };
  try {
    for (const file of manifest.files) await one(file, path.join(projectStage, ...file.path.split('/')));
    for (const file of manifest.historyFiles) await one(file, path.join(historyStage, ...file.path.slice(HISTORY_PREFIX.length).split('/')));
  } catch (error) {
    if (error instanceof ZipFormatError) throw new LibraryError('E_ARCHIVE_DAMAGED', `The archive is damaged: ${error.message}`);
    throw error;
  }
  // A course without screens yet still has its assets folder (initProject makes one).
  await fs.promises.mkdir(projectStage, { recursive: true });
}

// Replaces a library project with an extracted archive, under the project's lock:
//   1. a backup version of the project as it is (reason `import`), in its own history;
//   2. the old folder goes to the trash, the new one takes its place (two renames: a crash leaves
//      the old project, or the new one, never a mix; a failed second rename puts the old one back);
//   3. the history moves from the old folder to the new one, and the archive's history joins it;
//   4. a course in an older format is migrated, as a change of that history.
// With ELABORA_DATA_DIR, the history is keyed by the project id, which does not change: it stays.
async function replaceProject(targetDir: string, projectStage: string, historyStage: string, manifest: ArchiveManifest, options: ImportOptions): Promise<{ history: HistorySummary | null; replaced: NonNullable<ImportedProject['replaced']>; migratedFrom: string | null }> {
  return withLibraryLock(targetDir, async () => {
    // The author's sources stay with the module when the archive brings none (D49).
    const { trashEntry, version } = await swapIn(targetDir, projectStage, { author: options.author ?? null, keepSources: !manifest.files.some((file) => isSourcePath(file.path)) });
    const history = manifest.history
      ? await installHistory(targetDir, historyStage, manifest.historyFiles, manifest.historyBlobsInFiles, manifest.files, { kind: 'merge', stamp: compactTime(new Date()) })
      : null;
    if (options.origin) writeOrigin(targetDir, origin(options.origin));
    return { history, replaced: { trashEntry, version }, migratedFrom: migrateCourseFormat(targetDir) };
  });
}

// Puts a folder made in the library's staging folder in a project's place, under the project's lock
// (an archive replacing it, a Storyline or Rise module imported again, D47): a backup version of the
// project as it is (reason `import`), the old folder to the trash and the new one in its place (two
// renames: a crash leaves the old project, or the new one, never a mix; a failed second rename puts
// the old one back), the project's id and history kept, and its sources (D49) when keepSources.
async function swapIn(targetDir: string, projectStage: string, options: { author: Author | null; keepSources: boolean }): Promise<{ trashEntry: string; version: string | null }> {
  const id = path.basename(targetDir);
  const version = (await createVersion(targetDir, { reason: 'import', author: options.author })) ?? newestVersion(targetDir);
  writeProjectId(projectStage, id);
  const location = dataLocation(targetDir);
  // The new folder carries this lock, so that writers keep waiting once it is in place.
  const holder = heldLock(targetDir);
  if (holder) fs.copyFileSync(lockPath(targetDir), lockPath(projectStage), fs.constants.COPYFILE_EXCL);
  const trashEntry = await moveToTrash(targetDir, 'replaced');
  const trashed = path.join(libraryRoot(), TRASH_DIR, trashEntry);
  try {
    await renameWithRetries(projectStage, targetDir);
  } catch (error) {
    await renameWithRetries(trashed, targetDir);
    fs.rmSync(`${trashed}.json`, { force: true });
    throw error;
  }
  const oldSources = path.join(trashed, SOURCES_DIR);
  if (options.keepSources && fs.existsSync(oldSources)) await renameWithRetries(oldSources, path.join(targetDir, SOURCES_DIR));
  if (location.inProject) {
    const from = dataLocation(trashed).dir;
    const to = dataLocation(targetDir).dir;
    for (const name of fs.existsSync(from) ? fs.readdirSync(from) : []) {
      if (name === 'lock' || name === 'lock.break' || name === 'project-id' || fs.existsSync(path.join(to, name))) continue;
      await renameWithRetries(path.join(from, name), path.join(to, name));
    }
  }
  return { trashEntry, version: version?.id ?? null };
}

// A folder made in the library's staging folder takes a project's place (swapIn), under its lock.
// The folder brings no history of its own: what its tool folder holds besides its id is left out.
export async function replaceWithStaged(targetDir: string, projectStage: string, options: { author?: Author | null } = {}): Promise<{ trashEntry: string; version: string | null }> {
  const tools = path.join(projectStage, TOOL_DIR);
  for (const name of fs.existsSync(tools) ? fs.readdirSync(tools) : []) if (name !== 'project-id') fs.rmSync(path.join(tools, name), { recursive: true, force: true });
  return withLibraryLock(targetDir, () => swapIn(targetDir, projectStage, { author: options.author ?? null, keepSources: true }));
}

export interface ImportFolderOptions {
  onProgress?: (progress: Progress) => void;
}

// Copies a course folder from anywhere into the library under a new project id (clones where the
// file system allows it). The folder is left as it is, with its history: the copy starts its own.
export async function importFolder(dir: string, options: ImportFolderOptions = {}): Promise<ImportedProject> {
  const started = Date.now();
  const source = path.resolve(dir);
  const root = ensureLibrary();
  if (isInside(source, root)) throw new LibraryError('E_ALREADY_IN_LIBRARY', `${source} is in the library already: duplicate the project instead.`);
  if (!fs.existsSync(path.join(source, 'course.json'))) throw new LibraryError('E_NOT_A_COURSE', `${source} has no course.json: it is not an Elabora course folder.`);
  const skipped: ImportedProject['skipped'] = [];
  const { files, artefacts } = listProjectFiles(source, {
    onSkipped: (file, reason, error) => {
      if (reason === 'symlink') skipped.push({ path: file, reason });
      else throw new LibraryError('E_FILE_UNAVAILABLE', `${file} cannot be read (${error?.code ?? 'unknown error'}).`, { path: file });
    },
  });
  const listed = new Set(files.map((file) => file.path));
  for (const artefact of artefacts) {
    if (artefact.kind === 'conflict-copy') skipped.push({ path: artefact.path, reason: 'conflict-copy' });
    else if (artefact.original && !listed.has(artefact.original)) throw new LibraryError('E_FILE_UNAVAILABLE', `${artefact.original} is only in the cloud (iCloud): download it first.`, { path: artefact.original });
  }
  const staging = stagingFolder(root);
  let createdData: string | null = null;
  try {
    const projectStage = path.join(staging, 'project');
    await copyFiles(source, projectStage, files, options.onProgress);
    await copySources(source, projectStage, copyProjectFile);
    checkCourseFormat(readCourseInfo(projectStage).format);
    const id = newProjectId();
    writeProjectId(projectStage, id);
    // The migration writes history (a backup version, a journal): outside the project with
    // ELABORA_DATA_DIR, where nothing must stay if the import fails.
    if (!dataLocation(projectStage).inProject) createdData = dataLocation(projectStage).dir;
    const migratedFrom = migrateCourseFormat(projectStage);
    const target = path.join(root, id);
    await renameWithRetries(projectStage, target);
    createdData = null;
    const validation = validateAndCache(target);
    return { status: 'imported', project: getProject(id), validation, mode: 'new', replaced: null, history: null, migratedFrom, skipped, durationMs: Date.now() - started };
  } finally {
    if (createdData) await removeTree(createdData);
    await removeTree(staging);
  }
}

async function copyFiles(source: string, target: string, files: readonly FileInfo[], onProgress?: (progress: Progress) => void): Promise<void> {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  await fs.promises.mkdir(target, { recursive: true });
  for (const file of files) {
    await copyProjectFile(path.join(source, ...file.path.split('/')), path.join(target, ...file.path.split('/')));
    done += file.size;
    onProgress?.({ phase: 'copying', done, total });
  }
}
