---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Added)
npm/@elabora/engine: patch (Fixed)
---

A copy keeps its link as soon as it takes in a journal entry it has nothing to send for (a change the room gave it, or one that changed nothing): before, the link it kept named the entry before, so a browser's `keptCopies` counted a change from the room as unsent until the copy wrote again, and a copy opened again applied that change a second time. `keptCopies` counts only the copy's own changes, and `isFromRoom` is `@elabora/core`'s (`sync/copy`).
