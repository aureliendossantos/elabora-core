---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

`elabora object test` no longer fails an object's test that presses Tab under Google Chrome with « focus-without-user-activation is not allowed »: a test's clicks and keys reach the object with its frame holding the focus, as a learner's do once they clicked or tabbed into it.
