---
npm/elabora: patch (Changed)
npm/@elabora/player: patch (Changed)
---

What comes in with the scroll now slows down to rest instead of stopping at speed. The player names the rule, as tokens themes and components reuse: `animation: var(--t-scroll-in)` fades with `ease` and lifts by `--t-scroll-in-distance` (1rem) on `--t-ease-out`, the curves of a revealed step, over the stretch of scroll its `animation-range` gives; `--t-scroll-in-opacity` is where the fade starts. The words of a timeline or scroll « Étapes » block arrive this way (before: a linear rise that stopped at once). The sample `medieval-charts` uses it for the blocks of its pages (1.5rem, a shorter rise than before), and lets its diptych, layered figures and workshop cards settle on `--t-ease-out`; the rhumb lines of its charts share one ink between the 3D table and the figures, so the workshop's stages draw them as faintly as the whole chart.
