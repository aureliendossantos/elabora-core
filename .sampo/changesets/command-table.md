---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/cli: patch (Changed)
---

The commands by name (D84): `@elabora/core/commands/table` lists the 47 commands that need nothing but a project's files, each with the JSON Schema of its arguments, its description, whether it removes content and whether it is a person's only, and the function that runs it (`NAMED_COMMANDS`, `namedCommand(name)`, `COMMAND_NAMES`). The MCP tools whose arguments are a command's take their schema and description from it; the tool catalogue is unchanged.
