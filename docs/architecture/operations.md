# Operations, journal and identifiers

How every change to a course becomes an operation with an author, a batch and an inverse; the project lock and journal; permanent ids, renaming and format migrations. Part of the [architecture](../architecture.md), the contract every change follows.

## Operations, journal and undo

Every change to a project is a list of **operations** recorded in a **journal**. The app, the CLI, the MCP server, agents writing files directly, undo, backups restore, migrations and (later) collaboration all speak this one language.

### Operations

JSON files are edited by path. A path is a list of segments: an object key, or `{ id }` selecting the element of a **keyed array** (an array of objects that all have a distinct `id`, or an array of distinct strings, matched by value). Other arrays are values: they are replaced whole. Numeric indexes never appear in recorded operations.

```ts
type Segment = string | { id: string };
type Op =
  | { op: 'set'; file: string; path: Segment[]; value: Json; after?: string | null }  // path [] replaces the document; after: see below
  | { op: 'unset'; file: string; path: Segment[] }
  | { op: 'insert'; file: string; path: Segment[]; value: Json; after: string | null }  // path: the keyed array; after: id, or null for first
  | { op: 'remove'; file: string; path: Segment[] }                  // path ends with { id }
  | { op: 'move'; file: string; path: Segment[]; to: { file: string; path: Segment[] }; after: string | null }
  | { op: 'write'; file: string; text: string }                      // non-JSON text file, or a new JSON file
  | { op: 'write'; file: string; blob: string }                      // binary file, by hash in the blob store
  | { op: 'delete'; file: string };
```

- `applyOps(files, ops)` is pure and returns the new files; JSON files are written with 2-space indentation and a final newline, key order kept. `invertOps(before, ops)` returns the operations that undo them, one per operation. `diffFiles(before, after)` computes operations between two snapshots, by id in keyed arrays, with the fewest moves; an element removed from one keyed array and inserted into another (in the same file or not) with the same id becomes a `move`. That is how an agent's direct file edit becomes operations. All in `@elabora/core` `ops/`.
- `set` of a key the object does not have yet appends it, or places it after the key named by `after` (`null`: first). The inverse of `unset` uses it to put the key back where it was, so that a file comes back exactly.
- **Ids are permanent here too:** an operation never changes the `id` of an element of a keyed array (paths, and the inverses that select it, would break). Giving an element another id removes it and inserts it again.
- High-level **commands** (`add_block`, `move_block`, `create_screen`…, the vocabulary of the CLI and MCP) are pure functions in `@elabora/core` `commands/`: they read a files snapshot and return the files they would leave, or the operations they mean when intent matters (a move is a `move`, not a reorder of its neighbours). They never write files themselves. `@elabora/node` `edit/` runs them as changes.
- The plan (`plan.json`) is the working copy of the contract, written at any time (`write_plan`, `set_plan_text`, `set_plan_voiceover`, `revert_plan_change`); its versions in `plan-versions/` are made and validated by a person (`create_plan_version`, `approve_plan`: refused to an agent author, `E_PLAN_PERSON_ONLY`), and an agent's write that changes a text kept « à l'identique » is refused (`E_PLAN_VERBATIM_LOCKED`). Commands know their author for this (`CommandContext.author`, D52).

### Changes and authors

A **change** is one applied command: its operations, their inverse, the hashes of the touched files before and after, an author and a batch.

```ts
interface Change {
  seq: number; id: string; at: string;
  author: { kind: 'human' | 'agent' | 'external' | 'system'; name?: string };
  batch: string;
  command?: { name: string; args: unknown };
  ops: Op[]; inverse: Op[];
  files: { path: string; before: string | null; after: string | null }[];
  unavailable?: string[];  // hashes of previous contents no store kept (see Binary files)
}
```

