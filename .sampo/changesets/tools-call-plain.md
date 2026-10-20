---
npm/elabora: minor (Changed)
npm/@elabora/cli: minor (Changed)
---

`elabora tools call` takes its arguments inline with `--args '<json>'`, besides `--from <file>` and `--from -`. It now prints the tool's own JSON, or its text when the tool answers in text, instead of the MCP result with the JSON inside a text block. Images are written to files under the course's `.elabora/look/`, and their paths are listed in `images`. The exit codes are the same as before. `--raw` prints the MCP result as before.
