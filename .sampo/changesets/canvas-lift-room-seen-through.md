---
npm/elabora: patch (Changed)
npm/@elabora/player: patch (Changed)
---

The editor's canvas keeps the room of a block of the flow while it is sized by hand (a lift at a place), as it does while a block is dragged: the flow closes once it is let go, gliding. A dragged block is seen through (`data-t-dragged`, 60 %), and comes back opaque as it glides to its place.
