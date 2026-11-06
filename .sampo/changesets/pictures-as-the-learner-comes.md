---
npm/elabora: patch (Changed)
npm/@elabora/player: patch (Changed)
npm/@elabora/core: patch (Changed)
npm/@elabora/node: patch (Changed)
---

A published module loads its pictures as the learner comes to them. The build writes each picture's width and height on its `<img>`, so the page keeps its room and nothing moves when it arrives. A scroll page loads the pictures near the window first and the others as the learner scrolls (`medieval-charts` opens with 0.35 MB instead of 6.9 MB). Once a screen's own pictures are there and the page is quiet, the next screen's pictures and narration load ahead: a slide shows whole at once, and its narration starts at once.
