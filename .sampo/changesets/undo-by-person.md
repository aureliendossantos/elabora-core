---
npm/elabora: minor (Changed)
npm/@elabora/core: minor (Changed)
npm/@elabora/node: minor (Changed)
npm/@elabora/engine: minor (Changed)
---

Undo by person (D78, D79). A change's author gains `id` (a person's) and `by` (the person who launched an agent). `elabora undo` and the engine's `undo` without a number take back the asker's last step: their own change, or the whole batch of an agent they launched, never someone else's; the new `redo` (engine, `edit.redo`) undoes their last undo again while no change of theirs came after it. An inverse an undo left out stays in force: the change is undone in part (`BatchSummary.partly`), and undoing it again tries only that part. A step whose every part was changed since is still taken, as an undo that writes nothing and says what it kept.
