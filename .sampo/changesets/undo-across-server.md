---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/engine: patch (Fixed)
---

An undo carries what it left out through a project's server (D87): `undoes.skipped` on a submission and a placed change, what the copy's and the server's rebase left out of it added (`RebaseResult.left`, `leftByRebase`), and `journalOf(log)` to read a server's log with the core's undo rules, so that what an undo kept stays in force for a later one. An undo in a linked folder is sent alone, never with the changes after it in its batch.
