# Backups, sources and the project library

Versions kept in a content-addressed store, the author's sources, the project library, `.elabora` archives and machine-local data. Part of the [architecture](../architecture.md), the contract every change follows.

## Backups

The user never sees git. Elabora keeps versions of the project in `<data>/backups/`, as a content-addressed store:

- `<data>/blobs/sha256/ab/<hash>`: each file content once (shared with the journal). macOS uses copy-on-write clones, so masters cost no extra space there.
- `<data>/backups/versions/<time>-<id>.json`: a version is the list of files with their hashes, plus why it was taken (`auto`, `before-ai`, `after-ai`, `close`, `publish`, `migration`, `import`, `restore`, `manual`), an optional name and the batch.
- **When:** before and after each AI batch, every 5 minutes of activity, when the app closes, before migrations, imports and restores, and as a **named version at each release build** ("Published 1.2.0"). The CLI takes an automatic version before a write when the last one is older than 5 minutes, so backups exist without the app.
- **Retention:** everything for 24 hours, one per hour for 7 days, one per day for 30 days, then one per week, **trimmed of binary files** that are neither in the current project nor in a named version. Named versions are kept until the user deletes them. Garbage collection then deletes unreferenced blobs: a deleted video leaves the backups after 30 days.
- `elabora backup list | create [--name] | restore <version> [--files <glob>] | status`.

Backups do not protect against losing the disk. A copy to a second location, then the cloud, come later.

## The author's sources (D49)

The files a module is made from (a client's brief, a deck, recorded interviews) live in `sources/` at the top of the course folder, with a readable version of each that any agent can read. `@elabora/node` `sources/` implements them; `elabora sources …`, the MCP tools `elabora_sources`, `elabora_source_read` and `elabora_source_add`, and the app call it.

- **Not the course.** `sources/` is outside every snapshot (`project-files.ts`, `isSourcePath` in `@elabora/core` `project/files.ts`): it is never validated, journaled, watched by the engine, backed up, restored, built or published. The validator refuses a reference into it (`E_SOURCE_REFERENCED`: an asset, a theme's stylesheet, font or `url()`, a free object's file), and the build checks every entry it writes and every media file it reads, and refuses a sharing image taken there. A component's preview and a translation's folder leave it out. The library carries it: a module's copy (`duplicateProject`), its import from a folder (`importFolder`), its archive with `sources: true`; a replacement by an archive without sources keeps the module's; the trash keeps it with the module. `LibraryProject.sourcesSize` gives its bytes.
- **Adding** (`addSources(dir, files)`): files and folders copied (cloned where the file system allows it) into `sources/`, flat, at once. A content already there is not copied again (`already-there`); a name taken is numbered (« brief (2).docx »); names keep the author's words, made portable (`sources/names.ts`). Hidden files are never listed (Elabora's own work in progress among them: `.adding-*`, `.elabora-readable-*`).
- **Readable versions** (`sources/index.ts`): `sources/<name>.md` and `sources/<name>.files/`, written on demand (`makeSourcesReadable`, `readSource`), one at a time per source in a process, from a staging folder moved into place. The first line is a marker (`<!-- elabora:readable {…} -->`): the source's hash, size and time, the reader and its version, whether it is complete; `listSources` gives each source's state (`ready`, `partial`, `stale`, `missing`, `failed`, `native`, `unsupported`), hashing a source only when its size or time changed. The readers: `docx.ts` (Word), `pptx.ts` (PowerPoint: texts, notes and the pictures each slide places, with the file's thumbnail; `image-size.ts` reads a picture's size from its header to leave out the icons, bullets and rules), `recording.ts` (video and audio: the transcriber of D46, frames by ffmpeg), on `xml.ts` (a small XML reader) and `ooxml.ts` (an Office package's parts and relationships, read from the streaming ZIP reader). No program of the author's is used: a PDF is read as it is by agents (`native`), and a file in an older office format (.doc, .rtf, .odt, .ppt, .pps, .odp, .key) is `unsupported`, its notes saying to save it as .docx or .pptx (or as a PDF). Nothing leaves the computer.

## Project library and archives

The app keeps its projects in a **library** it manages, as Resolve does, and people exchange projects as **archives**. Projects stay plain folders of files: agents (Claude Code, Cowork, Codex) and the `elabora` command work on them by path. `@elabora/node` `library/` implements both; `elabora projects …`, `elabora export` and `elabora import` call it, and the MCP server reads the library (`elabora_projects_list`, `elabora_projects_path`) but never changes it.
- **Library**: a local folder that no sync service touches: `ELABORA_LIBRARY` when set (tests, servers), else the folder the user chose (`libraryPath` in `<local data>/settings.json`), else `<local data>/Library` (`~/Library/Application Support/Elabora/Library` on macOS, `%LOCALAPPDATA%\Elabora\Library` on Windows; Documents is often synced by OneDrive or iCloud). The user may move it (an external disk): on one volume the folder is renamed; across volumes everything is copied and checked by hash under every project's lock, and the originals are removed once the setting points to the copy; `.elabora-library.json` marks a library, so that a move interrupted by a crash resolves to the complete copy.
- **Projects**: one folder per project, named by its project id (`.elabora/project-id`): ids, not titles, keep paths short and valid on Windows. The index is read from the folders (`course.json`, file times and sizes, `<data>/thumbnail.png` drawn by the app), with a validation summary cached in the project's data while its files keep their sizes and times; a project that cannot be read is listed with its error. Creating, importing and duplicating build the project in `<library>/.staging/` and move it into place with one rename, so a crash never leaves half a project visible; every write to an existing project holds its lock. Renaming changes the title only, as a journaled edit of `course.json`. The app opens only library projects: opening a folder from elsewhere imports a copy (new id; the folder and its history stay where they are). A copy of an example the app ships records it in its data (`<data>/origin.json`: the example's id and version, when the copy was made), so that the app opens that copy again rather than making another; it is machine-local, so no archive carries it.
- **Trash**: deleting a project moves its folder, history included, to `<library>/.trash/<time>-<id>`; `listTrash` gives each entry its title, when it was trashed and when it will be deleted (`expiresAt`: 30 days after, `TRASH_RETENTION_DAYS`; the app deletes expired entries once per launch). An entry can be restored (`restoreFromTrash`: under a new id, with its history, if its id is taken again, so that it sits beside the module that holds the old one). Only `deleteFromTrash` (one entry, whatever its age) and `emptyTrash` (all, or those older than some days) delete for good; the command line has `elabora projects trash delete <entry>` and `trash empty`.
- **Archives** (`<course-id>.elabora`, see below): the project's files, without machine-local data; optionally with its history. Import checks the whole archive, then creates a new library project (a new id), migrates an older format and validates it; importing a course that is already in the library asks: replace it or keep both. A replacement keeps the project's id and folder (agents working on its path keep working), takes a backup version of the project first (reason `import`), moves the replaced files to the trash, and keeps the project's history. Archives are also the open-format sources delivered to clients.
- **Storyline and Rise modules** are imported into the library too, as new projects (*Importing Storyline and Rise modules* below).
- The `elabora` command still works on any folder (developers, tests, CI).
- Later, cloud projects use the library as their local copy.

