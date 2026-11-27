---
npm/elabora: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
---

Erasing a browser's copies (`forgetCopies`) erases their databases all at once, so that it waits eight seconds at most for the pages that still hold some; a copy's Worker lets its storage go as its session closes, before it answers `close`, and `keptCopies` gives way to an erasing that starts while it reads.

Reading the kept copies never makes again a database an erasing removed meanwhile (Firefox made it empty, and the next opening of that copy failed: `'meta' is not a known object store name`); a copy found in such an empty database is made again.
