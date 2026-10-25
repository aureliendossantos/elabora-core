---
npm/elabora: minor (Fixed)
npm/@elabora/core: minor (Fixed)
npm/@elabora/node: minor (Fixed)
---

The Rise 360 importer reads the two export shapes it missed. A 2026 export, whose course is in `runtime-data.js` and whose `index.html` only holds a config block, is imported (it was refused as not a Storyline or Rise module). A 2017 export, whose course is `var data = '…'` in the player page, is imported too. A Rise export that holds the publication of a Storyline block is now imported as the Rise course, not as a Storyline course made of the block's slides, and an older export left in a folder of a 2026 one is no longer read instead of the course at the root.
