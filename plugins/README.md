# Elabora for AI hosts

A coding agent with a shell (Claude Code, Codex, in a terminal or in their desktop apps) needs nothing from here: the Elabora app opens it in the course's folder with a request that names the `elabora` command, and the course's `AGENTS.md` (read by Codex, and by Claude Code through `CLAUDE.md`) says the rest. A plugin for them was tried on 29 Oct 2026 and removed on 31 Oct: it added almost nothing to that, and could fail where the command alone works.

Claude, the desktop app, has no shell. [`claude-desktop/`](claude-desktop/) is its extension, an MCP bundle (`.mcpb`): Claude's chat (and Cowork) then works on the courses the author picks, with the tools, rules and skills of the Elabora installed on the computer. It carries no copy of Elabora.

## The extension

`manifest.json` (MCPB 0.3) runs `server/launch.cjs` with Claude's own Node. The launcher finds the app (`/Applications/Elabora.app` or `~/Applications/Elabora.app` on macOS; `%LOCALAPPDATA%\Programs\elabora` on Windows, where it runs `Elabora.exe` as Node because a `.cmd` cannot start without a shell) and starts `elabora mcp` on the folders the author picked (`user_config.courses`, several allowed). `ELABORA_COMMAND` names another `elabora` (a checkout, a test). Several folders, or a folder of courses such as the library, need an Elabora whose `elabora mcp` takes several folders (after 0.3.0); 0.3.0 serves one course folder.

- **From the app**: Réglages › Outils pour les IA › « Installer dans Claude », shown when Claude's app is found. The app carries this folder (`claude-extension/` in its resources), packs it into an `.mcpb` and opens it with Claude, which installs it and asks for the folders (elabora-app `src/main/claude-extension.ts`).
- **From the site**: `/downloads/elabora.mcpb`, which `pnpm run mcpb` builds here (`dist/elabora.mcpb`, validated by the official `mcpb` tool).

```bash
pnpm run mcpb                                            # validates, then writes dist/elabora.mcpb
npx @modelcontextprotocol/inspector --cli -e ELABORA_COMMAND=$PWD/bin/elabora.js node plugins/claude-desktop/server/launch.cjs examples/coffee-in-brief --method tools/list
```

Raise `version` in `manifest.json` when the extension changes, and copy the built file to the site.

## Directories

Nothing here is submitted anywhere; that is the founder's call. Anthropic's directory no longer takes `.mcpb` submissions: a local server is listed inside a Claude plugin (a public GitHub repository submitted at claude.ai/directory/manage, `claude plugin validate` passing, `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl` and `termsOfServiceUrl` in `plugin.json`). The MCP registry lists published packages (`server.json`); Elabora's server comes with the app, not as its own package.
