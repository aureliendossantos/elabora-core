# Working on a course with an agent

Elabora supports external coding agents, MCP clients and embedded integrations. They use the same course folders and domain services. Choose the transport available in the host; a course never depends on one AI provider.

## Choosing an interface

| Interface | Use it for | Tradeoffs |
|---|---|---|
| Connected MCP server (`elabora mcp <course>`) | Discoverable operations with JSON input schemas; images returned with results; agents without a shell | The host must connect the server (the Claude desktop extension in `plugins/` does it). A server is scoped to the courses it was started on; it is not a filesystem sandbox. |
| CLI agent operations (`elabora tools list`, `elabora tools call`) | The exact same schemas, handlers and results from a shell, script or plugin | JSON arguments come from a file or stdin. Image results contain base64; prefer `elabora look` or `screenshot` for files. |
| Convenient CLI commands (`elabora validate`, `look`, `build`…) | Terminal work, CI, file outputs and advanced batch options | Commands have their own help and output. Use `--json` where supported; use `tools call` for a consistent tool result. |
| Direct file editing | CSS, templates, generators, free-object code and ordinary screen authoring | Validate afterward. Use domain operations for renaming ids, importing media, translations and other edits that maintain references. |

Use connected MCP tools when available. Otherwise use the CLI; do not try to configure the user's agent settings yourself. Read the course's `AGENTS.md`, start with `elabora_overview` (or `elabora project .`), and inspect the relevant tool's schema. A tool can be called from the shell without starting an MCP server:

```sh
elabora tools guide --json
elabora tools list elabora_translate_text --json
elabora tools call elabora_translation_table . --args '{"language": "en"}'
elabora tools call elabora_translate_text . --from translations.json
```

`--args` takes the arguments inline, `--from <file>` from a file and `--from -` from stdin. With neither it sends `{}`. `tools call` prints the tool's own JSON to stdout, or its text when the tool answers in text (`elabora_overview`, `elabora_docs`). Images are written to files under the course's `.elabora/look/`, and their paths are listed in `images`. A refusal is printed as the tool's error, usually `{ "error": … }`. `--raw` prints the MCP tool result itself instead: `content` with text and/or images, and `isError: true` for a failure, also set for results with `ok: false`. Rules notes go to stderr. Exit codes: 0 success, 1 refused/failed operation, 2 malformed command or unreadable/invalid JSON input. `--read-only` limits discovery and invocation to read tools and does not update course rules.

## Workflow coverage and intentional differences

Every listed MCP operation is available through `tools call` using its exact name and input schema. `tools list --json` and MCP `tools/list` are views of one catalogue; `@elabora/cli` exports `listAgentTools` and `callAgentTool` for local integrations. Pass the author's identity explicitly when embedding calls. Domain validation, locking, journaling and undo belong to the shared services, not the transport. Translation export/approval also go through that executor. The core refuses agent authors recording translated-plan approval, as it does for plan-version approval; a human-run script can identify its human author with `ELABORA_AUTHOR=human:<name>`. This attribution is not a security boundary against a host with arbitrary shell access.

`elabora_agent_guide` returns the same bootstrap/workflow data as `tools guide --json`, including tool names and human decisions. The exported `AGENT_GUIDE` also works in an embedded host without a course or MCP transport. It is a workflow index; load only the bundled skills relevant to the task. `elabora tools skills [<name> [<reference>]] [--json]` lists skills and their optional references, or reads one without a course. MCP serves the same text at `elabora://skills/<name>` and `elabora://skills/<name>/references/<reference>`, and `elabora_docs` (or `elabora docs`) at `skills`, `skills/<name>` and `skills/<name>/<reference>`, for a host that gives the model tools but does not show resources. The course's short `AGENTS.md` routes tasks to these skills; detailed recipes are loaded on demand.

## Host integration

