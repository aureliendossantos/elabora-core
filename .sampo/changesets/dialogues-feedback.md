---
npm/elabora: minor (Changed)
npm/@elabora/format: patch (Changed)
npm/@elabora/player: minor (Changed)
npm/@elabora/core: minor (Changed)
npm/@elabora/cli: patch (Changed)
---

Dialogues (D61) in the player. A line without a voice is whole at once (no ink), its cues all at once, and the dialogue waits for « Suite » after it and after a note when something to read follows; the options still come by themselves. « Suite » is quiet while the dialogue goes on by itself and filled when it waits; a click on it while a voice speaks ends the line there and goes on; a click on a bubble goes on only while the dialogue waits. The words still to be said are the ink at 38 % over the bubble (`dialog.wordUnspoken`, now checked at 1.5:1 on both bubbles and 3:1 from `dialog.wordSpoken` when a course sets it). « Tout afficher » and « Réécouter » are removed. The History and the debrief are panels over the dialogue: the rest dimmed and inert, closed by a click beside them, their close button or Échap, the focus back where it was. The trainer's note is an aside, centred, its quality in a pill of its colour, without its title (screen readers still hear it). Bubbles and narration use `text-wrap: balance`, a bubble as wide as its lines. `__elabora.dialogues.state()` says `waiting`. The view is split into modules (`box.ts`, `cast.ts`, `lines.ts`, `room.ts`, `moves.ts`, `modal.ts`).
