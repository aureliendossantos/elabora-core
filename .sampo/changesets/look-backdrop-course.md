---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
npm/@elabora/node: patch (Fixed)
npm/@elabora/core: patch (Fixed)
npm/@elabora/cli: patch (Fixed)
---

`elabora look` and the editor's canvas give the backdrop's decoration the screen's place in the whole course (its rank and its part's, their counts) and the room of the player's bars, as a package does; a decoration whose files change starts again with them. Each screen is shown at rest (no direction): `elabora object replay` and screenshots show the passages. `elabora fit` no longer reads text that a box of 1 px clips away (a chart's table for screen readers) against the pixels where it would lie: a chart over a backdrop was reported unreadable. A fork of a screen layout scopes its stylesheet with `.t-layout--<id>` and says it is a fork in its description; a colour given as the fallback of `var()` is no longer a hard-coded colour (`W_STYLE_LITERAL_COLOR`); `elabora object new --decoration` writes tests on the course's own screens; `elabora object test` names the load when a step fails on a timeout. The free-object contract lists the whole context of a decoration and `host.log`.
