---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Fixed)
---

Translations of ICU select and plural messages can change the words inside each branch. Placeholder checks preserve the actual arguments, including those nested in any branch, without mistaking branch text for variable names.
