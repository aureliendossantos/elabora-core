---
npm/elabora: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
---

A narration line made in a browser ends where its sound ends: the packets an AAC encoder writes past the end (one more frame from macOS's) are dropped, and an Opus sound's start is no longer cut twice. A video master made by WebKit is labelled with the colours it holds (BT.709, limited range), so that it no longer plays washed out elsewhere.
