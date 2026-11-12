---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

Hashing a project's binary files reuses one buffer instead of taking a megabyte for each file: opening a module of 300 pictures without its hash cache no longer leaves 300 MB to collect.
