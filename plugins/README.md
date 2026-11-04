# Elabora for AI hosts

**Coding agents with a shell** (Claude Code, Codex, in a terminal or in their desktop apps) are ready as they are. The Elabora app opens them in the course's folder with a request that names the `elabora` command. The course's `AGENTS.md` says the rest: Codex reads it, and Claude Code reads it through `CLAUDE.md`. A plugin for them was tried in October 2026 and removed: it added little to the command, and could fail where the command alone works.

**Claude, the desktop app**, has no shell. [`claude-desktop/`](claude-desktop/) is its extension, an MCP bundle (`.mcpb`). With it, Claude's chat and Cowork work on the author's courses with the tools, rules and skills of the Elabora installed on the computer. The extension itself is a small launcher.

## The extension

`manifest.json` (MCPB 0.3) runs `server/launch.cjs` with Claude's own Node. The manifest has no `user_config`, so Claude installs it without a question.

The launcher finds the app and starts its `elabora mcp` with no folder:

- **macOS**: `/Applications/Elabora.app` or `~/Applications/Elabora.app`.
- **Windows**: `%LOCALAPPDATA%\Programs\elabora`. It runs `Elabora.exe` as Node, because a `.cmd` needs a shell to start.

With no folder, the server serves the courses Elabora knows: its library and the folders the app opened (`elabora-app.json` in Elabora's data folder), read again at each call. Folders given after the launcher are served instead. `ELABORA_COMMAND` names another `elabora`, such as a checkout or a test build. The extension needs an Elabora whose `elabora mcp` serves its courses with no folder: version 0.4.0 or later.

Claude's own Node is a built-in runtime whose `process.stdin` and `process.stdout` are its connection to Claude. The launcher therefore passes every message, and the server's errors, through those streams (`test/fixtures/claude-node-host.cjs` runs it the same way in the tests). For the same reason, an `ELABORA_COMMAND` that points at a `.js` file needs a Node installed on the computer: the built-in runtime cannot start itself as a child.

Two ways to install it:

- **From the app**: Réglages › Outils pour les IA › « Installer dans Claude », shown when Claude's app is found. The app carries this folder, packs it into an `.mcpb` and opens it with Claude, which installs it.
- **From the site**: [elabora.studio/downloads/elabora.mcpb](https://elabora.studio/downloads/elabora.mcpb), built here with `pnpm run mcpb`.

```bash
pnpm run mcpb      # validates the manifest with the official mcpb tool, then writes dist/elabora.mcpb
npx @modelcontextprotocol/inspector --cli -e ELABORA_COMMAND=$PWD/bin/elabora.js node plugins/claude-desktop/server/launch.cjs examples/coffee-in-brief --method tools/list
```

When the extension changes, raise `version` in `manifest.json` and copy the built file to the site.

## Directories

The extension is listed in no directory yet; submitting it is a decision for the maintainers. Anthropic's directory lists local servers inside Claude plugins now, in place of `.mcpb` submissions: a public GitHub repository submitted at claude.ai/directory/manage, with `claude plugin validate` passing and `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl` and `termsOfServiceUrl` in `plugin.json`. The MCP registry lists published packages (`server.json`), and Elabora's server ships with the app.
