---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
---

A canvas page whose route the window closes stops what it was still loading as it gives the route back, so that a request still waiting ends quietly, never with the relay's 503 in its console while its frame is still there (a miniature's painter made again, a module closed).
