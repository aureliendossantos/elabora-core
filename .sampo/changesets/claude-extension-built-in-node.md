---
npm/elabora: patch (Fixed)
---

The Claude desktop extension starts again in Claude's built-in Node.js, its default for extensions: the launcher passed its own input and output handles to `elabora mcp`, but that runtime talks to the server through `process.stdin` and `process.stdout` alone, so the server read an empty input and Claude saw it close right after `initialize` ("Server disconnected", "Version negotiation failed"). The launcher now carries the messages and the server's errors through those streams; the extension is version 0.2.1.
