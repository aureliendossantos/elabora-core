---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Fixed)
npm/@elabora/cli: patch (Fixed)
---

Removing a glossary entry left its links in the screens, and each one stopped the build (E_GLOSSARY_TERM_UNKNOWN). Writing the glossary without an entry (update_player, elabora player, elabora_player) now removes every link to it in the same undoable change, placed by « Relier les termes aux écrans » or written by hand, inline or by reference: the words stay. The translations that had those texts up to date lose the same links and stay up to date. The result lists the links removed (unlinked) and, per translation, the texts unlinked too.
