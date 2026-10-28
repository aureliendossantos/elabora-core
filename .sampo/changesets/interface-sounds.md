---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
---

Interface sounds (D67). The player has one audio context for the page, made at the learner's first gesture, under the player's volume and mute. A question's feedback and a dialogue's choices sound alike: `select`, `good`, `ok`, `bad`, `back`, `open`, `close` and `end`, the founder's choice from Kenney's Interface Sounds (CC0), shipped as `elabora/sounds/<role>.m4a` (33 KB for seven) only in packages that use them. `course.json` `sounds.interface`: `when` (`auto`, the default, on when the module has sound; `on`; `off`), `volume`, and `replace` (a role muted, or given a sound of the course). Learners switch them off in « Affichage » (« Sons de l'interface »). New code: E_SOUND_MISSING.
