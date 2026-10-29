---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

`elabora fit` no longer reports `W_PLAYER_BAR_WRAPS` for every screen of a narrated course on a phone: the narration's controls take a row of their own there by design (D58), and an item as wide as the line is no longer counted as a line the others overflow onto.
