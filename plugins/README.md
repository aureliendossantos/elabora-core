# Elabora for AI hosts

What connects Elabora to the hosts authors work in. None of it carries a copy of Elabora: each starts the `elabora` command of the Elabora app installed on the computer, whose MCP server serves the tools, the course rules and the skills of that version. A plugin installed from this repository's `main` can be newer or older than the author's app and still say nothing that disagrees with it.

| Folder | Host | Install |
|---|---|---|
| [`elabora/`](elabora/) | Claude Code (`.claude-plugin/plugin.json`) and Codex (`.codex-plugin/plugin.json`), sharing `skills/` and `.mcp.json` | From this repository as a marketplace (below) |
| [`claude-desktop/`](claude-desktop/) | Claude, the desktop app: an MCP bundle (`.mcpb`) | `pnpm run mcpb` writes `dist/elabora.mcpb`; the author opens the file |

## The plugin (Claude Code and Codex)

```bash
# Claude Code (in a session: /plugin install elabora --marketplace aureliendossantos/elabora-core)
claude plugin install elabora --marketplace aureliendossantos/elabora-core
# Codex (or /plugins in a session)
codex plugin marketplace add aureliendossantos/elabora-core
codex plugin add elabora@elabora
```

The marketplaces are `../.claude-plugin/marketplace.json` (Claude Code) and `../.agents/plugins/marketplace.json` (Codex).

- **MCP**: `.mcp.json` starts `elabora mcp .`. Both hosts start it in the session's folder. A course folder is served as it is; a folder of courses is served whole, each operation then taking `course`; elsewhere, the server offers only the documentation, the skills and the app's library, and says how to reach a course (docs/agents.md, « Host integration »). So the plugin can stay enabled everywhere.
- **Skill**: `skills/elabora/SKILL.md` only sends the agent to the course's `AGENTS.md` and to the server's skills (`elabora://skills/<name>`, `elabora_docs`), as `AGENTS.md` itself says, and covers the two failures: no course here, no `elabora` on the PATH. Keep it free of anything a version of Elabora can change.
- **`elabora` not on the PATH**: the server fails to start and the host says so (Claude Code: `/mcp`). On macOS, Elabora's settings › Tools for AI install the command; on Windows the installer puts it on the Path. Not checked on Windows: hosts that start a command without a shell may not run `elabora.cmd`.
- **Version**: `version` in both manifests pins what users have installed until it changes. Raise it (in both) when the plugin's files change.

## The extension (Claude, desktop)

`manifest.json` (MCPB 0.3) runs `server/launch.cjs` with Claude's own Node. The launcher finds the app (`/Applications/Elabora.app` or `~/Applications/Elabora.app` on macOS; `%LOCALAPPDATA%\Programs\elabora` on Windows, where it runs `Elabora.exe` as Node because a `.cmd` cannot start without a shell) and starts `elabora mcp` on the folders the author picked (`user_config.courses`, several allowed). `ELABORA_COMMAND` names another `elabora` (a checkout, a test). Several folders, or a folder of modules such as the library, need an Elabora whose `elabora mcp` takes several folders (after 0.3.0); 0.3.0 serves one module folder.

```bash
pnpm run mcpb                                            # validates, then writes dist/elabora.mcpb
npx @modelcontextprotocol/inspector --cli -e ELABORA_COMMAND=$PWD/bin/elabora.js node plugins/claude-desktop/server/launch.cjs examples/coffee-in-brief --method tools/list
```

Raise `version` in `manifest.json` when the extension changes; the site serves the built file at `/downloads/elabora.mcpb`.

## Directories and submissions

Nothing here is submitted anywhere; that is the founder's call. What each listing asks for:

- **Anthropic's directory (Claude Code, and claude.ai)**: a plugin from a public GitHub repository, submitted at claude.ai/directory/manage, with `claude plugin validate` passing; `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl` in `plugin.json`. Plugins with a top-level `bin/` are not installed by claude.ai or Cowork (this one has none). The directory no longer takes `.mcpb` submissions: the extension is installed from its file.
- **OpenAI's plugin directory (Codex, ChatGPT)**: local MCP servers are listed for approved partners only; otherwise a ZIP, a verified identity, listing texts and icon, website, support, privacy and terms URLs, five positive and three negative test cases, a video and release notes. The git marketplace above needs none of it.
- **The MCP registry**: a `server.json` describing a published package (npm, a container…). Elabora's server comes with the app, not as its own package, so it would first need one.
