---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Fixed)
---

With less motion asked, what a course's theme draws in pseudo-elements is stilled too: a backdrop layer's `::after`, a block's `::before`. Their animations stop and their transitions end at once, as the player's rule meant (it named them inside `:is()`, which cannot hold a pseudo-element, so the rule left them out). A backdrop now changes variant at once, and a capture never takes it halfway: Flow's `ink` variant faded in from the screen before.
