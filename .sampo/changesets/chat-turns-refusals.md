---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

Elabora's chat keeps one batch per turn. A mark can carry its conversation (`chat`): its id is the turn's, and every change the conversation's agent makes (its MCP server started with `ELABORA_CHAT`) joins that turn's batch, even after the author's own edits, another agent's work or a long pause, so « Annuler » undoes the whole turn. The engine keeps the turn's batch open until `endTurn`, and takes it up again when the window reopens mid-turn. « Annuler le travail de l'IA » undoes the AI batch that wrote last.

The tools the chat refuses to its agent (a file edit, a shell) are recorded with `recordRefusal` (`@elabora/node/chats`): an activity line of the new family `refused`, with the tool and its target, never any content; the next Elabora operation is written to the conversation's transcript as its detour. `elabora history --chats` sums up each turn from the transcript and says whether refusals call for a new Elabora tool. `elabora mark --chat <id>` opens a turn from the command line. With `ELABORA_CHAT`, the MCP server's instructions tell the agent to write through Elabora's tools.
