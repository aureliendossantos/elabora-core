---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

Continuity between screens (D65): blocks of different screens that share `continuity: { "key", "duration"? }` are one thing to the learner. Going from one of those screens to another (Next, Previous, the outline, an event), a free object keeps running instead of loading again: its frame glides from the departing block's place to the arriving one's, and the object gets the arriving block's props with `update(props, transition)` (`from`, `to`, `direction`, `duration`, `reducedMotion`), its strings and its safe area, to move its camera and scene over the same time. Another block glides from where its counterpart was. Nothing else moves, and less motion makes it a cut. The chain saves one state (counted once in the worst case); events, completion, title and text version are the arriving block's; a resume mounts the object with the chain's state. The schemas are published as 0.1.2 (D64): the block's continuity, object tests' set-props transition, and the dialogue's pace, reveal, dialog.wordUnspoken and dialog.note described as they now work. New codes: E_CONTINUITY_DUPLICATE, E_CONTINUITY_MISMATCH, E_CONTINUITY_PLACE, W_CONTINUITY_ALONE. The engine runs `set_continuity` (link two blocks, cut a chain, set the passage's length in one change), the CLI `elabora block continue`, agents `elabora_set_continuity` and `continuity` in `elabora_update_block`; object tests give a passage with `set-props` and `transition`. The player's screen view is split into rooms, free objects and in-place updates, with no change of behaviour.
