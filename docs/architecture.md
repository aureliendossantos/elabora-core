# Architecture

This document is the target architecture of elabora-core after the TypeScript migration (October 2026). It is the contract every change follows. Where the code does not match it yet, the code is wrong.

## Goals and constraints

Agent transports and workflow coverage: [agents.md](agents.md). The CLI's `tools list/call` and MCP share `packages/cli/src/agent-tools.ts` (catalogue, argument validation, dispatch and errors); domain operations remain in core/node. Convenient CLI commands may have richer batch/file options. Human decisions are not exposed as agent tools. Do not duplicate an operation to add a transport.

- **A snappy desktop app on top of the core.** The app edits courses while AI agents edit the same files through the CLI or MCP, or directly with their own file tools.
- **Typical modules are large:** about 80 screens and 300 MB of video. Nothing may read every media file into memory, recompress it, or copy it on each edit.
- **Files on disk are the source of truth**, even while the app is open. The engine is the only writer while it runs. It merges what agents write.
- **No assumption about the environment**: no AI provider, no network access, no hosting (the hosting's client, D43, runs only when the author asks). The same core must later run in a browser (canvas, ChatGPT and Claude web plugins) and on a server (cloud projects, collaboration, review links).
- **Testers are freelancers and small companies** on Windows and macOS, whose Documents folder is often synced by OneDrive or iCloud: the app keeps projects in its own library (see [Project library and archives](architecture/storage.md#project-library-and-archives)).

## Packages

pnpm workspaces in `packages/`, TypeScript run directly by Node 24 (type stripping, no build step while developing).

| Package | Role | May import |
|---|---|---|
| `@elabora/format` | Normative JSON Schemas (published spec), generated TypeScript types, format version, schema registry (ajv) | nothing from Elabora |
| `@elabora/player` | Browser runtime shipped in every package (player, course state, SCORM 1.2, standalone and web adapters, behaviours, free-object host and frame; the review bridge in review builds) | nothing from Elabora |
| `@elabora/fonts` | The vetted free fonts courses embed (WOFF2 files of the latin and latin-ext subsets, with their unicode ranges, next to their licence) and their catalogue as data, refreshed from npm by `pnpm run fonts` | nothing from Elabora |
| `@elabora/core` | Logic without I/O: project model, validation, components and templates, compilation plan, operations and diffs, screen rendering, i18n, interop, diagnostics | format, player |
| `@elabora/node` | Node services: file store, project lock, journal, build and packaging, bundling (esbuild), generators, component migrations, media (ffmpeg), fonts, backups, LMS emulator, free-object gates, preview and captures, scaffolding, the hosting's client (`cloud/`, D43) | format, player, fonts, core |
| `@elabora/engine` | Editing session for the app: project in memory, operations, incremental validation, file watching, batches and undo, media jobs, backups schedule | format, core, node |
| `@elabora/cli` | The `elabora` command line and the MCP server | format, core, node, engine |

Rules:
1. **format, player, fonts and core never touch I/O.** They have no `node:` imports, no `process`, no `Buffer` (use `Uint8Array` and `TextEncoder`), no timers that outlive a call. Their `tsconfig.json` sets `"types": []`, so an import of a Node module fails the type check.
2. Packages import each other by name (`@elabora/core/validate/index`), never by relative paths across packages. Each package exports `./*` → `./src/*.ts` and a curated `index.ts`.
3. Code that the browser runs from a package (player, object frame, emulator harness) is bundled by esbuild at build time; the emulator harness files stay plain JavaScript because the emulator serves them as they are.
4. Data shipped with a package (schemas, LMS profiles, built-in templates, the font catalogue) is imported as modules (JSON import attributes, or generated `*.generated.ts` files), not read from disk, in pure packages. Binary data (the font files of `@elabora/fonts`) is read by Node code from the package's folder.

## Project model

### Files snapshot (core)

`ProjectFiles` is an immutable map from a project-relative POSIX path to a `SourceFile`:
- **Text files** (`.json .md .css .html .js .mjs .svg .xlf .vtt .txt`) carry their text.
- **Binary files** carry `size`, `hash` (`sha256:…` of the bytes, from a cache keyed by size and mtime) and, for media, `media` (probe information: kind, container, codecs, dimensions, duration, bitrate, `conformant`). Their bytes are never in the snapshot.

The snapshot excludes `.elabora/`, `dist/`, `node_modules/`, `.git/`, the author's sources (`sources/` at the top of the folder, D49: see [The author's sources](architecture/storage.md#the-authors-sources-d49)), OS files (`.DS_Store`, `Thumbs.db`, `desktop.ini`) and sync-service artefacts (see [Machine-local data](architecture/storage.md#machine-local-data)).

`loadProject(files)` parses the snapshot into a `Project` (course, plan, screens, objects, components, changes, translations, load errors). Every pure function takes a `Project` (or `ProjectFiles`); nothing takes a folder path.

### Store (interface in core, implementations in node)

```ts
interface Store {
  readonly id: string;                        // folder path, or a URI for remote stores
  list(): Promise<FileInfo[]>;                // path, size, mtimeMs
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<void>;   // atomic
  remove(path: string): Promise<void>;
  watch?(onChange: (paths: string[]) => void, onReady?: () => void): () => void;  // [] : changes it could not name, list again; onReady: what is written from then on is reported
  stat?(path: string): Promise<FileInfo | null>;             // optional: stores that know more
  hash?(path: string): Promise<FileHash>;                    // cached, so media are hashed once
}
```

`@elabora/node` provides `FsStore` (`store/`: asynchronous reads, atomic writes by temp file and rename with retries on Windows sharing violations, hashes through the snapshot's hash cache, recursive watching that leaves tool folders and temporary files out and says when it is live: on macOS from a worker thread of its own, whose FSEvents stream no other watcher of the process rebuilds (about 20 ms to start and 10 MB per folder watched), and by a probe file in `.elabora/` that its watcher must report, 2 s at most; inotify and ReadDirectoryChangesW watch from the call) and `readSnapshot(store)`, which gives the same snapshot as the CLI's synchronous reader, media verdicts and `MediaStatus` included. The CLI may use synchronous helpers for convenience; the engine uses the async interface.

## Subsystems

- [Operations, journal and identifiers](architecture/operations.md): How every change to a course becomes an operation with an author, a batch and an inverse; the project lock and journal; permanent ids, renaming and format migrations.
- [Media](architecture/media.md): How images, audio, video and narration enter a course, the canonical formats and quality presets, the encoder, and how media reach packages and previews.
- [Delivery targets and hosting](architecture/delivery.md): The SCORM 1.2 and web targets of one build, and the core as the client of Elabora's hosting.
- [The plan and its versions](architecture/plan.md): The plan as a working copy, the versions a person freezes, what changed between them, and the plan's document.
- [Backups, sources and the project library](architecture/storage.md): Versions kept in a content-addressed store, the author's sources, the project library, `.elabora` archives and machine-local data.
- [Importing Storyline and Rise modules](architecture/import.md): How Storyline 360 and Rise 360 modules are read into one model and converted into Elabora modules, with a report of every loss (beta).
- [Rendering, browsers and captures](architecture/rendering.md): Which browser measures, captures and tests use (the app's Electron workers or an external engine), and how one screen is rendered for the app and for looks.
- [Engine](architecture/engine.md): The editing session of the desktop app: the project in memory, one write queue, incremental validation, other writers, batches, media jobs and the message protocol.

## Conventions

- TypeScript `strict`, erasable syntax only (no enums, namespaces or parameter properties), `.ts` extensions in relative imports, `import type` for types.
- English in code, comments and messages to agents. Full words in names (`reporter`, not `rep`; `planIndex`, not `pidx`). Files in kebab-case.
- Comments explain why, briefly, as in the existing code.
- Diagnostic codes, CLI commands and MCP tool names are a public interface: change them only with a Sampo changeset (`docs/releases.md`) and updated skills.
- Tests with `node:test`. Follow [Contributing: tests](../CONTRIBUTING.md#tests) for validation appropriate to the change.
