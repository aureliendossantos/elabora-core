---
npm/elabora: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

What an agent does in a course is said while it works. Each operation an agent runs through Elabora's tools (MCP, `elabora tools call`, and the commands an agent runs, reads included) writes a line when it starts and one when it ends to `activity.jsonl` next to the journal: the operation, its family (reading the manual, looking at a screen, checking, writing…), the screen or page it works on, its author and whether it succeeded, never the course's text. A person's commands write nothing. The file keeps its last day. The engine sends the lines as they are appended (an `activity` event) and gives the last ones on request (`activity`), so the app can say « Claude examine l'écran 2.1… » for an agent that works in its own app. The MCP server signs its changes with `ELABORA_AUTHOR` when the host sets it, before the name of its client.
