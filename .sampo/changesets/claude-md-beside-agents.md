---
npm/elabora: patch (Added)
npm/@elabora/node: patch (Added)
npm/@elabora/engine: patch (Added)
npm/@elabora/cli: patch (Added)
---

A course has a `CLAUDE.md` beside its `AGENTS.md`, whose one line `@AGENTS.md` makes Claude Code read the rules even when the course sits under a folder with a `CLAUDE.md` of its own (Claude Code reads `AGENTS.md` only where it finds no `CLAUDE.md`). `elabora init`, the module templates and a Storyline/Rise import write it, and a re-import keeps the author's. A course without one gets it from the next `elabora` command, MCP server, opening in the app or migration, as part of the rules update, which `elabora undo` reverts. An author's `CLAUDE.md` is never touched, and builds leave it out as they do `AGENTS.md`. The note about edited rules now says what `elabora rules update --force` does, and the MCP server also gives it in its instructions, because agents never see the server's stderr (D34).
