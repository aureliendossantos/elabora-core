---
npm/elabora: minor (Changed)
npm/@elabora/core: patch (Changed)
npm/@elabora/engine: minor (Changed)
---

A file an agent writes with its own tools is computed from the version it most likely read (D75), in the engine too: what the author changed in that file meanwhile and the agent did not touch is kept, and the file on disk is written again with the merge. The versions come from the journal's recent changes (`recentVersions`). A value put back as it was in an older version applies, and the person who changed it since is told. A restore of a version is now the change of the person who asked for it, undone by their ⌘Z.
