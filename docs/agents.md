# Working on a course with an agent

Coding agents, MCP clients and apps that embed Elabora all work on the same course folders, through the same operations. Pick the interface your host offers. A course works with any AI provider.

## Choosing an interface

| Interface | Use it for | Good to know |
|---|---|---|
| MCP server (`elabora mcp <course>`) | Agents without a shell; operations with JSON input schemas; images returned with results | The host connects the server (the Claude desktop extension in `plugins/` does it). The server works on the courses it was started on; the host's own file access stays as it is. |
| Agent operations from the shell (`elabora tools list`, `elabora tools call`) | The same schemas, handlers and results from a shell, a script or a plugin | Arguments come as JSON, inline, from a file or from stdin. Use `elabora look` or `screenshot` to get images as files. |
| CLI commands (`elabora validate`, `look`, `build`…) | Terminal work, CI, file outputs, batch options | Each command has its own help and output. Many take `--json`; `tools call` gives a uniform tool result. |
| Editing files | CSS, templates, generators, free-object code, screen JSON | Run `elabora validate` afterwards. Use the operations to rename ids, import media, translate, or anything else that must keep references in step. |

Use connected MCP tools when the host has them, and the CLI otherwise. The user configures their own agent. Read the course's `AGENTS.md`, start with `elabora_overview` (or `elabora project .`), then read the schema of the tool you need.

## Calling a tool from the shell

Every MCP operation runs from the shell, with no server to start. From a course folder:

```sh
cd examples/canal-locks
elabora tools guide --json
elabora tools list elabora_translate_text --json
elabora tools call elabora_translation_table . --args '{"language": "fr"}'
elabora tools call elabora_translate_text . --from translations.json
```

Here `translations.json` holds the tool's arguments:

```json
{ "language": "fr", "texts": [{ "unit": "course.title", "target": "Comment marchent les écluses ?" }] }
```

- **Arguments.** `--args` takes them inline, `--from <file>` from a file and `--from -` from stdin. With neither, the tool gets `{}`.
- **Output.** `tools call` prints the tool's JSON to stdout, or its text for the tools that answer in text (`elabora_overview`, `elabora_docs`). Images go to the course's `.elabora/look/`, and `images` lists their paths. A refusal prints the tool's error, usually `{ "error": … }`. Notes on the course's rules go to stderr.
- **`--raw`** prints the MCP result itself: `content` with text and images, and `isError: true` for a failure or a result with `ok: false`.
- **Exit codes.** 0 for success, 1 for a refused or failed operation, 2 for a malformed command or unreadable JSON.
- **`--read-only`** keeps to the read tools and leaves the course's rules as they are.

## Skills and the guide

`elabora tools guide --json` (MCP `elabora_agent_guide`) is the map of workflows: where to start, the tools for each task and the decisions that belong to people. The exported `AGENT_GUIDE` gives the same data to an embedded host, with no course or MCP needed.

The skills hold the detailed recipes. The course's short `AGENTS.md` says which one a task needs. Load only that one:

```sh
elabora tools skills                                       # list the skills and their references
elabora tools skills elabora-course-authoring               # read one
elabora tools skills elabora-narration voice-and-timing     # read one of its references
```

MCP serves the same text as resources, `elabora://skills/<name>` and `elabora://skills/<name>/references/<reference>`. A host that shows tools only can read it with `elabora_docs` (or `elabora docs`) at `skills`, `skills/<name>` and `skills/<name>/<reference>`.

## Hosts

**Coding agents with a shell** (Claude Code, Codex) need nothing more. The Elabora desktop app opens them in the course's folder with a request that names its bundled `elabora` command. The agent reads `AGENTS.md` and runs `elabora`.

