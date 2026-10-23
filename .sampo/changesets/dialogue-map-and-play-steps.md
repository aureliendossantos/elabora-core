---
npm/elabora: patch (Changed)
npm/@elabora/core: patch (Changed)
---

A dialogue's map places each passage after every passage that leads to it (the longest way from the start, a retry or a loop going back drawn dashed), so a passage reached early by one option and late by another no longer sits before its own question; a retry loops back into its own passage's head. « Jouer un chemin » (dialoguePlay, `elabora dialogue play --json`) now says which passage waits for a choice (waiting), and each step names its line, its role, the option and the ending, for a host that words the path itself.
