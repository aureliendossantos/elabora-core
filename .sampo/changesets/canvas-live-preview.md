---
npm/elabora: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
---

The editor canvas has a live mode for the player's preview (page option chrome=live): the bars work as in a package around the screen the host renders, with panels, the resource preview, glossary definitions, « Affichage », « Langue », the outline and the narration's controls, and a change of the player reaches it without a reload, keeping the panel that was open. Its protocol, elabora-player-preview/1, lets the host outline an item (elabora/highlight), open or close a panel (elabora/open, elabora/close), and hear the item clicked (elabora/item), where Previous, Next and the outline go (elabora/navigate with by) and the language chosen (elabora/language). The canvas's render data now carries the course's outline, the resources, « IA et crédits » and the files of the logo and the resources.