### Archive format (`elabora-archive/1`)

A ZIP file (methods stored and deflate, no encryption, no ZIP64, so at most 4 GB), written as a stream: text files deflated, everything else stored as it is. Its entries:
- **The project's files at the root**, as `listProjectFiles` lists them (no `.elabora/`, `dist/`, `node_modules/`, OS files or sync-service conflict copies): unzipping an archive gives the course folder. With `sources: true` (`elabora export --sources`), the author's sources and their readable versions too, under `sources/`, listed in `files` like the others (an older Elabora imports them as course files); `ArchiveSummary.sources` and `ExportResult.sources` count them apart.
- **`elabora-archive.json`**, the manifest:

  ```ts
  interface ArchiveManifest {
    format: 'elabora-archive/1';
    elabora: string;                       // version of Elabora that wrote it
    exportedAt: string;                  // ISO 8601
    course: { id: string | null; title: string | null; language: string | null; format: string | null };  // from course.json
    history: boolean;
    files: { path: string; size: number; hash: `sha256:${string}` }[];         // the project files
    historyFiles: { path: string; size: number; hash: `sha256:${string}` }[];  // the entries under history/
    historyBlobsInFiles: `sha256:${string}`[];  // history contents that are project files: stored once, there
  }
  ```
- **`history/`**, with the history only: `history/journal/<yyyy-mm>.jsonl` (the journal as it is), `history/versions/<file>.json` (the backup version manifests, under their own names) and `history/blobs/<sha256 hex>` (the contents the versions and the journal refer to, except those listed in `historyBlobsInFiles`). Contents no longer in the store are left out and reported; restoring a version that needs them reports them missing.

Import refuses, before writing anything: a ZIP without manifest (a zipped folder: unzip it and import the folder), a manifest of an unknown or newer format, an entry name that is absolute, has `..` or `.` segments, backslashes or a drive letter, a project file in a tool folder (`.elabora/` and the others), a `history/` entry of another kind than these three, names that differ only by case or put a file where a folder is, an entry the manifest does not list or a listed one that is missing or has another size. It then extracts into the library's staging folder, checks each file's SHA-256 (and each ZIP CRC), refuses a journal with an operation outside the project's files and a version manifest the backups cannot read, and only then moves the project into place. The hashes catch damage and hand edits; they are not a signature. Readers ignore manifest fields they do not know; a new format version (`elabora-archive/2`) comes with a reader of the older ones, which brings them to the current form before anything else (`migrateManifest` in `library/archive.ts`).

### Machine-local data

A project's journal, lock, blob store, backups, media jobs, renditions, caches and previews are machine-local data. `@elabora/node` `projectDataDir(projectDir)` (`data-dir.ts`) says where they live, and every module goes through it; nothing joins `.elabora/` by hand. By default it is the project's own `.elabora/` folder; `ELABORA_DATA_DIR` moves every project's data under a folder (tests, servers), keyed by the id kept in `.elabora/project-id`. What this computer published of a course to Elabora's hosting is there too (`cloud/publications.json`, D43); the hosting's credentials are not project data: they are in the user's local data (`credentials/`), with the ElevenLabs key.

Blobs and backups copy files as clones where the file system shares blocks (APFS through `cp -c`, because Node 24 does not clone on macOS; Btrfs and XFS through `COPYFILE_FICLONE_FORCE`); NTFS has no clones, so on Windows a master costs its size again in the store.

A folder used with the CLI may still sit in a synced folder: conflict copies left by sync services are reported (`W_SYNC_CONFLICT_COPY`) instead of being loaded as content, and writes retry on Windows sharing violations (`EBUSY`, `EPERM`).
