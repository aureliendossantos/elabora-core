---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

A module's folder moved or deleted while the editing engine had it open is no longer recreated at its old place when the engine writes its hash cache (`.elabora/cache/hashes.json`), on closing or a second after new hashes.
