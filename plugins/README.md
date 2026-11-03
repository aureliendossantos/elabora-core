# Elabora for AI hosts

A coding agent with a shell (Claude Code, Codex, in a terminal or in their desktop apps) needs nothing from here: the Elabora app opens it in the course's folder with a request that names the `elabora` command, and the course's `AGENTS.md` (read by Codex, and by Claude Code through `CLAUDE.md`) says the rest. A plugin for them was tried on 29 Oct 2026 and removed on 31 Oct: it added almost nothing to that, and could fail where the command alone works.

Claude, the desktop app, has no shell. [`claude-desktop/`](claude-desktop/) is its extension, an MCP bundle (`.mcpb`): Claude's chat (and Cowork) then works on the author's courses, with the tools, rules and skills of the Elabora installed on the computer. It carries no copy of Elabora.

## The extension

`manifest.json` (MCPB 0.3) runs `server/launch.cjs` with Claude's own Node. The launcher finds the app (`/Applications/Elabora.app` or `~/Applications/Elabora.app` on macOS; `%LOCALAPPDATA%\Programs\elabora` on Windows, where it runs `Elabora.exe` as Node because a `.cmd` cannot start without a shell) and starts `elabora mcp` with no folder: the server serves the courses Elabora knows, its library and the folders the app opened (`elabora-app.json` in Elabora's data folder), read again at each call. Claude's own Node is, by default, a built-in runtime whose `process.stdin` and `process.stdout` are its connection, not the process's handles: the launcher passes every message and the server's errors through those streams, never `stdio: 'inherit'` (`test/fixtures/claude-node-host.cjs` runs it the same way in the tests). For the same reason, `ELABORA_COMMAND` pointing at a `.js` file works with a Node installed on the computer, not with the built-in one, which refuses to start itself as a child. The manifest has no `user_config`, so Claude installs it without asking anything. Folders given after the launcher are served instead; `ELABORA_COMMAND` names another `elabora` (a checkout, a test). It needs an Elabora whose `elabora mcp` serves its courses with no folder (after 0.4.0).

- **From the app**: Réglages › Outils pour les IA › « Installer dans Claude », shown when Claude's app is found. The app carries this folder (`claude-extension/` in its resources), packs it into an `.mcpb` and opens it with Claude, which installs it (elabora-app `src/main/claude-extension.ts`).
- **From the site**: `/downloads/elabora.mcpb`, which `pnpm run mcpb` builds here (`dist/elabora.mcpb`, validated by the official `mcpb` tool).

```bash
pnpm run mcpb                                            # validates, then writes dist/elabora.mcpb
npx @modelcontextprotocol/inspector --cli -e ELABORA_COMMAND=$PWD/bin/elabora.js node plugins/claude-desktop/server/launch.cjs examples/coffee-in-brief --method tools/list
```

Raise `version` in `manifest.json` when the extension changes, and copy the built file to the site.

## Directories

Nothing here is submitted anywhere; that is the founder's call. Anthropic's directory no longer takes `.mcpb` submissions: a local server is listed inside a Claude plugin (a public GitHub repository submitted at claude.ai/directory/manage, `claude plugin validate` passing, `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl` and `termsOfServiceUrl` in `plugin.json`). The MCP registry lists published packages (`server.json`); Elabora's server comes with the app, not as its own package.
