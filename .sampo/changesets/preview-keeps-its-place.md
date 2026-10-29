---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

A preview rebuilt while an agent writes the course keeps the learner where they were. It keeps its own lock while it runs (the build takes `lock`, given in place of `elabora.lock.json`, which it leaves as it is), so that a screen added before others that have no key in the project's lock yet no longer moves their keys, the learner's place and answers with them. Its page comes back on the same screen, step and scroll after the rebuild, and when the screen shown was taken out of the course, on the one now at its place.
