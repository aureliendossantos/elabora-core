---
npm/elabora: patch (Added)
npm/@elabora/cli: patch (Added)
npm/@elabora/node: patch (Added)
---

Agents start modules through MCP, as Claude's chat and Cowork have no shell: `elabora_projects_create` (blank or from a template; the course id is the title's, the language the app's unless given; the author's request kept in the module's notes and labelling the agent's first work in its history), `elabora_templates`, `elabora_projects_duplicate` and `elabora_import` (an archive, a course folder, or a Storyline or Rise module). Served with no folder, as Elabora's extension for Claude does, the new module is served at the next call under the name the tool returns. `elabora projects create` takes the course id as an option too.
