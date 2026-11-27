---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Added)
npm/@elabora/engine: patch (Fixed)
---

A browser engine forgets a relay port once its page closes the route: the page says `relay/done` on the port, the engine stops what it was answering there and keeps the port no longer, instead of holding every miniature's port until the module closes.
