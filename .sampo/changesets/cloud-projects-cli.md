---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

A folder linked to a project in the cloud (D83, test servers only for now): `elabora cloud teams`, `elabora cloud project create|push|clone` link a folder to a project of a team, and `elabora cloud project sync [--watch]` keeps it in sync through the engine's session. Every change made in the folder (yours, other processes' through Elabora's tools, files written by agents' own tools) goes to the project's room; the room's changes are written in the folder and journaled as their author's. Offline, changes wait in the link and go when the server is back. An agent's run of changes in one batch goes as one submission. In a linked folder, the journal names its person (`id`, and `by` for agents).