- **Author.** The app writes as `human`. MCP calls are `agent`, with the MCP client name. The CLI uses `ELABORA_AUTHOR` if set, `claude-code` when `CLAUDECODE` is set, `codex` when `CODEX_THREAD_ID` is (Codex CLI and desktop app), `agent` when stdin is not a terminal, else `human`. File changes that no Elabora tool made are `external`: in practice an agent editing files with its own tools.
- **Batch.** A batch is one piece of AI work, the unit of « Annuler le travail de l'IA ». An AI change (author `agent` or `external`) joins the current batch when the previous change was also an AI change and less than 5 minutes old, and no human or system change, and no mark, came in between. Otherwise it opens a new batch. Human and `system` changes (migrations, restores) are never part of AI work: each is its own batch. A **mark** (journal entry written when the user presses « Demander à l'IA » in the app) closes the batch and labels the next AI batch with the request.
- **Undo a batch** applies the inverse operations of its changes, newest first. An inverse operation whose target was changed since (the current value is not what the batch wrote) is skipped and reported, so a human edit made after the AI is kept. Undo is itself a change (author: the human), so it can be undone.
- **Binary files.** Undo restores the previous content of a binary file when the blob store holds it (the journal stores what Elabora tools overwrite; backups hold what an agent overwrote with its own tools, if a version was taken before). Otherwise that operation is skipped with the reason `unavailable`. A change that overwrites or deletes a binary file whose previous content no store kept (an agent's own tools, before any version) is journaled all the same, listing that content in `unavailable`.
- JSON files written in another formatting (by hand, by an agent's own tools) are formatted when an edit touches them; their original text is kept in the blob store, so undoing the edit gives the file back exactly as it was.

### Journal and lock

In the project's data folder ([Machine-local data](storage.md#machine-local-data); `.elabora/` by default), through `@elabora/node` `journal/`:
- `journal/<yyyy-mm>.jsonl`: one change, undo record or mark per line, append-only, kept 30 days (`pruneProjectData` prunes it with the backups). The edit history of the prototype (`.elabora/history/`) is not imported.
- `lock`: every writer (engine, CLI, MCP) holds the project lock while it checks preconditions, writes files and appends to the journal. It is created exclusively and records the process id, the computer and the time. A lock whose process is gone is broken: at once when that process ran on this computer (a command stopped with Ctrl-C must not block the next one), after 30 s when it ran on another computer, whose processes cannot be checked. Errors: `E_LOCKED`.
- Preconditions: a command computes its operations on the snapshot it read. Before writing, the writer checks that each touched file still has the content it read; otherwise it re-reads and recomputes (commands are deterministic), or fails with `E_CONFLICT`.
- Binary contents referenced by `write` operations and by inverses live in the blob store (shared with backups); journal lines hold their hashes. The store's garbage collection keeps every blob the journal refers to.
- The CLI's edits take an automatic backup version just before writing when the newest one is older than 5 minutes, then prune the project's data.

## Identifiers and format version

### Renaming

Ids of sections, screens, layers, blocks and events are unique in the project (`E_DUPLICATE_ID`) and **permanent**: tools never re-identify an existing node. The screen id is its file name. Renaming is one explicit command, `elabora rename [dir] <old> <new>` (MCP `elabora_rename`; `renameId` in `@elabora/core` `commands/rename.ts`, run as a change by `@elabora/node` `edit.rename`):
- the node gets its new id: an element of a keyed array is removed and inserted again (operations never change ids); a screen file is deleted and written under its new name;
- every reference follows: section ids and the screens they list, events (trigger targets, `visited` conditions, `go-to`, layer and block actions), translation unit ids in `translations/*.xlf` (and the screen file named in their notes), and attribute selectors on `data-section`, `data-screen`, `data-layer` (unless the backdrop has a layer of that name) and `data-block` in the stylesheets of `theme/` and `components/`;
- `elabora.lock.json` keeps the element's key under its new id (`screen:`, `quiz:`, `numeric:`, `decision:`, `object:`, `block:` and `visit:` entities), so learners keep their progress; `elabora diff` lists the element as renamed, not removed. The LMS keeps the screen a learner left by its key too (`lesson_location`), so a learner who left on a renamed screen resumes on it;
- waivers of the plan that name the id follow it (`waivers` in the result): the plan's diff shows the change;
- refused when the new id is in use (sections, screens and their files, layers, blocks, events), is not a slug, or the old one names nothing or more than one element. Ids written in free-object code or generators are not rewritten.

### Format version and migrations

`course.json` `format` gives the format version: `elabora/0.1` (`FORMAT` in `@elabora/format`, whose registry and generated types follow the current version; its schemas are in `packages/format/schemas/<version>/`, and those of later versions will sit beside them). It is the first version: the chain of migrations is empty. From the next format change on, every change ships with its migration and a fixture course in the older format (`test/fixtures/format-<version>/`), tested to load, migrate to exactly the migrated example, validate and build; the mechanism is tested now with a step of the tests' own (`checkFormat(files, chain)`, `migrateProject(dir, { steps })`).
- **Migrations** (`@elabora/core` `format/migrations/`): an ordered chain of pure steps, each from one version to the next, on the raw files of a project (`ProjectFiles` in; the changed files and notes of what changed, what was dropped and what was skipped out). A step edits the values it must in the text of each file (`json-text.ts`), so a file keeps its author's formatting; a file that does not parse is left as it is, with a note. `checkFormat(files)` says whether a project is current, outdated (with the migration), newer or of a format this Elabora does not know (loaded as it is: validation reports it).
- **Loading** an older project reads it migrated in memory: `project.files` are the migrated files, `project.migration` says from what, and `I_FORMAT_OUTDATED` lists what `elabora migrate` would change. A newer format gives `E_FORMAT_NEWER` and nothing past `course.json` is loaded.
- **Writing** (`@elabora/node` `migrateProject`; `elabora migrate [--dry-run]`): one `system` change (`migrate_format`) after a backup version taken for the reason `migration`, so `elabora undo` or a restore gives the course back as it was. A migration writes what the steps computed even where the files already had schema problems (validation reports them). It carries the gate record of a free object (`object.gates.json`) over to the object's new fingerprint when the record held before and the migration changed nothing in the object but format strings, so passed gates stay passed (the fingerprint hashes the object's bytes: node does it, not the core). `migrateIfOutdated(dir, options)` migrates only when needed and refuses a newer format; both take the executor's options (`files`: an engine's snapshot, `validate`, `autoVersion`; with `files`, the edit reads that snapshot with what the migration wrote); every edit through the executor calls it first (the migration is its own change, never part of AI work; the edit result carries `formatMigration`), the library calls it on import (once the files and history are in place, before the project appears), and the engine calls it when it opens a project.
