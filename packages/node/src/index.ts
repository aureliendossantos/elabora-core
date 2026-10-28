// Public API of @elabora/node: the Node services of Elabora (files, build, emulator, objects, preview,
// media, backups). The logic without I/O is in @elabora/core, the format and its types in
// @elabora/format: import them from there.

// Reading a course folder into a project, and where its machine-local data lives.
export { readProjectFiles, loadProjectFromDir, validateDir, HASH_CACHE_FILE } from './project-reader.ts';
export type { FolderSnapshot } from './project-reader.ts';
export { listProjectFiles, isIgnoredPath, syncArtefact } from './project-files.ts';
export type { FileInfo, ListOptions, SyncArtefact } from './project-files.ts';
export { projectDataDir, dataLocation, projectId, localDataRoot } from './data-dir.ts';
export type { DataLocation } from './data-dir.ts';
export { readJSONFile, writeFileAtomic, writeJSONFile } from './util/fs.ts';
export { writeLock } from './state-lock.ts';

// Build and packaging.
export { build } from './build.ts';
export type { BuildOptions, BuildResult, BuildSuccess, BuildFailure, BuildReport } from './build.ts';
export { ELABORA_VERSION } from './bundles.ts';
export { createZip, readZip, crc32 } from './zip.ts';
export type { CreatedZip, ReadZip, ZipEntryInfo } from './zip.ts';
export { planZip, writeZip, hashZip, ZipLimitError, STORED_EXTENSIONS } from './packaging/zip-writer.ts';
export { mediaQualityOf } from './packaging/media.ts';
export type { MediaProgress, PackagedMedia } from './packaging/media.ts';
export { servePlaceholder } from './http/files.ts';
export type { ZipInput, ZipEntry, ZipPlan, ZipWriteResult } from './packaging/zip-writer.ts';

// LMS emulator.
export { testPackage } from './emulator/run.ts';
export type { TestPackageOptions, PackageTestResult, PackageRun, AccessibilityReport } from './emulator/run.ts';
export { startServer } from './emulator/server.ts';
export type { EmulatorServer, Registration, RouteHandler, Send } from './emulator/server.ts';
export { launchBrowser } from './emulator/browser.ts';
export type { UnloadVariant } from './emulator/browser.ts';

// Free objects: automated gates and their record.
export { testObject } from './objects/test.ts';
export type { ObjectTestOptions, ObjectTestResult, ObjectGates, ObjectPerf } from './objects/test.ts';
export { gatesStatus, writeGatesRecord, objectFingerprint, GATES_FILE } from './objects/gates-record.ts';
export type { GatesRecord, GatesStatus } from './objects/gates-record.ts';

// Preview and captures.
export { preview } from './preview.ts';
export type { Preview, PreviewOptions } from './preview.ts';
export { capture, screenshot, previewComponent } from './capture.ts';
export type { Shot, ShotFrame, ShotResult, ShotSuccess, CaptureResult, ComponentPreview, ComponentPreviewOptions } from './capture.ts';
export { measureFit, fitDiagnostics, FIT_DEFAULTS } from './fit.ts';
export type { FitSize, FitResult, ScreenFit } from './fit.ts';
export type { MeasuredContrast } from './contrast.ts';

// The editor canvas: one screen served with the player, updated in place by pushed render data.
export { startCanvasHost, createCanvasHandler } from './canvas/host.ts';
export type { CanvasHost, CanvasHandler, CanvasHostOptions } from './canvas/host.ts';
export { serveFile, byteRange, mimeType, MIME_TYPES } from './canvas/files.ts';

// Scaffolding, asset generators, component migrations.
export { initProject, TEMPLATES_DIR } from './scaffold.ts';
export type { InitOptions } from './scaffold.ts';
export { runGenerators, GENERATORS_DIR, PROVENANCE_FILE } from './generators.ts';
export type { GeneratorApi, GeneratorOptions, GeneratorResult } from './generators.ts';
export { loadMigrations } from './component-migrations.ts';

// Translations and LESSON.md.
export { exportTranslation, translationStatus, buildTranslation, approveTranslation, translationFile } from './translate.ts';
export type { TranslationBuild } from './translate.ts';
export { exportLessonMd } from './lesson-md.ts';
export type { LessonMdLoss } from './lesson-md.ts';

// Blob store (shared by the journal and backups).
export { BLOBS_DIR, BLOBS_TMP_DIR, blobPath, hashBytes, hashFile, hasBlob, putBytes, putFile, putFileSnapshot, cloneFile, readBlob, copyBlobTo, listBlobs, removeBlob } from './blobs.ts';
export type { BlobHash } from './blobs.ts';

// Edits (commands run as journaled changes under the project lock), the journal and the lock.
// migrateProject: a course in an older format written in the current one (the engine calls it on open).
export * as edit from './edit/index.ts';
export { migrateProject, migrateIfOutdated } from './edit/migrate.ts';
export type { MigrateOptions, MigrateResult, FormatMigrationRef } from './edit/migrate.ts';
export * as journal from './journal/index.ts';
export { pruneProjectData } from './project-data.ts';

// Media pipeline and backups, as namespaces: media.importMedia, backups.restore…
export * as media from './media/index.ts';
export * as backups from './backups/index.ts';

// The project library (one folder per project) and project archives (.elabora).
export * as library from './library/index.ts';

// Importing Storyline 360 and Rise 360 modules (beta, docs/decisions.md D47).
export { detectImport, importCourse, ImportError, IMPORT_REPORT_FILE } from './import/index.ts';
export type { DetectedImport, ImportSourceKind, ImportCourseOptions, ImportCourseResult } from './import/index.ts';
