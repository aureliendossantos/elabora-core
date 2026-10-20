---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

A first installation of a local model (voices, word aligner, transcription) that stopped partway, cancelled or cut by the connection, is no longer taken for an older version once one of its files is complete: cancelling it removes everything it received instead of leaving those files on disk, a resumed download continues in its own folder instead of starting again beside it, and the element reads as absent, not as needing an update. An upgrade that only adds files to the installed release still downloads beside it, and cancelling it keeps the installed release.
