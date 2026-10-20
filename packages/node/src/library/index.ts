// The project library and archives (docs/architecture/storage.md, Project library and archives): the app
// keeps its projects as plain folders in a library it manages, and people exchange projects as
// `.elabora` archives. The `elabora` command still works on any folder.
export { libraryRoot, setLibraryRoot, ensureLibrary, settingsPath, LIBRARY_MARKER, TRASH_DIR, type LibraryMoveResult, type SetLibraryRootOptions } from './location.ts';
export {
  listProjects, getProject, findProjectsByCourseId, resolveProjectId, readCourseInfo, libraryProjectDir, createProject, duplicateProject, renameProject, validateLibraryProject,
  THUMBNAIL_FILE, ORIGIN_FILE, type LibraryProject, type ProjectOrigin, type ValidationSummary, type ListOptions, type CreateProjectOptions, type DuplicateOptions
} from './projects.ts';
export type { CourseBrief } from '../scaffold.ts';
export { trashProject, listTrash, restoreFromTrash, deleteFromTrash, emptyTrash, TRASH_RETENTION_DAYS, type TrashEntry, type TrashReason, type EmptyTrashResult } from './trash.ts';
export {
  exportProject, inspectArchive, importArchive, importFolder, archiveName, ARCHIVE_FORMAT, ARCHIVE_EXTENSION, MANIFEST_NAME,
  type ArchiveManifest, type ArchiveSummary, type ExportOptions, type ExportResult, type ImportOptions, type ImportResult, type ImportedProject,
  type ImportConflict, type ImportFolderOptions, type Progress
} from './archive.ts';
export type { ArchiveFile, HistorySummary } from './history.ts';
export { LibraryError, type LibraryErrorCode } from './errors.ts';