The current desktop app hands requests and the project folder to an external agent; it names its bundled CLI in the request and does not register MCP. A coding agent with a shell (Claude Code, Codex) needs nothing more: in the course's folder it reads `AGENTS.md` and runs `elabora`. Claude, the desktop app, has no shell: the extension `plugins/claude-desktop` ([`plugins/`](https://github.com/aureliendossantos/elabora-core/tree/main/plugins)) connects its chat. The app installs it (Réglages › Outils pour les IA › « Installer dans Claude »); `pnpm run mcpb` writes `dist/elabora.mcpb`. Its launcher finds the app (`/Applications` or `~/Applications` on macOS, `%LOCALAPPDATA%\Programs\elabora` on Windows) and starts its `elabora mcp` on the folders the author picks in the extension's settings. It carries no copy of the skills: the server serves those of the installed Elabora, so they always match its rules.

`elabora mcp` takes one folder or several. A course folder is served as it is. A folder that is not a course serves the courses directly in it (the app's library, a folder of modules). With several courses, every course operation takes a `course` argument, their name as `elabora_courses` and the server's instructions give it, and each course's rules are `elabora://course/<name>/AGENTS.md`. Without any course (no folder picked yet, or one that holds none), the server offers `elabora_agent_guide`, `elabora_docs`, `elabora_projects_list` and `elabora_projects_path`, and its instructions say how to reach a course. A course met inside a folder has its rules brought up to date when an operation first works on it, not when the server starts. A folder that is missing or unreadable is skipped and said; when it is the only one given, the server does not start. Follow the course instructions and use the CLI when no tools are connected. An embedded host can connect the stdio server or import the local API. No provider-specific setup is required in course files.

Hosts can select operations with `elabora mcp <course> --tools elabora_overview,elabora_translation_table,elabora_translate_text` (repeat `--tools` or separate names with commas). Discovery and calls use the same allowlist; unknown names fail at startup, and `--read-only` intersects the selection. By default all operations are exposed. The local APIs accept `{ readOnly, tools: [names] }`; `tools: []` explicitly exposes nothing. `tools list --tools <names> --json` previews that catalogue. A new server connection is needed to change its selection. Include the checks/builds a supported workflow requires; the guide lists them. Tool selection limits exposure in that connection, not the host's OS permissions.

```ts
import { createMcpServer, listAgentTools, callAgentTool } from '@elabora/cli';

const selection = { tools: ['elabora_translation_table', 'elabora_translate_text', 'elabora_translation_status'] };
const server = createMcpServer(courseFolder, selection); // connect a transport in the host
const catalogue = listAgentTools(selection);
const result = await callAgentTool('elabora_translation_table', { language: 'de' },
  { root: courseFolder, author: { kind: 'agent', name: 'my-plugin' } }, selection);
```

| Workflow | Shared operations | Additional CLI capabilities / intentional differences |
|---|---|---|
| Read and plan | Overview, sources, plan, schema, plan diff, write plan | Plan version creation and client approval are human decisions. |
| Author | Screens, blocks, layers, events, variables, components, design files | Direct code/file edits remain supported. |
| Media and narration | Import, captions, voice selection/generation, transcription, alignment, timing | CLI also exposes batch and maintenance commands. Paid services retain their approval requirements. |
| Review and undo | History, undo, reviewers' comments | Publishing, sharing, replying and resolving remain author actions. |
| Visual checks and delivery | Look, fit, screenshots, package build and tests | CLI supports capture batches, output paths and advanced test matrices. |
| Translation | Bilingual table, validated batch translation, readiness; validation, look, fit, screenshot, build and test with `language` on the source server | `translate export/status/build/approve` remain convenient CLI commands; translated-plan approval is human. |

Absence from MCP is not an authorization rule: an agent with shell access can reach the CLI. Respect the author's decisions regardless of transport. A read-only server limits that server's exposed operations, not other tools the host provides. Read tools may create derived caches or captures; they do not edit authored course content.

After an edit, read its diagnostics. After visual edits, look; before delivery, validate, check fit, inspect screenshots and run package/object tests. Fix the source course, never a generated translation. Keep the author's later edits when undo reports skipped operations.

## Maintaining the interfaces

Add agent-facing operations to the shared catalogue, not a second CLI implementation. Keep domain rules in `@elabora/core` and `@elabora/node`. Retain convenient CLI commands when flags, batch execution or file outputs help. Aim for complete workflows rather than identical flags. Changes to schemas, names or exposure require a changelog entry, updated skills and interface fixtures; integration tests compare discovery, errors and undo across transports.
