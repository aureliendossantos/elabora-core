---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

`elabora fit` no longer reports a line of text cut by one of the player's bars as hard to read: its contrast is measured a few pixels off the bar's edge, which the capture at half scale blends with the bar (a button half under the bottom bar on a phone read 1.79:1 against it).
