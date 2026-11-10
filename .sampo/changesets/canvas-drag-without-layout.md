---
npm/elabora: patch (Changed)
npm/@elabora/player: patch (Changed)
---

The editor's canvas moves a dragged block with a transform on each frame, without laying out the page or sending a layout report. It reports once when the block is let go. A placed block's custom properties no longer pass down to its content, so placing it restyles the block alone.
