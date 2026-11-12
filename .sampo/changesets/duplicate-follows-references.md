---
npm/@elabora/core: patch (Fixed)
---

A duplicated screen's dialogues open and close its own layers and blocks, its events' dialogue conditions and timeline triggers on a layer name its own, its texts stay translated as its original's (they had to be translated again while its audio was copied), and a glossary term unlinked on the original stays unlinked on the copy. A duplicated block keeps its translations too. Renaming a layer now carries the timeline triggers that wait on it, and a dialogue forked into a component is followed like the native one.