**Claude, the desktop app**, has no shell. The extension in [`plugins/claude-desktop`](https://github.com/aureliendossantos/elabora-core/tree/main/plugins) connects its chat. Install it from the Elabora app (Settings › Tools for AI › Install in Claude), or build it with `pnpm run mcpb` (it writes `dist/elabora.mcpb`). Its launcher finds the app (`/Applications` or `~/Applications` on macOS, `%LOCALAPPDATA%\Programs\elabora` on Windows) and starts its `elabora mcp` on the courses Elabora knows, so installing asks nothing. The skills come from the installed Elabora, so they always match its rules.

**Elabora's chat**, inside the app, runs an ACP agent with the course's MCP server, started with `ELABORA_AUTHOR=agent:<name>` and `ELABORA_CHAT=<conversation>` (letters, digits, `-` and `_`). The server then tells the agent that its own file edits and shell are refused, so it writes through Elabora's tools.

- **Turns.** The host opens each turn with a mark that carries the conversation: engine `mark { request, chat }`, `appendMark(dir, request, { chat })` from `@elabora/node/edit` in another process, or `elabora mark --chat <id>`. The mark's id is the turn's batch. Every change the server makes in that conversation joins it and is undone in one step. The engine's `endTurn { turn }` closes it.
- **Refusals.** When the host refuses one of the agent's own tools, it calls `recordRefusal(root, { chat, mark?, tool, path?, command?, author })` from `@elabora/node/chats`. This writes an activity line of family `refused` with the tool and the file (relative to the course; its name alone outside it) or the shell's program name. Contents stay out of it.
- **Transcript.** `.elabora/chats/<conversation>.jsonl` belongs to the app. The course's MCP server adds `detour` lines to it: the Elabora operation that followed a refusal.
- **Summary.** `elabora history --chats [--json]` sums up the turns from the transcript and the journal: refusals, detours, changes, how each turn ended, its tokens, and the needs behind refusals (`generators/*.mjs`, `*.css`). It suggests a new Elabora tool when refusals are frequent (one turn in five, or one need behind most refusals, after five turns). `turnSummary(dir, chat, turn)` gives one turn.

## Serving several courses

`elabora mcp` takes one folder or several:

- **A course folder** is served as it is.
- **A folder of courses** (the app's library, a folder of modules) serves each course directly in it.
- **No folder** serves the courses Elabora knows: its library and the folders the app opened in place (`elabora-app.json` in Elabora's data folder). It reads them again at each call, so a course created or opened since is served at once, and each keeps its name for the server's life. Before Elabora was ever opened on the computer, its tools say so in one sentence.

With several courses, every course operation takes a `course` argument. `elabora_courses` and the server's instructions give each course's name, and each course's rules are at `elabora://course/<name>/AGENTS.md`. A course's rules are brought up to date the first time an operation works on it.

With no course at all, the server offers what needs none (`elabora_agent_guide`, `elabora_docs`, the library's tools), and its instructions say how to reach a course. The library's tools add modules:

- `elabora_projects_create` starts a module, blank or from a template of `elabora_templates`. The course id comes from the title, the language from the app unless given.
- `elabora_projects_duplicate` copies one.
- `elabora_import` brings in an archive, a course folder, or a Storyline or Rise module.

Each returns the module's folder and, on a server started with no folder, the name it takes at the next call. They need no approval: they only add to the library, and the trash takes a module back.

A missing or unreadable folder is skipped with a message. When it is the only folder given, the server stops.

## Selecting tools

A host can expose only some operations:

```sh
elabora mcp examples/canal-locks --tools elabora_overview,elabora_translation_table,elabora_translate_text
elabora tools list --tools elabora_overview,elabora_translation_table --json     # preview that catalogue
```

Repeat `--tools` or separate names with commas. Discovery and calls use the same list, an unknown name stops the server at startup, and `--read-only` keeps the read tools of the list. By default every operation is exposed. Changing the list takes a new connection. Include the checks and builds the workflow needs: the guide lists them. The list limits what this connection offers; the host's own permissions stay as they are.

From code, the local APIs take `{ readOnly, tools: [names] }`. `tools: []` exposes nothing.

```ts
import { createMcpServer, listAgentTools, callAgentTool } from '@elabora/cli';

const selection = { tools: ['elabora_translation_table', 'elabora_translate_text', 'elabora_translation_status'] };
const server = createMcpServer(courseFolder, selection); // connect a transport in the host
const catalogue = listAgentTools(selection);
const result = await callAgentTool('elabora_translation_table', { language: 'de' },
  { root: courseFolder, author: { kind: 'agent', name: 'my-plugin' } }, selection);
```

Pass the author explicitly when you embed calls.

## One catalogue, every transport

`tools list --json` and MCP `tools/list` are two views of one catalogue, and `tools call` takes each operation by its exact name and schema. Validation, locking, journaling and undo live in the shared services, so every transport gets them. Translation export and approval go through the same executor.

Some decisions belong to people. The core refuses an agent author that makes a plan version or records the client's validation of one (`E_PLAN_PERSON_ONLY`).

Others are the author's, and their agent carries them out once they have said yes, as before a paid generation (D70). A translated plan is one: `elabora_translation_approve` (CLI `translate approve`) without `authorApproved` writes nothing and returns what to put to the author. Only with their yes does the agent call again with `authorApproved`, the translated plan's `contentHash` it was given; a plan changed in between is asked again (`E_TRANSLATION_ASK_AUTHOR`). The approval and the journal keep both: the author's name (`by`) and the agent's (`agent`, the journal's author). A build with a translation that is not approved is a different case: the package holds the languages asked, each as it is (D71); the agent says `W_PACKAGE_LANGUAGE_NOT_APPROVED` to the author in a sentence, with the way to approve it.

A script a person runs can name its author with `ELABORA_AUTHOR=human:<name>`. This attribution records who acted. A host with full shell access can still act as anyone.

| Workflow | Shared operations | What the CLI adds, and what stays human |
|---|---|---|
| Read and plan | Overview, sources, plan, schema, plan diff, write plan | Creating plan versions and the client's approval are human decisions. |
| Author | Screens, blocks, layers, events, variables, components, design files | Editing code and files directly works too. |
| Media and narration | Import, captions, voice selection and generation, transcription, alignment, timing | Batch and maintenance commands. Paid services keep their approval rules. |
| Review and undo | History, undo, reviewers' comments | Publishing, sharing, replying and resolving are the author's actions. |
| Visual checks and delivery | Look, fit, screenshots, package build and tests | Capture batches, output paths and larger test matrices. |
| Translation | Bilingual table, validated batch translation, readiness; validate, look, fit, screenshot, build and test with `language` on the source course | `translate export/status/build/approve`. The author approves a translated plan; the agent records it with their yes. |

An operation missing from MCP is still within reach of an agent with a shell, through the CLI. Respect the author's decisions whatever the transport. A read-only server limits that server's operations only. Read tools may write caches and captures; they leave the authored course as it is.

After an edit, read its diagnostics. After a visual edit, look. Before delivery, validate, check fit, inspect screenshots and run the package and object tests. Make fixes in the source course: a built translation is generated from it. When undo reports skipped operations, keep the author's later edits.

## Maintaining the interfaces

Add an operation for agents to the shared catalogue, so the CLI and MCP get it together. Keep domain rules in `@elabora/core` and `@elabora/node`. Keep CLI commands where their flags, batches or file outputs help: aim for complete workflows, and let flags differ. A change of schemas, names or exposure needs a changelog entry, updated skills and updated interface fixtures. Integration tests compare discovery, errors and undo across transports.
