---
npm/elabora: minor (Added)
npm/@elabora/cli: minor (Added)
npm/@elabora/node: minor (Added)
---

`elabora mcp` with no folder serves the courses Elabora knows: its library and the folders the app opened in place, read again at each call, so that a course created or opened after the server started is served without restarting it, under a name that does not change. Before Elabora was ever opened on the computer, its tools say so in one sentence. A folder given serves that folder, as before; a bare `elabora mcp` no longer serves the current folder (`elabora mcp .` does). The Claude desktop extension starts it this way: its manifest has no `user_config`, so Claude installs it without asking for folders. `knownFolders()` in `@elabora/node/library` gives those folders.
