---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
---

The schemas are published as 0.1.9: the player's `progress` item takes two options (D58, 31 Oct 2026). `parts` (default true) keeps the bar in parts, one segment per section and each a button to it; false makes it the classic bar in one piece, not clickable. `percent` (default true) shows the percentage beside it; screen readers hear it either way. `elabora player . --set progress.parts=false`, MCP `elabora_player` `options.progress`. `update_course` (and `elabora_update_course`) removes a setting given as null, such as the last pronunciation or the sounds, and refuses it for the title, the version and the sections; `elabora_update_course` takes `sounds`.
