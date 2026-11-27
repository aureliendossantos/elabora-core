---
npm/elabora: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
---

Erasing a browser's copies (`forgetCopies`) erases their databases all at once, so that it waits eight seconds at most for the pages that still hold some; a copy's Worker lets its storage go as its session closes, before it answers `close`, and `keptCopies` gives way to an erasing that starts while it reads.
