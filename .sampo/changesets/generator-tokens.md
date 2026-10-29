---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

A generator's assets are stale only when a token it read changes: its provenance records the tokens it read, and a change of another token no longer asks to run it again.
