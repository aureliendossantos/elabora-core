---
npm/elabora: minor (Added)
npm/@elabora/cli: minor (Added)
---

`elabora mcp` takes several folders, each a course or a folder of courses (one level down, the app's library for one): every course operation then takes `course`, the course's name as `elabora_courses` and the server's instructions give it, and each course's rules are the resource `elabora://course/<name>/AGENTS.md`. Started outside a course, the server no longer fails: it offers the documentation, the skills and the library (`elabora_agent_guide`, `elabora_docs`, `elabora_projects_list`, `elabora_projects_path`) and says how to reach a course, so a host plugin can start it wherever a session opens. A folder that is gone is skipped and said. `elabora tools call` runs those four outside a course too. The repository is now a plugin marketplace for Claude Code (`.claude-plugin/marketplace.json`) and Codex (`.agents/plugins/marketplace.json`), with the plugin `plugins/elabora` and the Claude extension `plugins/claude-desktop` (`pnpm run mcpb`).
