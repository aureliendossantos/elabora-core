---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
npm/@elabora/core: patch (Fixed)
---

A steps block's scroll (« Défilé ») keeps its figure in phase with the text: a step is current once its words cross the middle of the window, no longer once its taller room does (the figure changed while the step's words had only just come in at the bottom). In a frame of another origin (the editor's canvas, an LMS) the figure no longer shows the lowest step in view: the observers take the frame's own window. Templates mark a step's words with the new hook `data-t-words`, inside a `data-t-reveal` of a `data-t-follow` (`E_COMPONENT_HOOK` otherwise).
