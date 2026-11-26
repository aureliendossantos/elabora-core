---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
---

A browser's miniature at rest does no work: once its screen is drawn, an animation whose rule wins over the miniature's or started by script is paused, an inline SVG's SMIL animations are paused, and a GIF, an animated PNG or WebP or an SVG that animates shown by an image is shown as one still image (one GIF and one animated SVG in a miniature cost a tenth of a processor core until now). A miniature that does not answer in time is made again after 1 s and 4 s, then its place is freed and it is tried again when its scene is refreshed. A hidden tab draws no miniature: a refresh or a place freed while it is hidden waits for the tab to be seen again, and what failed meanwhile is tried again. A screen renamed changes only its own miniature's version (`thumbRender`), not every screen's.
