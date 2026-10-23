---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
---

The narration's seek bar keeps playing or paused as it was: let go at the end of what may play, a playing screen rests there instead of starting over, and a click within a few pixels of the end reaches it. A narration track that a browser decodes a few milliseconds short now ends its screen when it runs out, instead of leaving it playing just before its end (charts with voice beats then stayed spotlit, the pointer off); charts also come to rest whenever the screen's timeline ends.
