# Projects in the cloud: ordering, rebase and copies

How several people and agents work on one project at once: a server orders the changes of every copy, each change is rebased on what came before it, and every copy shows what the server confirmed with its own waiting changes on top. Part of the [architecture](../architecture.md); it builds on [operations](operations.md), the one language every change is written in. Decisions: [D73](../decisions/D73.md) (the server and the copies), [D74](../decisions/D74.md) (rebase), [D75](../decisions/D75.md) (files written by an agent's own tools), [D76](../decisions/D76.md) (a command run on files), [D77](../decisions/D77.md) (ids drawn with a random suffix), [D78](../decisions/D78.md) and [D79](../decisions/D79.md) (authors and undo by person), [D83](../decisions/D83.md) (a folder linked to a project), [D84](../decisions/D84.md) (the commands by name), [D85](../decisions/D85.md) (refusals named), [D86](../decisions/D86.md) (validation kept change by change), [D87](../decisions/D87.md) (an undo carries what it left out).

`@elabora/core` `sync/` holds it all, pure, without I/O: the server of a project (a room of the hosting) and every copy (the desktop engine, the CLI, later the browser) import the same functions.

## The server orders

A project in the cloud has one server, which holds its files (the head), a log of placed changes numbered from 1, and who is connected. A copy sends a **submission**: a change computed on the files it had at `base` (the number of the last change it got), with its operations, their inverse on those files, its author and its batch. The server (`acceptChange`):

1. places a submission once: one it already placed (by `id`; its acknowledgement was lost) is acknowledged again;
2. refuses a `base` newer than its head or older than the log it keeps (`E_SYNC_BASE`: the copy starts again from the project as it is);
3. rebases the change on its head (below);
4. validates the result (the room's validation is given to it: `validate`) and refuses a change after which the project has an error it did not have (`E_SYNC_INVALID`); `@elabora/core` `validate/incremental.ts` keeps a validation as a value (D86): the server holds the one of its head, `revalidate` gives the next one by running again only what the change can affect, `newErrors` says what it adds;
5. numbers it, computes its inverse on head, and sends it to the copy that submitted it (`ack`) and to the others (`change`).

A placed change (`Committed`) carries what it kept and what it did not: `skipped`, the operations left out (an agent's value over a person's, an element gone), and `overwrote`, the values a person's operation replaced without having seen them, so that whoever wrote them is told. A value left out names who changed it since (`SkippedOp.by`, D90). A refused change (`Refusal`) applies nothing; an `E_SYNC_INVALID` refusal may carry the errors it would have added (`diagnostics`, D90).

**Refusals** (`RefusalCode`, D85). `acceptChange` gives four: `E_SYNC_ID_TAKEN`, `E_SYNC_INVALID`, `E_SYNC_BASE` and `E_SYNC_MALFORMED` (it is not a change). A room checks more before it, and names it:

| Code | Why |
|---|---|
| `E_SYNC_READ_ONLY` | its author may read the project, not change it |
| `E_SYNC_PATH` | it names a file the project may not hold: a path that is not relative, under `.elabora/`, not in Unicode NFC, or another file's in another case |
| `E_SYNC_TOO_LARGE` | over the room's limits: operations in a change, a text written whole (send it as a medium) |
| `E_SYNC_TOO_MANY_FILES` | the project would hold more files than the room allows |
| `E_SYNC_BLOB_MISSING` | it writes a medium the room cannot find: the copy sends its media again, then the same change, up to three times |
| `E_SYNC_ID_USED` | another author's change has its id |

Every other refusal ends the change on the copy: it leaves the view and its author is told.

## Rebase

`rebase(head, change, since)` replays the change's operations on head, one by one, and compares the value each one replaces (read from its inverse: the value at base) with what head holds there:

| What head holds | A person's operation | An agent's, or a file edit no Elabora tool made |
|---|---|---|
| The value at base | applies | applies |
| Another value | applies (the last written wins); the value it replaced goes in `overwrote` | left out, reported in `skipped`; head keeps the value |

- **Values that are objects or arrays merge three ways first** (`mergeJson`): what only one side changed comes from that side; only the places both changed are decided by the table. Objects merge key by key, keyed arrays element by element, arrays without ids of one length position by position, and otherwise stretch by stretch (two additions at the end both go in). A JSON file written whole as text merges as a value; a text file (CSS, JS) is one value.
- **Structure.** An insertion whose anchor is gone goes last. Removing an element that is gone, or moving one that is no longer where the change found it, is left out. Removing an element someone changed since follows the table. Inserting an id another change took meanwhile refuses the whole change (`E_SYNC_ID_TAKEN`): its other operations may address that element by its id.
- `since` (the changes placed after the base) only says who wrote a value that was overwritten (`Overwrite.by`).

## A copy

A copy (`SyncClient`) holds the files the server confirmed, their number, and its own changes the server has not placed yet, oldest first. What it shows, and writes in its folder, is always computed again from those two: confirmed, then each waiting change rebased on top. Nothing is patched in place, so that every copy ends with the server's bytes.

- **One change in flight.** The first waiting change is rebased on confirmed just before it is sent, so its base is exact and the server meets only others' changes. What that rebase left out or overwrote goes with the change (`Submission.overwrote`), and in the outcome its author is shown.
- A change of others (`change`) or the acknowledgement of its own (`ack`) applies to confirmed, in number order; a gap asks for a catchup from the copy's number.
- **Offline**, the waiting changes pile up and show at once. On reconnecting the copy says its number (`hello`), gets what came since (`catchup`), recognises its own changes among them by id, and sends the rest in order. When the server no longer keeps that far back it sends the project as it is (`snapshot`): it replaces confirmed, and the waiting changes go on top of it as on any change of others.
- `takeOutcomes()` gives, for each change made here, whether it was placed (with what was left out or overwritten, here and on the server) or refused.
- **An agent's run goes as one submission** (D83): the waiting changes of one AI batch by one author, rebased one after the other, up to 100 changes, 600 operations or 2 MiB, named in its command (`changes`, with their ids). A person's changes go one by one.

## Files written by an agent's own tools

An agent may read a file, think, and write it long after: what it writes is the file as it read it, with its edit. Computed from the files as they are, that write would undo what was written meanwhile, in silence. A copy computes it from the version the agent most likely read instead (`externalEdit`): among the recent versions of each written file (each with who made the change after it), the one closest to what was written, JSON by value whatever the order of keys, other text by lines; then rebases it on the files as they are, as an agent's change. Where they clash, what is there now is kept, and `merged` lists the files whose content is no longer what the agent wrote, for it to read again. When several versions are as close, the newest is taken; if a person changed the file between them, what the edit replaces of theirs is reported as overwritten and `unsure` (the agent may not have seen it), so they are told.

## A folder linked to a project

`@elabora/node` `cloud/projects.ts` and `cloud/link.ts`, `@elabora/engine` `session-cloud.ts`; the command line's `elabora cloud teams` and `elabora cloud project create|push|clone|sync` (D83).

- **The link** (`cloud-project.json` in the project's data folder): the server, team and project, this copy's id, its person, the room's number it has, what the room confirmed (by hash in the folder's blob store), the changes waiting, the journal's last entry taken in. It is all a copy needs to go on after a restart, offline or not.
- **The engine's session syncs it.** Every journal entry, in order, goes into the copy's `SyncClient`: the session's own changes, other processes' (the CLI, the MCP server), file edits no Elabora tool made (computed as in D75). The room's changes are written in the folder and journaled as the change of their author, with the command `sync`, which is never sent back. The folder is always the client's view: a change the room refused leaves it, and the refusal is told (`cloudOutcome`). Another's change that replaced a value a change of this copy wrote, unseen, is told to this copy only (`cloudReplaced`, D90).
- **The journal names its person** (D78): in a linked folder, a person's changes carry the person's id, an agent's and a file edit's carry it as `by`.
- **Who is there**: the room's `welcome` and `presence` messages list the copies connected; the session keeps them (`session.cloud.peers`, the `cloudStatus` event, this copy's own `client` among them). `session.linkCloud(options)` starts syncing a folder linked while its session is open (the app links an open module).
- **Where its person is** (D91): `session.cloudWhere({ screen?, selection?, view? })`, sent at once, then at most every 150 ms, and again after each welcome.
- **A copy ends** (D91) when the room closes it with 4003 (the membership ended) or 4004 (the project deleted), or when, kept out, the team's list says so: no reconnection, the folder unlinked with what it held, and the `cloudEnded` event.
- **Media** are the team's: a change that writes a binary file sends what the team lacks first; a medium another copy wrote is read from the team before the folder is written.
- **A test server only, for now**: the commands need its address (`ELABORA_CLOUD_URL` or `--api`) and refuse Elabora's hosting.
- `scripts/cloud-sync-trial.ts` is the trial on such a server: two folders, a person through the command line, an agent through the MCP tools, files written by hand, one copy offline and back, an agent's burst timed.

## Undo across the server

An undo is a change that names what it undoes (`undoes`: the changes, the batch) and what of them it left out (`undoes.skipped`, D87): the inverse operations whose target someone changed since, which stay in force for a later undo (D79). The copy that computed it sends that list; the copy's rebase and the server's add what they left out of it, named after the undo. `journalOf(log)` reads a server's log as journal entries for the core's undo rules (`undoState`, `changesToUndo`, `lastStep`), so an agent of the cloud undoes from the server's log as a person does from a folder's journal. An undo is always sent alone.

## Commands by name

A room runs commands as well as changes: a tool of the cloud sends a command's name and arguments, the room runs it on its head (`executeCommand`, D76) and places the result as a change of the tool's author. `@elabora/core` `commands/table.ts` is the list (D84): the commands that need nothing but the project's files, each with the JSON Schema of its arguments, what a tool says of it, whether it removes content or is a person's only, and the function that runs it. `namedCommand(name)` finds one by its own name only. The schema is what a tool may send; the command checks its arguments itself and refuses with `CommandError`.

## Messages

`elabora-sync/1` (`protocol.ts`), JSON over a WebSocket:

| From a copy | |
|---|---|
| `hello { protocol, client, actor, since }` | opens a connection |
| `submit { change }` | a submission |
| `catchup { since }` | what came after a number |
| `presence { screen?, selection?, view? }` | where its author is (`view`: D91) |

| From the server | |
|---|---|
| `welcome { protocol, head, peers }` | |
| `ack { change }`, `change { change }` | a placed change, to its copy and to the others |
| `refused { refusal, head }` | |
| `catchup { changes, head }`, `snapshot { head, files }` | what a copy missed |
| `presence { peers }` | who is there: an `Actor` (a person, or an agent with the person who launched it) per copy |
| `role { role }` | the person's role changed while connected (D93): a viewer's changes wait in the copy |

**Authors.** A change's author is the `Author` of [operations](operations.md), with, in a project in the cloud, `id` (a person's stable id, their account) and, for an agent, `by` (the person who launched it). The rule of rebase depends on the author's kind, so the server sets the author from the connection, never from what a copy says.

## The convergence bench

`test/unit/sync-convergence.test.ts` draws, from a seed, two copies of a small course, a server in memory, people and agents running the core's commands, agents writing files with their own tools (from what they read earlier), undos (with `agentUndos`, agents undoing their batch from the server's log: `test/unit/sync-undo.test.ts`), and one copy going offline and back. Each draw affirms that every copy and the server end with the same files, that the project validates, that no text a person wrote is lost unless the one who replaced it had seen it or someone was told, and that an agent never replaces a person's text it had not seen; and, for each undo placed, that what it left out is an inverse of one of its targets and that nothing in force before it vanishes without being applied. Seeds that once failed are kept as fixed cases; `ELABORA_SYNC_DRAWS=5000` runs more draws.
