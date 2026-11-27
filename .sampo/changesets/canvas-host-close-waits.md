---
npm/elabora: patch (Changed)
npm/@elabora/player: minor (Changed)
---

`createPageCanvasHost().close()` returns a promise that settles once each relay page has said its route closed, or after half a second: a host removes its frame after it, so that the page reads the close and tells the engine to let the route's port go. A browser's miniatures and measurer wait for it, hidden meanwhile.
