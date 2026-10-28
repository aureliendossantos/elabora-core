---
npm/@elabora/player: patch (Fixed)
npm/@elabora/node: patch (Fixed)
npm/elabora: patch (Added)
---

The backdrop follows the screen wherever it is shown: `elabora look` and the editor canvas gave it the context, the variant and the `data-*` of the first screen shown, and kept them. A look now says the backdrop as the screen shows it (`backdrop`: screen, section, step, variant, hidden, and its decorative object starting, ready or failed), and the decorative object's errors reach the console as errors (`consoleErrors`).
