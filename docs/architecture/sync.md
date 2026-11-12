# Projects in the cloud: ordering, rebase and copies

How several people and agents work on one project at once: a server orders the changes of every copy, each change is rebased on what came before it, and every copy shows what the server confirmed with its own waiting changes on top. Part of the [architecture](../architecture.md); it builds on [operations](operations.md), the one language every change is written in. Decisions: [D73](../decisions/D73.md) (the server and the copies), [D74](../decisions/D74.md) (rebase), [D75](../decisions/D75.md) (files written by an agent's own tools), [D76](../decisions/D76.md) (a command run on files), [D77](../decisions/D77.md) (ids drawn with a random suffix), [D78](../decisions/D78.md) and [D79](../decisions/D79.md) (authors and undo by person), [D83](../decisions/D83.md) (a folder linked to a project).

`@elabora/core` `sync/` holds it all, pure, without I/O: the server of a project (a room of the hosting) and every copy (the desktop engine, the CLI, later the browser) import the same functions.

## The server orders

A project in the cloud has one server, which holds its files (the head), a log of placed changes numbered from 1, and who is connected. A copy sends a **submission**: a change computed on the files it had at `base` (the number of the last change it got), with its operations, their inverse on those files, its author and its batch. The server (`acceptChange`):

1. places a submission once: one it already placed (by `id`; its acknowledgement was lost) is acknowledged again;
2. refuses a `base` newer than its head or older than the log it keeps (`E_SYNC_BASE`: the copy starts again from the project as it is);
3. rebases the change on its head (below);
4. validates the result (the room's validation is given to it: `validate`) and refuses a change after which the project has an error it did not have (`E_SYNC_INVALID`);
5. numbers it, computes its inverse on head, and sends it to the copy that submitted it (`ack`) and to the others (`change`).

A placed change (`Committed`) carries what it kept and what it did not: `skipped`, the operations left out (an agent's value over a person's, an element gone), and `overwrote`, the values a person's operation replaced without having seen them, so that whoever wrote them is told. A refused change (`Refusal`) applies nothing.

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
- **The engine's session syncs it.** Every journal entry, in order, goes into the copy's `SyncClient`: the session's own changes, other processes' (the CLI, the MCP server), file edits no Elabora tool made (computed as in D75). The room's changes are written in the folder and journaled as the change of their author, with the command `sync`, which is never sent back. The folder is always the client's view: a change the room refused leaves it, and the refusal is told (`cloudOutcome`).
- **The journal names its person** (D78): in a linked folder, a person's changes carry the person's id, an agent's and a file edit's carry it as `by`.
- **Media** are the team's: a change that writes a binary file sends what the team lacks first; a medium another copy wrote is read from the team before the folder is written.
- **A test server only, for now**: the commands need its address (`ELABORA_CLOUD_URL` or `--api`) and refuse Elabora's hosting.
- `scripts/cloud-sync-trial.ts` is the trial on such a server: two folders, a person through the command line, an agent through the MCP tools, files written by hand, one copy offline and back, an agent's burst timed.

## Messages

`elabora-sync/1` (`protocol.ts`), JSON over a WebSocket:

| From a copy | |
|---|---|
| `hello { protocol, client, actor, since }` | opens a connection |
| `submit { change }` | a submission |
| `catchup { since }` | what came after a number |
| `presence { screen?, selection? }` | where its author is |

| From the server | |
|---|---|
| `welcome { protocol, head, peers }` | |
| `ack { change }`, `change { change }` | a placed change, to its copy and to the others |
| `refused { refusal, head }` | |
| `catchup { changes, head }`, `snapshot { head, files }` | what a copy missed |
| `presence { peers }` | who is there: an `Actor` (a person, or an agent with the person who launched it) per copy |

**Authors.** A change's author is the `Author` of [operations](operations.md), with, in a project in the cloud, `id` (a person's stable id, their account) and, for an agent, `by` (the person who launched it). The rule of rebase depends on the author's kind, so the server sets the author from the connection, never from what a copy says.

## The convergence bench

`test/unit/sync-convergence.test.ts` draws, from a seed, two copies of a small course, a server in memory, people and agents running the core's commands, agents writing files with their own tools (from what they read earlier), undos, and one copy going offline and back. Each draw affirms that every copy and the server end with the same files, that the project validates, that no text a person wrote is lost unless the one who replaced it had seen it or someone was told, and that an agent never replaces a person's text it had not seen. Seeds that once failed are kept as fixed cases; `ELABORA_SYNC_DRAWS=5000` runs more draws.
