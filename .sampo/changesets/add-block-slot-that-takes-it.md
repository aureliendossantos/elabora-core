---
npm/elabora: patch (Changed)
npm/@elabora/core: patch (Changed)
---

`add_block` without `block.slot`, on a screen with a layout or in a component instance, puts the block in a slot that takes it (its type accepted, room under `maxBlocks`): the slot of the block it follows, else the default slot, else the first such slot (D134). A text added after a scene's free object no longer lands in the scene.
