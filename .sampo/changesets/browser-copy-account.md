---
npm/elabora: patch (Fixed)
npm/@elabora/engine: minor (Added)
---

A browser's copy of a team's project opens only for the account its link names and only as the project it is kept under (D140): the open request takes `account`, the account signed in as the window last read it, else the Worker asks the hosting who is signed in; a refused copy answers `E_COPY_OTHER_ACCOUNT`, `E_COPY_NOT_THIS_PROJECT` or `E_COPY_ACCOUNT_UNKNOWN`, and is neither opened nor sent. `browser/idb-store` gives the window `keptCopies()`, each copy's team, project, account and changes not yet placed by the room, read without opening it, and `forgetCopies()`, which erases every copy, its media and its recorded takes, the local models kept; a copy open meanwhile says `E_COPY_ERASED`, closes its session and lets its storage go.
