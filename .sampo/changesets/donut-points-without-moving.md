---
npm/elabora: patch (Changed)
npm/@elabora/player: patch (Changed)
---

A donut chart's part no longer moves when pointed at: it takes the accent, as the part the voice names does, while the others step back and the highlight gives its accent up meanwhile. The figure in the centre cross-fades from one value to the next, the two on the same time and curve, instead of fading out then in (a blink). A part's colour now changes at the calm pace while the learner points, and over the pull's half second otherwise (its transitions were overridden before, so it changed at once). The markup's `--ux` and `--uy` are gone.
